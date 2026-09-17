/**
 * Markdown 渲染组件：封装 <md-block> Web Component。
 *
 * 引入即注册自定义元素，每个实例创建一个 <md-block> 节点，
 * 把 Markdown 原文设为其文本内容，由 md-block 自动渲染为 HTML。
 */

import 'md-block';

export function mountMarkdownBlock(host: HTMLElement, content: string): () => void {
  const el = document.createElement('md-block');
  el.textContent = content;
  host.appendChild(el);
  return () => { el.remove(); };
}