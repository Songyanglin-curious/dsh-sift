// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileResult } from '../src/client/dsh-adapter/workspace-entry.js';
import { installWorkspaceTypeCreator } from '../src/client/index.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** jsdom 的 getBoundingClientRect 全是 0，会导致点击层按零尺寸隐藏；测试里给一个真实矩形。 */
function withRect(button: HTMLButtonElement) {
  button.getBoundingClientRect = () => ({
    x: 10, y: 10, width: 28, height: 28, top: 10, left: 10, right: 38, bottom: 38, toJSON: () => ({}),
  } as DOMRect);
  return button;
}

function addNativeButton() {
  const button = document.createElement('button');
  button.setAttribute('aria-label', '添加工作区');
  withRect(button);
  document.body.appendChild(button);
  return button;
}

function setup() {
  const ctx = {
    uiWorkspace: {
      pickDirectory: vi.fn(async () => 'D:\\tmp\\ws'),
      openWorkspace: vi.fn(async () => {}),
    },
    workspaces: {
      create: vi.fn(async ({ path }: { path: string }) => ({ workspaceId: 'ws-new', title: 'ws', path, sessionIds: [] })),
    },
  };
  const setProfile = vi.fn(async (): Promise<ProfileResult> => ({ workspaceId: 'ws-new', title: 'ws', profile: 'default', status: 'ready' }));
  const button = addNativeButton();
  const dispose = installWorkspaceTypeCreator(ctx as never, setProfile);
  return { ctx, setProfile, button, dispose };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe('工作区类型选择接管', () => {
  it('不修改原生按钮，在其上方创建透明点击层', () => {
    const { button } = setup();
    expect(button.hidden).toBe(false);
    expect(button.dataset.siftCreatorLayer).toBe('');
    expect(button.nextElementSibling).toBeNull();
    const layer = document.querySelector('[data-sift-create-layer]');
    expect(layer).not.toBeNull();
    expect(layer?.getAttribute('aria-label')).toBe('添加工作区（选择类型）');
  });

  it('点击层弹出类型选择对话框，sift 默认选中', () => {
    const { button } = setup();
    document.querySelector('[data-sift-create-layer]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const overlay = document.querySelector('[data-sift-workspace-creator]');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelectorAll('[data-profile]')).toHaveLength(2);
    expect(overlay?.querySelector('[data-profile="sift"]')?.hasAttribute('data-selected')).toBe(true);
    // 对话框有样式挂载点（修掉"隐形弹窗"回归的锚点）。
    expect(overlay?.querySelector('[data-sift-dialog]')).not.toBeNull();
    void button;
  });

  it('选择 default 后创建：目录 → 建工作区 → 写类型 → 打开', async () => {
    const { ctx, setProfile } = setup();
    document.querySelector('[data-sift-create-layer]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.querySelector<HTMLElement>('[data-profile="default"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="create"]')?.click();
    await tick(); await tick();
    expect(ctx.uiWorkspace.pickDirectory).toHaveBeenCalled();
    expect(ctx.workspaces.create).toHaveBeenCalledWith({ path: 'D:\\tmp\\ws' });
    expect(setProfile).toHaveBeenCalledWith({ workspaceId: 'ws-new', profile: 'default' });
    expect(ctx.uiWorkspace.openWorkspace).toHaveBeenCalledWith('ws-new');
    expect(document.querySelector('[data-sift-workspace-creator]')).toBeNull();
  });

  it('取消关闭弹窗且不触发目录选择', () => {
    const { ctx } = setup();
    document.querySelector('[data-sift-create-layer]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.querySelector<HTMLElement>('[data-action="cancel"]')?.click();
    expect(document.querySelector('[data-sift-workspace-creator]')).toBeNull();
    expect(ctx.uiWorkspace.pickDirectory).not.toHaveBeenCalled();
  });

  it('原生按钮被 React 重建后重新接管新按钮', async () => {
    const { button } = setup();
    const oldLayer = document.querySelector('[data-sift-create-layer]');
    const next = addNativeButton();
    button.remove();
    // MutationObserver 回调在微任务里触发。
    await tick(); await tick();
    expect(oldLayer?.isConnected).toBe(false);
    const layer = document.querySelector('[data-sift-create-layer]');
    expect(layer).not.toBeNull();
    layer?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('[data-sift-workspace-creator]')).not.toBeNull();
    void next;
  });

  it('dispose 移除点击层与样式并摘除按钮标记', () => {
    const { button, dispose } = setup();
    dispose();
    expect(document.querySelector('[data-sift-create-layer]')).toBeNull();
    expect(document.querySelector('style[data-sift-creator]')).toBeNull();
    expect(button.dataset.siftCreatorLayer).toBeUndefined();
  });
});
