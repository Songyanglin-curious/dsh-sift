// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountDocumentEditor } from '../src/client/document-editor.js';
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
let sequence = 0;
function fixture() {
  let disk = '# Local';
  const writable = { write: vi.fn(async (value: string) => { disk = value; }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const handle = { name: 'local.md', getFile: vi.fn(async () => ({ text: async () => disk })), createWritable: vi.fn(async () => writable) };
  Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: vi.fn(async () => [handle]) });
  const section = document.createElement('section');
  const id = `test-${++sequence}`;
  const dispose = mountDocumentEditor(section, id);
  return { section, id, dispose, handle, writable, disk: () => disk, external: (value: string) => { disk = value; } };
}
beforeEach(() => { mocks.instances.length = 0; });
describe('local Markdown files', () => {
  it('starts with file selection and writes the latest editor text to the original file', async () => {
    const f = fixture();
    await tick();
    expect(mocks.instances).toHaveLength(0);
    expect(f.section.textContent).toContain('选择产出文件');
    f.section.querySelector('button')!.click();
    await tick();
    expect(mocks.instances[0].value).toBe('# Local');
    mocks.instances[0].value = '# Changed';
    mocks.instances[0].update();
    await new Promise(resolve => setTimeout(resolve, 450));
    await tick();
    expect(f.disk()).toBe('# Changed');
    expect(f.writable.close).toHaveBeenCalledOnce();
    expect(f.section.querySelectorAll('button')).toHaveLength(1);
    expect(f.section.querySelector('[role=status]')?.hasAttribute('hidden')).toBe(true);
    f.dispose();
  });
  it('does not overwrite externally changed files', async () => {
    const f = fixture();
    await tick();
    f.section.querySelector('button')!.click();
    await tick();
    mocks.instances[0].value = 'my edit';
    f.external('external edit');
    mocks.instances[0].update();
    await new Promise(resolve => setTimeout(resolve, 450));
    await tick();
    expect(f.handle.createWritable).not.toHaveBeenCalled();
    expect(f.section.textContent).toContain('文件已被其他程序修改');
    f.dispose();
  });
  it('flushes pending changes on workspace teardown and restores the selected file', async () => {
    const f = fixture();
    await tick();
    f.section.querySelector('button')!.click();
    await tick();
    mocks.instances[0].value = 'pending';
    f.dispose();
    await tick();
    const dispose = mountDocumentEditor(document.createElement('section'), f.id);
    await tick();
    expect(mocks.instances[1].value).toBe('pending');
    expect(f.disk()).toBe('pending');
    expect(f.handle.createWritable).toHaveBeenCalledOnce();
    dispose();
  });
});
