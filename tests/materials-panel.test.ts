// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mountMaterialsPanel } from '../src/client/materials-panel.js';
import type { Material, MaterialsApi } from '../src/materials.js';
const mocks = vi.hoisted(() => ({ preview: vi.fn(async (root: HTMLElement, item: { name: string }) => { root.textContent = item.name; return vi.fn(); }) }));
vi.mock('../src/client/material-preview.js', () => ({ previewMaterial: mocks.preview }));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  let items: Material[] = [{ id: 'md', kind: 'file', name: 'note.md', target: 'note.md' }, { id: 'pdf', kind: 'file', name: 'book.pdf', target: 'book.pdf' }];
  const api: MaterialsApi = {
    getMaterials: vi.fn(async () => ({ schemaVersion: 1, items })),
    listMaterialFiles: vi.fn(async () => [{ name: 'new.docx', path: 'new.docx', directory: false }]),
    readMaterial: vi.fn(async () => ({ base64: btoa('sample') })),
    addMaterial: vi.fn(async input => { items = [...items, { id: 'new', name: input.target, kind: input.kind, target: input.target }]; return { schemaVersion: 1, items }; }),
    removeMaterial: vi.fn(async input => { items = items.filter(item => item.id !== input.id); return { schemaVersion: 1, items }; }),
  };
  const root = document.createElement('section'); root.dataset.siftColumn = 'materials';
  const dispose = mountMaterialsPanel(root, 'workspace', api);
  return { api, root, dispose };
}
describe('materials tabs', () => {
  it('normalizes URL additions and selects the existing reference returned by the host', async () => {
    const f = fixture(); await tick();
    vi.mocked(f.api.addMaterial).mockResolvedValueOnce({ schemaVersion: 1, items: [
      { id: 'url', kind: 'url', target: 'https://example.com/', name: 'Example' },
      { id: 'md', kind: 'file', target: 'note.md', name: 'note.md' },
    ] });
    f.root.querySelector<HTMLButtonElement>('[aria-label="新增素材引用"]')!.click(); await tick();
    f.root.querySelector<HTMLInputElement>('input')!.value = 'https://example.com';
    f.root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick();
    expect(f.api.addMaterial).toHaveBeenCalledWith({ workspaceId: 'workspace', kind: 'url', target: 'https://example.com/' });
    expect(f.root.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Example');
    f.dispose();
  });
  it('switches tabs, removes an active reference and adds a workspace file', async () => {
    const f = fixture(); await tick();
    expect(f.root.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('note.md');
    f.root.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click(); await tick();
    expect(f.root.querySelector('[role=tabpanel]')?.textContent).toBe('book.pdf');
    f.root.querySelector<HTMLButtonElement>('[aria-label="移除 book.pdf 的引用（保留原文件）"]')!.click(); await tick();
    expect(f.api.removeMaterial).toHaveBeenCalledWith({ workspaceId: 'workspace', id: 'pdf' });
    expect(f.root.querySelector('[role=tabpanel]')?.textContent).toBe('note.md');
    f.root.querySelector<HTMLButtonElement>('[aria-label="新增素材引用"]')!.click(); await tick();
    Array.from(f.root.querySelectorAll('button')).find(button => button.textContent === 'new.docx')!.click(); await tick();
    expect(f.root.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('new.docx');
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
});
