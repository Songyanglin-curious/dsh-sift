import { describe, expect, it } from 'vitest';
import { createHistory } from '../src/client/reference/history.js';

describe('History', () => {
  it('初始时不能撤销也不能重做', () => {
    const h = createHistory(['a']);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it('记录后可以撤销', () => {
    const h = createHistory(['a']);
    h.record(['a', 'b']);
    expect(h.canUndo()).toBe(true);
    expect(h.undo()).toEqual(['a']);
  });

  it('撤销后可以重做', () => {
    const h = createHistory(['a']);
    h.record(['a', 'b']);
    h.undo();
    expect(h.canRedo()).toBe(true);
    expect(h.redo()).toEqual(['a', 'b']);
  });

  it('撤销多次回到初始状态后 canUndo 为 false', () => {
    const h = createHistory(['a']);
    h.record(['a', 'b']);
    h.record(['a', 'b', 'c']);
    h.undo();
    h.undo();
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBeNull();
  });

  it('重做到最新状态后 canRedo 为 false', () => {
    const h = createHistory(['a']);
    h.record(['a', 'b']);
    h.record(['a', 'b', 'c']);
    h.undo();
    h.undo();
    h.redo();
    h.redo();
    expect(h.canRedo()).toBe(false);
    expect(h.redo()).toBeNull();
  });

  it('记录新状态时丢弃 index 之后的历史', () => {
    const h = createHistory(['a']);
    h.record(['a', 'b']);
    h.record(['a', 'b', 'c']);
    h.undo(); // index=1 → ['a', 'b']
    h.record(['a', 'b', 'x']); // 应丢弃 ['a', 'b', 'c']
    expect(h.undo()).toEqual(['a', 'b']);
    expect(h.undo()).toEqual(['a']);
    expect(h.canUndo()).toBe(false);
    // c 应不可恢复
    expect(h.redo()).toEqual(['a', 'b']);
    h.redo();
    expect(h.redo()).toEqual(['a', 'b', 'x']);
    expect(h.canRedo()).toBe(false);
  });

  it('超限时丢弃最旧记录', () => {
    const h = createHistory(0 as unknown as string[], 3); // limit=3（最多 2 步回退 + 当前）
    h.record(['a']);
    h.record(['a', 'b']);
    h.record(['a', 'b', 'c']);
    // 当前 items 应为 [['a'], ['a','b'], ['a','b','c']]，index=2
    h.undo();
    expect(h.undo()).toEqual(['a']);
    h.undo();
    // 再 undo 应无了
    expect(h.undo()).toBeNull();
  });

  it('reset 丢弃所有历史并以新状态为初始基线', () => {
    const h = createHistory(['a']);
    h.record(['a', 'b']);
    h.record(['a', 'b', 'c']);
    h.reset(['x', 'y']);
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBeNull();
    h.record(['x', 'y', 'z']);
    expect(h.undo()).toEqual(['x', 'y']);
  });

  it('record 不会修改传入的数组（深拷贝）', () => {
    const arr = [{ id: '1' }];
    const h = createHistory(arr);
    arr[0]!.id = '2'; // 修改外部引用
    const undone = h.undo();
    expect(h.canUndo()).toBe(false);
    // create 时 deep clone 了，所以外部修改不影响历史
  });

  it('撤销恢复的数组不应被后续操作污染', () => {
    const h = createHistory([{ id: '1', content: 'a' }]);
    h.record([{ id: '1', content: 'b' }]);
    const restored = h.undo()!;
    restored[0]!.content = 'c'; // 修改恢复出来的引用
    // 不影响历史里的快照
    expect(h.redo()![0]!.content).toBe('b');
  });
});