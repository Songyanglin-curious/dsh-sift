// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canvasRefresh: vi.fn(), canvasNotify: vi.fn(), canvasAdd: vi.fn(),
  selectorOptions: undefined as undefined | { onSave(selected: string[]): void | Promise<void> },
}));

vi.mock('../src/client/renderer/canvas.js', () => ({
  mountCanvas: () => ({ refresh: mocks.canvasRefresh, notify: mocks.canvasNotify, addFromClipboard: mocks.canvasAdd, dispose: vi.fn() }),
}));
vi.mock('../src/client/renderer/inject-style.js', () => ({ SIFT_PLUGIN_ID: 'sift', injectStyle: () => vi.fn() }));
vi.mock('../src/client/reference/reference-edit.js', () => ({ mountReferenceEditor: () => vi.fn(), triggerEdit: vi.fn() }));
vi.mock('../src/client/renderer/card-edit.js', () => ({ mountCardEditor: () => vi.fn(), triggerCardEdit: vi.fn() }));
vi.mock('../src/client/reference/ref-selector.js', () => ({
  mountRefSelector: () => vi.fn(),
  triggerRefSelector: (options: { onSave(selected: string[]): void | Promise<void> }) => { mocks.selectorOptions = options; },
}));

import { mountReferencePanel, type ReferenceApi } from '../src/client/reference/panel.js';
import { WorkspaceController } from '../src/client/workspace-controller.js';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function createFixture(initial: Array<{ path: string; name: string; description: string }> = [], workspace?: WorkspaceController) {
  const existing = { path: 'references/existing.json', name: '已有材料', description: '', cards: [] };
  const created = { path: 'references/new.json', name: '文章参考', description: '', cards: [] };
  const conversation = {
    path: 'references/talk.json',
    name: '一次会话',
    description: '',
    kind: 'conversation' as const,
    source: { type: 'conversation' as const, uri: 'talk.md', format: 'chatgpt-markdown' as const, importedAt: '2026-10-12T00:00:00.000Z' },
    groups: [{
      id: 'q-001',
      user: { content: '旧问题' },
      assistant: { content: '旧回答', name: 'Assistant' },
      sourceRange: { startLine: 1, endLine: 2 },
      collapsed: true,
      contextDependency: 'standalone' as const,
    }],
    warnings: [],
    analysis: {
      anchorGroupId: 'q-001',
      model: { provider: 'tokenhub', model: 'deepseek-v4-flash' },
      createdAt: '2026-10-12T00:00:00.000Z',
      items: [{ groupId: 'q-001', relevance: 'strong' as const, continuity: 'none' as const, contextDependency: 'standalone' as const, evidenceGroupIds: [], reason: '旧结果' }],
    },
  };
  let listed = [...initial];
  const docs = new Map([[existing.path, existing], [created.path, created], [conversation.path, conversation]]);
  const api = {
    listReferences: vi.fn(async () => listed),
    loadReference: vi.fn(async (path: string) => docs.get(path)!),
    createReference: vi.fn(async () => { listed = [...listed, created]; return { path: created.path }; }),
    importConversationReference: vi.fn(async () => { listed = [...listed, conversation]; return { path: conversation.path }; }),
    saveReference: vi.fn(async () => {}),
    analyzeConversation: vi.fn(async () => conversation),
    analyzeConversationTopic: vi.fn(async () => conversation),
    removeReference: vi.fn(async (path: string) => { listed = listed.filter(item => item.path !== path); }),
    pickSourceFiles: vi.fn(async () => ({ paths: ['talk.md'], cancelled: false })), openSourcePath: vi.fn(async () => {}),
  } satisfies ReferenceApi;
  const section = document.createElement('section'); document.body.append(section);
  const dispose = mountReferencePanel(section, { api, ...(workspace ? { workspace } : {}) });
  return { api, section, dispose, existing, created, conversation };
}

describe('当前文章参考交互', () => {
  beforeEach(() => { mocks.canvasRefresh.mockClear(); mocks.canvasNotify.mockClear(); mocks.canvasAdd.mockClear(); mocks.selectorOptions = undefined; });
  afterEach(() => { document.body.replaceChildren(); });

  it('空文章不创建内部 Reference，并显示直接操作入口', async () => {
    const fixture = createFixture(); await flush();
    expect(fixture.api.createReference).not.toHaveBeenCalled();
    expect(fixture.section.querySelector('[data-sift-ref-empty]')?.textContent).toContain('暂无参考');
    expect(fixture.section.querySelector('[data-sift-empty-paste]')).not.toBeNull();
    expect(fixture.section.querySelector('[data-sift-ref-tabs]')).toBeNull();
    fixture.dispose();
  });

  it('首次粘贴会自动创建文章参考、建立关系并写入卡片', async () => {
    const relations = new Map([['article.md', { exists: true, references: [] as string[] }]]);
    const workspace = new WorkspaceController({
      getDocumentRelations: async ({ target }) => relations.get(target) ?? { exists: false, references: [] },
      setDocumentRelations: async ({ target, references }) => { relations.set(target, { exists: true, references: [...references] }); },
    });
    await workspace.setActiveOutput('article.md');
    const fixture = createFixture([], workspace); await flush();
    (fixture.section.querySelector('[data-sift-empty-paste]') as HTMLButtonElement).click(); await flush(); await flush();
    expect(fixture.api.createReference).toHaveBeenCalledOnce();
    expect(relations.get('article.md')?.references).toEqual([fixture.created.path]);
    expect(mocks.canvasAdd).toHaveBeenCalledOnce();
    fixture.dispose();
  });

  it('添加已有材料后直接显示内容，不再创建标签栏', async () => {
    const fixture = createFixture([fixturePlaceholder]); await flush();
    (fixture.section.querySelector('[data-sift-empty-existing]') as HTMLButtonElement).click();
    await mocks.selectorOptions?.onSave([fixture.existing.path]); await flush();
    expect(fixture.api.loadReference).toHaveBeenCalledWith(fixture.existing.path);
    expect(fixture.section.querySelector('[data-sift-reference-name]')?.textContent).toBe('已有材料');
    expect(fixture.section.querySelector('[data-sift-ref-tabs]')).toBeNull();
    fixture.dispose();
  });

  it('导入会话入口直接建立当前文章关联', async () => {
    const relations = new Map([['article.md', { exists: true, references: [] as string[] }]]);
    const workspace = new WorkspaceController({ getDocumentRelations: async ({ target }) => relations.get(target)!, setDocumentRelations: async ({ target, references }) => { relations.set(target, { exists: true, references: [...references] }); } });
    await workspace.setActiveOutput('article.md'); const fixture = createFixture([], workspace); await flush();
    (fixture.section.querySelector('[data-sift-empty-conversation]') as HTMLButtonElement).click(); await flush(); await flush();
    expect(fixture.api.importConversationReference).toHaveBeenCalledWith('talk.md');
    expect(relations.get('article.md')?.references).toEqual([fixture.conversation.path]);
    fixture.dispose();
  });

  it('多份旧参考只使用选择器切换，不恢复五图标工具栏', async () => {
    const refA = { path: 'references/a.json', name: '参考 A', description: '' };
    const refB = { path: 'references/b.json', name: '参考 B', description: '' };
    const relations = new Map([['article.md', { exists: true, references: [refA.path, refB.path] }]]);
    const workspace = new WorkspaceController({ getDocumentRelations: async ({ target }) => relations.get(target)!, setDocumentRelations: async () => {} });
    await workspace.setActiveOutput('article.md');
    const fixture = createFixture([refA, refB], workspace);
    vi.mocked(fixture.api.loadReference).mockImplementation(async path => ({ ...(path === refA.path ? refA : refB), cards: [] }));
    await flush(); await flush();
    expect(fixture.section.querySelectorAll('[data-sift-reference-switch] option')).toHaveLength(2);
    expect(fixture.section.querySelector('[data-sift-ref-add-ref]')).toBeNull();
    expect(fixture.section.querySelector('[data-sift-ref-edit]')).toBeNull();
    expect(fixture.section.querySelector('[data-sift-ref-delete]')).toBeNull();
    fixture.dispose();
  });

  it('取消会话分析时中止请求并保留旧分析结果', async () => {
    const relations = new Map([['article.md', { exists: true, references: ['references/talk.json'] }]]);
    const workspace = new WorkspaceController({
      getDocumentRelations: async ({ target }) => relations.get(target)!,
      setDocumentRelations: async () => {},
    });
    await workspace.setActiveOutput('article.md');
    const fixture = createFixture([{ path: 'references/talk.json', name: '一次会话', description: '' }], workspace);
    fixture.api.analyzeConversation.mockImplementation((_path, _groupId, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await flush();
    expect(fixture.section.querySelector('.sift-conversation-analyze')?.textContent).toBe('已分析');
    fixture.section.querySelector<HTMLButtonElement>('.sift-conversation-analyze')?.click();
    await flush();
    expect(fixture.section.querySelector('.sift-conversation-analyze')?.textContent).toBe('分析中…');
    expect(fixture.section.querySelector('[data-sift-conversation-group="q-001"]')?.getAttribute('data-relevance')).toBe('strong');
    fixture.section.querySelector<HTMLButtonElement>('.sift-conversation-analysis-status button')?.click();
    await flush();
    expect(mocks.canvasNotify).toHaveBeenCalledWith('已取消分析，已保留上一次结果。');
    expect(fixture.section.querySelector('.sift-conversation-analyze')?.textContent).toBe('已分析');
    fixture.dispose();
  });

  it('会话分析超过 60 秒时自动中止并保留旧分析结果', async () => {
    const relations = new Map([['article.md', { exists: true, references: ['references/talk.json'] }]]);
    const workspace = new WorkspaceController({
      getDocumentRelations: async ({ target }) => relations.get(target)!,
      setDocumentRelations: async () => {},
    });
    await workspace.setActiveOutput('article.md');
    const fixture = createFixture([{ path: 'references/talk.json', name: '一次会话', description: '' }], workspace);
    fixture.api.analyzeConversation.mockImplementation((_path, _groupId, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await flush();
    vi.useFakeTimers();
    fixture.section.querySelector<HTMLButtonElement>('.sift-conversation-analyze')?.click();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.canvasNotify).toHaveBeenCalledWith('分析已超时（60 秒），已保留上一次结果。');
    expect(fixture.section.querySelector('.sift-conversation-analyze')?.textContent).toBe('已分析');
    fixture.dispose();
    vi.useRealTimers();
  });
});

const fixturePlaceholder = { path: 'references/existing.json', name: '已有材料', description: '' };
