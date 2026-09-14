import editorCss from './document-editor.css?inline';

interface LocalFileHandle {
  name: string;
  requestPermission?(options: { mode: 'readwrite' }): Promise<string>;
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<{ write(value: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
interface OpenDocument {
  handle: LocalFileHandle;
  disk: string;
  markdown: string;
  baseline: string;
  dirty: boolean;
  saving: boolean;
  pending?: Promise<void>;
  error?: string;
}
const documents = new Map<string, OpenDocument>();
let unloadGuardInstalled = false;
const pickerOptions = { types: [{ description: 'Markdown 文件', accept: { 'text/markdown': ['.md', '.markdown'] } }], multiple: false };

/** File handles and unsaved edits only live for the current page session. */
export function mountDocumentEditor(section: HTMLElement, workspaceId: string): () => void {
  if (!unloadGuardInstalled) {
    window.addEventListener('beforeunload', event => {
      if ([...documents.values()].some(doc => doc.dirty || doc.saving)) { event.preventDefault(); event.returnValue = ''; }
    });
    unloadGuardInstalled = true;
  }
  const style = document.createElement('style');
  style.textContent = editorCss;
  const header = document.createElement('header');
  const status = document.createElement('small');
  status.setAttribute('role', 'status');
  const open = document.createElement('button');
  open.type = 'button';
  open.dataset.siftFileLocation = '';
  open.setAttribute('aria-label', '选择或切换产出文件');
  header.append(open, status);
  const root = document.createElement('div');
  root.dataset.siftEditor = '';
  section.replaceChildren(style, header, root);
  let current = documents.get(workspaceId);
  let disposed = false;
  let editor: import('@milkdown/crepe').Crepe | undefined;
  let created = false;
  let ready: Promise<void> = Promise.resolve();
  let busy = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const renderStatus = () => {
    if (disposed) return;
    open.textContent = current ? `▱  ${current.handle.name}  ▾` : '选择产出文件…  ▾';
    open.title = current ? `${current.handle.name} · 点击切换文件` : '选择本地 Markdown 文件';
    status.textContent = current?.error ?? (current?.saving ? '保存中…' : current?.dirty ? '等待保存…' : '');
    status.hidden = !status.textContent;
    open.disabled = busy;
  };
  const capture = () => {
    if (created && editor && current) {
      current.markdown = editor.getMarkdown();
      current.dirty = current.markdown !== current.baseline;
    }
  };
  const loadEditor = async () => {
    created = false;
    const old = editor;
    editor = undefined;
    await old?.destroy();
    root.replaceChildren();
    if (!current || disposed) return;
    const doc = current;
    const { Crepe } = await import('@milkdown/crepe');
    if (disposed) return;
    editor = new Crepe({ root, defaultValue: doc.markdown,
      features: { [Crepe.Feature.Latex]: false },
      featureConfigs: { [Crepe.Feature.Placeholder]: { text: '开始写作，或粘贴 Markdown…' } },
    });
    editor.on(listener => listener.markdownUpdated(() => {
      if (!disposed && created) { capture(); renderStatus(); scheduleSave(); }
    }));
    await editor.create();
    if (disposed) return;
    created = true;
    // Parsing may normalize Markdown. Opening a file alone must not mark it dirty.
    if (!doc.dirty) doc.baseline = editor.getMarkdown();
    root.querySelector('[contenteditable]')?.setAttribute('aria-label', '产出 Markdown 编辑器');
  };
  const initialize = () => {
    busy = true;
    created = false;
    renderStatus();
    ready = loadEditor().then(() => { busy = false; renderStatus(); scheduleSave(); }, error => {
      busy = false;
      renderStatus();
      if (!disposed) { status.hidden = false; status.textContent = `编辑器加载失败：${String(error)}`; }
    });
  };
  const picker = (window as Window & { showOpenFilePicker?: (options: typeof pickerOptions) => Promise<LocalFileHandle[]> }).showOpenFilePicker;
  open.addEventListener('click', async () => {
    capture();
    if (!picker) { status.hidden = false; status.textContent = '当前浏览器不支持直接读写本地文件，请使用 Chrome 或 Edge 打开'; return; }
    busy = true;
    renderStatus();
    try {
      const [handle] = await picker.call(window, pickerOptions);
      if (!handle || disposed) return;
      if (handle.requestPermission && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('需要文件写入权限才能自动保存。');
      capture();
      await saveFile();
      if (disposed || current?.dirty) return;
      const markdown = await (await handle.getFile()).text();
      if (disposed) return;
      current = { handle, disk: markdown, markdown, baseline: markdown, dirty: false, saving: false };
      documents.set(workspaceId, current);
      initialize();
      await ready;
    } catch (error) {
      if (!disposed && (error as Error).name !== 'AbortError') { status.hidden = false; status.textContent = `打开失败：${String(error)}`; }
    } finally {
      busy = false;
      if (!disposed) open.disabled = false;
    }
  });
  const saveFile = async () => {
    clearTimeout(saveTimer);
    capture();
    const doc = current;
    if (!doc) return;
    if (doc.pending) { await doc.pending; capture(); if (doc.error) return; }
    if (!doc.dirty) { renderStatus(); return; }
    doc.saving = true;
    doc.error = undefined;
    renderStatus();
    doc.pending = (async () => {
    try {
      // Serialize writes and drain changes typed while an earlier write was pending.
      while (doc.dirty) {
      const value = doc.markdown;
      if (await (await doc.handle.getFile()).text() !== doc.disk) throw new Error('文件已被其他程序修改。请先复制当前改动备份，再重新打开文件。');
      const writable = await doc.handle.createWritable();
      try { await writable.write(value); await writable.close(); }
      catch (error) { await writable.abort().catch(() => {}); throw error; }
      doc.disk = value;
      doc.baseline = value;
      if (!disposed && current === doc) capture();
      doc.dirty = doc.markdown !== doc.baseline;
      }
    } catch (error) {
      doc.error = `自动保存失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      doc.saving = false;
      doc.pending = undefined;
      renderStatus();
    }
    })();
    await doc.pending;
  };
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    if (current?.dirty) saveTimer = setTimeout(() => { void saveFile(); }, 400);
  };
  section.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFile(); }
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    capture();
    void saveFile();
    if ([...documents.values()].some(doc => doc.dirty || doc.saving)) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);
  initialize();
  return () => {
    capture();
    clearTimeout(saveTimer);
    void saveFile();
    disposed = true;
    // Preserve pending edits when moving between workspaces in this page session.
    // The shared unload guard also protects edits in inactive workspaces.
    window.removeEventListener('beforeunload', beforeUnload);
    void ready.then(() => editor?.destroy()).catch(error => console.error('Sift editor cleanup failed', error));
  };
}
