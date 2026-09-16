/**
 * Reference 的两种文本投影。
 *
 * 这是 v0.2 的接缝之一（见实施文档 §3.2、§24）：UI 不自己拼 Prompt，
 * 所有「Reference 如何变成给模型看的文字」只在这里定义。
 *
 * 硬约束（见 docs/dsh-reference-api-research.md §3、§8.5）：
 * - serialize 的返回值会替换 chip 在草稿里的区间，成为发给模型的 user message 正文；
 *   抛错会阻断整次发送，不会退回 clipboardText。
 * - clipboardText 会被 DSH 持久化进草稿，且 U+FFFC 与 U+E100–U+E11D 会被占位符剥离，
 *   因此正文里必须避开这些码位。
 */

/** Sift 侧的一条参考记录：Reference Board 卡片的数据面。 */
export interface SiftReferenceRecord {
  /** chip 的 ref，必须在本 source 内唯一。 */
  readonly id: string;
  /** 卡片标题，也是 chip 上显示的文字。 */
  readonly label: string;
  /** 参考正文，序列化时送给模型。 */
  readonly content: string;
  /** 来源标题，例如文件名或 URL。 */
  readonly sourceTitle?: string;
  /** 来源内定位，例如 `L120-L150` 或 `p.12`。 */
  readonly locator?: string;
}

/** 单行化：clipboardText 会进草稿正文，不能带换行。 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 复制/持久化投影。故意保持短且单行。 */
export function referenceClipboardText(record: SiftReferenceRecord): string {
  const label = oneLine(record.label) || record.id;
  return `@参考:${label}`;
}

/**
 * 模型序列化。格式集中在这里，由 `docs/dsh-reference-api-research.md` 的
 * codec 契约驱动；空的段落整体省略，避免出现只有标题没有内容的块。
 */
export function referencePromptText(record: SiftReferenceRecord): string {
  const sections: string[] = [];
  const source = record.sourceTitle === undefined ? undefined : oneLine(record.sourceTitle);
  const locator = record.locator === undefined ? undefined : oneLine(record.locator);
  if (source !== undefined && source !== '') sections.push(`Source:\n${source}`);
  if (locator !== undefined && locator !== '') sections.push(`Locator:\n${locator}`);
  sections.push(`Content:\n${record.content.trim()}`);
  return `[Sift Reference]\n\n${sections.join('\n\n')}`;
}
