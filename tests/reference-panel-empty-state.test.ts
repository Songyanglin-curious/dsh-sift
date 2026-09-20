// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canvasRefresh: vi.fn(),
  canvasNotify: vi.fn(),
  selectorOptions: undefined as undefined | { onSave(selected: string[]): void },
}));

vi.mock('../src/client/renderer/canvas.js', () => ({
  mountCanvas: () => ({
    refresh: mocks.canvasRefresh,
    notify: mocks.canvasNotify,
    dispose: vi.fn(),
  }),
}));

vi.mock('../src/client/renderer/inject-style.js', () => ({
  SIFT_PLUGIN_ID: 'sift',
  injectStyle: () => vi.fn(),
}));

vi.mock('../src/client/reference/reference-edit.js', () => ({
  mountReferenceEditor: () => vi.fn(),
  triggerEdit: vi.fn(),
}));

vi.mock('../src/client/renderer/card-edit.js', () => ({
  mountCardEditor: () => vi.fn(),
  triggerCardEdit: vi.fn(),
}));

vi.mock('../src/client/reference/ref-selector.js', () => ({
  mountRefSelector: () => vi.fn(),
  triggerRefSelector: (options: { onSave(selected: string[]): void }) => {
    mocks.selectorOptions = options;
  },
}));

import { mountReferencePanel, type ReferenceApi } from '../src/client/reference/panel.js';
import { WorkspaceController } from '../src/client/workspace-controller.js';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function createFixture(initialReferences?: Array<{ path: string; name: string; description: string }>, workspace?: WorkspaceController) {
  const existing = { path: 'references/existing.json', name: '已有参考', description: '' };
  const created = { path: 'references/new.json', name: '未命名参考', description: '', cards: [] };
  const api: ReferenceApi = {
    listReferences: vi.fn().mockResolvedValue(initialReferences ?? [existing]),
    loadReference: vi.fn(async path => path === created.path ? created : { ...existing, cards: [] }),
    createReference: vi.fn().mockResolvedValue({ path: created.path }),
    saveReference: vi.fn().mockResolvedValue(undefined),
    removeReference: vi.fn().mockResolvedValue(undefined),
    pickSourceFiles: vi.fn().mockResolvedValue({ paths: [], cancelled: true }),
    openSourcePath: vi.fn().mockResolvedValue(undefined),
  };
  const section = document.createElement('section');
  document.body.append(section);
  const dispose = mountReferencePanel(section, { api, ...(workspace ? { workspace } : {}) });
  return { api, section, dispose, existing, created };
}

describe('ReferencePanel 启动空状态', () => {
  beforeEach(() => {
    mocks.canvasRefresh.mockClear();
    mocks.canvasNotify.mockClear();
    mocks.selectorOptions = undefined;
  });

  it('取消二次确认时不删除当前 Reference', async () => {
    const confirmDelete = vi.fn(() => false);
    const fixture = createFixture();
    fixture.dispose();
    const section = document.createElement('section');
    document.body.append(section);
    const dispose = mountReferencePanel(section, { api: fixture.api, confirmDelete });
    await flush();
    (section.querySelector('[data-sift-ref-add-ref]') as HTMLButtonElement).click();
    mocks.selectorOptions?.onSave([fixture.existing.path]);
    (section.querySelector('.sift-ref-tab-label') as HTMLButtonElement).click();
    await flush();

    (section.querySelector('[data-sift-ref-delete]') as HTMLButtonElement).click();

    expect(confirmDelete).toHaveBeenCalledWith(fixture.existing.name);
    expect(fixture.api.removeReference).not.toHaveBeenCalled();
    expect(section.querySelector('.sift-ref-tab-label')?.textContent).toBe(fixture.existing.name);
    dispose();
  });

  it('确认后删除物理 Reference 并回到空状态', async () => {
    const fixture = createFixture();
    fixture.dispose();
    const section = document.createElement('section');
    document.body.append(section);
    const dispose = mountReferencePanel(section, { api: fixture.api, confirmDelete: () => true });
    await flush();
    (section.querySelector('[data-sift-ref-add-ref]') as HTMLButtonElement).click();
    mocks.selectorOptions?.onSave([fixture.existing.path]);
    (section.querySelector('.sift-ref-tab-label') as HTMLButtonElement).click();
    await flush();

    (section.querySelector('[data-sift-ref-delete]') as HTMLButtonElement).click();
    await flush();
    await flush();

    expect(fixture.api.removeReference).toHaveBeenCalledWith(fixture.existing.path);
    expect(section.querySelectorAll('.sift-ref-tab')).toHaveLength(0);
    expect((section.querySelector('[data-sift-ref-empty]') as HTMLElement).hidden).toBe(false);
    dispose();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('空工作区不自动创建 Reference', async () => {
    const fixture = createFixture([]);
    await flush();

    expect(fixture.api.createReference).not.toHaveBeenCalled();
    expect(fixture.api.loadReference).not.toHaveBeenCalled();
    expect((fixture.section.querySelector('[data-sift-ref-empty]') as HTMLElement).hidden).toBe(false);

    fixture.dispose();
  });

  it('已有 Reference 也不自动打开或创建', async () => {
    const fixture = createFixture();
    await flush();

    expect(fixture.api.createReference).not.toHaveBeenCalled();
    expect(fixture.api.loadReference).not.toHaveBeenCalled();
    expect(fixture.section.querySelectorAll('.sift-ref-tab')).toHaveLength(0);
    expect(fixture.section.querySelector('[data-sift-ref-empty]')?.textContent).toBe('暂无打开的参考');
    expect((fixture.section.querySelector('[data-sift-ref-empty]') as HTMLElement).hidden).toBe(false);

    fixture.dispose();
  });

  it('显式添加已有 Reference 后才打开并进入 Tab', async () => {
    const fixture = createFixture();
    await flush();

    (fixture.section.querySelector('[data-sift-ref-add-ref]') as HTMLButtonElement).click();
    mocks.selectorOptions?.onSave([fixture.existing.path]);
    await flush();
    (fixture.section.querySelector('.sift-ref-tab-label') as HTMLButtonElement).click();
    await flush();

    expect(fixture.api.loadReference).toHaveBeenCalledWith(fixture.existing.path);
    expect(fixture.section.querySelector('.sift-ref-tab-label')?.textContent).toBe(fixture.existing.name);
    expect((fixture.section.querySelector('[data-sift-ref-empty]') as HTMLElement).hidden).toBe(true);

    fixture.dispose();
  });

  it('显式新建 Reference 后创建文件并进入 Tab', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.api.listReferences).mockResolvedValueOnce([fixture.existing, {
      path: fixture.created.path,
      name: fixture.created.name,
      description: fixture.created.description,
    }]);
    await flush();

    (fixture.section.querySelector('[data-sift-ref-add]') as HTMLButtonElement).click();
    await flush();
    await flush();

    expect(fixture.api.createReference).toHaveBeenCalledTimes(1);
    expect(fixture.api.loadReference).toHaveBeenCalledWith(fixture.created.path);
    expect(fixture.section.querySelector('.sift-ref-tab-label')?.textContent).toBe(fixture.created.name);
    expect((fixture.section.querySelector('[data-sift-ref-empty]') as HTMLElement).hidden).toBe(true);

    fixture.dispose();
  });

  it('有活动 Output 时新建 Reference 会写入当前关系', async () => {
    const relations = new Map([['doc-a', { exists: true, references: [] as string[] }]]);
    const relationApi = {
      getDocumentRelations: vi.fn(async ({ target }: { target: string }) => relations.get(target) ?? { exists: false, references: [] }),
      setDocumentRelations: vi.fn(async ({ target, references }: { target: string; references: string[] }) => {
        relations.set(target, { exists: true, references: [...references] });
      }),
    };
    const workspace = new WorkspaceController(relationApi);
    await workspace.setActiveOutput('doc-a');
    const fixture = createFixture([], workspace);
    vi.mocked(fixture.api.listReferences).mockResolvedValueOnce([{
      path: fixture.created.path,
      name: fixture.created.name,
      description: fixture.created.description,
    }]);
    await flush();
    (fixture.section.querySelector('[data-sift-ref-add]') as HTMLButtonElement).click();
    await flush(); await flush();
    expect(relations.get('doc-a')).toEqual({ exists: true, references: [fixture.created.path] });
    expect(workspace.snapshot().activeReference).toBe(fixture.created.path);
    fixture.dispose();
  });

  it('切换 Output 后左侧 Tabs 只显示该 Output 的关联参考', async () => {
    const refA = { path: 'references/a.json', name: '参考 A', description: '' };
    const refB = { path: 'references/b.json', name: '参考 B', description: '' };
    const relations = new Map([
      ['doc-a', { exists: true, references: [refA.path] }],
      ['doc-b', { exists: true, references: [refB.path] }],
    ]);
    const workspace = new WorkspaceController({
      getDocumentRelations: async ({ target }) => relations.get(target) ?? { exists: false, references: [] },
      setDocumentRelations: async ({ target, references }) => { relations.set(target, { exists: true, references: [...references] }); },
    });
    await workspace.setActiveOutput('doc-a');
    const fixture = createFixture([refA, refB], workspace);
    await flush(); await flush();
    expect([...fixture.section.querySelectorAll('.sift-ref-tab-label')].map(item => item.textContent)).toEqual(['参考 A']);
    await workspace.setActiveOutput('doc-b');
    await flush(); await flush();
    expect([...fixture.section.querySelectorAll('.sift-ref-tab-label')].map(item => item.textContent)).toEqual(['参考 B']);
    fixture.dispose();
  });
});
