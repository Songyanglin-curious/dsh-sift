import documentEditorCss from './document-editor.css?inline';
import { DOCUMENT_DIRECTORY, type DocumentsApi, type SiftDocument } from '../documents.js';
import { mountMarkdownView } from './markdown-view.js';
import { installSelectionCapture, type ThoughtFeature } from './thoughts/index.js';
import type { WorkspaceController } from './workspace-controller.js';
import { setIcon } from './icons.js';

export interface DocumentEditorOptions {
  readonly workspaceId: string;
  readonly api: DocumentsApi;
  readonly newId?: () => string;
  readonly pickDirectory?: () => Promise<string | null>;
  readonly pickOutputFiles?: () => Promise<{ paths: readonly string[]; cancelled: boolean; message?: string }>;
  readonly confirmDelete?: (name: string) => boolean;
  readonly workspace?: WorkspaceController;
  readonly thoughts?: ThoughtFeature;
  readonly editRelations?: () => void | Promise<void>;
  readonly openDocumentPath?: (path: string) => Promise<void>;
  readonly setActiveDocument?: (documentId?: string) => Promise<void>;
}

const titleOf = (item: SiftDocument) => item.title?.trim() || (item.path ? item.path.split(/[\\/]/).at(-1)! : '未命名文档');
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `document-${Date.now()}`;

/** Document 中栏只负责阅读与同步；正式人工编辑交给外部编辑器。 */
export function mountDocumentEditor(section: HTMLElement, options: DocumentEditorOptions): () => void {
  const { workspaceId, api } = options;
  const style = document.createElement('style'); style.textContent = documentEditorCss;
  const tabBar = document.createElement('div'); tabBar.dataset.siftOutputTabs = '';
  const status = document.createElement('small'); status.dataset.siftOutputStatus = ''; status.setAttribute('role', 'status');
  const root = document.createElement('div'); root.dataset.siftEditor = ''; root.dataset.siftMarkdownView = '';
  const empty = document.createElement('div'); empty.dataset.siftOutputEmpty = '';
  const emptyTitle = document.createElement('strong'); emptyTitle.textContent = '暂无打开的产出';
  const emptyHint = document.createElement('span'); emptyHint.textContent = '点击右上角 ＋ 新建 Markdown'; empty.append(emptyTitle, emptyHint);
  const dialog = document.createElement('div'); dialog.dataset.siftOutputCreateDialog = ''; dialog.hidden = true;
  const form = document.createElement('form'); form.dataset.siftOutputCreateForm = '';
  const heading = document.createElement('strong'); heading.textContent = '新建产出';
  const label = document.createElement('label'); label.textContent = '文件名';
  const input = document.createElement('input'); input.setAttribute('aria-label', '产出文件名'); input.placeholder = '例如：设计说明.md'; label.append(input);
  const location = document.createElement('small'); location.dataset.siftOutputCreateLocation = '';
  const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = '选择目录…';
  const createError = document.createElement('small'); createError.dataset.siftOutputCreateError = ''; createError.hidden = true;
  const actions = document.createElement('div');
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '创建';
  actions.append(cancel, submit); form.append(heading, label, location, choose, createError, actions); dialog.append(form);
  section.replaceChildren(style, tabBar, root, empty, dialog);

  let documents: SiftDocument[] = [];
  let activeId: string | undefined;
  let activeContent = '';
  let activePath: string | undefined;
  let disposeMarkdown: (() => void) | undefined;
  let disposed = false;
  let busy = false;
  let targetDirectory: string | undefined;
  let lastLoadedContent: string | undefined;
  let syncing = false;

  const active = () => documents.find(item => item.id === activeId);
  const setStatus = (text = '', error = false) => {
    status.textContent = text; status.hidden = text === ''; status.toggleAttribute('data-error', error);
  };
  const showMarkdown = (content: string) => {
    disposeMarkdown?.(); root.replaceChildren(); activeContent = content;
    disposeMarkdown = mountMarkdownView(root, content);
  };
  const sync = async (announce = true) => {
    const current = active(); if (!current || syncing) return;
    syncing = true; if (announce) setStatus('同步中…');
    try {
      const result = await api.readDocumentContent({ workspaceId, documentId: current.id });
      activePath = result.path;
      if (result.content !== lastLoadedContent) showMarkdown(result.content);
      lastLoadedContent = result.content; if (announce) setStatus('已同步'); render();
    } catch (error) { setStatus(`同步失败：${error instanceof Error ? error.message : String(error)}`, true); }
    finally { syncing = false; }
  };
  const activate = async (id?: string) => {
    activeId = id; options.workspace?.setOutputTabs(documents.map(item => item.id));
    await options.workspace?.setActiveOutput(id); await options.setActiveDocument?.(id);
    activePath = undefined; lastLoadedContent = undefined; render();
    if (id) await sync(false);
  };
  const iconButton = (dataName: string, title: string, icon?: 'plus' | 'list-plus' | 'pencil' | 'close' | 'trash') => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sift-icon-button';
    button.dataset[dataName] = ''; button.title = title; button.setAttribute('aria-label', title); button.disabled = busy || activeId === undefined;
    if (icon) setIcon(button, icon); return button;
  };
  const render = () => {
    if (disposed) return; tabBar.replaceChildren();
    for (const item of documents) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'sift-output-tab'; button.textContent = titleOf(item);
      button.title = `${titleOf(item)}（双击修改显示标题）`; if (item.id === activeId) button.dataset.active = '';
      button.addEventListener('click', () => { void activate(item.id); }); button.addEventListener('dblclick', () => { void rename(item); }); tabBar.append(button);
    }
    const spacer = document.createElement('span'); spacer.className = 'sift-output-tab-spacer'; tabBar.append(spacer, status);
    const addExisting = iconButton('siftOutputAddExisting', '添加已有产出', 'list-plus'); addExisting.disabled = busy; addExisting.addEventListener('click', () => { void addExistingFiles(); }); tabBar.append(addExisting);
    const syncButton = iconButton('siftOutputSync', '从磁盘同步当前产出'); syncButton.textContent = '↻'; syncButton.addEventListener('click', () => { void sync(true); }); tabBar.append(syncButton);
    const openButton = iconButton('siftOutputOpenExternal', '用外部编辑器打开当前产出'); openButton.textContent = '↗'; openButton.disabled ||= !activePath || !options.openDocumentPath;
    openButton.addEventListener('click', () => { if (activePath) void options.openDocumentPath?.(activePath).catch(error => setStatus(`打开失败：${String(error)}`, true)); }); tabBar.append(openButton);
    const relations = iconButton('siftOutputEditRelations', '编辑关联参考', 'pencil'); relations.disabled ||= !options.editRelations;
    relations.addEventListener('click', () => { void Promise.resolve(options.editRelations?.()).catch(error => setStatus(`读取参考失败：${String(error)}`, true)); }); tabBar.append(relations);
    const detach = iconButton('siftOutputDetach', '从工作区移除当前产出（保留文件）', 'close'); detach.addEventListener('click', () => { void removeActive(false); }); tabBar.append(detach);
    const remove = iconButton('siftOutputDelete', '删除当前产出', 'trash'); remove.classList.add('sift-output-delete'); remove.addEventListener('click', () => { void removeActive(true); }); tabBar.append(remove);
    const add = iconButton('siftOutputAdd', '新建产出', 'plus'); add.disabled = busy; add.addEventListener('click', openCreate); tabBar.append(add);
    root.hidden = activeId === undefined; empty.hidden = activeId !== undefined;
  };
  const openCreate = () => {
    input.value = ''; targetDirectory = undefined; createError.hidden = true; location.textContent = `保存位置：当前 Workspace/${DOCUMENT_DIRECTORY}/`;
    dialog.hidden = false; queueMicrotask(() => input.focus());
  };
  const closeCreate = () => { dialog.hidden = true; };
  cancel.addEventListener('click', closeCreate);
  choose.addEventListener('click', () => { void options.pickDirectory?.().then(path => { if (path) { targetDirectory = path; location.textContent = `保存位置：${path}`; } }); });
  form.addEventListener('submit', event => { event.preventDefault(); void createDocument(); });
  const createDocument = async () => {
    const title = input.value.trim(); if (!title) { createError.textContent = '请输入文件名。'; createError.hidden = false; return; }
    busy = true; render();
    try {
      const id = (options.newId ?? randomId)();
      const result = await api.saveDocument({ workspaceId, documentId: id, title, content: '', ...(targetDirectory ? { targetDirectory } : {}) });
      documents.push(result.document); await options.workspace?.initializeOutput(id, options.workspace.visibleReferences(), false); closeCreate(); await activate(id);
    } catch (error) { createError.textContent = `创建失败：${String(error)}`; createError.hidden = false; }
    finally { busy = false; render(); }
  };
  const addExistingFiles = async () => {
    if (!options.pickOutputFiles) return; busy = true; render();
    try {
      const picked = await options.pickOutputFiles(); if (picked.cancelled) return; let last: string | undefined;
      for (const path of picked.paths) {
        const result = await api.addExistingDocument({ workspaceId, documentId: (options.newId ?? randomId)(), path });
        if (!documents.some(item => item.id === result.document.id)) documents.push(result.document);
        await options.workspace?.initializeOutput(result.document.id, options.workspace.visibleReferences(), true); last = result.document.id;
      }
      if (last) await activate(last);
    } catch (error) { setStatus(`添加失败：${String(error)}`, true); }
    finally { busy = false; render(); }
  };
  const rename = async (item: SiftDocument) => {
    const title = window.prompt('修改显示标题', titleOf(item))?.trim(); if (!title || title === titleOf(item)) return;
    try {
      const content = item.id === activeId ? activeContent : (await api.readDocumentContent({ workspaceId, documentId: item.id })).content;
      const result = await api.saveDocument({ workspaceId, documentId: item.id, title, content });
      documents = documents.map(candidate => candidate.id === item.id ? result.document : candidate); render();
    } catch (error) { setStatus(`重命名失败：${String(error)}`, true); }
  };
  const removeActive = async (deleting: boolean) => {
    const current = active(); if (!current) return;
    if (deleting && !(options.confirmDelete ?? (name => window.confirm(`永久删除“${name}”及其 Markdown 文件？`)))(titleOf(current))) return;
    busy = true; render();
    try {
      if (deleting) await api.removeDocument({ workspaceId, documentId: current.id }); else await api.detachDocument({ workspaceId, documentId: current.id });
      const position = documents.findIndex(item => item.id === current.id); documents.splice(position, 1); await activate(documents[position]?.id ?? documents[position - 1]?.id);
    } catch (error) { setStatus(`${deleting ? '删除' : '移除'}失败：${String(error)}`, true); }
    finally { busy = false; render(); }
  };
  const focusSync = () => { if (!document.hidden && activeId) void sync(false); };
  window.addEventListener('focus', focusSync); document.addEventListener('visibilitychange', focusSync);
  const syncTimer = window.setInterval(focusSync, 2000);
  const disposeSelection = options.thoughts ? installSelectionCapture(root, 'output', () => active() ? { sourceId: active()!.id, sourceName: titleOf(active()!) } : undefined, options.thoughts.capture) : undefined;
  void api.listDocuments({ workspaceId }).then(async index => { if (!disposed) { documents = [...index.documents]; await activate(documents[0]?.id); } }, error => setStatus(`读取 Document 失败：${String(error)}`, true));
  return () => {
    disposed = true; disposeMarkdown?.(); disposeSelection?.(); window.clearInterval(syncTimer); window.removeEventListener('focus', focusSync); document.removeEventListener('visibilitychange', focusSync); void options.setActiveDocument?.(undefined);
  };
}
