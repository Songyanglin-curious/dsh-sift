import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { createRoot } from 'react-dom/client';

const markdownLabels = {
  code: {
    copyLabel: '复制代码',
    copiedLabel: '已复制',
  },
  footnotes: '脚注',
};

/** 使用 DSH 原生 Markdown 渲染器挂载只读正文。 */
export function mountMarkdownView(host: HTMLElement, text: string): () => void {
  const root = createRoot(host);
  root.render(<MarkdownText text={text} labels={markdownLabels} />);
  return () => root.unmount();
}
