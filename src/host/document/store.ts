import { readFile, stat } from 'node:fs/promises';
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
export async function uniqueDocumentPath(root: string, title: string): Promise<string> {
  const name = documentFileName(title);
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
  return readWorkspaceText(root, path);
}

export async function writeDocumentText(root: string, path: string, content: string): Promise<void> {
  await writeWorkspaceText(root, path, content);
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
    // 只解除登记，绝不删除磁盘上的 Markdown（实施文档 §30）。
    index.documents = index.documents.filter(item => item.id !== id);
    await writeDocumentIndex(root, index);
    return index;
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
export function saveDocument(root: string, input: { id: string; title?: string; content: string }): Promise<SavedDocument> {
  return serialize(root, async () => {
    const index = await readDocumentIndex(root);
    const existing = index.documents.find(item => item.id === input.id);
    const title = input.title?.trim() ?? existing?.title?.trim() ?? '';
    let path = existing?.path ?? null;
    const created = path === null;
    if (path === null) path = await uniqueDocumentPath(root, title);
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
