import { z } from 'zod';

/**
 * Document 的共享模型（v0.2 实施文档 §27）。
 *
 * Document 的正文始终是普通 Markdown 文件；Sift 只在 `.sift/documents.json`
 * 里登记「哪些文件是 Document」。`path` 为 null 表示尚未落盘的 Untitled Document。
 */

export const UNTITLED_DOCUMENT_TITLE = '未命名文档';

/** Document 默认落在工作区的哪个目录下。 */
export const DOCUMENT_DIRECTORY = 'notes';

export const siftDocumentSchema = z.object({
  id: z.string(),
  path: z.string().nullable(),
  title: z.string().optional(),
});
export type SiftDocument = z.infer<typeof siftDocumentSchema>;

export const documentIndexSchema = z.object({
  schemaVersion: z.literal(1),
  documents: z.array(siftDocumentSchema),
});
export type DocumentIndex = z.infer<typeof documentIndexSchema>;

export function emptyDocumentIndex(): DocumentIndex {
  return { schemaVersion: 1, documents: [] };
}

/**
 * 由标题推导 Markdown 文件名。
 * 去掉 Windows 不允许的字符并折叠空白；结果始终以 `.md` 结尾。
 */
export function documentFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    // 非法字符替换成空格后可能留下「名字 .md」这种多余空格。
    .replace(/\s+\./g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  const base = cleaned === '' ? UNTITLED_DOCUMENT_TITLE : cleaned;
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

/** Untitled Document 的相对路径（首次保存时使用）。 */
export function documentRelativePath(title: string): string {
  return `${DOCUMENT_DIRECTORY}/${documentFileName(title)}`;
}

export interface DocumentsApi {
  listDocuments(input: { workspaceId: string }): Promise<DocumentIndex>;
  /** 首次保存（path 为 null）时由 Host 分配路径；之后写回同一路径。 */
  saveDocument(input: { workspaceId: string; documentId: string; title?: string; content: string }): Promise<{ index: DocumentIndex; document: SiftDocument; created: boolean }>;
  readDocumentContent(input: { workspaceId: string; documentId: string }): Promise<{ content: string; path: string }>;
  removeDocument(input: { workspaceId: string; documentId: string }): Promise<DocumentIndex>;
}
