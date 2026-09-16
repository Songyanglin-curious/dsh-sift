import panelCss from './panel.css?inline';
import type { SourcesApi } from '../../sources.js';
import { mountReferenceBoard } from './board.js';
import { mountSourceDrawer } from '../source/drawer.js';

/**
 * 左栏内容：Reference Board + 临时的 Source Drawer（v0.2 实施文档 §9、§16）。
 *
 * Source 不占第四栏，只由「＋ 从来源获取」展开。Phase 4 会把 Reference Store 接进来，
 * 那时只需把 board 的 cards 换成真实数据，并给 drawer 传 onSelectionChange。
 */

export interface ReferencePanelOptions {
  readonly workspaceId: string;
  readonly sources: SourcesApi;
  readonly pickDirectory?: () => Promise<string | null>;
}

export function mountReferencePanel(section: HTMLElement, options: ReferencePanelOptions): () => void {
  const style = document.createElement('style');
  style.textContent = panelCss;

  const actions = document.createElement('div');
  actions.dataset.siftReferenceActions = '';

  const openSources = document.createElement('button');
  openSources.type = 'button';
  openSources.dataset.siftOpenSources = '';
  openSources.textContent = '＋ 从来源获取';
  openSources.title = '查看并添加来源';
  actions.appendChild(openSources);

  const drawerHost = document.createElement('div');
  drawerHost.dataset.siftSourceDrawerHost = '';

  section.append(style, actions, drawerHost);

  const disposeBoard = mountReferenceBoard(section, { cards: [] });
  const drawer = mountSourceDrawer(drawerHost, {
    workspaceId: options.workspaceId,
    ...(options.pickDirectory === undefined ? {} : { pickDirectory: options.pickDirectory }),
    api: options.sources,
  });

  const sync = () => { openSources.setAttribute('aria-expanded', String(drawer.isOpen())); };
  openSources.addEventListener('click', () => {
    openSources.blur();
    if (drawer.isOpen()) drawer.close(); else drawer.open();
    sync();
  });
  sync();

  return () => {
    drawer.dispose();
    disposeBoard();
    actions.remove();
    drawerHost.remove();
    style.remove();
  };
}
