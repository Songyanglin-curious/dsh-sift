// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CARD_CONTENT_LIMIT, mountReferenceBoard, referenceOrigin, truncateContent, type ReferenceCardView } from '../src/client/reference/board.js';

const card: ReferenceCardView = {
  id: 'R1',
  title: 'Workspace 与实际目录绑定',
  content: 'Workspace 注册的是已有目录，不复制文件。',
  sourceTitle: 'architecture.md',
  locator: 'L120-L150',
};

describe('卡片内容截断', () => {
  it('短内容原样返回', () => {
    expect(truncateContent('  短文  ')).toBe('短文');
  });

  it('超过上限时截断并补省略号', () => {
    const long = 'a'.repeat(CARD_CONTENT_LIMIT + 50);
    const result = truncateContent(long);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(CARD_CONTENT_LIMIT + 1);
  });

  it('允许自定义上限', () => {
    expect(truncateContent('abcdef', 3)).toBe('abc…');
  });
});

describe('来源行', () => {
  it('组合来源标题与定位', () => {
    expect(referenceOrigin(card)).toBe('来源：architecture.md · L120-L150');
  });

  it('只有其中一项时只显示那一项', () => {
    expect(referenceOrigin({ ...card, locator: undefined })).toBe('来源：architecture.md');
    expect(referenceOrigin({ ...card, sourceTitle: undefined })).toBe('来源：L120-L150');
  });

  it('没有来源时不产生来源行', () => {
    expect(referenceOrigin({ ...card, sourceTitle: undefined, locator: undefined })).toBe('');
    expect(referenceOrigin({ ...card, sourceTitle: '  ', locator: '' })).toBe('');
  });
});

describe('Reference Board', () => {
  it('空状态说明 Reference 是什么', () => {
    const section = document.createElement('section');
    const dispose = mountReferenceBoard(section, { cards: [] });
    const empty = section.querySelector('[data-sift-reference-empty]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('还没有当前参考');
    expect(empty?.textContent).toContain('真正依据');
    expect(section.querySelectorAll('[data-sift-reference-card]')).toHaveLength(0);
    dispose();
    expect(section.querySelector('[data-sift-reference-list]')).toBeNull();
  });

  it('一级展示卡片内容与来源', () => {
    const section = document.createElement('section');
    const dispose = mountReferenceBoard(section, { cards: [card, { id: 'R2', title: '无来源', content: '正文' }] });
    const cards = section.querySelectorAll('[data-sift-reference-card]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('Workspace 与实际目录绑定');
    expect(cards[0]?.textContent).toContain('Workspace 注册的是已有目录');
    expect(cards[0]?.textContent).toContain('来源：architecture.md · L120-L150');
    // 没有来源的卡片不渲染来源行。
    expect(cards[1]?.querySelector('small')).toBeNull();
    expect(section.querySelector('[data-sift-reference-empty]')).toBeNull();
    dispose();
  });

  it('长正文按上限截断后再展示', () => {
    const section = document.createElement('section');
    const dispose = mountReferenceBoard(section, { cards: [{ id: 'R1', title: 'T', content: 'b'.repeat(400) }] });
    const body = section.querySelector('[data-sift-reference-card] p')!;
    expect(body.textContent?.endsWith('…')).toBe(true);
    expect(body.textContent!.length).toBe(CARD_CONTENT_LIMIT + 1);
    dispose();
  });
});
