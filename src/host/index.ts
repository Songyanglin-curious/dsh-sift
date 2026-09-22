import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readMaterials, listMaterialFiles, mutateMaterials, readMaterial } from './materials.js';
import { createDocumentChangeTool } from './document/change-tool.js';
import {
  readDocumentIndex,
  readDocumentText,
  addExistingDocument as addExistingDocumentFile,
  detachDocument as detachDocumentFile,
  removeDocument as unregisterDocument,
  saveDocument as saveDocumentFile,
} from './document/store.js';
import {
  addExternalFiles as addExternalFileRecords,
  addSource as addSourceRecord,
  browseExternal as browseExternalEntries,
  browseWorkspace as browseWorkspaceEntries,
  createSourceFile as createSourceFileRecord,
  readSourceIndex,
  removeSource as removeSourceRecord,
} from './source/store.js';
import { FileDialogUnsupportedError, pickFiles } from './source/file-dialog.js';
import { OpenPathError, openPathInEditor } from './open-path.js';
import { readClipboard } from './clipboard/index.js';
import {
  createReference as createReferenceRecord,
  getDocumentRelations as readDocumentRelations,
  migrateDocumentRelationTargets,
  importConversationReference as importConversationReferenceFile,
  listReferences as listReferenceSummaries,
  loadReference as readReferenceFile,
  removeReference as deleteReferenceFile,
  removeDocumentRelations,
  saveReference as writeReferenceFile,
  setDocumentRelations as writeDocumentRelations,
} from './reference/store.js';
import { isConversationReference, type ReferenceDocument } from '../references.js';
import { analyzeConversation, analyzeConversationTopic } from './conversation/analyzer.js';
import type { ToolRuntimeContract } from './tools/contract.js';
import {
  ConversationAnalysisSettingsSchema,
  SIFT_SETTINGS_NAMESPACE,
  type ConversationAnalysisSettings,
} from '../settings.js';

export const name = 'sift';

export type WorkspaceProfile = 'default' | 'sift';
export interface WorkspaceProfileResult {
  readonly workspaceId: string;
  readonly title: string;
  readonly profile: WorkspaceProfile;
  readonly status: 'ready' | 'missing' | 'invalid';
  readonly message?: string;
}

interface WorkspaceRecord {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

interface WorkspaceRegistry {
  get(id: string): WorkspaceRecord | undefined;
}

interface SiftContext extends Context {
  workspaceRegistry: WorkspaceRegistry;
  tools: ToolRuntimeContract;
  settings: {
    register<T>(namespace: string, schema: unknown, options?: { base?: T; applies?: 'live' | 'restart' }): {
      get(): T;
    };
  };
}

export async function readWorkspaceProfile(workspace: WorkspaceRecord): Promise<WorkspaceProfileResult> {
  const base = { workspaceId: workspace.id, title: workspace.title };
  try {
    const raw = await readFile(resolve(workspace.path, '.sift', 'config.json'), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (!isProfileConfig(value)) {
      return { ...base, profile: 'default', status: 'invalid', message: 'Sift 配置格式或版本不受支持。' };
    }
    return { ...base, profile: value.profile, status: 'ready' };
  } catch (error) {
    if (isMissingFile(error)) return { ...base, profile: 'default', status: 'missing' };
    return { ...base, profile: 'default', status: 'invalid', message: 'Sift 配置损坏，已使用 default。' };
  }
}

export async function writeWorkspaceProfile(workspace: WorkspaceRecord, profile: WorkspaceProfile): Promise<WorkspaceProfileResult> {
  const directory = resolve(workspace.path, '.sift');
  const target = resolve(directory, 'config.json');
  const temporary = resolve(directory, `config.json.${process.pid}.tmp`);
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, profile }, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return { workspaceId: workspace.id, title: workspace.title, profile, status: 'ready' };
}

function isProfileConfig(value: unknown): value is { schemaVersion: 1; profile: WorkspaceProfile } {
  return typeof value === 'object' && value !== null
    && (value as Record<string, unknown>).schemaVersion === 1
    && ((value as Record<string, unknown>).profile === 'default' || (value as Record<string, unknown>).profile === 'sift');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** 插件配置（写在 cordis.patch.yml 的 sift 行 config 段）。 */
export const Config = z.object({
  /** 打开卡片上「文件」来源时使用的编辑器可执行文件绝对路径；留空则用系统默认程序。 */
  editorCommand: z.string().optional(),
}).default({});
export type SiftConfig = z.infer<typeof Config>;

export class SiftService extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'tools', 'settings', 'llm'];
  static Config = Config;
  private readonly registry: WorkspaceRegistry;
  private readonly config: SiftConfig;
  private readonly analysisSettings: { get(): ConversationAnalysisSettings };
  private readonly llm: Context['llm'];
  private readonly logger: Context['logger'];
  /** 当前界面明确绑定的唯一 AI 可写 Document。 */
  private activeDocument?: { workspaceId: string; documentId: string };
  private workspacePath(id: string): string {
    const workspace = this.registry.get(id);
    if (!workspace) throw new Error('工作区不存在。');
    return workspace.path;
  }

  @Remote
  async getMaterials(input: { workspaceId: string }) { return readMaterials(this.workspacePath(input.workspaceId)); }
  @Remote
  async listMaterialFiles(input: { workspaceId: string; path: string }) { return listMaterialFiles(this.workspacePath(input.workspaceId), input.path); }
  @Remote
  async addMaterial(input: { workspaceId: string; kind: 'file' | 'url'; target: string }) { return mutateMaterials(this.workspacePath(input.workspaceId), input); }
  @Remote
  async removeMaterial(input: { workspaceId: string; id: string }) { return mutateMaterials(this.workspacePath(input.workspaceId), input); }
  @Remote
  async readMaterial(input: { workspaceId: string; id: string }) { return readMaterial(this.workspacePath(input.workspaceId), input.id); }

  @Remote
  async listDocuments(input: { workspaceId: string }) {
    const root = this.workspacePath(input.workspaceId);
    const index = await readDocumentIndex(root);
    await migrateDocumentRelationTargets(root, index.documents);
    return index;
  }

  @Remote
  async saveDocument(input: { workspaceId: string; documentId: string; title?: string; content: string; targetDirectory?: string }) {
    const root = this.workspacePath(input.workspaceId);
    return saveDocumentFile(root, {
      id: input.documentId,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.targetDirectory === undefined ? {} : { targetDirectory: input.targetDirectory }),
      content: input.content,
    });
  }

  @Remote
  async readDocumentContent(input: { workspaceId: string; documentId: string }) {
    const root = this.workspacePath(input.workspaceId);
    const index = await readDocumentIndex(root);
    const document = index.documents.find(item => item.id === input.documentId);
    if (!document?.path) throw new Error('Document 不存在或尚未保存。');
    return { content: await readDocumentText(root, document.path), path: document.path };
  }

  @Remote
  async setActiveDocument(input: { workspaceId: string; documentId?: string }) {
    if (input.documentId === undefined) {
      if (this.activeDocument?.workspaceId === input.workspaceId) this.activeDocument = undefined;
      return {};
    }
    const root = this.workspacePath(input.workspaceId);
    const index = await readDocumentIndex(root);
    if (!index.documents.some(item => item.id === input.documentId && item.path)) throw new Error('当前 Document 不存在或尚未保存。');
    this.activeDocument = { workspaceId: input.workspaceId, documentId: input.documentId };
    return {};
  }

  @Remote
  async addExistingDocument(input: { workspaceId: string; documentId: string; path: string }) {
    return addExistingDocumentFile(this.workspacePath(input.workspaceId), { id: input.documentId, path: input.path });
  }

  @Remote
  async detachDocument(input: { workspaceId: string; documentId: string }) {
    const root = this.workspacePath(input.workspaceId);
    const before = await readDocumentIndex(root);
    const document = before.documents.find(item => item.id === input.documentId);
    const index = await detachDocumentFile(root, input.documentId);
    await removeDocumentRelations(root, [input.documentId, document?.path ?? '']);
    return index;
  }

  @Remote
  async removeDocument(input: { workspaceId: string; documentId: string }) {
    const root = this.workspacePath(input.workspaceId);
    const before = await readDocumentIndex(root);
    const document = before.documents.find(item => item.id === input.documentId);
    const index = await unregisterDocument(root, input.documentId);
    await removeDocumentRelations(root, [input.documentId, document?.path ?? '']);
    return index;
  }

  @Remote
  async listSources(input: { workspaceId: string }) { return readSourceIndex(this.workspacePath(input.workspaceId)); }

  @Remote
  async addSource(input: { workspaceId: string; type: 'file' | 'url'; location?: 'workspace' | 'external'; target: string; title?: string }) {
    const root = this.workspacePath(input.workspaceId);
    return addSourceRecord(root, {
      type: input.type,
      ...(input.location === undefined ? {} : { location: input.location }),
      target: input.target,
      ...(input.title === undefined ? {} : { title: input.title }),
    });
  }

  /** 只解除登记，不删除来源文件本身。 */
  @Remote
  async removeSource(input: { workspaceId: string; id: string }) {
    return removeSourceRecord(this.workspacePath(input.workspaceId), input.id);
  }

  /** 原生多选文件对话框的结果一次性登记为本机来源。 */
  @Remote
  async addExternalFiles(input: { workspaceId: string; paths: string[] }) {
    return addExternalFileRecords(this.workspacePath(input.workspaceId), input.paths);
  }

  /**
   * 打开系统文件选择对话框（多选）。
   * 平台不支持或对话框打不开时抛出可读错误，客户端据此回落到目录浏览。
   */
  @Remote
  async pickSourceFiles() {
    try {
      return await pickFiles({ title: 'Sift：选择来源文件' });
    } catch (error) {
      if (error instanceof FileDialogUnsupportedError) return { paths: [], cancelled: true, message: error.message };
      throw error;
    }
  }

  @Remote
  async createSourceFile(input: { workspaceId: string; name: string; content: string }) {
    return createSourceFileRecord(this.workspacePath(input.workspaceId), { name: input.name, content: input.content });
  }

  @Remote
  async browseWorkspace(input: { workspaceId: string; path: string }) {
    return browseWorkspaceEntries(this.workspacePath(input.workspaceId), input.path);
  }

  @Remote
  async browseExternal(input: { path: string }) { return browseExternalEntries(input.path); }

  /**
   * 读取 Windows 原生剪贴板快照（文本/文件/HTML/URL）。
   * clipboard 模块是纯工具层，这里只做转发；失败时抛可读错误由客户端展示。
   */
  @Remote
  async readClipboard() { return readClipboard(); }

  /**
   * 在本机打开一个文件（卡片上「文件」来源的点击行为）。
   * 优先用配置的 editorCommand，未配置则交给系统默认程序；失败抛可读错误。
   */
  @Remote
  async openSourcePath(input: { path: string }) {
    try {
      await openPathInEditor(input.path, { editorCommand: this.config.editorCommand });
    } catch (error) {
      if (error instanceof OpenPathError) throw error;
      throw new OpenPathError(error instanceof Error ? error.message : String(error));
    }
    return {};
  }

  // ── Reference 文件化存储（阶段性实施方案 Step 1/2） ──

  @Remote
  async listReferences(input: { workspaceId: string }) { return listReferenceSummaries(this.workspacePath(input.workspaceId)); }

  @Remote
  async loadReference(input: { workspaceId: string; path: string }) { return readReferenceFile(this.workspacePath(input.workspaceId), input.path); }

  @Remote
  async createReference(input: { workspaceId: string; name?: string }) {
    const path = await createReferenceRecord(this.workspacePath(input.workspaceId), input.name);
    return { path };
  }

  @Remote
  async importConversationReference(input: { workspaceId: string; sourcePath: string }) {
    const path = await importConversationReferenceFile(this.workspacePath(input.workspaceId), input.sourcePath);
    return { path };
  }

  @Remote
  async saveReference(input: { workspaceId: string; path: string; reference: ReferenceDocument }) {
    await writeReferenceFile(this.workspacePath(input.workspaceId), input.path, input.reference);
    return {};
  }

  @Remote
  async analyzeConversation(input: { workspaceId: string; path: string; anchorGroupId: string }) {
    const root = this.workspacePath(input.workspaceId);
    const reference = await readReferenceFile(root, input.path);
    if (!isConversationReference(reference)) throw new Error('当前参考不是会话类型。');
    let analysis;
    try {
      analysis = await analyzeConversation(reference, input.anchorGroupId, this.analysisSettings.get(), this.llm);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
      throw error;
    }
    const next = { ...reference, analysis };
    await writeReferenceFile(root, input.path, next);
    return next;
  }

  @Remote
  async analyzeConversationTopic(input: { workspaceId: string; path: string; topic: string }) {
    const root = this.workspacePath(input.workspaceId);
    const reference = await readReferenceFile(root, input.path);
    if (!isConversationReference(reference)) throw new Error('当前参考不是会话类型。');
    const analysis = await analyzeConversationTopic(reference, input.topic, this.analysisSettings.get(), this.llm);
    const next = { ...reference, analysis };
    await writeReferenceFile(root, input.path, next);
    return next;
  }

  @Remote
  async removeReference(input: { workspaceId: string; path: string }) {
    await deleteReferenceFile(this.workspacePath(input.workspaceId), input.path);
    return {};
  }

  @Remote
  async getDocumentRelations(input: { workspaceId: string; target: string }) {
    const root = this.workspacePath(input.workspaceId);
    return readDocumentRelations(root, input.target);
  }

  @Remote
  async setDocumentRelations(input: { workspaceId: string; target: string; references: string[] }) {
    await writeDocumentRelations(this.workspacePath(input.workspaceId), input.target, input.references);
    return {};
  }

  constructor(ctx: SiftContext, config: SiftConfig = {}) {
    super(ctx, 'sift');
    this.registry = ctx.workspaceRegistry;
    this.config = config;
    this.llm = ctx.llm;
    this.logger = ctx.logger;
    this.analysisSettings = ctx.settings.register(
      SIFT_SETTINGS_NAMESPACE,
      ConversationAnalysisSettingsSchema,
      { base: {}, applies: 'live' },
    );
    // 注册即返回精确 disposer，随本 ctx 卸载自动回收，无需再包一层 effect。
    ctx.tools.register(createDocumentChangeTool(
      async () => {
        const active = this.activeDocument;
        if (!active) throw new Error('Sift 当前没有打开可修改的 Document。');
        const root = this.workspacePath(active.workspaceId);
        const index = await readDocumentIndex(root);
        const document = index.documents.find(item => item.id === active.documentId);
        if (!document?.path) throw new Error('当前 Document 不存在或尚未保存。');
        return { ...active, path: document.path };
      },
      async (target, content) => {
        const root = this.workspacePath(target.workspaceId);
        const index = await readDocumentIndex(root);
        const document = index.documents.find(item => item.id === target.documentId);
        if (!document?.path || document.path !== target.path) throw new Error('当前 Document 已发生变化，请重新打开后再试。');
        await saveDocumentFile(root, { id: document.id, ...(document.title === undefined ? {} : { title: document.title }), content });
      },
    ));
    ctx.logger.info('Sift 插件已加载。');
    ctx.effect(() => () => ctx.logger.info('Sift 插件已卸载。'));
  }

  @Remote
  async getWorkspaceProfile(input: { workspaceId: string }): Promise<WorkspaceProfileResult> {
    const workspace = this.registry.get(input.workspaceId);
    if (!workspace) {
      return { workspaceId: input.workspaceId, title: '', profile: 'default', status: 'invalid', message: '当前工作区已不存在。' };
    }
    return readWorkspaceProfile(workspace);
  }

  @Remote
  async setWorkspaceProfile(input: { workspaceId: string; profile: WorkspaceProfile }): Promise<WorkspaceProfileResult> {
    const workspace = this.registry.get(input.workspaceId);
    if (!workspace) {
      return { workspaceId: input.workspaceId, title: '', profile: 'default', status: 'invalid', message: '刚创建的工作区已不存在。' };
    }
    return writeWorkspaceProfile(workspace, input.profile);
  }
}

export default SiftService;
