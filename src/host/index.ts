import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readMaterials, listMaterialFiles, mutateMaterials, readMaterial } from './materials.js';
import { createDocumentChangeStore, createDocumentChangeTool } from './document/change-tool.js';
import {
  readDocumentIndex,
  readDocumentText,
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
import { readClipboard } from './clipboard/index.js';
import {
  createReference as createReferenceRecord,
  getDocumentRelations as readDocumentRelations,
  listReferences as listReferenceSummaries,
  loadReference as readReferenceFile,
  removeReference as deleteReferenceFile,
  saveReference as writeReferenceFile,
  setDocumentRelations as writeDocumentRelations,
} from './reference/store.js';
import type { ReferenceDocument } from '../references.js';
import type { ToolRuntimeContract } from './tools/contract.js';

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

export class SiftService extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'tools'];
  private readonly registry: WorkspaceRegistry;
  /** Phase 8 之前，待确认的 Document 修改提案先只存在内存里。 */
  private readonly documentChanges = createDocumentChangeStore();
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
  async listDocuments(input: { workspaceId: string }) { return readDocumentIndex(this.workspacePath(input.workspaceId)); }

  @Remote
  async saveDocument(input: { workspaceId: string; documentId: string; title?: string; content: string }) {
    const root = this.workspacePath(input.workspaceId);
    return saveDocumentFile(root, {
      id: input.documentId,
      ...(input.title === undefined ? {} : { title: input.title }),
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

  /** 只解除登记，不删除磁盘文件（实施文档 §30）。 */
  @Remote
  async removeDocument(input: { workspaceId: string; documentId: string }) {
    return unregisterDocument(this.workspacePath(input.workspaceId), input.documentId);
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
  async saveReference(input: { workspaceId: string; path: string; reference: ReferenceDocument }) {
    await writeReferenceFile(this.workspacePath(input.workspaceId), input.path, input.reference);
    return {};
  }

  @Remote
  async removeReference(input: { workspaceId: string; path: string }) {
    await deleteReferenceFile(this.workspacePath(input.workspaceId), input.path);
    return {};
  }

  @Remote
  async getDocumentRelations(input: { workspaceId: string; target: string }) {
    return readDocumentRelations(this.workspacePath(input.workspaceId), input.target);
  }

  @Remote
  async setDocumentRelations(input: { workspaceId: string; target: string; references: string[] }) {
    await writeDocumentRelations(this.workspacePath(input.workspaceId), input.target, input.references);
    return {};
  }

  constructor(ctx: SiftContext) {
    super(ctx, 'sift');
    this.registry = ctx.workspaceRegistry;
    // 注册即返回精确 disposer，随本 ctx 卸载自动回收，无需再包一层 effect。
    ctx.tools.register(createDocumentChangeTool(this.documentChanges));
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
