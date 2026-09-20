// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileResult } from '../src/client/dsh-adapter/workspace-entry.js';

const mocks = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock('@milkdown/crepe', () => ({ Crepe: class {
  static Feature = { Latex: 'latex', Placeholder: 'placeholder' };
  destroy = vi.fn(async () => {});
  value: string;
  constructor(public options: any) { this.value = options.defaultValue; mocks.instances.push(this); }
  on(fn: any) { fn({ markdownUpdated: () => {} }); }
  async create() {}
  getMarkdown() { return this.value; }
} }));

const { apply } = await import('../src/client/index.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function source<T>(snapshot: T) {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

/** 造一个带 DSH center column 锚点的页面。 */
function page() {
  document.body.replaceChildren();
  const center = document.createElement('div');
  center.dataset.center = '';
  const main = document.createElement('div');
  main.setAttribute('data-slot', 'main');
  const conversation = document.createElement('div');
  conversation.setAttribute('data-slot', 'main.conversation');
  main.appendChild(conversation);
  center.appendChild(main);
  const anchor = document.createElement('div');
  anchor.setAttribute('data-rightbar-col', '');
  document.body.append(center, anchor);
  return center;
}

function context(profile: ProfileResult, workspaceId: string, sessionId: string) {
  const service = {
    getWorkspaceProfile: vi.fn(async () => profile),
    setWorkspaceProfile: vi.fn(async () => profile),
    listDocuments: vi.fn(async () => ({ schemaVersion: 1 as const, documents: [] })),
    saveDocument: vi.fn(),
    readDocumentContent: vi.fn(),
    addExistingDocument: vi.fn(),
    detachDocument: vi.fn(),
    removeDocument: vi.fn(),
  };
  return {
    slots: { inject: (_name: string, factory: () => unknown) => factory(), register: () => () => {} },
    workspaces: { list: source({ items: [{ workspaceId, title: 'W', sessionIds: [sessionId] }], phase: 'ready' as const }) },
    sessions: { list: source({ current: sessionId, phase: 'ready' as const }) },
    uiWorkspace: { pickDirectory: async () => null, openWorkspace: async () => {} },
    remote: { $mount: async () => () => {} },
    get: (name: string) => name === 'remote.sift' ? service : undefined,
    effect: (factory: () => unknown) => { factory(); },
    service,
  };
}

function profile(overrides: Partial<ProfileResult>): ProfileResult {
  return { workspaceId: 'ws-1', title: 'W', profile: 'sift', status: 'ready', ...overrides };
}

/**
 * 每个用例用独立的工作区 id：editor 的未保存草稿按工作区缓存在模块里，
 * 共用同一个 id 会让后面的用例直接复用前一个用例的草稿。
 */
let sequence = 0;
function fresh() {
  const id = ++sequence;
  return { workspaceId: `ws-${id}`, sessionId: `s-${id}` };
}

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mocks.instances.length = 0;
  localStorage.clear();
  document.head.querySelectorAll('style[data-sift-layout]').forEach(node => node.remove());
});

describe('Sift 界面接线', () => {
  it('sift 工作区挂上参考、文档两栏并保留原生对话插槽', async () => {
    const center = page();
    const ids = fresh();
    apply(context(profile({ profile: 'sift', status: 'ready' }), ids.workspaceId, ids.sessionId) as never);
    await tick(); await tick();

    expect(center.hasAttribute('data-sift-three-column')).toBe(true);
    expect(center.querySelector('[data-sift-column="reference"]')).not.toBeNull();
    expect(center.querySelector('[data-sift-column="document"]')).not.toBeNull();
    expect(center.querySelector('[data-sift-reference-empty]')).not.toBeNull();
    // 原生对话节点必须原地保留，只是被排到第三栏。
    expect(center.querySelector('[data-slot="main.conversation"]')).not.toBeNull();
    expect(center.querySelector('[data-slot="main"]')).not.toBeNull();
  });

  it('default 工作区完全不受影响', async () => {
    const center = page();
    const ids = fresh();
    apply(context(profile({ profile: 'default', status: 'ready' }), ids.workspaceId, ids.sessionId) as never);
    await tick(); await tick();

    expect(center.hasAttribute('data-sift-three-column')).toBe(false);
    expect(center.querySelector('[data-sift-column]')).toBeNull();
    expect(center.querySelector('[data-sift-layout-toolbar]')).toBeNull();
    expect(center.querySelectorAll('[data-slot="main"]')).toHaveLength(1);
  });

  it('配置缺失或损坏时也回落到原生界面', async () => {
    for (const status of ['missing', 'invalid'] as const) {
      const center = page();
      const ids = fresh();
      apply(context(profile({ profile: 'sift', status }), ids.workspaceId, ids.sessionId) as never);
      await tick(); await tick();
      expect(center.hasAttribute('data-sift-three-column')).toBe(false);
    }
  });

  it('找不到 center column 锚点时放弃启用三栏', async () => {
    document.body.replaceChildren();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids = fresh();
    apply(context(profile({ profile: 'sift', status: 'ready' }), ids.workspaceId, ids.sessionId) as never);
    await tick(); await tick();
    expect(document.querySelector('[data-sift-column]')).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('center column 锚点'));
    error.mockRestore();
  });

  it('sift 界面里直接打开未命名的 Document', async () => {
    page();
    const ids = fresh();
    const ctx = context(profile({ profile: 'sift', status: 'ready' }), ids.workspaceId, ids.sessionId);
    apply(ctx as never);
    await tick(); await tick();

    expect(ctx.service.listDocuments).toHaveBeenCalledWith({ workspaceId: ids.workspaceId });
    expect(mocks.instances).toHaveLength(1);
    expect(document.querySelector('[data-sift-document-path]')?.textContent).toBe('尚未保存为文件');
    // 没有登记表内容时不应该写任何东西。
    expect(ctx.service.saveDocument).not.toHaveBeenCalled();
  });
});
