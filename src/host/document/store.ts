import { readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import {
  DOCUMENT_DIRECTORY,
  documentFileName,
  documentIndexSchema,
  emptyDocumentIndex,
  type DocumentIndex,
  type SiftDocument,
} from '../../documents.js';
import {
  isMissingFile,
  metadataFile,
  readWorkspaceText,
  resolveInsideWorkspace,
  serialize,
  writeTextAtomic,
  writeWorkspaceText,
  unusedFileName,
} from '../storage/workspace-files.js';

/**
 * Document 的宿主侧存储：`.sift/documents.json` 登记表 + 工作区内的 Markdown 文件。
 * 底层写入与路径校验见 `host/storage/workspace-files.ts`。
 */

export { resolveInsideWorkspace };

async function indexFile(root: string): Promise<string> {
  return metadataFile(root, 'documents.json');
}

export async function readDocumentIndex(root: string): Promise<DocumentIndex> {
  const path = await indexFile(root);
  try {
    return documentIndexSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (isMissingFile(error)) return emptyDocumentIndex();
    // 损坏的登记表不静默覆盖：抛错让上层提示用户。
    throw new Error(`Document 登记表无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeDocumentIndex(root: string, index: DocumentIndex): Promise<void> {
  await writeTextAtomic(await indexFile(root), `${JSON.stringify(index, null, 2)}\n`);
}

/** 为一个标题找一个尚未占用的工作区相对路径。 */
export async function uniqueDocumentPath(root: string, title: string, targetDirectory?: string): Promise<string> {
  const name = documentFileName(title);
  if (targetDirectory !== undefined) {
    if (!isAbsolute(targetDirectory)) throw new Error('自定义保存目录必须是绝对路径。');
    const directory = resolve(targetDirectory);
    return resolve(directory, await unusedFileName(directory, name));
  }
  const stem = name.slice(0, -3);
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = `${DOCUMENT_DIRECTORY}/${attempt === 1 ? stem : `${stem} ${attempt}`}.md`;
    try {
      await stat(resolveInsideWorkspace(root, candidate));
    } catch (error) {
      if (isMissingFile(error)) return candidate;
      throw error;
    }
  }
  throw new Error('同名文档过多，请换一个标题。');
}

export async function readDocumentText(root: string, path: string): Promise<string> {
  return isAbsolute(path) ? readFile(resolve(path), 'utf8') : readWorkspaceText(root, path);
}

export async function writeDocumentText(root: string, path: string, content: string): Promise<void> {
  if (isAbsolute(path)) await writeTextAtomic(resolve(path), content);
  else await writeWorkspaceText(root, path, content);
}

export function upsertDocument(root: string, document: SiftDocument): Promise<DocumentIndex> {
  return serialize(root, async () => {
    const index = await readDocumentIndex(root);
    const position = index.documents.findIndex(item => item.id === document.id);
    if (position === -1) index.documents.push(document);
    else index.documents[position] = document;
    await writeDocumentIndex(root, index);
    return index;
  });
}

export function removeDocument(root: string, id: string): Promise<DocumentIndex> {
  return serialize(root, async () => {
    const index = await readDocumentIndex(root);
    const document = index.documents.find(item => item.id === id);
    if (document?.path) await rm(isAbsolute(document.path) ? document.path : resolveInsideWorkspace(root, document.path), { force: true });
    index.documents = index.documents.filter(item => item.id !== id);
    await writeDocumentIndex(root, index);
    return index;
  });
}

/** 只从工作区登记表移除，绝不删除对应的 Markdown 文件。 */
export function detachDocument(root: string, id: string): Promise<DocumentIndex> {
  return serialize(root, async () => {
    const index = await readDocumentIndex(root);
    index.documents = index.documents.filter(item => item.id !== id);
    await writeDocumentIndex(root, index);
    return index;
  });
}

export function addExistingDocument(root: string, input: { id: string; path: string }): Promise<{ index: DocumentIndex; document: SiftDocument; added: boolean }> {
  return serialize(root, async () => {
    if (!isAbsolute(input.path)) throw new Error('已有产出必须使用绝对路径。');
    const path = resolve(input.path);
    if (extname(path).toLowerCase() !== '.md') throw new Error('只能添加 Markdown（.md）文件。');
    const info = await stat(path);
    if (!info.isFile()) throw new Error('选择的产出不是普通文件。');
    const index = await readDocumentIndex(root);
    const existing = index.documents.find(item => item.path
      && (isAbsolute(item.path) ? resolve(item.path) : resolve(root, item.path)) === path);
    if (existing) return { index, document: existing, added: false };
    const document: SiftDocument = { id: input.id, path, title: basename(path) };
    index.documents.push(document);
    await writeDocumentIndex(root, index);
    return { index, document, added: true };
  });
}

export interface SavedDocument {
  readonly index: DocumentIndex;
  readonly document: SiftDocument;
  readonly created: boolean;
}

/**
 * 保存一次 Document 正文。
 * `path` 为 null 的记录（Untitled Document）在这里首次落盘（实施文档 §28）。
 */
export function saveDocument(root: string, input: { id: string; title?: string; content: string; targetDirectory?: string }): Promise<SavedDocument> {
  return serialize(root, async () => {
    const index = await readDocumentIndex(root);
    const existing = index.documents.find(item => item.id === input.id);
    const title = input.title?.trim() ?? existing?.title?.trim() ?? '';
    let path = existing?.path ?? null;
    const created = path === null;
    if (path === null) path = await uniqueDocumentPath(root, title, input.targetDirectory);
    const document: SiftDocument = {
      id: input.id,
      path,
      ...(title === '' ? {} : { title }),
    };
    await writeDocumentText(root, path, input.content);
    const position = index.documents.findIndex(item => item.id === input.id);
    if (position === -1) index.documents.push(document);
    else index.documents[position] = document;
    await writeDocumentIndex(root, index);
    return { index, document, created };
  });
}
