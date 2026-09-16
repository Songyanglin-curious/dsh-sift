// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountDocumentEditor } from '../src/client/document-editor.js';
import { UNTITLED_DOCUMENT_TITLE, type DocumentsApi, type SiftDocument } from '../src/documents.js';

const mocks = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock('@milkdown/crepe', () => ({ Crepe: class {
  static Feature = { Latex: 'latex', Placeholder: 'placeholder' };
  destroy = vi.fn(async () => {});
  value: string;
  update?: () => void;
  constructor(public options: any) { this.value = options.defaultValue; mocks.instances.push(this); }
  on(fn: any) { fn({ markdownUpdated: (callback: any) => { this.update = callback; } }); }
  async create() {}
  getMarkdown() { return this.value; }
} }));

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = () => new Promise(resolve => setTimeout(resolve, 450));
let sequence = 0;

/** 假 Host：登记表 + 磁盘内容，行为与 host/document/store.ts 对齐。 */
function fakeHost(initial?: { id: string; path: string; title?: string; content: string }) {
  const documents: SiftDocument[] = initial ? [{ id: initial.id, path: initial.path, ...(initial.title === undefined ? {} : { title: initial.title }) }] : [];
  const disk = new Map<string, string>();
  if (initial) disk.set(initial.path, initial.content);
  const index = () => ({ schemaVersion: 1 as const, documents: documents.map(item => ({ ...item })) });
  const api: DocumentsApi = {
    listDocuments: vi.fn(async () => index()),
    readDocumentContent: vi.fn(async ({ documentId }) => {
      const document = documents.find(item => item.id === documentId);
      if (!document?.path) throw new Error('Document 不存在或尚未保存。');
      return { content: disk.get(document.path) ?? '', path: document.path };
    }),
    saveDocument: vi.fn(async ({ documentId, title, content }) => {
      let document = documents.find(item => item.id === documentId);
      const created = document === undefined;
      if (!document) {
        document = { id: documentId, path: `notes/${title ?? UNTITLED_DOCUMENT_TITLE}.md`, ...(title === undefined ? {} : { title }) };
        documents.push(document);
      }
      disk.set(document.path!, content);
      return { index: index(), document: { ...document }, created };
    }),
    removeDocument: vi.fn(async () => index()),
  };
  return { api, documents, disk, external: (path: string, content: string) => disk.set(path, content) };
}

function mount(f: { api: DocumentsApi }) {
  const section = document.createElement('section');
  const workspaceId = `workspace-${++sequence}`;
  const dispose = mountDocumentEditor(section, { workspaceId, api: f.api, newId: () => `doc-${sequence}` });
  return { section, workspaceId, dispose };
}

beforeEach(() => { mocks.instances.length = 0; });

describe('Untitled Document', () => {
  it('打开空工作区时给出未命名的 Document，且不自动落盘', async () => {
    const f = fakeHost();
    const view = mount(f);
    await tick();
    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0].value).toBe('');
    expect(view.section.querySelector('[data-sift-document-path]')?.textContent).toBe('尚未保存为文件');
    const save = view.section.querySelector<HTMLButtonElement>('[data-sift-document-save]')!;
    expect(save.hidden).toBe(false);

    mocks.instances[0].value = '# 初稿';
    mocks.instances[0].update();
    await settle();
    // 未落盘前不自动保存：首次保存必须是显式动作。
    expect(f.api.saveDocument).not.toHaveBeenCalled();
    expect(view.section.querySelector('[role=status]')?.textContent).toBe('未保存');
    view.dispose();
  });

  it('首次保存创建 Document 文件，之后隐藏保存按钮', async () => {
    const f = fakeHost();
    const view = mount(f);
    await tick();
    const title = view.section.querySelector<HTMLInputElement>('[data-sift-document-title]')!;
    title.value = '设计说明';
    title.dispatchEvent(new Event('input'));
    mocks.instances[0].value = '# 正文';
    mocks.instances[0].update();

    view.section.querySelector<HTMLButtonElement>('[data-sift-document-save]')!.click();
    await tick();
    await tick();

    expect(f.api.saveDocument).toHaveBeenCalledTimes(1);
    expect(f.api.saveDocument).toHaveBeenCalledWith({ workspaceId: view.workspaceId, documentId: `doc-${sequence}`, title: '设计说明', content: '# 正文' });
    expect(f.disk.get('notes/设计说明.md')).toBe('# 正文');
    expect(view.section.querySelector('[data-sift-document-path]')?.textContent).toBe('notes/设计说明.md');
    expect(view.section.querySelector<HTMLButtonElement>('[data-sift-document-save]')!.hidden).toBe(true);
    expect(view.section.querySelector('[role=status]')?.hasAttribute('hidden')).toBe(true);
    view.dispose();
  });

  it('落盘之后的编辑恢复自动保存', async () => {
    const f = fakeHost();
    const view = mount(f);
    await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-document-save]')!.click();
    await tick(); await tick();
    mocks.instances[0].value = '# 第二次';
    mocks.instances[0].update();
    await settle();
    await tick();
    expect(f.api.saveDocument).toHaveBeenCalledTimes(2);
    expect(f.disk.get(`notes/${UNTITLED_DOCUMENT_TITLE}.md`)).toBe('# 第二次');
    view.dispose();
  });
});

describe('已落盘的 Document', () => {
  it('打开登记表里的第一份并加载正文', async () => {
    const f = fakeHost({ id: 'doc-existing', path: 'notes/已有.md', title: '已有', content: '# 磁盘内容' });
    const view = mount(f);
    await tick();
    expect(mocks.instances[0].value).toBe('# 磁盘内容');
    expect(view.section.querySelector<HTMLInputElement>('[data-sift-document-title]')!.value).toBe('已有');
    expect(view.section.querySelector<HTMLButtonElement>('[data-sift-document-save]')!.hidden).toBe(true);
    expect(f.api.saveDocument).not.toHaveBeenCalled();
    view.dispose();
  });

  it('磁盘被其他程序改过时拒绝覆盖', async () => {
    const f = fakeHost({ id: 'doc-existing', path: 'notes/已有.md', content: '# 磁盘内容' });
    const view = mount(f);
    await tick();
    mocks.instances[0].value = '# 我的修改';
    f.external('notes/已有.md', '# 别人的修改');
    mocks.instances[0].update();
    await settle();
    await tick();
    expect(f.api.saveDocument).not.toHaveBeenCalled();
    expect(view.section.querySelector('[role=status]')?.textContent).toContain('文件已被其他程序修改');
    view.dispose();
  });
});

describe('切换与恢复', () => {
  it('卸载后重新挂载同一个工作区会恢复未保存的编辑', async () => {
    const f = fakeHost();
    const first = mount(f);
    await tick();
    mocks.instances[0].value = 'pending';
    mocks.instances[0].update();
    first.dispose();
    await tick();

    const section = document.createElement('section');
    const dispose = mountDocumentEditor(section, { workspaceId: first.workspaceId, api: f.api, newId: () => 'unused' });
    await tick();
    expect(mocks.instances[1].value).toBe('pending');
    dispose();
  });

  it('不会把只是打开的 Document 标记成未保存', async () => {
    const f = fakeHost({ id: 'doc-existing', path: 'notes/已有.md', content: '# 磁盘内容' });
    const view = mount(f);
    await tick();
    // 没有任何编辑，因此不该触发保存，也不该出现待保存状态。
    await settle();
    expect(f.api.saveDocument).not.toHaveBeenCalled();
    expect(view.section.querySelector('[role=status]')?.hasAttribute('hidden')).toBe(true);
    view.dispose();
  });
});
