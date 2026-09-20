// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mountDocumentEditor } from '../src/client/document-editor.js';
import { documentFileName, type DocumentsApi, type SiftDocument } from '../src/documents.js';

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

async function createOutput(section: HTMLElement, title: string): Promise<void> {
  section.querySelector<HTMLButtonElement>('[data-sift-output-add]')!.click();
  const input = section.querySelector<HTMLInputElement>('[aria-label="产出文件名"]')!;
  input.value = title;
  section.querySelector<HTMLFormElement>('[data-sift-output-create-form]')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  await tick();
}

/** 假 Host：登记表 + 磁盘内容，行为与 host/document/store.ts 对齐。 */
type InitialDocument = { id: string; path: string; title?: string; content: string };

function fakeHost(initial?: InitialDocument | InitialDocument[]) {
  const initialDocuments = initial === undefined ? [] : Array.isArray(initial) ? initial : [initial];
  const documents: SiftDocument[] = initialDocuments.map(item => ({ id: item.id, path: item.path, ...(item.title === undefined ? {} : { title: item.title }) }));
  const disk = new Map<string, string>();
  for (const item of initialDocuments) disk.set(item.path, item.content);
  const index = () => ({ schemaVersion: 1 as const, documents: documents.map(item => ({ ...item })) });
  const api: DocumentsApi = {
    listDocuments: vi.fn(async () => index()),
    readDocumentContent: vi.fn(async ({ documentId }) => {
      const document = documents.find(item => item.id === documentId);
      if (!document?.path) throw new Error('Document 不存在或尚未保存。');
      return { content: disk.get(document.path) ?? '', path: document.path };
    }),
    saveDocument: vi.fn(async ({ documentId, title, content, targetDirectory }) => {
      let document = documents.find(item => item.id === documentId);
      const created = document === undefined;
      if (!document) {
        document = { id: documentId, path: targetDirectory ? join(targetDirectory, documentFileName(title ?? '')) : `notes/${documentFileName(title ?? '')}`, ...(title === undefined ? {} : { title }) };
        documents.push(document);
      }
      disk.set(document.path!, content);
      return { index: index(), document: { ...document }, created };
    }),
    addExistingDocument: vi.fn(async ({ documentId, path }) => {
      const existing = documents.find(item => item.path === path);
      if (existing) return { index: index(), document: { ...existing }, added: false };
      const document = { id: documentId, path, title: path.split(/[\\/]/).at(-1)! };
      documents.push(document);
      return { index: index(), document: { ...document }, added: true };
    }),
    detachDocument: vi.fn(async ({ documentId }) => {
      const position = documents.findIndex(item => item.id === documentId);
      if (position !== -1) documents.splice(position, 1);
      return index();
    }),
    removeDocument: vi.fn(async ({ documentId }) => {
      const position = documents.findIndex(item => item.id === documentId);
      if (position !== -1) {
        const [removed] = documents.splice(position, 1);
        if (removed?.path) disk.delete(removed.path);
      }
      return index();
    }),
  };
  return { api, documents, disk, external: (path: string, content: string) => disk.set(path, content) };
}

function mount(
  f: { api: DocumentsApi },
  pickDirectory?: () => Promise<string | null>,
  pickOutputFiles?: () => Promise<{ paths: readonly string[]; cancelled: boolean }>,
  confirmDelete?: (name: string) => boolean,
) {
  const section = document.createElement('section');
  const workspaceId = `workspace-${++sequence}`;
  let created = 0;
  const dispose = mountDocumentEditor(section, {
    workspaceId,
    api: f.api,
    ...(pickDirectory === undefined ? {} : { pickDirectory }),
    ...(pickOutputFiles === undefined ? {} : { pickOutputFiles }),
    ...(confirmDelete === undefined ? {} : { confirmDelete }),
    newId: () => created++ === 0 ? `doc-${sequence}` : `doc-${sequence}-${created}`,
  });
  return { section, workspaceId, dispose };
}

beforeEach(() => { mocks.instances.length = 0; });

describe('Output 创建', () => {
  it('打开空工作区时不创建 Draft 或文件，只显示空状态', async () => {
    const f = fakeHost();
    const view = mount(f);
    await tick();
    expect(mocks.instances).toHaveLength(0);
    expect(view.section.querySelectorAll('.sift-output-tab')).toHaveLength(0);
    expect(view.section.querySelector('[data-sift-output-empty]')?.textContent).toContain('暂无打开的产出');
    expect(f.api.saveDocument).not.toHaveBeenCalled();
    expect(view.section.querySelector('[data-sift-document-title]')).toBeNull();
    expect(view.section.querySelector('[data-sift-document-save]')).toBeNull();
    expect(view.section.querySelector('[data-sift-document-path]')).toBeNull();
    view.dispose();
  });

  it('点击加号输入文件名后立即创建真实 Markdown 并打开 Tab', async () => {
    const f = fakeHost();
    const view = mount(f);
    await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-add]')!.click();
    expect((view.section.querySelector('[data-sift-output-create-dialog]') as HTMLElement).hidden).toBe(false);
    expect(view.section.querySelector('[data-sift-output-create-form]')?.textContent).toContain('当前 Workspace/notes/');
    const input = view.section.querySelector<HTMLInputElement>('[aria-label="产出文件名"]')!;
    input.value = '设计说明.md';
    view.section.querySelector<HTMLFormElement>('[data-sift-output-create-form]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();

    expect(f.api.saveDocument).toHaveBeenCalledTimes(1);
    expect(f.api.saveDocument).toHaveBeenCalledWith({ workspaceId: view.workspaceId, documentId: `doc-${sequence}`, title: '设计说明.md', content: '' });
    expect(f.disk.get('notes/设计说明.md')).toBe('');
    expect(view.section.querySelector('.sift-output-tab[data-active]')?.textContent).toBe('设计说明.md');
    expect(mocks.instances.at(-1).value).toBe('');
    expect(view.section.querySelector('[role=status]')?.hasAttribute('hidden')).toBe(true);
    view.dispose();
  });

  it('可以选择 Workspace 外部目录，默认目录不是强制规则', async () => {
    const f = fakeHost();
    const pickDirectory = vi.fn(async () => 'D:\\Notes');
    const view = mount(f, pickDirectory);
    await tick();

    view.section.querySelector<HTMLButtonElement>('[data-sift-output-add]')!.click();
    view.section.querySelectorAll<HTMLButtonElement>('[data-sift-output-create-form] button')[0]!.click();
    await tick();
    expect(view.section.querySelector('[data-sift-output-create-location]')?.textContent).toContain('D:\\Notes');
    const input = view.section.querySelector<HTMLInputElement>('[aria-label="产出文件名"]')!;
    input.value = '外部笔记.md';
    view.section.querySelector<HTMLFormElement>('[data-sift-output-create-form]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();

    expect(f.api.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ targetDirectory: 'D:\\Notes', title: '外部笔记.md' }));
    expect(view.section.querySelector('.sift-output-tab[data-active]')?.textContent).toBe('外部笔记.md');
    view.dispose();
  });

  it('落盘之后的编辑恢复自动保存', async () => {
    const f = fakeHost();
    const view = mount(f);
    await tick();
    await createOutput(view.section, '自动保存');
    mocks.instances[0].value = '# 第二次';
    mocks.instances[0].update();
    await settle();
    await tick();
    expect(f.api.saveDocument).toHaveBeenCalledTimes(2);
    expect(f.disk.get('notes/自动保存.md')).toBe('# 第二次');
    view.dispose();
  });
});

describe('已落盘的 Document', () => {
  it('添加已有 Markdown 后打开原文件，重复添加不会产生重复 Tab', async () => {
    const f = fakeHost();
    f.external('D:\\Notes\\已有.md', '# 已有正文');
    const pick = vi.fn(async () => ({ paths: ['D:\\Notes\\已有.md'], cancelled: false }));
    const view = mount(f, undefined, pick);
    await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-add-existing]')!.click();
    await tick(); await tick();
    expect(view.section.querySelectorAll('.sift-output-tab')).toHaveLength(1);
    expect(view.section.querySelector('.sift-output-tab[data-active]')?.textContent).toBe('已有.md');
    expect(mocks.instances.at(-1).value).toBe('# 已有正文');
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-add-existing]')!.click();
    await tick(); await tick();
    expect(view.section.querySelectorAll('.sift-output-tab')).toHaveLength(1);
    view.dispose();
  });

  it('删除当前产出需要确认，确认后删除文件并切换到相邻 Tab', async () => {
    const f = fakeHost([
      { id: 'doc-a', path: 'notes/A.md', title: 'A', content: '# A' },
      { id: 'doc-b', path: 'notes/B.md', title: 'B', content: '# B' },
    ]);
    const confirmDelete = vi.fn(() => true);
    const view = mount(f, undefined, undefined, confirmDelete);
    await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-delete]')!.click();
    await tick(); await tick();
    expect(confirmDelete).toHaveBeenCalledWith('A');
    expect(f.api.removeDocument).toHaveBeenCalledWith({ workspaceId: view.workspaceId, documentId: 'doc-a' });
    expect(f.disk.has('notes/A.md')).toBe(false);
    expect(view.section.querySelectorAll('.sift-output-tab')).toHaveLength(1);
    expect(view.section.querySelector('.sift-output-tab[data-active]')?.textContent).toBe('B');
    view.dispose();
  });

  it('移除当前产出只解除登记并关闭 Tab，磁盘文件保持不变', async () => {
    const f = fakeHost([
      { id: 'doc-a', path: 'notes/A.md', title: 'A', content: '# A' },
      { id: 'doc-b', path: 'notes/B.md', title: 'B', content: '# B' },
    ]);
    const view = mount(f);
    await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-detach]')!.click();
    await tick(); await tick();
    expect(f.api.detachDocument).toHaveBeenCalledWith({ workspaceId: view.workspaceId, documentId: 'doc-a' });
    expect(f.api.removeDocument).not.toHaveBeenCalled();
    expect(f.disk.get('notes/A.md')).toBe('# A');
    expect(view.section.querySelectorAll('.sift-output-tab')).toHaveLength(1);
    expect(view.section.querySelector('.sift-output-tab[data-active]')?.textContent).toBe('B');
    view.dispose();
  });

  it('取消删除时文件与 Tab 均保持不变', async () => {
    const f = fakeHost({ id: 'doc-a', path: 'notes/A.md', title: 'A', content: '# A' });
    const view = mount(f, undefined, undefined, () => false);
    await tick();
    view.section.querySelector<HTMLButtonElement>('[data-sift-output-delete]')!.click();
    await tick();
    expect(f.api.removeDocument).not.toHaveBeenCalled();
    expect(f.disk.has('notes/A.md')).toBe(true);
    expect(view.section.querySelectorAll('.sift-output-tab')).toHaveLength(1);
    view.dispose();
  });

  it('打开登记表里的第一份并加载正文', async () => {
    const f = fakeHost({ id: 'doc-existing', path: 'notes/已有.md', title: '已有', content: '# 磁盘内容' });
    const view = mount(f);
    await tick();
    expect(mocks.instances[0].value).toBe('# 磁盘内容');
    expect(view.section.querySelector('.sift-output-tab[data-active]')?.textContent).toBe('已有');
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
  it('为全部已登记 Document 建立 Tabs，并可切换正文', async () => {
    const f = fakeHost([
      { id: 'doc-a', path: 'notes/A.md', title: 'A', content: '# A' },
      { id: 'doc-b', path: 'notes/B.md', title: 'B', content: '# B' },
    ]);
    const view = mount(f);
    await tick();

    const tabs = view.section.querySelectorAll<HTMLButtonElement>('.sift-output-tab');
    expect([...tabs].map(tab => tab.textContent)).toEqual(['A', 'B']);
    expect(mocks.instances[0].value).toBe('# A');

    tabs[1]!.click();
    await tick();
    await tick();

    expect(mocks.instances.at(-1).value).toBe('# B');
    expect(view.section.querySelector('.sift-output-tab[data-active]')?.textContent).toBe('B');
    view.dispose();
  });

  it('新建第二个 Output 后往返切换会保留各自草稿', async () => {
    const f = fakeHost();
    const view = mount(f);
    await tick();
    await createOutput(view.section, '第一份');

    mocks.instances[0].value = '# 第一份草稿';
    mocks.instances[0].update();
    await createOutput(view.section, '第二份');

    expect(view.section.querySelectorAll('.sift-output-tab')).toHaveLength(2);
    expect(mocks.instances.at(-1).value).toBe('');
    mocks.instances.at(-1).value = '# 第二份草稿';
    mocks.instances.at(-1).update();

    view.section.querySelectorAll<HTMLButtonElement>('.sift-output-tab')[0]!.click();
    await tick();
    await tick();
    expect(mocks.instances.at(-1).value).toBe('# 第一份草稿');

    view.section.querySelectorAll<HTMLButtonElement>('.sift-output-tab')[1]!.click();
    await tick();
    await tick();
    expect(mocks.instances.at(-1).value).toBe('# 第二份草稿');
    expect(f.disk.get('notes/第一份.md')).toBe('# 第一份草稿');
    expect(f.disk.get('notes/第二份.md')).toBe('# 第二份草稿');
    view.dispose();
  });

  it('卸载后重新挂载同一个工作区会恢复未保存的编辑', async () => {
    const f = fakeHost();
    const first = mount(f);
    await tick();
    await createOutput(first.section, '恢复测试');
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
