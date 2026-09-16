/**
 * 左栏 Reference Board（v0.2 实施文档 §12、§13、§19）。
 *
 * Phase 1 只要求「Reference 为空」：这里渲染空状态并说明 Reference 是什么。
 * 卡片本身的结构和截断规则一并放进来，Phase 4 接上 Reference Store 后
 * 只需要把数据传进来，不必改这个文件。
 */

/** 卡片一级展示用的视图模型（不是持久化模型，持久化模型见 Phase 4 的 Reference）。 */
export interface ReferenceCardView {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly sourceTitle?: string;
  readonly locator?: string;
}

/** 一级展示的正文上限（实施文档 §19）：避免一张卡片吃掉整个工作台。 */
export const CARD_CONTENT_LIMIT = 280;

/** 截断到上限；被截断时补省略号。 */
export function truncateContent(content: string, limit = CARD_CONTENT_LIMIT): string {
  const text = content.trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

/** 来源行：来源标题 + 定位，缺一不可省略。 */
export function referenceOrigin(card: ReferenceCardView): string {
  const parts = [card.sourceTitle, card.locator].filter(value => value !== undefined && value.trim() !== '');
  return parts.length === 0 ? '' : `来源：${parts.join(' · ')}`;
}

export interface ReferenceBoardOptions {
  readonly cards: readonly ReferenceCardView[];
}

export function mountReferenceBoard(section: HTMLElement, options: ReferenceBoardOptions): () => void {
  const list = document.createElement('div');
  list.dataset.siftReferenceList = '';
  if (options.cards.length === 0) {
    list.dataset.siftReferenceEmpty = '';
    const heading = document.createElement('strong');
    heading.textContent = '还没有当前参考';
    const hint = document.createElement('p');
    hint.textContent = 'Reference 是这篇文档此刻真正依据的内容。加入来源后，可以从来源里直接选取，或让 AI 提取候选。';
    list.append(heading, hint);
  } else {
    for (const card of options.cards) {
      const article = document.createElement('article');
      article.dataset.siftReferenceCard = card.id;
      const heading = document.createElement('strong');
      heading.textContent = card.title;
      const body = document.createElement('p');
      body.textContent = truncateContent(card.content);
      article.append(heading, body);
      const origin = referenceOrigin(card);
      if (origin !== '') {
        const footer = document.createElement('small');
        footer.textContent = origin;
        article.appendChild(footer);
      }
      list.appendChild(article);
    }
  }
  section.appendChild(list);
  return () => list.remove();
}
