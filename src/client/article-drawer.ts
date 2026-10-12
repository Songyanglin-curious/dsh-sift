import drawerCss from './article-drawer.css?inline';
import type { ClipboardSnapshot } from '../host/clipboard/index.js';
import { injectStyle, SIFT_PLUGIN_ID } from './renderer/inject-style.js';
import { mountReferencePanel, type ReferenceApi } from './reference/panel.js';
import { WorkspaceController } from './workspace-controller.js';

export interface ArticleReferenceDrawerOptions {
  readonly workspaceId: string;
  readonly absolutePath: string;
  /** 当前文件预览根节点；参考区会作为它的相邻栏，而不是覆盖页面。 */
  readonly previewElement: HTMLElement;
  readonly api: ReferenceApi & {
    getDocumentRelations(input: { target: string }): Promise<{ exists: boolean; references: string[] }>;
    setDocumentRelations(input: { target: string; references: string[] }): Promise<void>;
  };
  readClipboard(): Promise<ClipboardSnapshot>;
  onClose(): void;
}

function basename(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }

/** 在当前 DSH 文件旁打开轻量参考栏；文章路径本身就是关系主键。 */
export function mountArticleReferenceDrawer(options: ArticleReferenceDrawerOptions): () => void {
  const disposeCss = injectStyle(SIFT_PLUGIN_ID, 'article-drawer.css', drawerCss);
  const drawer = document.createElement('aside'); drawer.dataset.siftArticleDrawer = '';
  const header = document.createElement('header'); header.dataset.siftArticleDrawerHeader = '';
  const title = document.createElement('div'); title.dataset.siftArticleDrawerTitle = ''; title.textContent = `参考 · ${basename(options.absolutePath)}`;
  const subtitle = document.createElement('small'); subtitle.dataset.siftArticleDrawerSubtitle = ''; subtitle.textContent = '仅关联当前文章'; title.appendChild(subtitle);
  const close = document.createElement('button'); close.type = 'button'; close.dataset.siftArticleDrawerClose = ''; close.setAttribute('aria-label', '关闭参考'); close.textContent = '×'; close.addEventListener('click', options.onClose);
  const body = document.createElement('section'); body.dataset.siftArticleDrawerBody = '';
  const status = document.createElement('div'); status.dataset.siftArticleDrawerStatus = ''; status.textContent = '正在读取当前文章的参考…'; body.appendChild(status);
  header.append(title, close); drawer.append(header, body);
  const splitHost = options.previewElement.parentElement;
  if (!splitHost) throw new Error('当前文件预览尚未挂载。');
  splitHost.dataset.siftArticleSplit = '';
  options.previewElement.dataset.siftArticlePreview = '';
  options.previewElement.after(drawer);

  const controller = new WorkspaceController({ getDocumentRelations: options.api.getDocumentRelations, setDocumentRelations: options.api.setDocumentRelations });
  controller.setOutputTabs([options.absolutePath]);
  let disposed = false;
  let disposePanel: (() => void) | undefined;
  void controller.setActiveOutput(options.absolutePath).then(() => {
    if (disposed) return;
    status.remove();
    disposePanel = mountReferencePanel(body, { api: options.api, readClipboard: options.readClipboard, workspace: controller });
  }, error => { if (!disposed) status.textContent = `参考加载失败：${error instanceof Error ? error.message : String(error)}`; });

  return () => {
    disposed = true; disposePanel?.(); drawer.remove();
    delete options.previewElement.dataset.siftArticlePreview;
    if (!splitHost.querySelector('[data-sift-article-drawer]')) delete splitHost.dataset.siftArticleSplit;
    disposeCss();
  };
}

/** DSH 暂无“Markdown”按钮前的专用 slot；把已注册 action 移到对应原生控件之前。 */
export function installArticleActionPlacement(): () => void {
  const place = () => {
    if (typeof document === 'undefined') return;
    for (const button of Array.from(document.querySelectorAll('[data-sift-article-action]')) as HTMLElement[]) {
      const preview = button.closest('[data-textpreview-url]') as HTMLElement | null;
      const viewer = preview?.querySelector('[data-document-viewer-menu]') as HTMLElement | null;
      const viewerCarrier = viewer?.parentElement;
      if (!preview || !viewerCarrier) continue;
      let proxy = preview.querySelector('[data-sift-article-action-proxy]') as HTMLButtonElement | null;
      if (!proxy) {
        proxy = document.createElement('button'); proxy.type = 'button'; proxy.dataset.siftArticleActionProxy = '';
        proxy.title = button.title; proxy.setAttribute('aria-label', button.getAttribute('aria-label') ?? '打开当前文章的参考'); proxy.innerHTML = button.innerHTML;
        proxy.addEventListener('click', () => button.click());
      }
      if (proxy.nextElementSibling !== viewerCarrier) viewerCarrier.before(proxy);
      button.hidden = true;
    }
  };
  const observer = new MutationObserver(place); observer.observe(document.body, { childList: true, subtree: true }); queueMicrotask(place);
  return () => {
    observer.disconnect();
    document.querySelectorAll('[data-sift-article-action-proxy]').forEach(node => node.remove());
    document.querySelectorAll<HTMLElement>('[data-sift-article-action]').forEach(node => { node.hidden = false; });
  };
}
