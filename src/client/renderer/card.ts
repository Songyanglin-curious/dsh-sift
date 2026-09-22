/**
 * ReferenceCard：一条参考卡片的 DOM 构造与清理。
 *
 * 卡片只负责：Markdown 展示、拖拽把手、删除、来源入口。
 * 不负责：读取剪贴板、排序状态、持久化（那些是 Canvas 的事）。
 *
 * 结构：
 *   [data-sift-card]
 *     [data-sift-card-handle]   ← 左上 ⠿ 拖拽把手（唯一拖拽热区）
 *     [data-sift-card-remove]   ← 右上 × 删除
 *     [data-sift-card-body]     ← DSH 原生 Markdown 渲染区
 *     [data-sift-card-source]   ← 右下弱图标，仅有来源时渲染
 */

import { mountMarkdownBlock } from './markdown-block.js';

/** 类型来自共享模型（type-only 导入，编译期擦除）；没有来源时直接缺省。 */
import type { ReferenceCard, ReferenceCardSource } from '../../references.js';

export type ReferenceCardData = ReferenceCard;
export type { ReferenceCardSource };

export interface CardOptions {
  readonly card: ReferenceCardData;
  readonly onRemove: (id: string) => void;
  readonly onEdit?: (id: string) => void;
  /** 点击文件来源图标：在本机打开该文件（由 Host 决定用什么程序）。 */
  readonly onOpenSource?: (uri: string) => void;
}

export function mountCard(host: HTMLElement, options: CardOptions): () => void {
  const { card, onRemove, onEdit, onOpenSource } = options;

  const container = document.createElement('div');
  container.dataset.siftCard = '';
  container.dataset.cardId = card.id;

  // 拖拽把手（唯一拖拽热区；正文区域保持可选中可复制）
  const handle = document.createElement('span');
  handle.dataset.siftCardHandle = '';
  handle.title = '拖动排序';
  handle.textContent = '⠿';

  // 编辑按钮
  let editBtn: HTMLButtonElement | undefined;
  if (onEdit) {
    editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.dataset.siftCardEdit = '';
    editBtn.title = '编辑';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => onEdit(card.id));
  }

  // 删除按钮
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.dataset.siftCardRemove = '';
  removeBtn.title = '删除';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => onRemove(card.id));

  // 正文区域
  const body = document.createElement('div');
  body.dataset.siftCardBody = '';
  const disposeMd = mountMarkdownBlock(body, card.content);

  container.append(handle, removeBtn, ...(editBtn ? [editBtn] : []), body);

  // 来源：右下角弱图标，hover 显示完整 uri。
  // 网页可点击打开；文件在注入了 onOpenSource 时可点击，交给 Host 用本机程序打开。
  if (card.source?.uri !== undefined && card.source.uri !== '') {
    const uri = card.source.uri;
    const isWeb = card.source.type === 'web';
    const canOpenFile = !isWeb && onOpenSource !== undefined;
    const interactive = isWeb || canOpenFile;
    const source = interactive ? document.createElement('button') : document.createElement('span');
    source.dataset.siftCardSource = card.source.type;
    source.title = isWeb ? uri : `${uri}${canOpenFile ? '（点击用本机程序打开）' : ''}`;
    source.textContent = isWeb ? '🔗' : '📄';
    if (interactive) {
      const button = source as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', () => {
        // 网页用 window.open，避免在 Sift 页面里整页跳走；文件交给 Host 用本机程序打开。
        if (isWeb) window.open(uri, '_blank', 'noopener,noreferrer');
        else onOpenSource!(uri);
      });
    }
    container.appendChild(source);
  }

  host.appendChild(container);

  return () => {
    disposeMd();
    container.remove();
  };
}
