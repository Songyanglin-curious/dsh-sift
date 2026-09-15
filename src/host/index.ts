import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readMaterials, listMaterialFiles, mutateMaterials, readMaterial } from './materials.js';

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
  static inject = ['workspaceRegistry'];
  private readonly registry: WorkspaceRegistry;
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

  constructor(ctx: SiftContext) {
    super(ctx, 'sift');
    this.registry = ctx.workspaceRegistry;
    ctx.logger.info('Sift 插件已加载11。');
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
