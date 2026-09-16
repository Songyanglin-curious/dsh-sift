// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountReferencePanel } from '../src/client/reference/panel.js';
import type { SourceIndex, SourcesApi } from '../src/sources.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { await tick(); await tick(); };

function emptyApi(): SourcesApi {
  const index = (): SourceIndex => ({ schemaVersion: 1, items: [] });
  return {
    listSources: vi.fn(async () => index()),
    addSource: vi.fn(),
    addExternalFiles: vi.fn(async () => ({ index: index(), added: [], failed: [] })),
    pickSourceFiles: vi.fn(async () => ({ paths: [], cancelled: true })),
    removeSource: vi.fn(async () => index()),
    createSourceFile: vi.fn(),
    browseWorkspace: vi.fn(async () => []),
    browseExternal: vi.fn(async () => []),
  };
}

function mount(sources: SourcesApi, pickDirectory?: () => Promise<string | null>) {
  const section = document.createElement('section');
  document.body.appendChild(section);
  const dispose = mountReferencePanel(section, {
    workspaceId: 'ws-1',
    sources,
    ...(pickDirectory === undefined ? {} : { pickDirectory }),
  });
  return { section, dispose };
}

beforeEach(() => { document.body.replaceChildren(); });

describe('参考栏组合', () => {
  it('保留 Reference Board 的空状态，并给出「从来源获取」入口', () => {
    const { section, dispose } = mount(emptyApi());
    expect(section.querySelector('[data-sift-reference-empty]')).not.toBeNull();
    const button = section.querySelector<HTMLButtonElement>('[data-sift-open-sources]')!;
    expect(button.textContent).toContain('从来源获取');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    dispose();
  });

  it('按钮展开与收起来源抽屉', async () => {
    const sources = emptyApi();
    const { section, dispose } = mount(sources);
    const button = section.querySelector<HTMLButtonElement>('[data-sift-open-sources]')!;
    const drawer = section.querySelector<HTMLElement>('[data-sift-source-drawer]')!;
    expect(drawer.hidden).toBe(true);

    button.click();
    await settle();
    expect(drawer.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(sources.listSources).toHaveBeenCalledWith({ workspaceId: 'ws-1' });

    button.click();
    expect(drawer.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    dispose();
  });

  it('原生文件对话框不可用时，把系统目录选择器作为回落手段透传给抽屉', async () => {
    const pickDirectory = vi.fn(async () => 'D:\\Downloads');
    const sources = emptyApi();
    (sources.pickSourceFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ paths: [], cancelled: true, message: '当前平台不支持原生文件选择。' });
    const { section, dispose } = mount(sources, pickDirectory);
    section.querySelector<HTMLButtonElement>('[data-sift-open-sources]')!.click();
    await settle();
    section.querySelector<HTMLButtonElement>('[data-sift-source-action="add-external"]')!.click();
    await settle();
    section.querySelector<HTMLButtonElement>('[data-sift-source-action="pick-directory"]')!.click();
    await settle();
    expect(pickDirectory).toHaveBeenCalled();
    dispose();
  });

  it('卸载后移除入口、抽屉与看板', () => {
    const { section, dispose } = mount(emptyApi());
    dispose();
    expect(section.querySelector('[data-sift-open-sources]')).toBeNull();
    expect(section.querySelector('[data-sift-source-drawer]')).toBeNull();
    expect(section.querySelector('[data-sift-reference-list]')).toBeNull();
  });
});
