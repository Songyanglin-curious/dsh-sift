// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWorkspaceTypeCreator } from '../src/client/index.js';

// Mock DSH Modal：在 jsdom 中渲染为可查询的 DOM 节点。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: ({ open, onClose, title, closeLabel, description, footer, children }: any) => {
    if (!open) return null;
    return (
      <div data-testid="sift-creator-modal">
        <h2>{title}</h2>
        <p>{description}</p>
        <div data-testid="modal-content">{children}</div>
        <div data-testid="footer">{footer}</div>
        <button data-testid="close-btn" onClick={onClose}>{closeLabel}</button>
      </div>
    );
  },
}));

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function addNativeButton() {
  const button = document.createElement('button');
  button.setAttribute('aria-label', '添加工作区');
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
  const setProfile = vi.fn(async ({ workspaceId, profile }: { workspaceId: string; profile: string }) => ({
    workspaceId, title: 'ws', profile, status: 'ready' as const,
  }));
  const button = addNativeButton();
  const dispose = installWorkspaceTypeCreator(ctx as never, setProfile);
  return { ctx, setProfile, button, dispose };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe('工作区类型选择接管', () => {
  it('不修改原生按钮，不插入外来节点', () => {
    const { button } = setup();
    expect(button.hidden).toBe(false);
    expect(button.hasAttribute('data-sift-creator-layer')).toBe(false);
    expect(button.nextElementSibling).toBeNull();
    expect(document.querySelector('[data-sift-create-layer]')).toBeNull();
  });

  it('点击原生按钮弹出 DSH Modal（捕获阶段拦截）', () => {
    const { button } = setup();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const modal = document.querySelector('[data-testid="sift-creator-modal"]');
    expect(modal).not.toBeNull();
    expect(modal?.querySelector('h2')?.textContent).toBe('创建工作区');
    expect(modal?.querySelector('p')?.textContent).toBe('选择这个工作区使用的类型。');
    // Modal 内包含 type 选择按钮
    const types = modal?.querySelectorAll('[data-testid="modal-content"] button');
    expect(types).toBeDefined();
    if (types) expect(types.length).toBeGreaterThanOrEqual(2);
  });

  it('选择 default 后创建：目录 → 建工作区 → 写类型 → 打开', async () => {
    const { ctx, setProfile, button } = setup();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Modal 渲染在 React 微任务里
    await tick(); await tick();

    // 选 default 类型（在 modal 内容区的第一个 button 对应 default）
    const typeButtons = document.querySelectorAll('[data-testid="modal-content"] button');
    (typeButtons[0] as HTMLButtonElement)?.click();

    // 点"选择目录并创建"（footer 里的第二个 button）
    const footerButtons = document.querySelectorAll('[data-testid="footer"] button');
    (footerButtons[1] as HTMLButtonElement)?.click();
    await tick(); await tick();

    expect(ctx.uiWorkspace.pickDirectory).toHaveBeenCalled();
    expect(ctx.workspaces.create).toHaveBeenCalledWith({ path: 'D:\\tmp\\ws' });
    expect(setProfile).toHaveBeenCalledWith({ workspaceId: 'ws-new', profile: 'default' });
    expect(ctx.uiWorkspace.openWorkspace).toHaveBeenCalledWith('ws-new');
    expect(document.querySelector('[data-testid="sift-creator-modal"]')).toBeNull();
  });

  it('取消关闭弹窗且不触发目录选择', () => {
    const { ctx, button } = setup();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-testid="close-btn"]')?.click();
    expect(document.querySelector('[data-testid="sift-creator-modal"]')).toBeNull();
    expect(ctx.uiWorkspace.pickDirectory).not.toHaveBeenCalled();
  });

  it('原生按钮被 React 重建后点击新按钮仍能弹出 Modal（捕获阶段监听无需重新绑定）', () => {
    const { button } = setup();
    const next = addNativeButton();
    button.remove();
    next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('[data-testid="sift-creator-modal"]')).not.toBeNull();
  });

  it('dispose 移除监听，此后点击按钮不弹 Modal', () => {
    const { button, dispose } = setup();
    dispose();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('[data-testid="sift-creator-modal"]')).toBeNull();
  });
});