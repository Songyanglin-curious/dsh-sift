import { materialFormat, normalizeMaterialUrl, type Material, type MaterialsApi } from '../materials.js';
import { previewMaterial } from './material-preview.js';
import editorCss from './document-editor.css?inline';
import panelCss from './materials-panel.css?inline';

export function mountMaterialsPanel(section: HTMLElement, workspaceId: string, api: MaterialsApi): () => void {
  const style = document.createElement('style'); style.textContent = editorCss + panelCss;
  const header = document.createElement('header');
  const tabs = document.createElement('div'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '素材文件');
  const add = document.createElement('button'); add.type = 'button'; add.textContent = '+'; add.title = '新增素材引用'; add.setAttribute('aria-label', '新增素材引用');
  header.append(tabs, add);
  const chooser = document.createElement('div'); chooser.dataset.siftMaterialChooser = ''; chooser.hidden = true;
  const message = document.createElement('small'); message.setAttribute('role', 'status');
  const preview = document.createElement('div'); preview.dataset.siftMaterialPreview = ''; preview.setAttribute('role', 'tabpanel');
  section.replaceChildren(style, header, chooser, message, preview);
  let items: Material[] = [];
  let selected: string | undefined;
  let disposed = false;
  let busy = true;
  let controller: AbortController | undefined;
  let disposePreview: (() => void) | undefined;
  let browseGeneration = 0;
  const report = (error: unknown) => { if (!disposed) message.textContent = error instanceof Error ? error.message : String(error); };
  const empty = () => { preview.textContent = '点击 + 添加工作区文件或网页引用'; };
  const select = async (id: string) => {
    const item = items.find(entry => entry.id === id);
    if (!item || disposed) return;
    selected = id;
    renderTabs();
    controller?.abort(); disposePreview?.(); disposePreview = undefined;
    const request = controller = new AbortController();
    const body = document.createElement('div');
    preview.setAttribute('aria-label', item.name);
    preview.replaceChildren(body); message.textContent = '正在加载…';
    try {
      const format = materialFormat(item);
      const encoded = item.kind === 'file' && format !== 'doc' && format !== 'unsupported' ? (await api.readMaterial({ workspaceId, id })).base64 : '';
      if (disposed || request.signal.aborted) return;
      const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
      const cleanup = await previewMaterial(body, item, bytes, request.signal);
      if (disposed || request.signal.aborted) { cleanup(); return; }
      disposePreview = cleanup; message.textContent = '';
    } catch (error) { if (!request.signal.aborted) { report(error); body.textContent = '无法预览此素材。文件可能已移动或损坏，可移除引用后重新添加。'; } }
  };
  const remove = async (id: string) => {
    if (busy) return;
    busy = true; renderTabs();
    try {
      const index = items.findIndex(item => item.id === id);
      const result = await api.removeMaterial({ workspaceId, id });
      if (disposed) return;
      items = result.items;
      if (selected === id) {
        controller?.abort(); disposePreview?.(); disposePreview = undefined;
        selected = items[Math.min(index, items.length - 1)]?.id;
        if (selected) await select(selected); else { message.textContent = ''; empty(); }
      }
    } catch (error) { report(error); }
    finally { busy = false; if (!disposed) renderTabs(); }
  };
  const renderTabs = () => {
    tabs.replaceChildren();
    items.forEach(item => {
      const tab = document.createElement('div'); tab.dataset.materialTab = item.id;
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
      button.dataset.format = materialFormat(item).toUpperCase();
      button.setAttribute('aria-selected', String(item.id === selected)); button.tabIndex = item.id === selected ? 0 : -1;
      button.textContent = item.name; button.title = item.target;
      button.addEventListener('click', () => { void select(item.id); });
      button.addEventListener('keydown', event => {
        const index = items.findIndex(entry => entry.id === item.id);
        const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); void select(items[next].id);
        tabs.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
      });
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.disabled = busy;
      close.title = `移除 ${item.name} 的引用（保留原文件）`; close.setAttribute('aria-label', close.title);
      close.addEventListener('click', () => { void remove(item.id); });
      tab.append(button, close); tabs.append(tab);
    });
    add.disabled = busy;
    tabs.querySelector<HTMLElement>('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  const addReference = async (kind: 'file' | 'url', target: string) => {
    if (busy) return;
    busy = true; renderTabs();
    try {
      if (kind === 'url') target = normalizeMaterialUrl(target);
      const result = await api.addMaterial({ workspaceId, kind, target });
      if (disposed) return;
      items = result.items; chooser.hidden = true;
      const item = items.find(entry => entry.kind === kind && entry.target === target) ?? items.at(-1);
      if (item) await select(item.id);
    } catch (error) { report(error); }
    finally { busy = false; if (!disposed) renderTabs(); }
  };
  const browse = async (path = '') => {
    const generation = ++browseGeneration;
    const list = document.createElement('div'); list.textContent = '读取工作区…';
    chooser.replaceChildren(list);
    try {
      const entries = await api.listMaterialFiles({ workspaceId, path });
      if (disposed || generation !== browseGeneration) return;
      list.replaceChildren();
      const location = document.createElement('div'); location.textContent = path || '工作区'; list.append(location);
      if (path) {
        const up = document.createElement('button'); up.type = 'button'; up.textContent = '← 上级目录';
        up.addEventListener('click', () => { void browse(path.split('/').slice(0, -1).join('/')); }); list.append(up);
      }
      entries.forEach(entry => {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `${entry.directory ? '▸ ' : ''}${entry.name}`;
        button.addEventListener('click', () => { if (entry.directory) void browse(entry.path); else void addReference('file', entry.path); }); list.append(button);
      });
      if (!entries.length) { const p = document.createElement('p'); p.textContent = '此目录没有可添加的文件'; list.append(p); }
      const form = document.createElement('form');
      const input = document.createElement('input'); input.type = 'url'; input.required = true; input.placeholder = 'https://…'; input.setAttribute('aria-label', '网页地址');
      const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '添加网页';
      form.append(input, submit); form.addEventListener('submit', event => { event.preventDefault(); void addReference('url', input.value); });
      chooser.append(form);
    } catch (error) { report(error); list.textContent = '无法读取目录，点击 + 重试'; }
  };
  add.addEventListener('click', () => { chooser.hidden = !chooser.hidden; if (!chooser.hidden) void browse(); });
  empty();
  renderTabs();
  void api.getMaterials({ workspaceId }).then(result => {
    if (disposed) return;
    busy = false;
    items = result.items; selected = items[0]?.id; renderTabs(); if (selected) void select(selected);
  }, error => { busy = false; if (!disposed) renderTabs(); report(error); });
  return () => { disposed = true; browseGeneration++; controller?.abort(); disposePreview?.(); };
}
