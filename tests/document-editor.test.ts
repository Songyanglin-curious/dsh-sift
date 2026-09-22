// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mountDocumentEditor } from '../src/client/document-editor.js';
import { documentFileName, type DocumentsApi, type SiftDocument } from '../src/documents.js';
import { WorkspaceController } from '../src/client/workspace-controller.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let sequence = 0;
type InitialDocument = { id: string; path: string; title?: string; content: string };

function fakeHost(initial?: InitialDocument | InitialDocument[]) {
  const items = initial === undefined ? [] : Array.isArray(initial) ? initial : [initial];
  const documents: SiftDocument[] = items.map(item => ({ id: item.id, path: item.path, ...(item.title ? { title: item.title } : {}) }));
  const disk = new Map(items.map(item => [item.path, item.content]));
  const index = () => ({ schemaVersion: 1 as const, documents: documents.map(item => ({ ...item })) });
  const api: DocumentsApi = {
    listDocuments: vi.fn(async () => index()),
    readDocumentContent: vi.fn(async ({ documentId }) => {
      const item = documents.find(candidate => candidate.id === documentId); if (!item?.path) throw new Error('Document 不存在');
      return { content: disk.get(item.path) ?? '', path: item.path };
    }),
    saveDocument: vi.fn(async ({ documentId, title, content, targetDirectory }) => {
      let item = documents.find(candidate => candidate.id === documentId); const created = !item;
      if (!item) { item = { id: documentId, path: targetDirectory ? join(targetDirectory, documentFileName(title ?? '')) : `notes/${documentFileName(title ?? '')}`, ...(title ? { title } : {}) }; documents.push(item); }
      else if (title !== undefined) item.title = title;
      disk.set(item.path!, content); return { index: index(), document: { ...item }, created };
    }),
    addExistingDocument: vi.fn(async ({ documentId, path }) => {
      const existing = documents.find(item => item.path === path); if (existing) return { index: index(), document: { ...existing }, added: false };
      const item = { id: documentId, path, title: path.split(/[\\/]/).at(-1)! }; documents.push(item); return { index: index(), document: { ...item }, added: true };
    }),
    detachDocument: vi.fn(async ({ documentId }) => { const i = documents.findIndex(item => item.id === documentId); if (i >= 0) documents.splice(i, 1); return index(); }),
    removeDocument: vi.fn(async ({ documentId }) => { const i = documents.findIndex(item => item.id === documentId); if (i >= 0) { const [item] = documents.splice(i, 1); if (item?.path) disk.delete(item.path); } return index(); }),
  };
  return { api, disk, external: (path: string, content: string) => disk.set(path, content) };
}

function mount(f: { api: DocumentsApi }, extras: Partial<Parameters<typeof mountDocumentEditor>[1]> = {}) {
  const section = document.createElement('section'); document.body.append(section);
  const workspaceId = `workspace-${++sequence}`; let id = 0;
  const setActiveDocument = vi.fn(async () => {}); const openDocumentPath = vi.fn(async () => {});
  const dispose = mountDocumentEditor(section, { workspaceId, api: f.api, newId: () => `doc-${sequence}-${++id}`, setActiveDocument, openDocumentPath, ...extras });
  return { section, workspaceId, setActiveDocument, openDocumentPath, dispose: () => { dispose(); section.remove(); } };
}

async function create(section: HTMLElement, title: string) {
  section.querySelector<HTMLButtonElement>('[data-sift-output-add]')!.click();
  const input = section.querySelector<HTMLInputElement>('[aria-label="产出文件名"]')!; input.value = title;
  section.querySelector<HTMLFormElement>('[data-sift-output-create-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick(); await tick();
}

describe('Document 只读工作流', () => {
  it('空工作区不创建文件', async () => {
    const f = fakeHost(); const view = mount(f); await tick();
    expect(view.section.querySelector('[data-sift-output-empty]')?.textContent).toContain('暂无打开的产出');
    expect(f.api.saveDocument).not.toHaveBeenCalled(); view.dispose();
  });

  it('创建 Markdown 后用 DSH MarkdownText 展示并绑定为当前 Document', async () => {
    const f = fakeHost(); const view = mount(f); await tick(); await create(view.section, '设计说明.md');
    expect(f.disk.get('notes/设计说明.md')).toBe('');
    expect(view.section.querySelector('.sift-output-tab[data-active]')?.textContent).toBe('设计说明.md');
    expect(view.section.querySelector('[data-dsh-markdown-text]')).not.toBeNull();
    expect(view.setActiveDocument).toHaveBeenLastCalledWith(`doc-${sequence}-1`); view.dispose();
  });

  it('新建 Document 继承当前可见 Reference', async () => {
    const f = fakeHost(); const relations = new Map<string, string[]>();
    const workspace = new WorkspaceController({ getDocumentRelations: async ({ target }) => ({ exists: relations.has(target), references: relations.get(target) ?? [] }), setDocumentRelations: async ({ target, references }) => { relations.set(target, [...references]); } });
    await workspace.addReferences(['references/a.json']); const view = mount(f, { workspace }); await tick(); await create(view.section, '继承关系');
    expect(relations.get(`doc-${sequence}-1`)).toEqual(['references/a.json']); view.dispose();
  });

  it('可以选择外部保存目录', async () => {
    const f = fakeHost(); const view = mount(f, { pickDirectory: async () => 'D:\\Notes' }); await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-add]')!.click();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-create-form] button')!.click(); await tick();
    const input = view.section.querySelector<HTMLInputElement>('[aria-label="产出文件名"]')!; input.value = '外部.md';
    view.section.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick();
    expect(f.api.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ targetDirectory: 'D:\\Notes' })); view.dispose();
  });

  it('手动同步重新读取外部修改', async () => {
    const f = fakeHost({ id: 'a', path: 'notes/a.md', title: 'A', content: '# 旧内容' }); const view = mount(f); await tick(); await tick();
    expect(view.section.textContent).toContain('# 旧内容'); f.external('notes/a.md', '# 新内容');
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-sync]')!.click(); await tick(); await tick();
    expect(view.section.textContent).toContain('# 新内容'); expect(view.section.querySelector('[role=status]')?.textContent).toBe('已同步'); view.dispose();
  });

  it('用外部编辑器打开当前文件', async () => {
    const f = fakeHost({ id: 'a', path: 'D:\\Notes\\a.md', content: 'a' }); const view = mount(f); await tick(); await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-open-external]')!.click();
    expect(view.openDocumentPath).toHaveBeenCalledWith('D:\\Notes\\a.md'); view.dispose();
  });

  it('添加已有文件不产生重复 Tab', async () => {
    const f = fakeHost(); f.external('D:\\Notes\\已有.md', '# 已有');
    const view = mount(f, { pickOutputFiles: async () => ({ paths: ['D:\\Notes\\已有.md'], cancelled: false }) }); await tick();
    const button = view.section.querySelector<HTMLButtonElement>('[data-sift-output-add-existing]')!; button.click(); await tick(); await tick(); button.click(); await tick(); await tick();
    expect(view.section.querySelectorAll('.sift-output-tab')).toHaveLength(1); expect(view.section.textContent).toContain('# 已有'); view.dispose();
  });

  it('切换 Tab 会读取对应磁盘正文', async () => {
    const f = fakeHost([{ id: 'a', path: 'a.md', title: 'A', content: '# A' }, { id: 'b', path: 'b.md', title: 'B', content: '# B' }]); const view = mount(f); await tick(); await tick();
    view.section.querySelectorAll<HTMLButtonElement>('.sift-output-tab')[1]!.click(); await tick(); await tick();
    expect(view.section.textContent).toContain('# B'); expect(view.setActiveDocument).toHaveBeenLastCalledWith('b'); view.dispose();
  });

  it('移除保留文件，删除则确认后删除文件', async () => {
    const f = fakeHost([{ id: 'a', path: 'a.md', title: 'A', content: 'A' }, { id: 'b', path: 'b.md', title: 'B', content: 'B' }]);
    const view = mount(f, { confirmDelete: () => true }); await tick(); await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-detach]')!.click(); await tick(); await tick(); expect(f.disk.has('a.md')).toBe(true);
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-delete]')!.click(); await tick(); await tick(); expect(f.disk.has('b.md')).toBe(false); view.dispose();
  });
});
