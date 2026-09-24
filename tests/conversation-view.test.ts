// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mountConversationView } from '../src/client/reference/conversation-view.js';
import type { ConversationReferenceDocument } from '../src/references.js';

const reference: ConversationReferenceDocument = {
  kind: 'conversation',
  name: '并发测试',
  description: '',
  source: { type: 'conversation', uri: 'test.md', format: 'chatgpt-markdown', importedAt: '2026-09-23T00:00:00.000Z' },
  warnings: [],
  groups: [{
    id: 'q-001',
    user: { content: '问题' },
    assistant: { content: '回答', name: 'ChatGPT' },
    sourceRange: { startLine: 1, endLine: 4 },
    collapsed: true,
    contextDependency: 'unknown',
  }],
};

describe('Conversation view', () => {
  it('分析进行时禁用主题输入、主题按钮和所有问答分析按钮', () => {
    const host = document.createElement('div');
    const dispose = mountConversationView(host, reference, vi.fn(), vi.fn(), vi.fn(), true, { type: 'group', groupId: 'q-001' });
    expect(host.querySelector<HTMLInputElement>('[aria-label="会话分析主题"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('.sift-conversation-topic-bar > button')?.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>('.sift-conversation-analyze')].every(button => button.disabled)).toBe(true);
    expect(host.querySelector('.sift-conversation-analyze')?.textContent).toBe('分析中…');
    expect(host.querySelector('[data-sift-conversation-group="q-001"]')?.hasAttribute('data-analyzing')).toBe(true);
    dispose();
  });

  it('主题分析中保留问题、允许继续输入，并可一键清除', () => {
    const host = document.createElement('div');
    const onTopicDraftChange = vi.fn();
    const dispose = mountConversationView(host, reference, vi.fn(), vi.fn(), vi.fn(), true, { type: 'topic', topic: '人的认知带宽' }, '人的认知带宽', onTopicDraftChange);
    const input = host.querySelector<HTMLInputElement>('[aria-label="会话分析主题"]')!;
    expect(input.value).toBe('人的认知带宽');
    expect(input.disabled).toBe(false);
    host.querySelector<HTMLButtonElement>('[aria-label="清除分析主题"]')?.click();
    expect(input.value).toBe('');
    expect(onTopicDraftChange).toHaveBeenLastCalledWith('');
    dispose();
  });

  it('点击定位条时自动展开问答并把顶部对齐到可视区域顶部', async () => {
    const host = document.createElement('div');
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    let dispose: (() => void) | undefined;
    const render = (current: ConversationReferenceDocument) => {
      dispose?.();
      dispose = mountConversationView(host, current, next => render(next), vi.fn(), vi.fn());
    };
    render(reference);
    host.querySelector<HTMLButtonElement>('.sift-conversation-nav-marker')?.click();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(host.querySelector('[data-sift-conversation-group="q-001"]')?.hasAttribute('data-expanded')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest', behavior: 'smooth' });
    dispose?.();
  });
});
