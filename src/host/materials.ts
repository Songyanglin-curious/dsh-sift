import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { materialsSchema, normalizeMaterialUrl, type Materials } from '../materials.js';

const queues = new Map<string, Promise<unknown>>();
export async function workspaceFile(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const target = await realpath(resolve(base, path));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('只能访问当前工作区内的文件。');
  return target;
}
async function metadataPath(root: string) {
  const directory = resolve(root, '.sift');
  await mkdir(directory, { recursive: true });
  await workspaceFile(root, '.sift');
  const target = resolve(directory, 'materials.json');
  try { await workspaceFile(root, '.sift/materials.json'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}
export async function readMaterials(root: string): Promise<Materials> {
  const path = await metadataPath(root);
  try { return materialsSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, items: [] }; throw error; }
}
export async function listMaterialFiles(root: string, path: string) {
  const directory = await workspaceFile(root, path);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(entry => !entry.isSymbolicLink() && !['.git', '.sift', 'node_modules'].includes(entry.name)
    && (entry.isDirectory() || /\.(md|markdown|pdf|docx|doc)$/i.test(entry.name)))
    .map(entry => ({ name: entry.name, path: relative(root, resolve(directory, entry.name)).split(sep).join('/'), directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}
export function mutateMaterials(root: string, mutation: { kind: 'file' | 'url'; target: string } | { id: string }): Promise<Materials> {
  const key = resolve(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const state = await readMaterials(root);
    if ('id' in mutation) state.items = state.items.filter(item => item.id !== mutation.id);
    else {
      const target = mutation.kind === 'url' ? normalizeMaterialUrl(mutation.target)
        : relative(root, await workspaceFile(root, mutation.target)).split(sep).join('/');
      if (mutation.kind === 'file' && !(await stat(await workspaceFile(root, target))).isFile()) throw new Error('请选择文件。');
      if (!state.items.some(item => item.kind === mutation.kind && item.target === target)) {
        state.items.push({ id: randomUUID(), kind: mutation.kind, target, name: mutation.kind === 'url' ? target : basename(target) });
      }
    }
    const path = await metadataPath(root);
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
    return state;
  });
  queues.set(key, work);
  void work.finally(() => { if (queues.get(key) === work) queues.delete(key); }).catch(() => {});
  return work;
}
export async function readMaterial(root: string, id: string) {
  const material = (await readMaterials(root)).items.find(item => item.id === id);
  if (!material || material.kind !== 'file') throw new Error('文件引用不存在。');
  const path = await workspaceFile(root, material.target);
  if ((await stat(path)).size > 30 * 1024 * 1024) throw new Error('文件超过 30 MB，请使用本地应用打开。');
  return { base64: (await readFile(path)).toString('base64') };
}
