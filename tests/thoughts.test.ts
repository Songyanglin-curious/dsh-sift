import { describe, expect, it } from 'vitest';
import { detectEnd, detectOffset, formatThought, thoughtLabel, thoughtRef } from '../src/client/thoughts/model.js';

describe('本轮想法', () => {
  it('把用户想法作为主体，并附带区域、来源和选中信息', () => {
    expect(formatThought({
      id: 't1', area: 'reference', sourceId: 'r1#c1', sourceName: '关系设计',
      selectedText: '切换只读取关系。', thought: '这是实际边界。',
    })).toContain('【本轮想法｜参考：关系设计】\n选中信息：\n切换只读取关系。\n\n我的想法：\n这是实际边界。');
  });

  it('chip 标签保持简短，但引用身份包含会话隔离', () => {
    expect(thoughtLabel('  这是一条   很短的想法  ')).toBe('想法：这是一条 很短的想法');
    expect(thoughtLabel('这是一个非常非常非常非常非常非常非常非常长的想法')).toMatch(/^想法：.{22}…$/u);
    expect(thoughtRef('session-a', 'thought-1')).toBe('session-a:thought-1');
  });

  it('将多条 chip 的剪贴板坐标换算为编辑坐标', () => {
    const occurrences = [
      { offset: 2, length: 12 },
      { offset: 16, length: 10 },
    ];
    expect(detectEnd('ab@thought-one  @thought-2z', occurrences)).toBe(7);
    expect(detectOffset(occurrences[0], occurrences)).toBe(2);
    expect(detectOffset(occurrences[1], occurrences)).toBe(5);
  });
});
