// @vitest-environment jsdom
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mountMaterialsPanel } from '../src/client/materials-panel.js';
import { listMaterialFiles, mutateMaterials, readMaterial, readMaterials } from '../src/host/materials.js';
import type { MaterialsApi } from '../src/materials.js';

// Vitest runs with the project root as the working directory; jsdom has no file: URL for import.meta.
const sampleDirectory = resolve('scripts/runtime/samples');
const samples = ['01-素材说明.md', '02-参考资料.pdf', '03-参考文档.docx', '04-旧格式.doc'];

async function until<T>(check: () => T | undefined | null | false, label: string, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * Drives the real material panel against the real host module and the real preview renderers over a
 * throwaway workspace: reference maintenance, the VS Code style tab bar and every renderer except
 * PDF (PDF.js needs a dedicated Worker, covered by pdf-rendering.test.ts).
 */
describe('materials workspace integration', () => {
  let workspace = '';
  let root: HTMLElement;
  let dispose: () => void;
  let api: MaterialsApi;

  beforeAll(async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    // 部分预览组件会读取选区 Range，jsdom 默认未实现这些几何方法。
    const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
    Range.prototype.getClientRects = emptyRects;
    Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
    workspace = await mkdtemp(join(tmpdir(), 'sift-materials-'));
    await mkdir(join(workspace, '.sift'), { recursive: true });
    for (const name of samples) await copyFile(join(sampleDirectory, name), join(workspace, name));
    api = {
      getMaterials: async () => readMaterials(workspace),
      listMaterialFiles: async input => listMaterialFiles(workspace, input.path),
      addMaterial: async input => mutateMaterials(workspace, input),
      removeMaterial: async input => mutateMaterials(workspace, input),
      readMaterial: async input => readMaterial(workspace, input.id),
    };
    root = document.createElement('section');
    root.dataset.siftColumn = 'materials';
    document.body.append(root);
    dispose = mountMaterialsPanel(root, 'workspace', api);
  }, 30000);

  afterAll(async () => {
    dispose?.();
    root?.remove();
    vi.unstubAllGlobals();
    await rm(workspace, { recursive: true, force: true });
  });

  const tab = (name: string) => until(
    () => [...root.querySelectorAll<HTMLElement>('[data-material-tab]')].find(node => node.querySelector('[data-material-label]')?.textContent === name),
    `标签 ${name}`,
  );
  // The panel disables its reload action while a preview is loading or a relation is being written.
  const idle = () => until(
    () => root.querySelector<HTMLButtonElement>('[aria-label="重新读取素材引用"]')?.disabled === false ? true : undefined,
    '面板空闲',
  );
  const select = async (name: string) => {
    (await tab(name)).querySelector<HTMLButtonElement>('[role=tab]')!.click();
    await idle();
  };
  const addFile = async (name: string) => {
    root.querySelector<HTMLButtonElement>('[aria-label="新增素材引用"]')!.click();
    await until(() => root.querySelector<HTMLElement>('[data-sift-material-menu]:not([hidden])'), '新增菜单');
    root.querySelectorAll<HTMLButtonElement>('[data-sift-material-menu] [role=menuitem]')[0].click();
    const row = await until(() => root.querySelector<HTMLButtonElement>(`[data-material-entry="${name}"]`), `目录项 ${name}`);
    row.click();
    await tab(name);
    await idle();
  };

  it('starts from the empty state and describes the supported material types', async () => {
    const empty = await until(() => root.querySelector<HTMLElement>('[data-sift-material-empty]'), '空状态');
    expect(empty.textContent).toContain('还没有素材引用');
    expect(root.querySelector<HTMLButtonElement>('[data-material-empty]')?.textContent).toBe('添加素材');
  }, 30000);

  it('adds every workspace sample through the file browser and writes the relation file', async () => {
    for (const name of samples) await addFile(name);
    expect(root.querySelectorAll('[data-material-tab]')).toHaveLength(4);
    const stored = await readMaterials(workspace);
    expect(stored.items.map(item => item.target)).toEqual(samples);
    // Only references were written; the source files are untouched.
    expect((await readdir(workspace)).sort()).toEqual([...samples, '.sift'].sort());
  }, 60000);

  it('adds a web reference through the URL form', async () => {
    root.querySelector<HTMLButtonElement>('[aria-label="新增素材引用"]')!.click();
    await until(() => root.querySelector<HTMLElement>('[data-sift-material-menu]:not([hidden])'), '新增菜单');
    root.querySelectorAll<HTMLButtonElement>('[data-sift-material-menu] [role=menuitem]')[1].click();
    const input = await until(() => root.querySelector<HTMLInputElement>('[data-sift-material-url] input'), '网页地址输入框');
    input.value = 'https://example.com';
    root.querySelector('[data-sift-material-url]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tab('https://example.com/');
    await idle();
    const frame = await until(() => root.querySelector<HTMLIFrameElement>('[data-sift-material-preview] iframe'), '网页 iframe');
    expect(frame.src).toBe('https://example.com/');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect((await readMaterials(workspace)).items.at(-1)?.target).toBe('https://example.com/');
  }, 30000);

  it('renders Markdown read-only through DSH MarkdownText', async () => {
    await select('01-素材说明.md');
    const heading = await until(() => root.querySelector<HTMLElement>('[data-sift-material-preview] h1'), 'Markdown 标题');
    expect(heading.textContent).toBe('素材预览验收');
    expect(root.querySelector('[data-sift-material-preview] [data-dsh-markdown-text]')).not.toBeNull();
    expect(root.querySelector('[data-sift-material-preview] [contenteditable]')).toBeNull();
  }, 30000);

  it('renders the DOCX into a script-disabled frame and refuses to parse legacy DOC', async () => {
    await select('03-参考文档.docx');
    const body = await until(() => root.querySelector<HTMLIFrameElement>('[data-sift-material-preview] iframe[data-format=docx]')?.contentDocument?.body, 'DOCX 正文');
    await until(() => body.textContent?.includes('DOCX 中文素材预览') ? body : undefined, 'DOCX 文本');
    expect(root.querySelector('[data-sift-material-preview] iframe')?.getAttribute('sandbox')).toBe('allow-same-origin');

    await select('04-旧格式.doc');
    const hint = await until(() => root.querySelector<HTMLElement>('[data-sift-material-preview]')?.textContent?.includes('暂不支持 .doc') ? root.querySelector<HTMLElement>('[data-sift-material-preview]') : undefined, 'DOC 提示');
    expect(hint.textContent).toContain('暂不支持 .doc');
  }, 30000);

  it('keeps the original file on disk when its reference is removed', async () => {
    const target = await tab('04-旧格式.doc');
    target.querySelector<HTMLButtonElement>('[data-material-close]')!.click();
    await idle();
    await until(() => root.querySelectorAll('[data-material-tab]').length === 4 ? true : undefined, '删除后的标签数');
    expect((await readMaterials(workspace)).items.map(item => item.target)).not.toContain('04-旧格式.doc');
    expect((await stat(join(workspace, '04-旧格式.doc'))).isFile()).toBe(true);
  }, 30000);
});
