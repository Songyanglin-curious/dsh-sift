// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installArticleActionPlacement, mountArticleReferenceDrawer } from '../src/client/article-drawer.js';

afterEach(() => { document.body.replaceChildren(); document.head.querySelectorAll('[data-plugin-css]').forEach(node => node.remove()); });

function api() {
  return {
    getDocumentRelations: vi.fn(async () => ({ exists: false, references: [] })),
    setDocumentRelations: vi.fn(async () => {}),
    listReferences: vi.fn(async () => []), loadReference: vi.fn(), createReference: vi.fn(), importConversationReference: vi.fn(), saveReference: vi.fn(),
    analyzeConversation: vi.fn(), analyzeConversationTopic: vi.fn(), removeReference: vi.fn(), pickSourceFiles: vi.fn(), openSourcePath: vi.fn(),
  };
}

describe('当前文章并排参考栏', () => {
  it('以当前文件路径读取关系，不创建 Sift 工作区或 Document', async () => {
    const service = api(); const onClose = vi.fn();
    const splitHost = document.createElement('main');
    const previewElement = document.createElement('section'); splitHost.appendChild(previewElement); document.body.appendChild(splitHost);
    const dispose = mountArticleReferenceDrawer({ workspaceId: 'ws-1', absolutePath: 'D:\\notes\\article.md', previewElement, api: service as never, readClipboard: vi.fn(), onClose });
    await Promise.resolve(); await Promise.resolve();
    expect(service.getDocumentRelations).toHaveBeenCalledWith({ target: 'D:\\notes\\article.md' });
    expect(service.listReferences).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-sift-article-drawer-title]')?.textContent).toContain('参考 · article.md');
    expect(document.querySelector('[data-sift-article-drawer-subtitle]')?.textContent).toBe('仅关联当前文章');
    expect(Array.from(splitHost.children)).toEqual([previewElement, document.querySelector('[data-sift-article-drawer]')]);
    expect(splitHost.dataset.siftArticleSplit).toBe('');
    (document.querySelector('[data-sift-article-drawer-close]') as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledOnce();
    dispose();
    expect(splitHost.dataset.siftArticleSplit).toBeUndefined();
  });

  it('把参考图标放到原生 Markdown 菜单之前', async () => {
    const preview = document.createElement('section'); preview.dataset.textpreviewUrl = 'file.md';
    const header = document.createElement('header');
    const viewerCarrier = document.createElement('span');
    const viewer = document.createElement('button'); viewer.dataset.documentViewerMenu = ''; viewer.textContent = 'Markdown'; viewerCarrier.appendChild(viewer);
    const reload = document.createElement('button'); reload.textContent = '刷新';
    const slot = document.createElement('div'); slot.dataset.slot = 'sidebar.right.tab.document.actions';
    const action = document.createElement('button'); action.dataset.siftArticleAction = '';
    slot.appendChild(action); header.append(viewerCarrier, reload, slot); preview.appendChild(header); document.body.appendChild(preview);
    const dispose = installArticleActionPlacement(); await Promise.resolve();
    const proxy = header.querySelector('[data-sift-article-action-proxy]');
    expect(Array.from(header.children)).toEqual([proxy, viewerCarrier, reload, slot]);
    expect(action.hidden).toBe(true);
    dispose();
    expect(action.hidden).toBe(false);
  });
});
