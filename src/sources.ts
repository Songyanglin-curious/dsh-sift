import { z } from 'zod';

/**
 * Source 的共享模型（v0.2 实施文档 §9、§10）。
 *
 * Source 只登记「Sift 能稳定访问的信息来源」，不复制也不移动原文件：
 * - 工作区文件：`location = workspace`，`target` 是工作区内相对路径
 * - 本机外部文件：`location = external`，`target` 是绝对路径
 * - 网页：`type = url`，`target` 是规范化后的 URL
 *
 * 粘贴创建 Markdown 的产物本身就是一个工作区文件 Source，不另立类型。
 */

export const sourceTypeSchema = z.enum(['file', 'url']);
export const sourceLocationSchema = z.enum(['workspace', 'external']);

export const sourceSchema = z.object({
  id: z.string(),
  type: sourceTypeSchema,
  title: z.string(),
  target: z.string(),
  location: sourceLocationSchema.optional(),
  createdAt: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;

export const sourceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(sourceSchema),
});
export type SourceIndex = z.infer<typeof sourceIndexSchema>;

export function emptySourceIndex(): SourceIndex {
  return { schemaVersion: 1, items: [] };
}

/** 粘贴创建 Source 时的输入；文件会落在工作区内。 */
export const sourceTypeLabel: Record<Source['type'], string> = { file: '文件', url: '网页' };

/**
 * 规范化网页地址：只接受不带账号密码的 HTTP/HTTPS。
 */
export function normalizeSourceUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入不含账号密码的 HTTP 或 HTTPS 网页地址。');
  }
  return url.href;
}

/** 从路径里取文件名，兼容 Windows 反斜杠与 URL。 */
export function fileNameOf(target: string): string {
  const trimmed = target.replace(/[/\\]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly directory: boolean;
}

export interface SourcesApi {
  listSources(input: { workspaceId: string }): Promise<SourceIndex>;
  addSource(input: { workspaceId: string; type: 'file' | 'url'; location?: 'workspace' | 'external'; target: string; title?: string }): Promise<{ index: SourceIndex; source: Source }>;
  /** 原生多选对话框的结果：一次登记多个本机文件。 */
  addExternalFiles(input: { workspaceId: string; paths: readonly string[] }): Promise<{ index: SourceIndex; added: readonly Source[]; failed: readonly { target: string; message: string }[] }>;
  /** 打开系统文件选择对话框；平台不支持时 `message` 给出原因，由调用方回落。 */
  pickSourceFiles(input: Record<string, never>): Promise<{ paths: readonly string[]; cancelled: boolean; message?: string }>;
  removeSource(input: { workspaceId: string; id: string }): Promise<SourceIndex>;
  /** 粘贴内容 → 在工作区创建 Markdown → 登记为 Source，是一个原子操作。 */
  createSourceFile(input: { workspaceId: string; name: string; content: string }): Promise<{ index: SourceIndex; source: Source }>;
  /** 列出工作区内某个目录，用于「添加工作区文件」。 */
  browseWorkspace(input: { workspaceId: string; path: string }): Promise<FileEntry[]>;
  /** 列出本机某个绝对目录，用于「添加本机文件」（由系统目录选择器选到目录）。 */
  browseExternal(input: { path: string }): Promise<FileEntry[]>;
}
