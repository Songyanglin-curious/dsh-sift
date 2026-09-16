import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  emptySourceIndex,
  fileNameOf,
  normalizeSourceUrl,
  sourceIndexSchema,
  type Source,
  type SourceIndex,
  type FileEntry,
} from '../../sources.js';
import { documentFileName } from '../../documents.js';
import {
  IGNORED_DIRECTORY_NAMES,
  isMissingFile,
  metadataFile,
  resolveInsideWorkspace,
  resolveWorkspaceDirectory,
  serialize,
  unusedFileName,
  writeTextAtomic,
  writeWorkspaceText,
} from '../storage/workspace-files.js';

/**
 * Source 的宿主侧存储与来源浏览（v0.2 实施文档 §9、§10）。
 *
 * Source 只登记位置，不复制内容：工作区文件存相对路径，本机外部文件存绝对路径，
 * 网页存规范化 URL。粘贴创建 Markdown 是「先落盘、再登记」的同一次操作。
 */

export interface AddSourceInput {
  readonly type: 'file' | 'url';
  readonly location?: 'workspace' | 'external';
  readonly target: string;
  readonly title?: string;
}

export interface SourceMutation {
  readonly index: SourceIndex;
  readonly source: Source;
}

async function sourceIndexFile(root: string): Promise<string> {
  return metadataFile(root, 'sources.json');
}

export async function readSourceIndex(root: string): Promise<SourceIndex> {
  const path = await sourceIndexFile(root);
  try {
    return sourceIndexSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (isMissingFile(error)) return emptySourceIndex();
    throw new Error(`Source 登记表无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeSourceIndex(root: string, index: SourceIndex): Promise<void> {
  await writeTextAtomic(await sourceIndexFile(root), `${JSON.stringify(index, null, 2)}\n`);
}

/** 同一 (type, location, target) 视为同一条 Source；重复添加返回已有记录。 */
function findExisting(index: SourceIndex, input: AddSourceInput): Source | undefined {
  return index.items.find(item => item.type === input.type
    && item.target === input.target
    && (input.type === 'url' || item.location === input.location));
}

/** 在已读入的登记表上登记一条 Source；调用方负责串行与落盘。 */
function registerInto(index: SourceIndex, entry: { type: 'file' | 'url'; location?: 'workspace' | 'external'; target: string; title: string }): Source {
  const existing = findExisting(index, entry);
  if (existing) return existing;
  const source: Source = {
    id: randomUUID(),
    type: entry.type,
    title: entry.title,
    target: entry.target,
    ...(entry.location === undefined ? {} : { location: entry.location }),
    createdAt: new Date().toISOString(),
  };
  index.items.push(source);
  return source;
}

/** 校验并规范化一次添加请求。 */
async function normalizeInput(root: string, input: AddSourceInput): Promise<{ type: 'file' | 'url'; location?: 'workspace' | 'external'; target: string; title: string }> {
  if (input.type === 'url') {
    const target = normalizeSourceUrl(input.target);
    return { type: 'url', target, title: input.title?.trim() || target };
  }
  const raw = input.target.trim();
  if (raw === '') throw new Error('请选择文件。');
  const location = input.location ?? 'workspace';
  if (location === 'workspace') {
    const absolute = resolveInsideWorkspace(root, raw);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('请选择文件，而不是目录。');
    const target = relative(resolve(root), absolute).split(sep).join('/');
    return { type: 'file', location, target, title: input.title?.trim() || basename(target) };
  }
  if (!isAbsolute(raw)) throw new Error('本机文件需要绝对路径。');
  const info = await stat(raw);
  if (!info.isFile()) throw new Error('请选择文件，而不是目录。');
  return { type: 'file', location, target: raw, title: input.title?.trim() || fileNameOf(raw) };
}

export function addSource(root: string, input: AddSourceInput): Promise<SourceMutation> {
  return serialize(root, async () => {
    const entry = await normalizeInput(root, input);
    const index = await readSourceIndex(root);
    const source = registerInto(index, entry);
    await writeSourceIndex(root, index);
    return { index, source };
  });
}

export interface BatchSourceMutation {
  readonly index: SourceIndex;
  readonly added: readonly Source[];
  /** 逐个失败的原因；成功的条目仍然会被登记。 */
  readonly failed: readonly { readonly target: string; readonly message: string }[];
}

/**
 * 一次登记多个本机文件（原生多选对话框的结果）。
 * 单次串行写入，避免多选时写出 N 次登记表；个别文件失败不影响其余文件。
 */
export function addExternalFiles(root: string, paths: readonly string[]): Promise<BatchSourceMutation> {
  return serialize(root, async () => {
    const index = await readSourceIndex(root);
    const added: Source[] = [];
    const failed: { target: string; message: string }[] = [];
    for (const path of paths) {
      try {
        added.push(registerInto(index, await normalizeInput(root, { type: 'file', location: 'external', target: path })));
      } catch (error) {
        failed.push({ target: path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (added.length === 0 && failed.length > 0) throw new Error(failed[0]!.message);
    await writeSourceIndex(root, index);
    return { index, added, failed };
  });
}

export function removeSource(root: string, id: string): Promise<SourceIndex> {
  return serialize(root, async () => {
    const index = await readSourceIndex(root);
    // 只解除登记，绝不删除来源文件本身。
    index.items = index.items.filter(item => item.id !== id);
    await writeSourceIndex(root, index);
    return index;
  });
}

/**
 * 粘贴内容 → 在工作区根目录创建 Markdown → 登记为 Source。
 * 两步在同一次串行写入里完成，避免出现「文件建了但没登记」的中间态。
 */
export function createSourceFile(root: string, input: { name: string; content: string }): Promise<SourceMutation> {
  return serialize(root, async () => {
    const name = await unusedFileName(resolve(root), documentFileName(input.name));
    await writeWorkspaceText(root, name, input.content);
    const index = await readSourceIndex(root);
    const source = registerInto(index, { type: 'file', location: 'workspace', target: name, title: name });
    await writeSourceIndex(root, index);
    return { index, source };
  });
}

/** 工作区目录浏览：返回相对路径，目录在前。 */
export async function browseWorkspace(root: string, path: string): Promise<FileEntry[]> {
  const directory = resolveWorkspaceDirectory(root, path === '' ? '.' : path);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(entry => !entry.isSymbolicLink() && !IGNORED_DIRECTORY_NAMES.includes(entry.name as typeof IGNORED_DIRECTORY_NAMES[number]))
    .map(entry => ({
      name: entry.name,
      path: relative(resolve(root), resolve(directory, entry.name)).split(sep).join('/'),
      directory: entry.isDirectory(),
    }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

/**
 * 本机目录浏览：返回绝对路径。
 * DSH 只提供目录选择器（没有原生文件选择器），所以外部文件是「选目录 → 再挑文件」。
 */
export async function browseExternal(path: string): Promise<FileEntry[]> {
  if (!isAbsolute(path)) throw new Error('本机目录需要绝对路径。');
  const directory = resolve(path);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(entry => !entry.isSymbolicLink() && !IGNORED_DIRECTORY_NAMES.includes(entry.name as typeof IGNORED_DIRECTORY_NAMES[number]))
    .map(entry => ({
      name: entry.name,
      path: resolve(directory, entry.name),
      directory: entry.isDirectory(),
    }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}
