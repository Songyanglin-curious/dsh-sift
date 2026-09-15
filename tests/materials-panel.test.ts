// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountMaterialsPanel } from '../src/client/materials-panel.js';
import type { FileEntry, Material, MaterialsApi } from '../src/materials.js';

const mocks = vi.hoisted(() => ({ preview: vi.fn(async (root: HTMLElement, item: { name: string }) => { root.textContent = item.name; return vi.fn(); }) }));
vi.mock('../src/client/material-preview.js', () => ({ previewMaterial: mocks.preview }));

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const START: Material[] = [{ id: 'md', kind: 'file', name: 'note.md', target: 'note.md' }, { id: 'pdf', kind: 'file', name: 'book.pdf', target: 'book.pdf' }];

function fixture(options: { items?: Material[]; entries?: FileEntry[] } = {}) {
  let items = options.items ?? START;
  const entries = options.entries ?? [{ name: 'new.docx', path: 'new.docx', directory: false }, { name: 'notes', path: 'notes', directory: true }];
  const api: MaterialsApi = {
    getMaterials: vi.fn(async () => ({ schemaVersion: 1, items })),
    listMaterialFiles: vi.fn(async input => {
      const prefix = input.path ? `${input.path}/` : '';
      return entries.filter(entry => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'));
    }),
    readMaterial: vi.fn(async () => ({ base64: btoa('sample') })),
    addMaterial: vi.fn(async input => {
      const existing = items.find(item => item.kind === input.kind && item.target === input.target);
      if (!existing) items = [...items, { id: `added-${input.target}`, name: input.target, kind: input.kind, target: input.target }];
      return { schemaVersion: 1, items };
    }),
    removeMaterial: vi.fn(async input => { items = items.filter(item => item.id !== input.id); return { schemaVersion: 1, items }; }),
  };
  const root = document.createElement('section');
  root.dataset.siftColumn = 'materials';
  document.body.append(root);
  const dispose = mountMaterialsPanel(root, 'workspace', api);
  return { api, root, dispose, items: () => items };
}

function menu(root: HTMLElement, item: 'file' | 'url') {
  root.querySelector<HTMLButtonElement>('[aria-label="新增素材引用"]')!.click();
  root.querySelectorAll<HTMLButtonElement>('[data-sift-material-menu] [role=menuitem]')[item === 'file' ? 0 : 1].click();
}

beforeEach(() => { document.body.replaceChildren(); mocks.preview.mockClear(); });

describe('materials tabs', () => {
  it('renders one tab per reference with its type badge and selects the first', async () => {
    const f = fixture(); await tick();
    const tabs = [...f.root.querySelectorAll<HTMLElement>('[data-material-tab]')];
    expect(tabs).toHaveLength(2);
    expect(tabs[0].querySelector('[data-material-badge]')?.textContent).toBe('MD');
    expect(tabs[1].querySelector('[data-material-badge]')?.textContent).toBe('PDF');
    expect(tabs[0].hasAttribute('data-active')).toBe(true);
    expect(tabs[0].querySelector('[role=tab]')?.getAttribute('aria-label')).toBe('note.md');
    expect(f.root.querySelector('[data-sift-material-target] code')?.textContent).toBe('note.md');
    f.dispose();
  });

  it('switches tabs and shows the reference path in the footer', async () => {
    const f = fixture(); await tick();
    f.root.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click(); await tick();
    expect(f.root.querySelectorAll('[data-material-tab]')[1].hasAttribute('data-active')).toBe(true);
    expect(f.root.querySelector('[role=tabpanel]')?.textContent).toBe('book.pdf');
    expect(f.root.querySelector('[data-sift-material-target] code')?.textContent).toBe('book.pdf');
    f.dispose();
  });

  it('adds a workspace file from the browser and selects its tab', async () => {
    const f = fixture(); await tick();
    menu(f.root, 'file'); await tick();
    expect(f.api.listMaterialFiles).toHaveBeenCalledWith({ workspaceId: 'workspace', path: '' });
    expect(f.root.querySelector('[data-sift-material-entries]')?.textContent).toContain('new.docx');
    f.root.querySelector<HTMLButtonElement>('[data-material-entry="new.docx"]')!.click(); await tick();
    expect(f.api.addMaterial).toHaveBeenCalledWith({ workspaceId: 'workspace', kind: 'file', target: 'new.docx' });
    expect(f.root.querySelector('[data-material-tab][data-active] [data-material-label]')?.textContent).toBe('new.docx');
    expect(f.root.querySelector('[data-sift-material-chooser]')?.hasAttribute('hidden')).toBe(true);
    f.dispose();
  });

  it('walks into a workspace subdirectory and marks references that already exist', async () => {
    const f = fixture({ entries: [
      { name: 'notes', path: 'notes', directory: true },
      { name: 'inside.md', path: 'notes/inside.md', directory: false },
      { name: 'note.md', path: 'note.md', directory: false },
    ] }); await tick();
    menu(f.root, 'file'); await tick();
    f.root.querySelector<HTMLButtonElement>('[data-material-entry="notes"]')!.click(); await tick();
    expect(f.api.listMaterialFiles).toHaveBeenLastCalledWith({ workspaceId: 'workspace', path: 'notes' });
    expect(f.root.querySelector<HTMLButtonElement>('[data-material-entry="note.md"]')).toBeNull();
    expect(f.root.querySelector<HTMLButtonElement>('[data-material-entry="notes/inside.md"]')!.disabled).toBe(false);
    f.dispose();
  });

  it('marks an already referenced file as added instead of adding it twice', async () => {
    const f = fixture({ entries: [{ name: 'note.md', path: 'note.md', directory: false }] }); await tick();
    menu(f.root, 'file'); await tick();
    const row = f.root.querySelector<HTMLButtonElement>('[data-material-entry="note.md"]')!;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain('已添加');
    f.dispose();
  });

  it('normalizes URL additions and selects the existing reference returned by the host', async () => {
    const f = fixture(); await tick();
    vi.mocked(f.api.addMaterial).mockResolvedValueOnce({ schemaVersion: 1, items: [
      { id: 'url', kind: 'url', target: 'https://example.com/', name: 'Example' },
      { id: 'md', kind: 'file', target: 'note.md', name: 'note.md' },
    ] });
    menu(f.root, 'url');
    const input = f.root.querySelector<HTMLInputElement>('[data-sift-material-url] input')!;
    input.value = 'https://example.com';
    f.root.querySelector('[data-sift-material-url]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(f.api.addMaterial).toHaveBeenCalledWith({ workspaceId: 'workspace', kind: 'url', target: 'https://example.com/' });
    expect(f.root.querySelector('[data-material-tab][data-active] [data-material-label]')?.textContent).toBe('Example');
    expect(f.root.querySelector('[data-material-tab][data-active] [data-material-badge]')?.textContent).toBe('WEB');
    f.dispose();
  });

  it('removes a reference without touching other tabs and keeps the original file untouched', async () => {
    const f = fixture(); await tick();
    f.root.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click(); await tick();
    f.root.querySelector<HTMLButtonElement>('[aria-label="移除「book.pdf」的引用（原文件保留）"]')!.click(); await tick();
    expect(f.api.removeMaterial).toHaveBeenCalledWith({ workspaceId: 'workspace', id: 'pdf' });
    expect(f.root.querySelector('[data-sift-material-status]')?.textContent).toContain('原文件仍保留');
    expect(f.root.querySelector('[role=tabpanel]')?.textContent).toBe('note.md');
    // The reference list shrank; the file itself is the host's business and stays on disk.
    expect(f.items().map(item => item.id)).toEqual(['md']);
    f.dispose();
  });

  it('falls back to the empty state when the last reference is removed', async () => {
    const f = fixture({ items: [{ id: 'md', kind: 'file', name: 'note.md', target: 'note.md' }] }); await tick();
    f.root.querySelector<HTMLButtonElement>('[data-material-close]')!.click(); await tick();
    expect(f.root.querySelector('[data-sift-material-empty]')).not.toBeNull();
    expect(f.root.querySelectorAll('[data-material-tab]')).toHaveLength(0);
    expect(f.root.querySelector('[data-sift-material-target]')?.hasAttribute('hidden')).toBe(true);
    f.dispose();
  });

  it('offers the workspace browser from the empty state so files are reachable without a URL', async () => {
    const f = fixture({ items: [] }); await tick();
    const start = f.root.querySelector<HTMLButtonElement>('[data-material-empty]')!;
    expect(start.textContent).toBe('添加素材');
    start.click(); await tick();
    expect(f.api.listMaterialFiles).toHaveBeenCalledWith({ workspaceId: 'workspace', path: '' });
    expect(f.root.querySelector('[data-sift-material-entries]')?.textContent).toContain('new.docx');
    f.dispose();
  });

  it('reports a missing file and keeps the reference list intact', async () => {
    const f = fixture(); await tick();
    vi.mocked(f.api.readMaterial).mockRejectedValueOnce(new Error('ENOENT：文件不存在。'));
    f.root.querySelectorAll<HTMLButtonElement>('[role=tab]')[0].click(); await tick();
    expect(f.root.querySelector('[data-sift-material-missing]')?.textContent).toContain('无法预览这条素材');
    expect(f.root.querySelector('[data-sift-material-status]')?.textContent).toContain('ENOENT');
    f.dispose();
  });

  it('ignores stale file reads after another tab is selected', async () => {
    const f = fixture(); await tick();
    let finish!: (value: { base64: string }) => void;
    vi.mocked(f.api.readMaterial).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.root.querySelectorAll<HTMLButtonElement>('[role=tab]')[0].click();
    f.root.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click(); await tick();
    finish({ base64: btoa('old') }); await tick();
    expect(f.root.querySelector('[role=tabpanel]')?.textContent).toBe('book.pdf');
    f.dispose();
  });

  it('re-reads the reference list when the workspace changes outside the panel', async () => {
    const f = fixture(); await tick();
    vi.mocked(f.api.getMaterials).mockResolvedValueOnce({ schemaVersion: 1, items: [...START, { id: 'docx', kind: 'file', name: 'later.docx', target: 'later.docx' }] });
    f.root.querySelector<HTMLButtonElement>('[aria-label="重新读取素材引用"]')!.click(); await tick();
    expect(f.root.querySelectorAll('[data-material-tab]')).toHaveLength(3);
    f.root.querySelectorAll<HTMLButtonElement>('[role=tab]')[2].click(); await tick();
    expect(f.root.querySelector('[data-sift-material-target] code')?.textContent).toBe('later.docx');
    f.dispose();
  });
});
