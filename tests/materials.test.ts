import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listMaterialFiles, mutateMaterials, readMaterial, readMaterials, workspaceFile } from '../src/host/materials.js';
import { materialFormat, normalizeMaterialUrl } from '../src/materials.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sift-materials-')); roots.push(root);
  await writeFile(join(root, 'note.md'), '# 原始素材\n');
  await writeFile(join(root, 'legacy.doc'), 'legacy');
  await mkdir(join(root, 'folder'));
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('durable material relationships', () => {
  it('lists supported candidates, persists references and only removes the relationship', async () => {
    const root = await fixture();
    expect((await listMaterialFiles(root, '')).map(entry => entry.name)).toEqual(['folder', 'legacy.doc', 'note.md']);
    const state = await mutateMaterials(root, { kind: 'file', target: 'note.md' });
    expect(await readMaterials(root)).toEqual(state);
    expect(Buffer.from((await readMaterial(root, state.items[0].id)).base64, 'base64').toString()).toBe('# 原始素材\n');
    expect((await mutateMaterials(root, { kind: 'file', target: './note.md' })).items).toHaveLength(1);
    expect((await mutateMaterials(root, { id: state.items[0].id })).items).toEqual([]);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('# 原始素材\n');
  });
  it('serializes additions without losing references and isolates workspaces', async () => {
    const root = await fixture(); const other = await fixture();
    await Promise.all([mutateMaterials(root, { kind: 'file', target: 'note.md' }), mutateMaterials(root, { kind: 'url', target: 'https://example.com' })]);
    expect((await readMaterials(root)).items).toHaveLength(2);
    expect((await readMaterials(other)).items).toHaveLength(0);
    expect((await readMaterials(root)).items[1].target).toBe('https://example.com/');
  });
  it('rejects workspace escapes and invalid URLs', async () => {
    const root = await fixture(); const outside = await fixture();
    await expect(workspaceFile(root, join(outside, 'note.md'))).rejects.toThrow('当前工作区');
    await expect(mutateMaterials(root, { kind: 'url', target: 'javascript:alert(1)' })).rejects.toThrow('HTTP');
    expect(() => normalizeMaterialUrl('https://user:pass@example.com')).toThrow();
  });
  it('does not replace corrupt relationship metadata', async () => {
    const root = await fixture(); await mkdir(join(root, '.sift'));
    await writeFile(join(root, '.sift/materials.json'), '{broken');
    await expect(mutateMaterials(root, { kind: 'file', target: 'note.md' })).rejects.toThrow();
    expect(await readFile(join(root, '.sift/materials.json'), 'utf8')).toBe('{broken');
  });
  it('dispatches Markdown, PDF, DOCX, DOC and URL separately', () => {
    expect(['note.MD', 'note.markdown', 'book.pdf', 'book.docx', 'old.doc', 'other.txt'].map(target => materialFormat({ kind: 'file', target }))).toEqual(['md', 'md', 'pdf', 'docx', 'doc', 'unsupported']);
    expect(materialFormat({ kind: 'url', target: 'https://example.com/book.pdf' })).toBe('url');
  });
});
