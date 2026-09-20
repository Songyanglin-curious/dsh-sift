import editorCss from './document-editor.css?inline';
import { setIcon } from './icons.js';
import { createMarkdownSurface } from './markdown-surface.js';
import { DOCUMENT_DIRECTORY, type DocumentsApi } from '../documents.js';
import type { WorkspaceController } from './workspace-controller.js';
import {
  applyEdit,
  canAutosave,
  createDraft,
  draftTitle,
  isUntitled,
  markError,
  markSaved,
  markSaving,
  openWorkspaceDocuments,
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
  /** 选择任意本机保存目录；取消时返回 null。 */
  readonly pickDirectory?: () => Promise<string | null>;
  /** 选择要加入当前工作区的已有 Markdown 文件。 */
  readonly pickOutputFiles?: () => Promise<{ paths: readonly string[]; cancelled: boolean; message?: string }>;
  /** 测试可注入；默认使用浏览器确认框。 */
  readonly confirmDelete?: (name: string) => boolean;
  readonly workspace?: WorkspaceController;
  readonly editRelations?: () => void | Promise<void>;
}

interface WorkspaceDocumentSession {
  readonly drafts: Map<string, DocumentDraft>;
  readonly registeredIds: Set<string>;
  readonly tabIds: string[];
  activeId?: string;
  createDirectory?: string;
}

/** 每个工作区一份多 Output 会话，切走再切回来时保留全部未保存编辑。 */
const sessions = new Map<string, WorkspaceDocumentSession>();
let unloadGuardInstalled = false;

function allDrafts(): DocumentDraft[] {
  return [...sessions.values()].flatMap(session => [...session.drafts.values()]);
}

function defaultNewId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `doc-${Math.random().toString(36).slice(2, 10)}`;
}

export function mountDocumentEditor(section: HTMLElement, options: DocumentEditorOptions): () => void {
  const { workspaceId, api } = options;
  const newId = options.newId ?? defaultNewId;
  if (!unloadGuardInstalled) {
    window.addEventListener('beforeunload', event => {
      if (allDrafts().some(draft => draft.dirty || draft.saving)) { event.preventDefault(); event.returnValue = ''; }
    });
    unloadGuardInstalled = true;
  }

  const style = document.createElement('style');
  style.textContent = editorCss;
  const tabBar = document.createElement('div');
  tabBar.dataset.siftOutputTabs = '';
  const status = document.createElement('small');
  status.setAttribute('role', 'status');
  status.dataset.siftOutputStatus = '';
  const root = document.createElement('div');
  root.dataset.siftEditor = '';
  const emptyState = document.createElement('div');
  emptyState.dataset.siftOutputEmpty = '';
  const emptyTitle = document.createElement('strong');
  emptyTitle.textContent = '暂无打开的产出';
  const emptyHint = document.createElement('span');
  emptyHint.textContent = '点击右上角 ＋ 新建 Markdown';
  emptyState.append(emptyTitle, emptyHint);

  const createDialog = document.createElement('div');
  createDialog.dataset.siftOutputCreateDialog = '';
  createDialog.hidden = true;
  const createForm = document.createElement('form');
  createForm.dataset.siftOutputCreateForm = '';
  const createHeading = document.createElement('strong');
  createHeading.textContent = '新建产出';
  const createLabel = document.createElement('label');
  createLabel.textContent = '文件名';
  const createInput = document.createElement('input');
  createInput.type = 'text';
  createInput.placeholder = '例如：设计说明.md';
  createInput.setAttribute('aria-label', '产出文件名');
  createLabel.append(createInput);
  const createLocation = document.createElement('small');
  createLocation.dataset.siftOutputCreateLocation = '';
  const chooseDirectory = document.createElement('button');
  chooseDirectory.type = 'button';
  chooseDirectory.textContent = '选择目录…';
  const createError = document.createElement('small');
  createError.dataset.siftOutputCreateError = '';
  createError.hidden = true;
  const createActions = document.createElement('div');
  const createCancel = document.createElement('button');
  createCancel.type = 'button';
  createCancel.textContent = '取消';
  const createSubmit = document.createElement('button');
  createSubmit.type = 'submit';
  createSubmit.textContent = '创建';
  createActions.append(createCancel, createSubmit);
  createForm.append(createHeading, createLabel, createLocation, chooseDirectory, createError, createActions);
  createDialog.append(createForm);
  section.replaceChildren(style, tabBar, root, emptyState, createDialog);

  let mounted = false;
  let disposed = false;
  let session = sessions.get(workspaceId);
  let draft = session?.activeId === undefined ? undefined : session.drafts.get(session.activeId);
  let editor: import('@milkdown/crepe').Crepe | undefined;
  let editorReady = false;
  let ready: Promise<void> = Promise.resolve();
  let busy = false;
  let inFlight: Promise<void> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let renamingId: string | undefined;
  let panelError: string | undefined;

  const renderTabs = () => {
    tabBar.replaceChildren();
    if (session) {
      for (const id of session.tabIds) {
        const item = session.drafts.get(id);
        if (!item) continue;
        if (renamingId === id) {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'sift-output-tab-rename';
          input.dataset.outputId = id;
          input.value = item.title;
          input.placeholder = '未命名文档';
          input.setAttribute('aria-label', '产出标题');
          let finished = false;
          const finish = (commit: boolean) => {
            if (finished) return;
            finished = true;
            renamingId = undefined;
            if (commit) commitRename(id, input.value);
            else render();
          };
          input.addEventListener('blur', () => finish(true));
          input.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key === 'Enter') { event.preventDefault(); finish(true); }
            if (event.key === 'Escape') { event.preventDefault(); finish(false); }
          });
          tabBar.appendChild(input);
          queueMicrotask(() => { input.focus(); input.select(); });
        } else {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'sift-output-tab';
          button.dataset.outputId = id;
          if (id === session.activeId) button.dataset.active = '';
          button.title = `${draftTitle(item)}（双击修改标题）`;
          button.textContent = `${draftTitle(item)}${item.dirty ? ' •' : ''}`;
          button.addEventListener('click', () => { void activateDocument(id); });
          button.addEventListener('dblclick', () => { void beginRename(id); });
          tabBar.appendChild(button);
        }
      }
    }
    const spacer = document.createElement('span');
    spacer.className = 'sift-output-tab-spacer';
    tabBar.appendChild(spacer);
    tabBar.appendChild(status);
    const addExisting = document.createElement('button');
    addExisting.type = 'button';
    addExisting.className = 'sift-icon-button';
    addExisting.dataset.siftOutputAddExisting = '';
    addExisting.title = '添加已有产出';
    addExisting.setAttribute('aria-label', '添加已有产出');
    addExisting.disabled = busy;
    setIcon(addExisting, 'list-plus');
    addExisting.addEventListener('click', () => { void addExistingOutputs(); });
    tabBar.appendChild(addExisting);
    const editRelations = document.createElement('button');
    editRelations.type = 'button';
    editRelations.className = 'sift-icon-button';
    editRelations.dataset.siftOutputEditRelations = '';
    editRelations.title = '编辑关联参考';
    editRelations.setAttribute('aria-label', '编辑关联参考');
    editRelations.disabled = busy || draft === undefined || !options.editRelations;
    setIcon(editRelations, 'pencil');
    editRelations.addEventListener('click', () => {
      void Promise.resolve(options.editRelations?.()).catch(error => {
        panelError = `读取参考失败：${error instanceof Error ? error.message : String(error)}`;
        render();
      });
    });
    tabBar.appendChild(editRelations);
    const detach = document.createElement('button');
    detach.type = 'button';
    detach.className = 'sift-icon-button';
    detach.dataset.siftOutputDetach = '';
    detach.title = '从工作区移除当前产出（保留文件）';
    detach.setAttribute('aria-label', '移除当前产出');
    detach.disabled = busy || draft === undefined;
    setIcon(detach, 'close');
    detach.addEventListener('click', () => { void detachActiveOutput(); });
    tabBar.appendChild(detach);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sift-icon-button sift-output-delete';
    remove.dataset.siftOutputDelete = '';
    remove.title = '删除当前产出';
    remove.setAttribute('aria-label', '删除当前产出');
    remove.disabled = busy || draft === undefined;
    setIcon(remove, 'trash');
    remove.addEventListener('click', () => { void deleteActiveOutput(); });
    tabBar.appendChild(remove);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'sift-icon-button';
    add.dataset.siftOutputAdd = '';
    add.title = '新建产出';
    add.setAttribute('aria-label', '新建产出');
    add.disabled = busy;
    setIcon(add, 'plus');
    add.addEventListener('click', () => { openCreateDialog(); });
    tabBar.appendChild(add);
  };

  const render = () => {
    if (disposed || !mounted) return;
    const current = draft;
    status.textContent = panelError ?? current?.error
      ?? (current?.saving ? '保存中…' : '');
    status.hidden = !status.textContent;
    status.toggleAttribute('data-error', panelError !== undefined || current?.error !== undefined);
    root.hidden = current === undefined;
    emptyState.hidden = current !== undefined;
    renderTabs();
  };

  const publish = (next: DocumentDraft) => {
    draft = next;
    session?.drafts.set(next.id, next);
    render();
  };

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
    // 这个页面会话里已经打开过的 Outputs 直接复用内存草稿，避免丢掉未保存的编辑。
    const restoring = session !== undefined;
    ready = (restoring
      ? Promise.resolve()
      : openWorkspaceDocuments(api, workspaceId, newId).then(opened => {
        session = {
          drafts: new Map(opened.map(item => [item.draft.id, item.draft])),
          registeredIds: new Set(opened.filter(item => item.registered).map(item => item.draft.id)),
          tabIds: opened.map(item => item.draft.id),
          activeId: opened[0]?.draft.id,
        };
        sessions.set(workspaceId, session);
        draft = session.activeId === undefined ? undefined : session.drafts.get(session.activeId);
        options.workspace?.setOutputTabs(session.tabIds);
      }))
      .then(async () => {
        options.workspace?.setOutputTabs(session?.tabIds ?? []);
        await options.workspace?.setActiveOutput(session?.activeId);
        await loadEditor();
      })
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
      if (session?.registeredIds.has(saving.id) && saving.disk !== null) {
        const onDisk = await api.readDocumentContent({ workspaceId, documentId: saving.id });
        if (onDisk.content !== saving.disk) throw new Error('文件已被其他程序修改。请先复制当前改动备份，再重新打开文档。');
      }
      const content = saving.markdown;
      const result = await api.saveDocument({ workspaceId, documentId: saving.id, title: draftTitle(saving), content });
      session?.registeredIds.add(saving.id);
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

  const commitRename = (id: string, value: string): void => {
    if (!session) return;
    const current = session.drafts.get(id);
    if (!current) return;
    const title = value.trim();
    const next = { ...current, title, dirty: current.dirty || title !== current.title || isUntitled(current) };
    session.drafts.set(id, next);
    if (session.activeId === id) {
      draft = next;
      render();
      scheduleSave();
    } else {
      renderTabs();
    }
  };

  const beginRename = async (id: string): Promise<void> => {
    if (!session || busy) return;
    if (session.activeId !== id) await activateDocument(id);
    if (disposed || busy) return;
    renamingId = id;
    render();
  };

  const activateDocument = async (id: string): Promise<void> => {
    if (!session || session.activeId === id || busy) return;
    capture();
    clearTimeout(saveTimer);
    if (draft && canAutosave(draft)) await saveNow();
    const next = session.drafts.get(id);
    if (!next || disposed) return;
    session.activeId = id;
    draft = next;
    await options.workspace?.setActiveOutput(id);
    busy = true;
    render();
    await loadEditor();
    busy = false;
    render();
    scheduleSave();
  };

  const addExistingOutputs = async (): Promise<void> => {
    if (!session || busy || !options.pickOutputFiles) return;
    panelError = undefined;
    busy = true;
    render();
    try {
      const inheritedReferences = options.workspace?.visibleReferences() ?? [];
      const picked = await options.pickOutputFiles();
      if (picked.cancelled) return;
      let lastId: string | undefined;
      for (const path of picked.paths) {
        const result = await api.addExistingDocument({ workspaceId, documentId: newId(), path });
        const id = result.document.id;
        await options.workspace?.initializeOutput(id, inheritedReferences, true);
        if (!session.drafts.has(id)) {
          const content = await api.readDocumentContent({ workspaceId, documentId: id });
          const next = markSaved(createDraft(id, result.document.title ?? '', content.content), {
            content: content.content,
            path: content.path,
            title: result.document.title ?? '',
          });
          session.drafts.set(id, next);
          session.registeredIds.add(id);
          session.tabIds.push(id);
          options.workspace?.setOutputTabs(session.tabIds);
        }
        lastId = id;
      }
      if (lastId !== undefined) {
        session.activeId = lastId;
        draft = session.drafts.get(lastId);
        await options.workspace?.setActiveOutput(lastId);
        await loadEditor();
      }
    } catch (error) {
      panelError = `添加失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      render();
    }
  };

  const deleteActiveOutput = async (): Promise<void> => {
    if (!session || !draft || busy) return;
    const deleting = draft;
    const name = draftTitle(deleting);
    const confirmed = options.confirmDelete?.(name)
      ?? window.confirm(`删除产出“${name}”？\n\n这会永久删除 Markdown 文件并从当前工作区移除。此操作无法撤销。`);
    if (!confirmed) return;
    clearTimeout(saveTimer);
    if (inFlight) await inFlight.catch(() => {});
    busy = true;
    panelError = undefined;
    render();
    try {
      await api.removeDocument({ workspaceId, documentId: deleting.id });
      await removeDraftFromSession(deleting.id);
    } catch (error) {
      panelError = `删除失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      render();
    }
  };

  const removeDraftFromSession = async (id: string): Promise<void> => {
    if (!session) return;
    const position = session.tabIds.indexOf(id);
    if (position !== -1) session.tabIds.splice(position, 1);
    options.workspace?.setOutputTabs(session.tabIds);
    session.drafts.delete(id);
    session.registeredIds.delete(id);
    const nextId = session.tabIds[position] ?? session.tabIds[position - 1];
    session.activeId = nextId;
    draft = nextId === undefined ? undefined : session.drafts.get(nextId);
    await options.workspace?.setActiveOutput(nextId);
    await loadEditor();
  };

  const detachActiveOutput = async (): Promise<void> => {
    if (!session || !draft || busy) return;
    capture();
    if (draft && canAutosave(draft)) await saveNow();
    const detaching = draft;
    if (!detaching || detaching.dirty) {
      panelError = detaching?.error ?? '当前修改尚未保存，无法移除。';
      render();
      return;
    }
    if (inFlight) await inFlight.catch(() => {});
    busy = true;
    panelError = undefined;
    render();
    try {
      await api.detachDocument({ workspaceId, documentId: detaching.id });
      await removeDraftFromSession(detaching.id);
    } catch (error) {
      panelError = `移除失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      render();
    }
  };

  const openCreateDialog = (): void => {
    if (!session || busy) return;
    createInput.value = '';
    createError.hidden = true;
    createError.textContent = '';
    createLocation.textContent = `保存位置：${session.createDirectory ?? `当前 Workspace/${DOCUMENT_DIRECTORY}/`}`;
    createDialog.hidden = false;
    queueMicrotask(() => createInput.focus());
  };

  const closeCreateDialog = (): void => {
    createDialog.hidden = true;
    createError.hidden = true;
    createError.textContent = '';
  };

  const createOutput = async (title: string): Promise<void> => {
    if (!session || busy) return;
    capture();
    clearTimeout(saveTimer);
    if (draft && canAutosave(draft)) await saveNow();
    busy = true;
    createSubmit.disabled = true;
    createCancel.disabled = true;
    const id = newId();
    const inheritedReferences = options.workspace?.visibleReferences() ?? [];
    try {
      const result = await api.saveDocument({
        workspaceId,
        documentId: id,
        title,
        content: '',
        ...(session.createDirectory === undefined ? {} : { targetDirectory: session.createDirectory }),
      });
      const next = markSaved(createDraft(id, title), {
        content: '',
        path: result.document.path ?? '',
        title: result.document.title ?? title,
      });
      session.registeredIds.add(id);
      session.drafts.set(next.id, next);
      session.tabIds.push(next.id);
      options.workspace?.setOutputTabs(session.tabIds);
      session.activeId = next.id;
      draft = next;
      await options.workspace?.initializeOutput(next.id, inheritedReferences, false);
      await options.workspace?.setActiveOutput(next.id);
      closeCreateDialog();
      render();
      await loadEditor();
    } catch (error) {
      createError.textContent = `创建失败：${error instanceof Error ? error.message : String(error)}`;
      createError.hidden = false;
    } finally {
      busy = false;
      createSubmit.disabled = false;
      createCancel.disabled = false;
      render();
    }
  };

  createCancel.addEventListener('click', closeCreateDialog);
  chooseDirectory.addEventListener('click', () => {
    if (!options.pickDirectory || busy) return;
    void options.pickDirectory().then(directory => {
      if (!directory || !session) return;
      session.createDirectory = directory;
      createLocation.textContent = `保存位置：${directory}`;
    }, error => {
      createError.textContent = `选择目录失败：${error instanceof Error ? error.message : String(error)}`;
      createError.hidden = false;
    });
  });
  createForm.addEventListener('submit', event => {
    event.preventDefault();
    const title = createInput.value.trim();
    if (title === '') {
      createError.textContent = '请输入文件名。';
      createError.hidden = false;
      return;
    }
    void createOutput(title);
  });

  section.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveNow(); }
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    capture();
    if (allDrafts().some(item => item.dirty || item.saving)) { event.preventDefault(); event.returnValue = ''; }
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
