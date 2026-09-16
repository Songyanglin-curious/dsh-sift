// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSourceDrawer, droppedUrl, isTextLikeFile } from '../src/client/source/drawer.js';
import type { FileEntry, Source, SourceIndex, SourcesApi } from '../src/sources.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { await tick(); await tick(); await tick(); };

function source(overrides: Partial<Source> & Pick<Source, 'id' | 'type' | 'target'>): Source {
  return {
    title: overrides.target.split(/[\\/]/).at(-1)!,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Source;
}

function fakeApi(initial: Source[] = [], listings: Record<string, FileEntry[]> = {}) {
  const items = [...initial];
  let counter = items.length;
  const index = (): SourceIndex => ({ schemaVersion: 1, items: items.map(item => ({ ...item })) });
  let pickResult: { paths: string[]; cancelled: boolean; message?: string } = { paths: [], cancelled: true };
  const api: SourcesApi = {
    listSources: vi.fn(async () => index()),
    addSource: vi.fn(async ({ type, location, target }) => {
      const entry = source({ id: `s-${++counter}`, type, target, ...(location === undefined ? {} : { location }) });
      items.push(entry);
      return { index: index(), source: entry };
    }),
    addExternalFiles: vi.fn(async ({ paths }) => {
      const added = paths.map(path => source({ id: `s-${++counter}`, type: 'file', location: 'external', target: path }));
      items.push(...added);
      return { index: index(), added, failed: [] };
    }),
    pickSourceFiles: vi.fn(async () => pickResult),
    removeSource: vi.fn(async ({ id }) => {
      const position = items.findIndex(item => item.id === id);
      if (position >= 0) items.splice(position, 1);
      return index();
    }),
    createSourceFile: vi.fn(async ({ name, content }) => {
      const entry = source({ id: `s-${++counter}`, type: 'file', location: 'workspace', target: `${name}.md` });
      items.push(entry);
      return { index: index(), source: entry };
    }),
    browseWorkspace: vi.fn(async ({ path }) => listings[`ws:${path}`] ?? []),
    browseExternal: vi.fn(async ({ path }) => listings[`ext:${path}`] ?? []),
  };
  return {
    api,
    items,
    /** 让下一次原生文件对话框返回这些路径。 */
    willPick: (result: { paths: string[]; cancelled: boolean; message?: string }) => { pickResult = result; },
  };
}

function mount(api: SourcesApi, extras: { pickDirectory?: () => Promise<string | null>; onSelectionChange?: (ids: readonly string[]) => void } = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const drawer = mountSourceDrawer(host, { workspaceId: 'ws-1', api, ...extras });
  return { host, drawer };
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

beforeEach(() => { document.body.replaceChildren(); });

describe('Source Drawer', () => {
  it('默认收起，展开时读取来源', async () => {
    const f = fakeApi([source({ id: 's-1', type: 'file', location: 'workspace', target: 'docs/fiber.md', title: 'fiber.md' })]);
    const { host, drawer } = mount(f.api);
    expect(drawer.isOpen()).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-sift-source-drawer]')!.hidden).toBe(true);

    drawer.open();
    await settle();
    expect(drawer.isOpen()).toBe(true);
    expect(f.api.listSources).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    const row = host.querySelector('[data-sift-source-id="s-1"]')!;
    expect(row.textContent).toContain('fiber.md');
    expect(row.textContent).toContain('工作区 · docs/fiber.md');
    expect(host.querySelector<HTMLElement>('[data-sift-source-empty]')!.hidden).toBe(true);
    drawer.dispose();
  });

  it('没有来源时给出空状态', async () => {
    const f = fakeApi();
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();
    expect(host.querySelector<HTMLElement>('[data-sift-source-empty]')!.hidden).toBe(false);
    expect(host.querySelector('[data-sift-source-list]')!.children).toHaveLength(0);
    drawer.dispose();
  });

  it('多选后把选中集合交给外部', async () => {
    const changes: (readonly string[])[] = [];
    const f = fakeApi([
      source({ id: 's-1', type: 'file', location: 'workspace', target: 'a.md' }),
      source({ id: 's-2', type: 'url', target: 'https://example.com' }),
    ]);
    const { host, drawer } = mount(f.api, { onSelectionChange: ids => changes.push(ids) });
    drawer.open();
    await settle();
    const boxes = [...host.querySelectorAll<HTMLInputElement>('[data-sift-source-list] input[type=checkbox]')];
    boxes[0]!.checked = true; boxes[0]!.dispatchEvent(new Event('change'));
    boxes[1]!.checked = true; boxes[1]!.dispatchEvent(new Event('change'));
    boxes[0]!.checked = false; boxes[0]!.dispatchEvent(new Event('change'));
    expect(changes).toEqual([['s-1'], ['s-1', 's-2'], ['s-2']]);
    expect(drawer.selection()).toEqual(['s-2']);
    drawer.dispose();
  });

  it('添加网页后刷新列表并回到列表视图', async () => {
    const f = fakeApi();
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();

    host.querySelector<HTMLButtonElement>('[data-sift-source-action="add-url"]')!.click();
    const input = host.querySelector<HTMLInputElement>('[data-sift-source-url]')!;
    input.value = 'https://example.com/doc';
    submit(input.closest('form')!);
    await settle();

    expect(f.api.addSource).toHaveBeenCalledWith({ workspaceId: 'ws-1', type: 'url', target: 'https://example.com/doc' });
    expect(f.items).toHaveLength(1);
    expect(host.querySelector('[data-sift-source-list]')!.children).toHaveLength(1);
    // 回到列表视图后表单不再存在。
    expect(host.querySelector('[data-sift-source-url]')).toBeNull();
    drawer.dispose();
  });

  it('粘贴内容创建并登记工作区文件', async () => {
    const f = fakeApi();
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();

    host.querySelector<HTMLButtonElement>('[data-sift-source-action="add-paste"]')!.click();
    host.querySelector<HTMLInputElement>('[data-sift-source-paste-name]')!.value = 'remote-notes';
    host.querySelector<HTMLTextAreaElement>('[data-sift-source-paste-content]')!.value = '来自远端的内容';
    submit(host.querySelector<HTMLFormElement>('[data-sift-source-view] form')!);
    await settle();

    expect(f.api.createSourceFile).toHaveBeenCalledWith({ workspaceId: 'ws-1', name: 'remote-notes', content: '来自远端的内容' });
    expect(f.items[0]?.target).toBe('remote-notes.md');
    drawer.dispose();
  });

  it('工作区浏览器：进入子目录并挑中文件后登记', async () => {
    const f = fakeApi([], {
      'ws:': [{ name: 'docs', path: 'docs', directory: true }],
      'ws:docs': [{ name: 'fiber.md', path: 'docs/fiber.md', directory: false }],
    });
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();

    host.querySelector<HTMLButtonElement>('[data-sift-source-action="add-workspace"]')!.click();
    await settle();
    expect(f.api.browseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-1', path: '' });
    const directory = host.querySelector<HTMLButtonElement>('[data-sift-source-entry="docs"] button')!;
    expect(directory.textContent).toContain('📁');

    directory.click();
    await settle();
    expect(f.api.browseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-1', path: 'docs' });

    host.querySelector<HTMLButtonElement>('[data-sift-source-entry="docs/fiber.md"] button')!.click();
    await settle();
    expect(f.api.addSource).toHaveBeenCalledWith({ workspaceId: 'ws-1', type: 'file', location: 'workspace', target: 'docs/fiber.md' });
    expect(host.querySelector('[data-sift-source-list]')!.children).toHaveLength(1);
    drawer.dispose();
  });

  it('本机文件：一次原生多选对话框把选中的文件全部登记为 external', async () => {
    const f = fakeApi();
    f.willPick({ paths: ['D:\\Downloads\\61850.pdf', 'D:\\Downloads\\spec.docx'], cancelled: false });
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();

    host.querySelector<HTMLButtonElement>('[data-sift-source-action="add-external"]')!.click();
    await settle();

    expect(f.api.pickSourceFiles).toHaveBeenCalled();
    expect(f.api.addExternalFiles).toHaveBeenCalledWith({ workspaceId: 'ws-1', paths: ['D:\\Downloads\\61850.pdf', 'D:\\Downloads\\spec.docx'] });
    expect(f.items.map(item => item.target)).toEqual(['D:\\Downloads\\61850.pdf', 'D:\\Downloads\\spec.docx']);
    expect(host.querySelector('[data-sift-source-list]')!.children).toHaveLength(2);
    drawer.dispose();
  });

  it('用户取消原生对话框时不登记任何东西', async () => {
    const f = fakeApi();
    f.willPick({ paths: [], cancelled: true });
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-sift-source-action="add-external"]')!.click();
    await settle();
    expect(f.api.addExternalFiles).not.toHaveBeenCalled();
    expect(f.items).toHaveLength(0);
    drawer.dispose();
  });

  it('原生对话框不可用时回落到目录浏览并说明原因', async () => {
    const f = fakeApi([], { 'ext:D:\\Downloads': [{ name: '61850.pdf', path: 'D:\\Downloads\\61850.pdf', directory: false }] });
    f.willPick({ paths: [], cancelled: true, message: '当前平台（linux）暂不支持原生文件选择，请改用目录浏览或直接填写路径。' });
    const pickDirectory = vi.fn(async () => 'D:\\Downloads');
    const { host, drawer } = mount(f.api, { pickDirectory });
    drawer.open();
    await settle();

    host.querySelector<HTMLButtonElement>('[data-sift-source-action="add-external"]')!.click();
    await settle();
    expect(host.querySelector<HTMLElement>('[data-sift-source-error]')!.textContent).toContain('暂不支持原生文件选择');
    expect(host.querySelector('[data-sift-source-path]')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('[data-sift-source-action="pick-directory"]')!.click();
    await settle();
    expect(pickDirectory).toHaveBeenCalled();
    expect(f.api.browseExternal).toHaveBeenCalledWith({ path: 'D:\\Downloads' });
    const target = [...host.querySelectorAll<HTMLElement>('[data-sift-source-entry]')]
      .find(node => node.dataset.siftSourceEntry === 'D:\\Downloads\\61850.pdf');
    target!.querySelector('button')!.click();
    await settle();
    expect(f.api.addSource).toHaveBeenCalledWith({ workspaceId: 'ws-1', type: 'file', location: 'external', target: 'D:\\Downloads\\61850.pdf' });
    drawer.dispose();
  });

  it('移除只调用 removeSource，不碰原文件', async () => {
    const f = fakeApi([source({ id: 's-1', type: 'file', location: 'workspace', target: 'a.md' })]);
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-sift-source-id="s-1"] [data-sift-source-action="remove"]')!.click();
    await settle();
    expect(f.api.removeSource).toHaveBeenCalledWith({ workspaceId: 'ws-1', id: 's-1' });
    expect(host.querySelector('[data-sift-source-list]')!.children).toHaveLength(0);
    drawer.dispose();
  });

  it('失败时显示原因而不是静默失败', async () => {
    const f = fakeApi();
    (f.api.addSource as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('请输入不含账号密码的 HTTP 或 HTTPS 网页地址。'));
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-sift-source-action="add-url"]')!.click();
    const input = host.querySelector<HTMLInputElement>('[data-sift-source-url]')!;
    input.value = 'ftp://example.com';
    submit(input.closest('form')!);
    await settle();
    const error = host.querySelector<HTMLElement>('[data-sift-source-error]')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('HTTP 或 HTTPS');
    expect(f.items).toHaveLength(0);
    drawer.dispose();
  });

  it('卸载后移除抽屉节点', async () => {
    const f = fakeApi();
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();
    drawer.dispose();
    expect(host.querySelector('[data-sift-source-drawer]')).toBeNull();
  });
});

describe('拖入', () => {
  it('识别文本类文件', () => {
    expect(isTextLikeFile({ name: 'notes.md' })).toBe(true);
    expect(isTextLikeFile({ name: 'X.TXT' })).toBe(true);
    expect(isTextLikeFile({ name: 'a.json', type: 'application/json' })).toBe(true);
    expect(isTextLikeFile({ name: 'blob', type: 'text/plain' })).toBe(true);
    expect(isTextLikeFile({ name: '61850.pdf', type: 'application/pdf' })).toBe(false);
    expect(isTextLikeFile({ name: 'photo.png' })).toBe(false);
  });

  it('从拖放数据里挑出第一个 http 地址', () => {
    expect(droppedUrl(() => 'https://example.com/a\nhttps://example.com/b')).toBe('https://example.com/a');
    expect(droppedUrl(format => format === 'text/plain' ? 'https://example.com/x' : '')).toBe('https://example.com/x');
    expect(droppedUrl(() => 'file:///c:/x')).toBeUndefined();
    expect(droppedUrl(() => '')).toBeUndefined();
  });

  const drop = (target: HTMLElement, data: { text?: string; files?: readonly { name: string; type?: string; text(): Promise<string> }[] }) => {
    const event = new Event('drop', { cancelable: true, bubbles: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { getData: () => data.text ?? '', files: data.files ?? [] },
    });
    target.dispatchEvent(event);
  };

  it('拖入网页地址直接登记为网页来源', async () => {
    const f = fakeApi();
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();
    drop(host.querySelector('[data-sift-source-drawer]')!, { text: 'https://example.com/doc' });
    await settle();
    expect(f.api.addSource).toHaveBeenCalledWith({ workspaceId: 'ws-1', type: 'url', target: 'https://example.com/doc' });
    drawer.dispose();
  });

  it('拖入本地文本文件时把内容导入工作区', async () => {
    const f = fakeApi();
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();
    drop(host.querySelector('[data-sift-source-drawer]')!, {
      files: [{ name: 'dropped.md', text: async () => '# 拖进来的内容' }],
    });
    await settle();
    expect(f.api.createSourceFile).toHaveBeenCalledWith({ workspaceId: 'ws-1', name: 'dropped.md', content: '# 拖进来的内容' });
    drawer.dispose();
  });

  it('拖入二进制文件时提示改用文件对话框，不做导入', async () => {
    const f = fakeApi();
    const { host, drawer } = mount(f.api);
    drawer.open();
    await settle();
    drop(host.querySelector('[data-sift-source-drawer]')!, {
      files: [{ name: '61850.pdf', type: 'application/pdf', text: async () => 'binary' }],
    });
    await settle();
    expect(f.api.createSourceFile).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLElement>('[data-sift-source-error]')!.textContent).toContain('二进制文件');
    drawer.dispose();
  });
});
