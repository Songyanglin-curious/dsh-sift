/** Reference 卡片统一复用 DSH 原生 Markdown 渲染能力。 */
import { mountMarkdownView } from '../markdown-view.js';

export function mountMarkdownBlock(host: HTMLElement, content: string): () => void {
  return mountMarkdownView(host, content);
}
