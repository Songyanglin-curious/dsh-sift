import drawerCss from './drawer.css?inline';
import type { FileEntry, Source, SourceIndex, SourcesApi } from '../../sources.js';

/**
 * Source Drawer（v0.2 实施文档 §16）。
 *
 * Source 不常驻主界面，通过 Reference Board 的「＋ 从来源获取」临时展开。
 * Drawer 解决的是「我手里有哪些原始输入」，因此这里只做来源的查看与登记；
 * 「整份加入当前参考」（Phase 4）与「让 AI 提取参考」（Phase 7）由外部通过
 * `onSelectionChange` 拿到选中集合后自己接。
 *
 * 三种加入方式：
 * - **本机文件**：调用 Host 的原生多选文件对话框，直接引用原路径，不复制文件。
 * - **拖进来**：拖 URL 直接登记为网页来源；拖本地文件时浏览器拿不到绝对路径，
 *   按实施文档 §5.3 的回落做法把**内容导入工作区**后登记。
 * - **工作区文件 / 网页 / 粘贴**：工作区内浏览选择、填地址、粘贴创建 Markdown。
 */

export interface SourceDrawerOptions {
  readonly workspaceId: string;
  readonly api: SourcesApi;
  /** 系统目录选择器（仅在不支持原生文件对话框时作为回落手段）。 */
  readonly pickDirectory?: () => Promise<string | null>;
  readonly onSelectionChange?: (ids: readonly string[]) => void;
}

export type SourceDrawerView = 'list' | 'workspace' | 'external' | 'url' | 'paste';

export interface SourceDrawer {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** 当前选中的 Source id，供 Phase 4/7 使用。 */
  selection(): readonly string[];
  reload(): Promise<void>;
  dispose(): void;
}

const VIEW_TITLES: Record<Exclude<SourceDrawerView, 'list'>, string> = {
  workspace: '添加工作区文件',
  external: '浏览本机目录',
  url: '添加网页',
  paste: '粘贴并创建文件',
};

/** 拖进来时可以被当作文本导入的扩展名；其余按二进制处理并提示用文件对话框。 */
const TEXT_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.html', '.htm', '.xml', '.csv', '.log', '.py', '.java', '.cs', '.go', '.rs', '.sql', '.sh', '.toml', '.ini',
];

export function isTextLikeFile(file: { name: string; type?: string }): boolean {
  const type = file.type ?? '';
  if (type.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/x-yaml'].includes(type)) return true;
  const name = file.name.toLowerCase();
  return TEXT_EXTENSIONS.some(extension => name.endsWith(extension));
}

/** 从拖放数据里取第一个 http(s) 地址。 */
export function droppedUrl(read: (format: string) => string): string | undefined {
  for (const format of ['text/uri-list', 'text/plain']) {
    const value = read(format);
    if (!value) continue;
    const candidate = value.split(/\r?\n/).map(line => line.trim()).find(line => /^https?:\/\//i.test(line));
    if (candidate) return candidate;
  }
  return undefined;
}

function sourceOrigin(source: Source): string {
  if (source.type === 'url') return source.target;
  return source.location === 'external' ? source.target : `工作区 · ${source.target}`;
}

export function mountSourceDrawer(host: HTMLElement, options: SourceDrawerOptions): SourceDrawer {
  const { workspaceId, api } = options;

  const style = document.createElement('style');
  style.textContent = drawerCss;

  const root = document.createElement('div');
  root.dataset.siftSourceDrawer = '';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '来源');

  const header = document.createElement('header');
  const heading = document.createElement('strong');
  heading.textContent = '来源';
  const hint = document.createElement('small');
  hint.textContent = '拖入网页地址或文件';
  const close = document.createElement('button');
  close.type = 'button';
  close.dataset.siftSourceAction = 'close';
  close.setAttribute('aria-label', '关闭来源');
  close.textContent = '×';
  header.append(heading, hint, close);

  const error = document.createElement('p');
  error.dataset.siftSourceError = '';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const list = document.createElement('ul');
  list.dataset.siftSourceList = '';
  const empty = document.createElement('p');
  empty.dataset.siftSourceEmpty = '';
  empty.textContent = '还没有来源。加入工作区文件、本机文件或网页后，就能从这里挑出当前要用的内容。';

  const actions = document.createElement('div');
  actions.dataset.siftSourceActions = '';
  for (const [view, label] of [['workspace', '工作区文件'], ['external', '本机文件'], ['url', '网页地址'], ['paste', '粘贴创建']] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.siftSourceAction = `add-${view}`;
    button.textContent = label;
    actions.appendChild(button);
  }

  const view = document.createElement('div');
  view.dataset.siftSourceView = '';

  root.append(style, header, error, empty, list, actions, view);
  host.appendChild(root);

  let items: readonly Source[] = [];
  const selected = new Set<string>();
  let currentView: SourceDrawerView = 'list';
  let busy = false;

  const showError = (message?: string) => {
    error.hidden = message === undefined;
    error.textContent = message ?? '';
  };

  const renderList = () => {
    empty.hidden = items.length > 0;
    list.replaceChildren();
    for (const source of items) {
      const row = document.createElement('li');
      row.dataset.siftSourceId = source.id;
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(source.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(source.id); else selected.delete(source.id);
        options.onSelectionChange?.([...selected]);
      });
      const title = document.createElement('span');
      title.textContent = source.title;
      title.title = source.title;
      label.append(checkbox, title);
      const origin = document.createElement('small');
      origin.textContent = sourceOrigin(source);
      origin.title = sourceOrigin(source);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.siftSourceAction = 'remove';
      remove.setAttribute('aria-label', `移除 ${source.title}`);
      remove.textContent = '移除';
      remove.title = '只解除登记，不删除原文件';
      remove.addEventListener('click', () => { void mutate(() => api.removeSource({ workspaceId, id: source.id })); });
      row.append(label, origin, remove);
      list.appendChild(row);
    }
  };

  const renderView = () => {
    view.replaceChildren();
    view.hidden = currentView === 'list';
    if (currentView === 'list') return;
    const bar = document.createElement('div');
    bar.dataset.siftSourceViewHeader = '';
    const back = document.createElement('button');
    back.type = 'button';
    back.dataset.siftSourceAction = 'back';
    back.textContent = '← 返回';
    back.addEventListener('click', () => { currentView = 'list'; renderView(); });
    const title = document.createElement('strong');
    title.textContent = VIEW_TITLES[currentView as Exclude<SourceDrawerView, 'list'>];
    bar.append(back, title);
    view.appendChild(bar);
    if (currentView === 'url') renderUrlForm();
    else if (currentView === 'paste') renderPasteForm();
    else renderBrowser(currentView);
  };

  const renderUrlForm = () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'url';
    input.placeholder = 'https://…（也可以直接把地址拖进这个面板）';
    input.setAttribute('aria-label', '网页地址');
    input.dataset.siftSourceUrl = '';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = '添加网页';
    form.append(input, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void mutate(() => api.addSource({ workspaceId, type: 'url', target: input.value }));
    });
    view.appendChild(form);
  };

  const renderPasteForm = () => {
    const form = document.createElement('form');
    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = '文件名，例如 remote-notes';
    name.setAttribute('aria-label', '文件名');
    name.dataset.siftSourcePasteName = '';
    const content = document.createElement('textarea');
    content.rows = 6;
    content.placeholder = '粘贴内容…';
    content.setAttribute('aria-label', '粘贴内容');
    content.dataset.siftSourcePasteContent = '';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = '创建并登记';
    form.append(name, content, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void mutate(async () => (await api.createSourceFile({ workspaceId, name: name.value, content: content.value })).index);
    });
    view.appendChild(form);
  };

  /** 工作区与本机共用的目录浏览（原生对话框不可用时的回落）。 */
  const renderBrowser = (kind: 'workspace' | 'external') => {
    let path = '';
    const bar = document.createElement('div');
    bar.dataset.siftSourceBrowse = '';
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.dataset.siftSourcePath = '';
    pathInput.setAttribute('aria-label', kind === 'workspace' ? '工作区路径' : '本机目录绝对路径');
    pathInput.placeholder = kind === 'workspace' ? '工作区根目录' : '例如 D:\\Downloads';
    const up = document.createElement('button');
    up.type = 'button';
    up.dataset.siftSourceAction = 'up';
    up.textContent = '↑ 上一级';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.dataset.siftSourceAction = 'pick-directory';
    pick.textContent = kind === 'workspace' ? '工作区根目录' : '选择文件夹…';
    const entries = document.createElement('ul');
    entries.dataset.siftSourceEntries = '';
    const status = document.createElement('p');
    status.dataset.siftSourceBrowseStatus = '';
    status.hidden = true;
    bar.append(pathInput, up, pick);
    view.append(bar, status, entries);

    const load = async (next: string) => {
      path = next;
      pathInput.value = next;
      status.hidden = false;
      status.textContent = '正在读取…';
      entries.replaceChildren();
      try {
        const listing = kind === 'workspace'
          ? await api.browseWorkspace({ workspaceId, path: next })
          : await api.browseExternal({ path: next });
        status.hidden = listing.length > 0;
        status.textContent = listing.length > 0 ? '' : '这个目录里没有可用的条目。';
        for (const entry of listing) entries.appendChild(entryRow(entry, kind, load));
      } catch (cause) {
        status.hidden = false;
        status.textContent = cause instanceof Error ? cause.message : String(cause);
      }
    };

    pathInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); void load(pathInput.value.trim()); }
    });
    up.addEventListener('click', () => {
      if (kind === 'workspace') {
        void load(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
        return;
      }
      const parent = path.replace(/[\\/][^\\/]*$/, '');
      if (parent !== path) void load(parent);
    });
    pick.addEventListener('click', () => {
      if (kind === 'workspace') { void load(''); return; }
      void (async () => {
        const picked = await options.pickDirectory?.();
        if (picked) await load(picked);
      })();
    });

    void load(kind === 'workspace' ? '' : path);
  };

  const entryRow = (entry: FileEntry, kind: 'workspace' | 'external', load: (path: string) => Promise<void>) => {
    const row = document.createElement('li');
    row.dataset.siftSourceEntry = entry.path;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.directory ? `📁 ${entry.name}` : entry.name;
    button.addEventListener('click', () => {
      if (entry.directory) { void load(entry.path); return; }
      void mutate(() => api.addSource({
        workspaceId,
        type: 'file',
        location: kind === 'workspace' ? 'workspace' : 'external',
        target: entry.path,
      }));
    });
    row.appendChild(button);
    return row;
  };

  /** 所有写操作走同一条路径：先占位、再刷新、失败显示原因。 */
  const mutate = async (action: () => Promise<SourceIndex | { index: SourceIndex }>) => {
    if (busy) return;
    busy = true;
    showError();
    try {
      const result = await action();
      items = 'index' in result ? result.index.items : result.items;
      renderList();
      currentView = 'list';
      renderView();
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy = false;
    }
  };

  /** 本机文件：优先用原生多选对话框；平台不支持时回落到目录浏览。 */
  const pickLocalFiles = async () => {
    if (busy) return;
    busy = true;
    showError();
    try {
      const picked = await api.pickSourceFiles({});
      if (picked.message !== undefined) {
        showError(picked.message);
        currentView = 'external';
        renderView();
        return;
      }
      if (picked.cancelled || picked.paths.length === 0) return;
      const result = await api.addExternalFiles({ workspaceId, paths: [...picked.paths] });
      items = result.index.items;
      renderList();
      currentView = 'list';
      renderView();
      if (result.failed.length > 0) showError(`有 ${result.failed.length} 个文件没能加入：${result.failed[0]!.message}`);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy = false;
    }
  };

  /** 拖入：网页地址直接登记；本地文件导入工作区后登记（浏览器拿不到绝对路径）。 */
  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    root.removeAttribute('data-sift-source-dragging');
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const url = droppedUrl(format => transfer.getData(format));
    if (url !== undefined) {
      await mutate(() => api.addSource({ workspaceId, type: 'url', target: url }));
      return;
    }
    const files = Array.from(transfer.files);
    if (files.length === 0) return;
    const textFiles = files.filter(isTextLikeFile);
    const skipped = files.length - textFiles.length;
    if (textFiles.length === 0) {
      showError('拖入的是二进制文件。请用「本机文件」按钮，它直接引用原路径而不复制内容。');
      return;
    }
    if (busy) return;
    busy = true;
    showError();
    try {
      for (const file of textFiles) {
        await api.createSourceFile({ workspaceId, name: file.name, content: await file.text() });
      }
      await reload();
      if (skipped > 0) showError(`已导入 ${textFiles.length} 个文本文件；${skipped} 个二进制文件被跳过，请用「本机文件」按钮引用它们。`);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy = false;
    }
  };

  const reload = async () => {
    try {
      const index = await api.listSources({ workspaceId });
      items = index.items;
      renderList();
      showError();
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  close.addEventListener('click', () => { root.hidden = true; });
  actions.querySelectorAll<HTMLButtonElement>('[data-sift-source-action]').forEach(button => {
    const action = button.dataset.siftSourceAction!;
    if (!action.startsWith('add-')) return;
    const next = action.slice('add-'.length) as SourceDrawerView;
    button.addEventListener('click', () => {
      if (next === 'external') { void pickLocalFiles(); return; }
      currentView = next;
      renderView();
    });
  });

  root.addEventListener('dragover', event => {
    event.preventDefault();
    root.setAttribute('data-sift-source-dragging', '');
  });
  root.addEventListener('dragleave', event => {
    if (event.target === root) root.removeAttribute('data-sift-source-dragging');
  });
  root.addEventListener('drop', event => { void handleDrop(event); });

  renderList();
  renderView();

  return {
    open: () => { root.hidden = false; void reload(); renderView(); },
    close: () => { root.hidden = true; },
    isOpen: () => !root.hidden,
    selection: () => [...selected],
    reload,
    dispose: () => root.remove(),
  };
}
