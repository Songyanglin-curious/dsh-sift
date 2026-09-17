import type { Crepe } from '@milkdown/crepe';
import { injectStyle, SIFT_PLUGIN_ID } from './renderer/inject-style.js';
import crepeMarkdownCss from './crepe-markdown.css?inline';

/**
 * 共享 Markdown 表面：中栏 Document 编辑、卡片编辑弹窗、只读预览都用它。
 *
 * 排版统一由 crepe-markdown.css 提供（对齐 DSH 对话栏 markdown 的令牌与间距），
 * 这里负责给根节点打上作用域标记，并确保样式表已注入（injectStyle 自带去重，
 * 因此可以随每个表面重复调用；样式表随插件生命周期存在，不随单个表面销毁）。
 */

const SURFACE_CLASS = 'sift-crepe-surface';

export async function createMarkdownSurface(root: HTMLElement, markdown: string, options: { readonly?: boolean; onChange?: () => void } = {}): Promise<Crepe> {
  root.classList.add(SURFACE_CLASS);
  injectStyle(SIFT_PLUGIN_ID, 'crepe-markdown.css', crepeMarkdownCss);

  const { Crepe } = await import('@milkdown/crepe');
  const editor = new Crepe({ root, defaultValue: markdown,
    features: { [Crepe.Feature.Latex]: false },
    featureConfigs: { [Crepe.Feature.Placeholder]: { text: '开始写作，或粘贴 Markdown…' } },
  });
  if (options.readonly) editor.setReadonly(true);
  if (options.onChange) editor.on(listener => listener.markdownUpdated(options.onChange!));
  try { await editor.create(); return editor; }
  catch (error) { await editor.destroy().catch(() => {}); throw error; }
}
