import editorCss from './document-editor.css?inline';
import { createMarkdownSurface } from './markdown-surface.js';
import type { DocumentsApi } from '../documents.js';
import {
  applyEdit,
  canAutosave,
  draftTitle,
  isUntitled,
  markError,
  markSaved,
  markSaving,
  openCurrentDocument,
  type DocumentDraft,
} from './document/store.js';

/**
 * 中栏 Document 编辑器（v0.2 实施文档 §15、§27–§32）。
 *
 * 复用既有实现里的编辑/保存能力：Milkdown Crepe 正文、脏标记、防抖自动保存、
 * Ctrl+S、外部修改检测、beforeunload 保护。
 * 变化的是持久化目标：从浏览器的本地文件句柄改成工作区内的 Markdown 文件，
 * 由 Host 的 Document Remote 落盘；Untitled Document 在首次保存时才创建文件。
 *
 * Diff（§36）到 Phase 8 再接；这里先只做正文编辑。
 */

export interface DocumentEditorOptions {
  readonly workspaceId: string;
  readonly api: DocumentsApi;
  /** 生成新 Document id；测试可注入。 */
  readonly newId?: () => string;
}

/** 每个工作区一份 Draft，切走再切回来时保留未保存的编辑。 */
const drafts = new Map<string, DocumentDraft>();
let unloadGuardInstalled = false;

function defaultNewId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `doc-${Math.random().toString(36).slice(2, 10)}`;
}

export function mountDocumentEditor(section: HTMLElement, options: DocumentEditorOptions): () => void {
  const { workspaceId, api } = options;
  const newId = options.newId ?? defaultNewId;
  if (!unloadGuardInstalled) {
    window.addEventListener('beforeunload', event => {
      if ([...drafts.values()].some(draft => draft.dirty || draft.saving)) { event.preventDefault(); event.returnValue = ''; }
    });
    unloadGuardInstalled = true;
  }

  const style = document.createElement('style');
  style.textContent = editorCss;
  const header = document.createElement('header');
  const title = document.createElement('input');
  title.type = 'text';
  title.dataset.siftDocumentTitle = '';
  title.placeholder = '未命名文档';
  title.setAttribute('aria-label', '文档标题');
  const status = document.createElement('small');
  status.setAttribute('role', 'status');
  const save = document.createElement('button');
  save.type = 'button';
  save.dataset.siftDocumentSave = '';
  save.textContent = '保存';
  const location = document.createElement('small');
  location.dataset.siftDocumentPath = '';
  header.append(title, status, save, location);
  const root = document.createElement('div');
  root.dataset.siftEditor = '';
  section.replaceChildren(style, header, root);

  let mounted = false;
  let disposed = false;
  let draft: DocumentDraft | undefined = drafts.get(workspaceId);
  /** 是否已登记在 .sift/documents.json 里（决定要不要做外部修改检测）。 */
  let registered = draft !== undefined && draft.path !== null;
  let editor: import('@milkdown/crepe').Crepe | undefined;
  let editorReady = false;
  let ready: Promise<void> = Promise.resolve();
  let busy = false;
  let inFlight: Promise<void> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const render = () => {
    if (disposed || !mounted) return;
    const current = draft;
    title.value = current?.title ?? '';
    title.disabled = busy;
    save.disabled = busy || current === undefined;
    save.hidden = current !== undefined && !isUntitled(current);
    status.textContent = current?.error
      ?? (current?.saving ? '保存中…'
        : current === undefined ? ''
          : isUntitled(current) ? (current.dirty ? '未保存' : '')
            : current.dirty ? '等待保存…' : '');
    status.hidden = !status.textContent;
    location.textContent = current === undefined ? '' : current.path ?? '尚未保存为文件';
    title.title = current === undefined ? '' : draftTitle(current);
  };

  const publish = (next: DocumentDraft) => { draft = next; drafts.set(workspaceId, next); render(); };

  const capture = () => {
    if (editorReady && editor && draft) publish(applyEdit(draft, editor.getMarkdown()));
  };

  const loadEditor = async () => {
    editorReady = false;
    const previous = editor;
    editor = undefined;
    await previous?.destroy();
    root.replaceChildren();
    if (!draft || disposed) return;
    editor = await createMarkdownSurface(root, draft.markdown, { onChange: () => {
      if (disposed || !editorReady || !draft) return;
      publish(applyEdit(draft, editor!.getMarkdown()));
      scheduleSave();
    } });
    if (disposed) return;
    editorReady = true;
    // 解析可能规范化 Markdown；仅仅是打开文件不该把它标记成 dirty。
    if (draft && !draft.dirty) publish({ ...draft, baseline: editor.getMarkdown() });
    root.querySelector('[contenteditable]')?.setAttribute('aria-label', 'Document Markdown 编辑器');
  };

  const initialize = () => {
    busy = true;
    editorReady = false;
    render();
    // 这个页面会话里已经打开过的 Document 直接复用内存草稿，避免丢掉未保存的编辑。
    const restoring = draft !== undefined;
    ready = (restoring
      ? Promise.resolve()
      : openCurrentDocument(api, workspaceId, newId).then(opened => {
        registered = opened.registered;
        publish(opened.draft);
      }))
      .then(() => loadEditor())
      .then(() => { busy = false; render(); scheduleSave(); }, error => {
        busy = false;
        render();
        if (!disposed) { status.hidden = false; status.textContent = `编辑器加载失败：${error instanceof Error ? error.message : String(error)}`; }
      });
  };

  const runSave = async (): Promise<void> => {
    const current = draft;
    if (!current) return;
    if (!current.dirty && !isUntitled(current)) { render(); return; }
    const saving = markSaving(current, true);
    publish(saving);
    try {
      // 已落盘的 Document 在写入前先确认磁盘没被别人改过。
      if (registered && saving.disk !== null) {
        const onDisk = await api.readDocumentContent({ workspaceId, documentId: saving.id });
        if (onDisk.content !== saving.disk) throw new Error('文件已被其他程序修改。请先复制当前改动备份，再重新打开文档。');
      }
      const content = saving.markdown;
      const result = await api.saveDocument({ workspaceId, documentId: saving.id, title: draftTitle(saving), content });
      registered = true;
      // 用「此刻」的正文算 dirty：保存期间继续输入的内容仍然算未保存。
      const latest = draft ?? saving;
      publish(markSaved({ ...latest, saving: true }, {
        content,
        path: result.document.path ?? saving.path ?? '',
        title: result.document.title ?? latest.title,
      }));
      if (draft && canAutosave(draft)) scheduleSave();
    } catch (error) {
      publish(markError(saving, `保存失败：${error instanceof Error ? error.message : String(error)}`));
    }
  };

  /** 串行化保存：一次只跑一个，后到的调用排队等前一个结束再评估。 */
  const saveNow = async (): Promise<void> => {
    clearTimeout(saveTimer);
    capture();
    if (inFlight) await inFlight.catch(() => {});
    if (disposed) return;
    const task = runSave();
    inFlight = task;
    try { await task; } finally { if (inFlight === task) inFlight = undefined; }
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    if (draft && canAutosave(draft)) saveTimer = setTimeout(() => { void saveNow(); }, 400);
  };

  title.addEventListener('input', () => {
    if (!draft) return;
    // 改标题也是未保存的改动；Untitled Document 借此提示需要显式保存。
    publish({ ...draft, title: title.value, dirty: draft.dirty || isUntitled(draft) });
    render();
  });
  save.addEventListener('click', () => { void saveNow(); });
  section.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveNow(); }
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    capture();
    if ([...drafts.values()].some(item => item.dirty || item.saving)) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);

  mounted = true;
  initialize();

  return () => {
    capture();
    clearTimeout(saveTimer);
    disposed = true;
    window.removeEventListener('beforeunload', beforeUnload);
    // 未保存的编辑保留在 drafts 里，切换工作区再回来仍然可见。
    void ready.then(() => editor?.destroy()).catch(error => console.error('Sift editor cleanup failed', error));
  };
}
