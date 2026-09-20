export const SIFT_THOUGHT_SOURCE = 'sift-thought';

export interface ThoughtSelection {
  readonly area: 'reference' | 'output';
  readonly selectedText: string;
  readonly sourceId: string;
  readonly sourceName: string;
}

export interface Thought extends ThoughtSelection {
  readonly id: string;
  thought: string;
}

export function thoughtRef(sessionId: string, id: string): string {
  return `${sessionId}:${id}`;
}

export function formatThought(thought: Thought): string {
  const area = thought.area === 'reference' ? '参考' : '产出';
  return [
    '',
    `【本轮想法｜${area}：${thought.sourceName}】`,
    '选中信息：',
    thought.selectedText,
    '',
    '我的想法：',
    thought.thought,
    '',
  ].join('\n');
}

export function thoughtLabel(thought: string): string {
  const compact = thought.replace(/\s+/g, ' ').trim();
  return `想法：${compact.length > 22 ? `${compact.slice(0, 22)}…` : compact}`;
}

export interface ThoughtOccurrencePosition {
  readonly offset: number;
  readonly length: number;
}

/** DSH 编辑坐标中每个引用 chip 只占一个字符，draft/occurrence 则使用剪贴板文本坐标。 */
export function detectEnd(draft: string, occurrences: readonly ThoughtOccurrencePosition[]): number {
  return draft.length - occurrences.reduce((hidden, occurrence) => hidden + occurrence.length - 1, 0);
}

export function detectOffset(
  occurrence: ThoughtOccurrencePosition,
  occurrences: readonly ThoughtOccurrencePosition[],
): number {
  return occurrence.offset - occurrences
    .filter(candidate => candidate.offset < occurrence.offset)
    .reduce((hidden, candidate) => hidden + candidate.length - 1, 0);
}
