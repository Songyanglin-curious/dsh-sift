import { materialFormat, normalizeMaterialUrl, type FileEntry, type Material, type MaterialFormat, type MaterialsApi } from '../materials.js';
import { previewMaterial } from './material-preview.js';
import editorCss from './document-editor.css?inline';
import panelCss from './materials-panel.css?inline';

/** Short type badge shown on tabs and file rows, mirroring the VS Code file-icon slot. */
const BADGES: Record<MaterialFormat, string> = { md: 'MD', pdf: 'PDF', docx: 'DOCX', doc: 'DOC', url: 'WEB', unsupported: 'FILE' };
const SUPPORTED_HINT = '支持工作区里的 Markdown、PDF、DOCX 文件，也可以引用网页地址。';
type AddView = 'file' | 'url';

/**
 * Material relation panel for the Sift three-column layout.
 *
 * The panel only maintains references: no file is copied, moved or rewritten, and removing a tab
 * drops the reference while the original file stays in the workspace.
 */
export function mountMaterialsPanel(section: HTMLElement, workspaceId: string, api: MaterialsApi): () => void {
  const style = document.createElement('style');
  style.textContent = editorCss + panelCss;

  const toolbar = document.createElement('header');
  toolbar.dataset.siftMaterialToolbar = '';
  const tabs = document.createElement('div');
  tabs.dataset.siftMaterialTabs = '';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '素材标签');
  const actions = document.createElement('div');
  actions.dataset.siftMaterialActions = '';
  const add = control('＋', { title: '新增素材引用' });
  add.setAttribute('aria-haspopup', 'menu');
  add.setAttribute('aria-expanded', 'false');
  const reload = control('↻', { title: '重新读取素材引用' });
  actions.append(add, reload);
  toolbar.append(tabs, actions);

  const menu = document.createElement('div');
  menu.dataset.siftMaterialMenu = '';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const addFile = control('添加工作区文件…');
  addFile.setAttribute('role', 'menuitem');
  const addUrl = control('添加网页地址…');
  addUrl.setAttribute('role', 'menuitem');
  menu.append(addFile, addUrl);

  const chooser = document.createElement('div');
  chooser.dataset.siftMaterialChooser = '';
  chooser.hidden = true;
  const message = document.createElement('small');
  message.dataset.siftMaterialStatus = '';
  message.setAttribute('role', 'status');
  const preview = document.createElement('div');
  preview.dataset.siftMaterialPreview = '';
  preview.setAttribute('role', 'tabpanel');
  const footer = document.createElement('footer');
  footer.dataset.siftMaterialTarget = '';
  footer.hidden = true;
  const targetLabel = document.createElement('span');
  targetLabel.textContent = '引用';
  const targetValue = document.createElement('code');
  const copy = control('复制');
  footer.append(targetLabel, targetValue, copy);

  section.replaceChildren(style, toolbar, menu, chooser, message, preview, footer);

  let items: Material[] = [];
  let selected: string | undefined;
  let busy = true;
  let disposed = false;
  let controller: AbortController | undefined;
  let disposePreview: (() => void) | undefined;
  let browseGeneration = 0;
  let browsePath = '';

  const report = (error: unknown) => {
    if (!disposed) message.textContent = error instanceof Error ? error.message : String(error);
  };
  const active = () => items.find(item => item.id === selected);

  const renderTabs = () => {
    tabs.replaceChildren();
    for (const item of items) {
      const format = materialFormat(item);
      const wrapper = document.createElement('div');
      wrapper.dataset.materialTab = item.id;
      wrapper.toggleAttribute('data-active', item.id === selected);
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(item.id === selected));
      tab.tabIndex = item.id === selected ? 0 : -1;
      tab.dataset.format = format;
      tab.title = item.kind === 'url' ? item.target : `${item.target}（工作区文件）`;
      tab.setAttribute('aria-label', item.name);
      const badge = document.createElement('span');
      badge.dataset.materialBadge = '';
      badge.textContent = BADGES[format];
      const label = document.createElement('span');
      label.dataset.materialLabel = '';
      label.textContent = item.name;
      tab.append(badge, label);
      tab.addEventListener('click', () => void select(item.id));
      tab.addEventListener('keydown', event => {
        const index = items.findIndex(entry => entry.id === item.id);
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void remove(item.id); return; }
        const next = event.key === 'ArrowRight' ? (index + 1) % items.length
          : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length
            : event.key === 'Home' ? 0
              : event.key === 'End' ? items.length - 1 : -1;
        if (next < 0 || !items[next]) return;
        event.preventDefault();
        void select(items[next].id);
        tabs.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
      });
      const close = control('×', { title: `移除「${item.name}」的引用（原文件保留）` });
      close.dataset.materialClose = '';
      close.addEventListener('click', event => { event.stopPropagation(); void remove(item.id); });
      wrapper.append(tab, close);
      tabs.append(wrapper);
    }
    reload.disabled = busy;
    tabs.querySelector<HTMLElement>('[data-active]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const renderTarget = () => {
    const item = active();
    footer.hidden = !item;
    if (!item) return;
    targetValue.textContent = item.target;
    targetValue.title = item.target;
    copy.title = item.kind === 'url' ? '复制网页地址' : '复制工作区相对路径';
  };

  const renderEmpty = () => {
    const box = document.createElement('div');
    box.dataset.siftMaterialEmpty = '';
    const title = document.createElement('strong');
    title.textContent = '还没有素材引用';
    const hint = document.createElement('p');
    hint.textContent = '把工作区里的资料添加为素材，之后就能像 VS Code 标签页一样切换阅读。这里只保存引用关系，不复制、不移动原文件。';
    const start = control('添加素材', { className: 'primary' });
    start.dataset.materialEmpty = '';
    start.addEventListener('click', () => openChooser('file'));
    const supported = document.createElement('small');
    supported.textContent = SUPPORTED_HINT;
    box.append(title, hint, start, supported);
    return box;
  };

  const renderMissing = (item: Material) => {
    const box = document.createElement('div');
    box.dataset.siftMaterialMissing = '';
    const title = document.createElement('strong');
    title.textContent = '无法预览这条素材';
    const hint = document.createElement('p');
    hint.textContent = '文件可能已被移动、重命名或删除。可以移除这条引用，再从工作区重新添加。';
    const path = document.createElement('code');
    path.textContent = item.target;
    box.append(title, hint, path);
    return box;
  };

  const select = async (id: string) => {
    const item = items.find(entry => entry.id === id);
    if (!item || disposed) return;
    selected = id;
    renderTabs();
    renderTarget();
    controller?.abort();
    disposePreview?.();
    disposePreview = undefined;
    const request = controller = new AbortController();
    const body = document.createElement('div');
    preview.setAttribute('aria-label', `${item.name} 预览`);
    preview.replaceChildren(body);
    message.textContent = '正在加载…';
    try {
      const format = materialFormat(item);
      const encoded = item.kind === 'file' && format !== 'doc' && format !== 'unsupported'
        ? (await api.readMaterial({ workspaceId, id })).base64 : '';
      if (disposed || request.signal.aborted) return;
      const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
      const cleanup = await previewMaterial(body, item, bytes, request.signal);
      if (disposed || request.signal.aborted) { cleanup(); return; }
      disposePreview = cleanup;
      message.textContent = '';
    } catch (error) {
      if (disposed || request.signal.aborted) return;
      report(error);
      body.replaceChildren(renderMissing(item));
    }
  };

  const renderList = async (preferred?: string) => {
    const result = await api.getMaterials({ workspaceId });
    if (disposed) return;
    items = result.items;
    const candidates = [preferred, selected].filter((value): value is string => typeof value === 'string');
    selected = candidates.find(value => items.some(item => item.id === value)) ?? items[0]?.id;
    renderTabs();
    renderTarget();
    if (!selected) {
      controller?.abort();
      disposePreview?.();
      disposePreview = undefined;
      preview.removeAttribute('aria-label');
      preview.replaceChildren(renderEmpty());
      return;
    }
    await select(selected);
  };

  const remove = async (id: string) => {
    if (busy || disposed) return;
    const index = items.findIndex(item => item.id === id);
    const name = items[index]?.name ?? '素材';
    busy = true;
    renderTabs();
    try {
      const result = await api.removeMaterial({ workspaceId, id });
      if (disposed) return;
      items = result.items;
      if (selected === id) {
        controller?.abort();
        disposePreview?.();
        disposePreview = undefined;
        selected = items[Math.min(index, Math.max(items.length - 1, 0))]?.id;
      }
      renderTarget();
      if (selected) await select(selected);
      else {
        preview.removeAttribute('aria-label');
        preview.replaceChildren(renderEmpty());
      }
      if (!disposed && message.textContent === '') message.textContent = `已移除「${name}」的引用，原文件仍保留在工作区。`;
    } catch (error) { report(error); }
    finally {
      busy = false;
      if (!disposed) { renderTabs(); renderTarget(); }
    }
  };

  const addReference = async (kind: 'file' | 'url', value: string) => {
    if (busy || disposed) return;
    busy = true;
    renderTabs();
    try {
      const wanted = kind === 'url' ? normalizeMaterialUrl(value) : value;
      items = (await api.addMaterial({ workspaceId, kind, target: wanted })).items;
      let item = items.find(entry => entry.kind === kind && entry.target === wanted);
      if (!item) {
        // The host normalizes targets again; reload before guessing so a duplicate never selects the wrong tab.
        items = (await api.getMaterials({ workspaceId })).items;
        item = items.find(entry => entry.kind === kind && entry.target === wanted);
      }
      if (disposed) return;
      closeChooser();
      if (!item) { renderTabs(); report(new Error('引用已保存，但未能定位到对应标签，请点击 ↻ 重新读取。')); return; }
      await select(item.id);
    } catch (error) { report(error); }
    finally {
      busy = false;
      if (!disposed) { renderTabs(); renderTarget(); }
    }
  };

  const renderUrlForm = () => {
    const form = document.createElement('form');
    form.dataset.siftMaterialUrl = '';
    const label = document.createElement('label');
    label.textContent = '网页地址';
    const input = document.createElement('input');
    input.type = 'url';
    input.required = true;
    input.placeholder = 'https://example.com/';
    input.setAttribute('aria-label', '网页地址');
    label.append(input);
    const submit = control('添加引用', { className: 'primary' });
    submit.type = 'submit';
    form.append(label, submit);
    const hint = document.createElement('p');
    hint.textContent = '只接受 HTTP/HTTPS 地址。部分网站禁止内嵌显示，可在预览里打开原网页。';
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (input.value.trim()) void addReference('url', input.value);
    });
    chooser.replaceChildren(form, hint);
    input.focus?.();
  };

  const renderFileBrowser = (path: string, entries: FileEntry[]) => {
    const body = document.createElement('div');
    body.dataset.siftMaterialBrowser = '';
    const head = document.createElement('nav');
    head.dataset.siftMaterialCrumbs = '';
    head.setAttribute('aria-label', '工作区目录');
    const parts = path.split('/').filter(Boolean);
    const root = control('工作区');
    root.addEventListener('click', () => void browse(''));
    head.append(root);
    parts.forEach((part, index) => {
      const separator = document.createElement('span');
      separator.textContent = '›';
      separator.setAttribute('aria-hidden', 'true');
      const crumb = control(part);
      crumb.addEventListener('click', () => void browse(parts.slice(0, index + 1).join('/')));
      head.append(separator, crumb);
    });
    const up = control('↑ 上一级');
    up.hidden = !path;
    up.addEventListener('click', () => void browse(parts.slice(0, -1).join('/')));
    const refresh = control('↻', { title: '刷新当前目录' });
    refresh.addEventListener('click', () => void browse(path));
    head.append(up, refresh);
    const list = document.createElement('div');
    list.dataset.siftMaterialEntries = '';
    for (const entry of entries) {
      const format = materialFormat({ kind: 'file', target: entry.name });
      const row = control('');
      row.dataset.materialEntry = entry.path;
      row.dataset.format = entry.directory ? 'directory' : format;
      const badge = document.createElement('span');
      badge.dataset.materialBadge = '';
      badge.textContent = entry.directory ? '▸' : BADGES[format];
      const text = document.createElement('span');
      text.dataset.materialLabel = '';
      text.textContent = entry.name;
      row.append(badge, text);
      const added = items.some(item => item.kind === 'file' && item.target === entry.path);
      if (entry.directory) row.title = `打开 ${entry.path}（文件夹）`;
      else if (added) { row.disabled = true; row.title = '已在素材标签中'; text.textContent = `${entry.name}（已添加）`; }
      else row.title = `添加引用：${entry.path}`;
      row.setAttribute('aria-label', row.title);
      row.addEventListener('click', () => { if (entry.directory) void browse(entry.path); else void addReference('file', entry.path); });
      list.append(row);
    }
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.dataset.siftMaterialBrowserEmpty = '';
      empty.textContent = `这个目录里没有可添加的文件。${SUPPORTED_HINT}`;
      list.append(empty);
    }
    body.append(head, list);
    chooser.replaceChildren(body);
  };

  const browse = async (path: string) => {
    const generation = ++browseGeneration;
    browsePath = path;
    chooser.hidden = false;
    const loading = document.createElement('p');
    loading.dataset.siftMaterialBrowser = '';
    loading.textContent = '正在读取工作区…';
    chooser.replaceChildren(loading);
    try {
      const entries = await api.listMaterialFiles({ workspaceId, path });
      if (disposed || generation !== browseGeneration) return;
      renderFileBrowser(path, entries);
    } catch (error) {
      if (disposed || generation !== browseGeneration) return;
      const box = document.createElement('div');
      box.dataset.siftMaterialBrowser = '';
      const text = document.createElement('p');
      text.textContent = `无法读取目录：${error instanceof Error ? error.message : String(error)}`;
      const retry = control('重试');
      retry.addEventListener('click', () => void browse(path));
      box.append(text, retry);
      chooser.replaceChildren(box);
    }
  };

  const openChooser = (next: AddView) => {
    toggleMenu(false);
    if (next === 'file') void browse(browsePath);
    else { chooser.hidden = false; renderUrlForm(); }
  };
  const closeChooser = () => {
    browseGeneration += 1;
    chooser.hidden = true;
    chooser.replaceChildren();
  };
  const toggleMenu = (open?: boolean) => {
    const next = open ?? menu.hidden;
    menu.hidden = !next;
    add.setAttribute('aria-expanded', String(next));
    if (next) menu.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus?.();
  };
  const onPointerDown = (event: Event) => {
    if (menu.hidden) return;
    const node = event.target as Node | null;
    if (!node || menu.contains(node) || actions.contains(node)) return;
    toggleMenu(false);
  };

  add.addEventListener('click', () => toggleMenu());
  addFile.addEventListener('click', () => openChooser('file'));
  addUrl.addEventListener('click', () => openChooser('url'));
  reload.addEventListener('click', () => {
    if (busy || disposed) return;
    busy = true;
    renderTabs();
    void renderList(selected).catch(report).finally(() => { busy = false; if (!disposed) renderTabs(); });
  });
  copy.addEventListener('click', () => {
    const item = active();
    if (!item) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) { message.textContent = '当前环境不支持自动复制。'; return; }
    void clipboard.writeText(item.target).then(
      () => { if (!disposed) message.textContent = `已复制引用：${item.target}`; },
      () => { if (!disposed) message.textContent = '复制失败，请手动选择路径。'; },
    );
  });
  document.addEventListener('pointerdown', onPointerDown);

  preview.replaceChildren(renderEmpty());
  renderTabs();
  void renderList().catch(report).finally(() => { if (!disposed) { busy = false; renderTabs(); } });

  return () => {
    disposed = true;
    browseGeneration += 1;
    document.removeEventListener('pointerdown', onPointerDown);
    controller?.abort();
    disposePreview?.();
  };
}

function control(label: string, options: { title?: string; className?: string } = {}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  const description = options.title ?? (label || '按钮');
  button.title = description;
  button.setAttribute('aria-label', description);
  if (options.className) button.className = options.className;
  return button;
}
