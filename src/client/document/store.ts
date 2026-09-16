import type { SiftDocument, DocumentsApi } from '../../documents.js';
import { UNTITLED_DOCUMENT_TITLE } from '../../documents.js';

/**
 * 客户端 Document 状态（v0.2 实施文档 §27–§29）。
 *
 * 真正的编辑行为在 document/editor.ts；这里只放可单独测试的状态规则，
 * 避免把「什么时候该保存」「什么时候算干净」混进 DOM 代码。
 */

export interface DocumentDraft {
  readonly id: string;
  /** null 表示尚未落盘的 Untitled Document。 */
  path: string | null;
  title: string;
  /** 编辑器里的当前正文。 */
  markdown: string;
  /** 上一次成功保存（或刚打开）时的正文，用于判断是否 dirty。 */
  baseline: string;
  /** 上一次在磁盘上看到的正文，用于检测外部修改。 */
  disk: string | null;
  dirty: boolean;
  saving: boolean;
  error?: string;
}

/** 新建一个还没落盘的 Draft。 */
export function createDraft(id: string, title = '', markdown = ''): DocumentDraft {
  return { id, path: null, title, markdown, baseline: markdown, disk: null, dirty: false, saving: false };
}

export function isUntitled(draft: DocumentDraft): boolean {
  return draft.path === null;
}

/** 显示标题：没有标题的 Untitled Document 用占位名。 */
export function draftTitle(draft: DocumentDraft): string {
  const title = draft.title.trim();
  if (title !== '') return title;
  return draft.path === null ? UNTITLED_DOCUMENT_TITLE : draft.path.split('/').at(-1) ?? UNTITLED_DOCUMENT_TITLE;
}

/**
 * 未落盘的 Document 不自动保存：第一次落盘必须是一次显式保存
 * （实施文档 §28「首次保存时再创建 Markdown」）。
 */
export function canAutosave(draft: DocumentDraft): boolean {
  return !isUntitled(draft) && draft.dirty;
}

/** 保存成功后更新基线；正文在保存期间又被改过时保持 dirty。 */
export function markSaved(draft: DocumentDraft, saved: { content: string; path: string; title?: string }): DocumentDraft {
  return {
    ...draft,
    path: saved.path,
    ...(saved.title === undefined ? {} : { title: saved.title }),
    disk: saved.content,
    baseline: saved.content,
    dirty: draft.markdown !== saved.content,
    saving: false,
    error: undefined,
  };
}

/** 正文变化后重新计算 dirty。 */
export function applyEdit(draft: DocumentDraft, markdown: string): DocumentDraft {
  return { ...draft, markdown, dirty: markdown !== draft.baseline };
}

export function markSaving(draft: DocumentDraft, saving: boolean): DocumentDraft {
  return { ...draft, saving };
}

export function markError(draft: DocumentDraft, error: string): DocumentDraft {
  return { ...draft, saving: false, error };
}

export interface OpenDocument {
  readonly draft: DocumentDraft;
  /** 这份记录是否已经登记在 .sift/documents.json 里。 */
  readonly registered: boolean;
}

/**
 * 打开一个工作区的当前 Document。
 *
 * Phase 1 只取登记表里的第一份；切换 Document 是 Phase 4 的事。
 * 登记表为空时返回一个全新的 Untitled Document（不写磁盘）。
 */
export async function openCurrentDocument(api: DocumentsApi, workspaceId: string, newId: () => string): Promise<OpenDocument> {
  const index = await api.listDocuments({ workspaceId });
  const first = index.documents[0];
  if (!first) return { draft: createDraft(newId()), registered: false };
  if (first.path === null) {
    // 登记表里理论不会有 path 为 null 的记录；真出现时按未落盘处理，不猜文件。
    return { draft: createDraft(first.id, first.title ?? ''), registered: false };
  }
  const { content, path } = await api.readDocumentContent({ workspaceId, documentId: first.id });
  return {
    draft: { id: first.id, path, title: first.title ?? '', markdown: content, baseline: content, disk: content, dirty: false, saving: false },
    registered: true,
  };
}

export type { SiftDocument };
