/**
 * 卡片操作历史（Undo / Redo）。
 *
 * 纯数据层：只操作数组快照，不碰 DOM / Remote。
 * 每个快照使用 structuredClone 深拷贝，避免引用污染。
 */

const DEFAULT_LIMIT = 10;

export interface History<T> {
  /** 记录一个新状态；超出 limit 时丢弃最旧记录。 */
  record(next: T): void;
  /** 撤销：返回上一个状态，若无历史则返回 null。 */
  undo(): T | null;
  /** 重做：返回下一个状态，若无可重做则返回 null。 */
  redo(): T | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 重置历史，丢弃所有记录并以当前状态作为初始基线。 */
  reset(initial: T): void;
}

export function createHistory<T>(initial: T, limit = DEFAULT_LIMIT): History<T> {
  const items: T[] = [structuredClone(initial)];
  let index = 0;

  const record = (next: T): void => {
    // 丢弃 index 之后的所有记录
    items.length = index + 1;
    items.push(structuredClone(next));
    index++;
    // 超出上限时淘汰最旧记录
    if (items.length > limit) {
      items.shift();
      index--;
    }
  };

  const undo = (): T | null => {
    if (index <= 0) return null;
    index--;
    return structuredClone(items[index]);
  };

  const redo = (): T | null => {
    if (index >= items.length - 1) return null;
    index++;
    return structuredClone(items[index]);
  };

  const canUndo = (): boolean => index > 0;
  const canRedo = (): boolean => index < items.length - 1;

  const reset = (initial: T): void => {
    items.length = 0;
    items.push(structuredClone(initial));
    index = 0;
  };

  return { record, undo, redo, canUndo, canRedo, reset };
}