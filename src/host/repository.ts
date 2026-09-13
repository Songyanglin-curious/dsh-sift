import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SiftRequest } from '../contracts/remote.js';
import {
  emptyCatalog,
  type Annotation,
  type BinaryDocument,
  type Catalog,
  type HostFileListing,
  type Project,
  type ProjectWorkState,
  type Solution,
  type Source,
  type SourcePreview,
  type TextDocument,
} from '../domain/model.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

interface LegacyCatalog {
  schemaVersion: 1;
  solutions: Array<Omit<Solution, 'workspaceId' | 'workspacePath'>>;
  projects: Array<Omit<Project, 'sessionIds' | 'activeSessionId'>>;
  sources: Array<Omit<Source, 'solutionId' | 'originalLocation' | 'status' | 'statusMessage'>>;
  annotations: Array<{
    id: string;
    projectId: string;
    target: 'source' | 'note';
    targetId: string | null;
    quote: string;
    comment: string;
    createdAt: string;
  }>;
}

function now(): string {
  return new Date().toISOString();
}

function versionOf(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultWorkState(projectId: string, time = now()): ProjectWorkState {
  return {
    projectId,
    openTabs: ['note'],
    activeTab: 'note',
    readingLocations: {},
    noteDraft: null,
    noteDraftBaseVersion: null,
    selectedAnnotationIds: [],
    materialWidth: 280,
    conversationWidth: 480,
    materialTreeCollapsed: false,
    pendingNavigation: null,
    updatedAt: time,
  };
}

export class SiftRepository {
  readonly root: string;
  readonly catalogFile: string;
  readonly sourceRoot: string;
  private mutation = Promise.resolve();
  private migration: Promise<void> | null = null;

  constructor(root: string) {
    this.root = resolve(root);
    this.catalogFile = join(this.root, 'catalog.json');
    this.sourceRoot = join(this.root, 'sources');
  }

  async dispatch(request: SiftRequest): Promise<unknown> {
    if (request.type === 'catalog.get') {
      return this.serial(async () => {
        const catalog = await this.readCatalog();
        if (await this.refreshLocalSourceStatuses(catalog)) await this.writeCatalog(catalog);
        return catalog;
      });
    }
    if (request.type === 'note.read') return this.readNote(request.projectId);
    if (request.type === 'note.read.lines') return this.readNoteLines(request.projectId, request.startLine, request.endLine);
    if (request.type === 'file.list') return this.listFiles(request.solutionId, request.path);
    return this.serial(() => this.execute(request));
  }

  async readCatalog(): Promise<Catalog> {
    await this.ensureMigrated();
    try {
      const value = JSON.parse(await readFile(this.catalogFile, 'utf8')) as Catalog;
      if (value.schemaVersion !== 2) throw new Error(`不支持的 Sift 数据版本：${String(value.schemaVersion)}`);
      for (const solution of value.solutions) solution.workspaceId ??= null;
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCatalog();
      throw error;
    }
  }

  async readNote(projectId: string): Promise<TextDocument> {
    const { project } = await this.projectAndSolution(projectId);
    const content = await readFile(project.notePath, 'utf8');
    return { content, version: versionOf(content) };
  }

  async projectForSession(sessionId: string): Promise<Project | null> {
    const catalog = await this.readCatalog();
    return catalog.projects.find(project => project.sessionIds.includes(sessionId)) ?? null;
  }

  private async execute(request: Exclude<SiftRequest, { type: 'catalog.get' | 'note.read' | 'note.read.lines' | 'file.list' }>): Promise<unknown> {
    if (request.type === 'source.preview') return this.previewSource(request.id);
    if (request.type === 'source.binary') return this.readSourceBinary(request.id);

    const catalog = await this.readCatalog();
    const time = now();
    switch (request.type) {
      case 'solution.create': {
        const solution: Solution = {
          id: randomUUID(), name: request.name, description: request.description,
          workspaceId: request.workspaceId,
          workspacePath: request.workspacePath == null ? null : this.workspacePath(request.workspacePath),
          createdAt: time, updatedAt: time,
        };
        catalog.solutions.push(solution);
        await this.writeCatalog(catalog);
        return solution;
      }
      case 'solution.update': {
        const solution = this.solution(catalog, request.id);
        solution.name = request.name;
        solution.description = request.description;
        solution.workspaceId = request.workspaceId;
        solution.workspacePath = request.workspacePath === null ? null : this.workspacePath(request.workspacePath);
        solution.updatedAt = time;
        await this.writeCatalog(catalog);
        return solution;
      }
      case 'solution.delete': {
        if (catalog.projects.some(item => item.solutionId === request.id)) throw new Error('解决方案仍包含项目，不能删除。');
        if (catalog.sources.some(item => item.solutionId === request.id)) throw new Error('解决方案仍包含共享素材，不能删除。');
        catalog.solutions = catalog.solutions.filter(item => item.id !== request.id);
        await this.writeCatalog(catalog);
        return catalog;
      }
      case 'project.create': {
        const solution = this.solution(catalog, request.solutionId);
        if (solution.workspaceId === null || solution.workspacePath === null) throw new Error('请先为解决方案选择 DSH 工作区。');
        const projectId = randomUUID();
        const notePath = request.notePath == null
          ? join(solution.workspacePath, '.sift', 'projects', projectId, 'note.md')
          : this.notePathInWorkspace(request.notePath, solution.workspacePath);
        await this.ensureNote(notePath, request.title);
        const project: Project = {
          id: projectId, solutionId: request.solutionId, title: request.title, goal: request.goal,
          notePath, sourceIds: [], sessionIds: [], activeSessionId: null, createdAt: time, updatedAt: time,
        };
        catalog.projects.push(project);
        catalog.workStates.push(defaultWorkState(projectId, time));
        await this.writeCatalog(catalog);
        return project;
      }
      case 'project.update': {
        const project = this.project(catalog, request.id);
        project.title = request.title;
        project.goal = request.goal;
        project.updatedAt = time;
        await this.writeCatalog(catalog);
        return project;
      }
      case 'project.delete': {
        if (!catalog.projects.some(item => item.id === request.id)) return catalog;
        catalog.projects = catalog.projects.filter(item => item.id !== request.id);
        catalog.annotations = catalog.annotations.filter(item => item.projectId !== request.id);
        catalog.annotationSends = catalog.annotationSends.filter(item => item.projectId !== request.id);
        catalog.workStates = catalog.workStates.filter(item => item.projectId !== request.id);
        catalog.noteRevisions = catalog.noteRevisions.filter(item => item.projectId !== request.id);
        await this.writeCatalog(catalog);
        return catalog;
      }
      case 'project.session.bind': {
        const project = this.project(catalog, request.projectId);
        const existing = catalog.projects.find(item => item.id !== project.id && item.sessionIds.includes(request.sessionId));
        if (existing) throw new Error('该 DSH 会话已经关联其他 Sift 项目。');
        if (!project.sessionIds.includes(request.sessionId)) project.sessionIds.push(request.sessionId);
        if (request.activate || project.activeSessionId === null) project.activeSessionId = request.sessionId;
        project.updatedAt = time;
        await this.writeCatalog(catalog);
        return project;
      }
      case 'project.session.activate': {
        const project = this.project(catalog, request.projectId);
        if (!project.sessionIds.includes(request.sessionId)) throw new Error('该会话未关联当前项目。');
        project.activeSessionId = request.sessionId;
        project.updatedAt = time;
        await this.writeCatalog(catalog);
        return project;
      }
      case 'project.session.unbind': {
        const project = this.project(catalog, request.projectId);
        project.sessionIds = project.sessionIds.filter(id => id !== request.sessionId);
        if (project.activeSessionId === request.sessionId) project.activeSessionId = project.sessionIds.at(-1) ?? null;
        project.updatedAt = time;
        await this.writeCatalog(catalog);
        return project;
      }
      case 'source.create': {
        const project = request.projectId ? this.project(catalog, request.projectId) : null;
        const solutionId = project?.solutionId ?? request.solutionId;
        if (!solutionId) throw new Error('新增素材必须指定解决方案或项目。');
        if (request.solutionId && project && request.solutionId !== project.solutionId) throw new Error('项目与解决方案不一致。');
        const solution = this.solution(catalog, solutionId);
        const sourceId = randomUUID();
        let location = request.location;
        if (request.kind === 'text') {
          await mkdir(this.sourceRoot, { recursive: true });
          location = join(this.sourceRoot, `${sourceId}.md`);
          await writeFile(location, request.content ?? '', 'utf8');
        } else if (request.kind === 'file') {
          location = this.absolutePath(location, '本地素材必须使用绝对路径。');
        } else {
          location = this.webUrl(location);
        }
        if (request.kind === 'file') this.rejectNoteAsSource(catalog, location);
        const source: Source = {
          id: sourceId, solutionId: solution.id, kind: request.kind, title: request.title,
          location, originalLocation: location, mediaType: request.mediaType,
          status: 'available', statusMessage: null, createdAt: time, updatedAt: time,
        };
        catalog.sources.push(source);
        if (project) {
          project.sourceIds.push(source.id);
          project.updatedAt = time;
        }
        await this.writeCatalog(catalog);
        return source;
      }
      case 'source.update': {
        const source = this.source(catalog, request.id);
        source.title = request.title;
        source.mediaType = request.mediaType;
        source.updatedAt = time;
        await this.writeCatalog(catalog);
        return source;
      }
      case 'source.attach': {
        const project = this.project(catalog, request.projectId);
        const source = this.source(catalog, request.id);
        if (source.solutionId !== project.solutionId) throw new Error('素材不属于当前解决方案。');
        if (!project.sourceIds.includes(source.id)) project.sourceIds.push(source.id);
        project.updatedAt = time;
        await this.writeCatalog(catalog);
        return project;
      }
      case 'source.detach': {
        const project = this.project(catalog, request.projectId);
        project.sourceIds = project.sourceIds.filter(id => id !== request.id);
        project.updatedAt = time;
        await this.writeCatalog(catalog);
        return catalog;
      }
      case 'source.classify': {
        const source = this.source(catalog, request.id);
        if (source.solutionId !== null) throw new Error('只有待归类素材可以重新归属。');
        this.solution(catalog, request.solutionId);
        source.solutionId = request.solutionId;
        source.updatedAt = time;
        await this.writeCatalog(catalog);
        return source;
      }
      case 'source.remove': {
        const source = this.source(catalog, request.id);
        if (source.solutionId !== request.solutionId) throw new Error('素材不属于当前解决方案。');
        const affected = catalog.projects.filter(item => item.sourceIds.includes(source.id)).map(item => item.id).sort();
        const confirmed = [...new Set(request.affectedProjectIds)].sort();
        if (JSON.stringify(affected) !== JSON.stringify(confirmed)) throw new Error('素材引用关系已变化，请刷新影响项目后再次确认。');
        for (const project of catalog.projects) project.sourceIds = project.sourceIds.filter(id => id !== source.id);
        catalog.sources = catalog.sources.filter(item => item.id !== source.id);
        await this.writeCatalog(catalog);
        return catalog;
      }
      case 'source.relocate': {
        const source = this.source(catalog, request.id);
        if (source.kind === 'text') throw new Error('粘贴文本由 Sift 管理，不能重新定位。');
        const location = source.kind === 'file'
          ? this.absolutePath(request.location, '本地素材必须使用绝对路径。')
          : this.webUrl(request.location);
        if (source.kind === 'file') this.rejectNoteAsSource(catalog, location);
        source.location = location;
        source.status = 'available';
        source.statusMessage = null;
        source.updatedAt = time;
        await this.writeCatalog(catalog);
        return source;
      }
      case 'annotation.create': {
        const project = this.project(catalog, request.projectId);
        if (request.target === 'source' && (!request.targetId || !project.sourceIds.includes(request.targetId))) {
          throw new Error('批注素材不属于当前项目。');
        }
        if (request.target === 'message' && request.targetId === null) throw new Error('消息批注缺少消息标识。');
        const annotation: Annotation = {
          id: randomUUID(), projectId: request.projectId, target: request.target,
          targetId: request.target === 'note' ? null : request.targetId,
          snapshot: request.snapshot,
          comments: [{ version: 1, comment: request.comment, createdAt: time }],
          currentCommentVersion: 1, createdAt: time, updatedAt: time,
        };
        catalog.annotations.push(annotation);
        const state = this.workState(catalog, project.id, time);
        if (!state.selectedAnnotationIds.includes(annotation.id)) state.selectedAnnotationIds.push(annotation.id);
        await this.writeCatalog(catalog);
        return annotation;
      }
      case 'annotation.comment.update': {
        const annotation = this.annotation(catalog, request.id);
        const nextVersion = annotation.currentCommentVersion + 1;
        annotation.comments.push({ version: nextVersion, comment: request.comment, createdAt: time });
        annotation.currentCommentVersion = nextVersion;
        annotation.updatedAt = time;
        const state = this.workState(catalog, annotation.projectId, time);
        if (!state.selectedAnnotationIds.includes(annotation.id)) state.selectedAnnotationIds.push(annotation.id);
        await this.writeCatalog(catalog);
        return annotation;
      }
      case 'annotation.delete': {
        const annotation = catalog.annotations.find(item => item.id === request.id);
        catalog.annotations = catalog.annotations.filter(item => item.id !== request.id);
        if (annotation) {
          const state = this.workState(catalog, annotation.projectId, time);
          state.selectedAnnotationIds = state.selectedAnnotationIds.filter(id => id !== annotation.id);
        }
        await this.writeCatalog(catalog);
        return catalog;
      }
      case 'annotation.send.record': {
        const project = this.project(catalog, request.projectId);
        if (!project.sessionIds.includes(request.sessionId)) throw new Error('发送会话未关联当前项目。');
        for (const selected of request.annotationVersions) {
          const annotation = this.annotation(catalog, selected.annotationId);
          if (annotation.projectId !== project.id || annotation.currentCommentVersion < selected.commentVersion) {
            throw new Error('批注版本与当前项目不一致。');
          }
        }
        catalog.annotationSends.push({
          id: randomUUID(), projectId: project.id, sessionId: request.sessionId, mode: request.mode,
          annotationVersions: request.annotationVersions, messageTextVersion: request.messageTextVersion, acceptedAt: time,
        });
        const state = this.workState(catalog, project.id, time);
        state.selectedAnnotationIds = state.selectedAnnotationIds.filter(annotationId => {
          const selected = request.annotationVersions.find(item => item.annotationId === annotationId);
          const annotation = catalog.annotations.find(item => item.id === annotationId);
          return selected === undefined || annotation?.currentCommentVersion !== selected.commentVersion;
        });
        await this.writeCatalog(catalog);
        return catalog.annotationSends.at(-1);
      }
      case 'workstate.update': {
        this.project(catalog, request.projectId);
        const state = this.workState(catalog, request.projectId, time);
        Object.assign(state, request.state, { projectId: request.projectId, updatedAt: time });
        await this.writeCatalog(catalog);
        return state;
      }
      case 'note.write':
        return this.writeNote(catalog, request.projectId, request.content, request.expectedVersion, request.actor ?? 'human', time);
      case 'note.insert': {
        const current = await this.readNoteFromCatalog(catalog, request.projectId);
        this.expectVersion(current, request.expectedVersion);
        const lines = current.content.split('\n');
        if (request.afterLine > lines.length) throw new Error('笔记插入位置超出范围。');
        lines.splice(request.afterLine, 0, ...request.content.split('\n'));
        return this.writeNote(catalog, request.projectId, lines.join('\n'), request.expectedVersion, 'ai', time);
      }
      case 'note.replace.lines': {
        const current = await this.readNoteFromCatalog(catalog, request.projectId);
        this.expectVersion(current, request.expectedVersion);
        const lines = current.content.split('\n');
        if (request.endLine < request.startLine || request.endLine > lines.length) throw new Error('笔记行范围无效。');
        lines.splice(request.startLine - 1, request.endLine - request.startLine + 1, ...request.replacement.split('\n'));
        return this.writeNote(catalog, request.projectId, lines.join('\n'), request.expectedVersion, 'ai', time);
      }
      case 'note.replace.text': {
        const current = await this.readNoteFromCatalog(catalog, request.projectId);
        this.expectVersion(current, request.expectedVersion);
        const first = current.content.indexOf(request.match);
        if (first === -1) throw new Error('笔记中找不到要替换的文本。');
        if (current.content.indexOf(request.match, first + request.match.length) !== -1) throw new Error('要替换的文本不唯一，请改用行范围。');
        const content = `${current.content.slice(0, first)}${request.replacement}${current.content.slice(first + request.match.length)}`;
        return this.writeNote(catalog, request.projectId, content, request.expectedVersion, 'ai', time);
      }
      case 'note.rollback': {
        const revision = catalog.noteRevisions.find(item => item.id === request.revisionId && item.projectId === request.projectId);
        if (!revision) throw new Error('笔记修订不存在。');
        return this.writeNote(catalog, request.projectId, revision.beforeContent, request.expectedVersion, 'rollback', time);
      }
    }
  }

  private async previewSource(sourceId: string): Promise<SourcePreview> {
    const catalog = await this.readCatalog();
    const source = this.source(catalog, sourceId);
    try {
      const result = source.kind === 'url' ? await this.previewUrl(source) : await this.previewTextFile(source);
      source.status = 'available';
      source.statusMessage = null;
      await this.writeCatalog(catalog);
      return result;
    } catch (error) {
      source.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
      source.statusMessage = messageOf(error);
      source.updatedAt = now();
      await this.writeCatalog(catalog);
      throw error;
    }
  }

  private async previewTextFile(source: Source): Promise<SourcePreview> {
    const buffer = await readFile(source.location);
    const truncated = buffer.length > MAX_TEXT_BYTES;
    const content = buffer.subarray(0, MAX_TEXT_BYTES).toString('utf8');
    if (content.includes('\u0000')) throw new Error('该素材不是可预览的 UTF-8 文本。');
    return {
      title: source.title, location: source.location, mediaType: source.mediaType,
      content, version: versionOf(buffer), status: 'available', truncated, encoding: 'utf8',
    };
  }

  private async readSourceBinary(sourceId: string): Promise<BinaryDocument> {
    const catalog = await this.readCatalog();
    const source = this.source(catalog, sourceId);
    if (source.kind === 'url') throw new Error('网页素材不提供二进制读取。');
    try {
      const info = await stat(source.location);
      if (info.size > MAX_BINARY_BYTES) throw new Error('素材超过 64 MiB 本地预览上限。');
      const buffer = await readFile(source.location);
      source.status = 'available';
      source.statusMessage = null;
      await this.writeCatalog(catalog);
      return {
        title: source.title, location: source.location,
        mediaType: source.mediaType ?? 'application/octet-stream', version: versionOf(buffer),
        status: 'available', contentBase64: buffer.toString('base64'),
      };
    } catch (error) {
      source.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
      source.statusMessage = messageOf(error);
      source.updatedAt = now();
      await this.writeCatalog(catalog);
      throw error;
    }
  }

  private async previewUrl(source: Source): Promise<SourcePreview> {
    const response = await fetch(source.location, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    if (!response.ok) throw new Error(`网页素材读取失败：HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_TEXT_BYTES) throw new Error('网页素材超过 2 MiB 阅读上限。');
    const body = await response.text();
    const truncated = Buffer.byteLength(body, 'utf8') > MAX_TEXT_BYTES;
    const clipped = Buffer.from(body).subarray(0, MAX_TEXT_BYTES).toString('utf8');
    const contentType = response.headers.get('content-type');
    return {
      title: source.title, location: source.location, mediaType: contentType ?? source.mediaType,
      content: clipped, version: versionOf(body), status: 'available', truncated, encoding: 'utf8',
    };
  }

  private async readNoteLines(projectId: string, startLine: number, endLine: number): Promise<TextDocument & { startLine: number; endLine: number; totalLines: number }> {
    if (endLine < startLine) throw new Error('笔记行范围无效。');
    const document = await this.readNote(projectId);
    const lines = document.content.split('\n');
    if (startLine > lines.length) throw new Error('起始行超出笔记范围。');
    const actualEnd = Math.min(endLine, lines.length);
    const content = lines.slice(startLine - 1, actualEnd).map((line, index) => `${startLine + index}: ${line}`).join('\n');
    return { content, version: document.version, startLine, endLine: actualEnd, totalLines: lines.length };
  }

  private async writeNote(catalog: Catalog, projectId: string, content: string, expectedVersion: string | null, actor: 'human' | 'ai' | 'rollback', time: string): Promise<TextDocument> {
    const current = await this.readNoteFromCatalog(catalog, projectId);
    if (expectedVersion !== null) this.expectVersion(current, expectedVersion);
    const project = this.project(catalog, projectId);
    await this.atomicWrite(project.notePath, content);
    const afterVersion = versionOf(content);
    if (current.content !== content) {
      catalog.noteRevisions.push({
        id: randomUUID(), projectId, beforeVersion: current.version, afterVersion,
        beforeContent: current.content, afterContent: content, actor, createdAt: time,
      });
    }
    project.updatedAt = time;
    const state = this.workState(catalog, projectId, time);
    state.noteDraft = null;
    state.noteDraftBaseVersion = null;
    await this.writeCatalog(catalog);
    return { content, version: afterVersion };
  }

  private async readNoteFromCatalog(catalog: Catalog, projectId: string): Promise<TextDocument> {
    const project = this.project(catalog, projectId);
    let content = '';
    try {
      content = await readFile(project.notePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { content, version: versionOf(content) };
  }

  private expectVersion(document: TextDocument, expectedVersion: string): void {
    if (document.version !== expectedVersion) throw new Error('笔记已经在其他位置发生变化，请重新加载后再修改。');
  }

  private solution(catalog: Catalog, id: string): Solution {
    const solution = catalog.solutions.find(item => item.id === id);
    if (!solution) throw new Error('解决方案不存在。');
    return solution;
  }

  private project(catalog: Catalog, id: string): Project {
    const project = catalog.projects.find(item => item.id === id);
    if (!project) throw new Error('项目不存在。');
    return project;
  }

  private source(catalog: Catalog, id: string): Source {
    const source = catalog.sources.find(item => item.id === id);
    if (!source) throw new Error('素材不存在。');
    return source;
  }

  private annotation(catalog: Catalog, id: string): Annotation {
    const annotation = catalog.annotations.find(item => item.id === id);
    if (!annotation) throw new Error('批注不存在。');
    return annotation;
  }

  private workState(catalog: Catalog, projectId: string, time: string): ProjectWorkState {
    let state = catalog.workStates.find(item => item.projectId === projectId);
    if (!state) {
      state = defaultWorkState(projectId, time);
      catalog.workStates.push(state);
    }
    return state;
  }

  private async projectAndSolution(projectId: string): Promise<{ catalog: Catalog; project: Project; solution: Solution }> {
    const catalog = await this.readCatalog();
    const project = this.project(catalog, projectId);
    return { catalog, project, solution: this.solution(catalog, project.solutionId) };
  }

  private workspacePath(value: string): string {
    return this.absolutePath(value, 'DSH 工作区必须使用绝对路径。');
  }

  private notePathInWorkspace(value: string, workspacePath: string): string {
    const notePath = this.absolutePath(value, '笔记必须使用绝对路径。');
    if (extname(notePath).toLowerCase() !== '.md') throw new Error('项目笔记必须是 Markdown 文件。');
    const pathFromWorkspace = relative(workspacePath, notePath);
    if (pathFromWorkspace.startsWith('..') || isAbsolute(pathFromWorkspace)) throw new Error('项目笔记必须位于解决方案的 DSH 工作区内。');
    return notePath;
  }

  private absolutePath(value: string, errorMessage: string): string {
    if (!isAbsolute(value)) throw new Error(errorMessage);
    return resolve(value);
  }

  private webUrl(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('网页素材只支持 HTTP 或 HTTPS URL。');
    return url.href;
  }

  private rejectNoteAsSource(catalog: Catalog, location: string): void {
    if (catalog.projects.some(project => resolve(project.notePath).toLowerCase() === resolve(location).toLowerCase())) {
      throw new Error('当前成果笔记不能同时作为只读素材引用。');
    }
  }

  private async listFiles(solutionId: string, requestedPath: string | null): Promise<HostFileListing> {
    const catalog = await this.readCatalog();
    const solution = this.solution(catalog, solutionId);
    if (!solution.workspacePath) throw new Error('请先为解决方案选择 DSH 工作区。');
    const path = requestedPath === null ? solution.workspacePath : resolve(requestedPath);
    if (requestedPath !== null && !isAbsolute(requestedPath)) throw new Error('文件浏览器只接受绝对目录路径。');
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error('文件浏览位置不是目录。');
    const rows = await readdir(path, { withFileTypes: true });
    const entries = rows
      .filter(row => row.isDirectory() || row.isFile())
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
      .slice(0, 1_000)
      .map(row => ({ name: row.name, path: join(path, row.name), kind: row.isDirectory() ? 'directory' as const : 'file' as const }));
    const parent = dirname(path);
    return { path, parent: parent === path ? null : parent, entries, truncated: rows.length > 1_000 };
  }

  private async refreshLocalSourceStatuses(catalog: Catalog): Promise<boolean> {
    let changed = false;
    for (const source of catalog.sources) {
      if (source.kind === 'url') continue;
      let status: Source['status'] = 'available';
      let statusMessage: string | null = null;
      try {
        const info = await stat(source.location);
        if (!info.isFile()) { status = 'unreadable'; statusMessage = '素材位置不是文件。'; }
      } catch (error) {
        status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
        statusMessage = messageOf(error);
      }
      if (source.status !== status || source.statusMessage !== statusMessage) {
        source.status = status; source.statusMessage = statusMessage; source.updatedAt = now(); changed = true;
      }
    }
    return changed;
  }

  private async ensureNote(path: string, title: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(path, `# ${title}\n`, { encoding: 'utf8', flag: 'wx' });
    }
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migration !== null) return this.migration;
    this.migration = this.migrateIfNeeded();
    return this.migration;
  }

  private async migrateIfNeeded(): Promise<void> {
    let parsed: LegacyCatalog | Catalog;
    try {
      parsed = JSON.parse(await readFile(this.catalogFile, 'utf8')) as LegacyCatalog | Catalog;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (parsed.schemaVersion === 2) return;
    if (parsed.schemaVersion !== 1) throw new Error(`不支持的 Sift 数据版本：${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);

    const backupRoot = `${this.root}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await cp(this.root, backupRoot, { recursive: true, errorOnExist: true });
    const migrated = this.migrateV1(parsed);
    await this.writeCatalog(migrated);
  }

  private migrateV1(legacy: LegacyCatalog): Catalog {
    const migrated = emptyCatalog();
    migrated.solutions = legacy.solutions.map(solution => ({ ...solution, workspaceId: null, workspacePath: null }));
    migrated.projects = legacy.projects.map(project => ({ ...project, sessionIds: [], activeSessionId: null }));
    migrated.workStates = migrated.projects.map(project => defaultWorkState(project.id, project.updatedAt));

    const sourceMap = new Map<string, Map<string, string>>();
    for (const source of legacy.sources) {
      const solutionIds = [...new Set(legacy.projects.filter(project => project.sourceIds.includes(source.id)).map(project => project.solutionId))];
      const owners = solutionIds.length === 0 ? [null] : solutionIds;
      for (const [index, solutionId] of owners.entries()) {
        const id = index === 0 ? source.id : randomUUID();
        if (solutionId !== null) {
          let bySolution = sourceMap.get(source.id);
          if (!bySolution) sourceMap.set(source.id, bySolution = new Map());
          bySolution.set(solutionId, id);
        }
        migrated.sources.push({
          ...source, id, solutionId, originalLocation: source.location,
          status: 'available', statusMessage: null,
        });
      }
    }
    for (const project of migrated.projects) {
      project.sourceIds = project.sourceIds.map(sourceId => sourceMap.get(sourceId)?.get(project.solutionId) ?? sourceId);
    }
    migrated.annotations = legacy.annotations.map(annotation => {
      const project = migrated.projects.find(item => item.id === annotation.projectId);
      const targetId = annotation.targetId === null || project === undefined
        ? annotation.targetId
        : sourceMap.get(annotation.targetId)?.get(project.solutionId) ?? annotation.targetId;
      const source = migrated.sources.find(item => item.id === targetId);
      return {
        id: annotation.id, projectId: annotation.projectId, target: annotation.target, targetId,
        snapshot: {
          quote: annotation.quote,
          title: source?.title ?? '历史成果笔记',
          location: source?.location ?? project?.notePath ?? null,
          documentVersion: 'legacy-location-unavailable', anchor: null,
        },
        comments: [{ version: 1, comment: annotation.comment, createdAt: annotation.createdAt }],
        currentCommentVersion: 1, createdAt: annotation.createdAt, updatedAt: annotation.createdAt,
      };
    });
    return migrated;
  }

  private async writeCatalog(catalog: Catalog): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.atomicWrite(this.catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, 'utf8');
    try {
      await rename(temporary, path);
    } catch (error) {
      throw new Error(`写入失败：${messageOf(error)}`, { cause: error });
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }
}
