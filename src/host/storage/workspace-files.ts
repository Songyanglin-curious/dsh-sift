import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 工作区文件与 `.sift` 数据的共享底层（v0.2 实施文档 §39）。
 *
 * 这些模式原本只存在于 `host/materials.ts`，现在抽出来给 Document 与 Source 共用：
 * 按工作区串行写入、临时文件 + rename 原子替换、路径越界拒绝。
 */

const queues = new Map<string, Promise<unknown>>();

/** 按工作区串行执行写入，避免并发保存互相覆盖。 */
export function serialize<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function resolveWithin(root: string, path: string, allowRoot: boolean): string {
  if (path.trim() === '') throw new Error('文件路径不能为空。');
  const base = resolve(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  // rel === '' 表示目标就是工作区根目录：文件操作要拒绝，目录浏览要允许。
  const escapes = isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || (rel === '' && !allowRoot);
  if (escapes) throw new Error('只能访问当前工作区内的文件。');
  return target;
}

/**
 * 把工作区内的相对路径解析成绝对路径，并拒绝越界。
 * 不要求目标已存在：首次保存要创建新文件，因此不能用 realpath 校验。
 */
export function resolveInsideWorkspace(root: string, relativePath: string): string {
  return resolveWithin(root, relativePath, false);
}

/** 与 `resolveInsideWorkspace` 相同，但允许路径落在工作区根目录（用于目录浏览）。 */
export function resolveWorkspaceDirectory(root: string, relativePath: string): string {
  return resolveWithin(root, relativePath, true);
}

/** 原子写文本：先写同目录临时文件，再 rename 替换。 */
export async function writeTextAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function readWorkspaceText(root: string, path: string): Promise<string> {
  return readFile(resolveInsideWorkspace(root, path), 'utf8');
}

export async function writeWorkspaceText(root: string, path: string, content: string): Promise<void> {
  await writeTextAtomic(resolveInsideWorkspace(root, path), content);
}

/** `.sift` 下的数据文件路径；顺带保证目录存在。 */
export async function metadataFile(root: string, name: string): Promise<string> {
  const directory = resolve(root, '.sift');
  await mkdir(directory, { recursive: true });
  return resolve(directory, name);
}

/** 浏览目录时跳过的名字：版本库、Sift 自己的数据、依赖目录。 */
export const IGNORED_DIRECTORY_NAMES = ['.git', '.sift', 'node_modules'] as const;

/**
 * 在给定目录（工作区相对或绝对）里找一个不冲突的名字。
 * `desired` 是完整文件名，例如 `粘贴笔记.md`。
 */
export async function unusedFileName(directory: string, desired: string): Promise<string> {
  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const extension = dot > 0 ? desired.slice(dot) : '';
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const name = `${attempt === 1 ? stem : `${stem} ${attempt}`}${extension}`;
    try {
      await stat(resolve(directory, name));
    } catch (error) {
      if (isMissingFile(error)) return name;
      throw error;
    }
  }
  throw new Error('同名文件过多，请换一个名字。');
}
