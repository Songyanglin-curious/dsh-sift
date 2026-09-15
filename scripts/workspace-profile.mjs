import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = resolve(process.env.SIFT_DEV_HOME ?? resolve(root, '.debug/development'));
export const workspaceRoot = resolve(home, 'workspace-profile');
export const defaultWorkspace = resolve(workspaceRoot, 'default');
export const siftWorkspace = resolve(workspaceRoot, 'sift');
const configPath = resolve(siftWorkspace, '.sift/config.json');
const materialsPath = resolve(siftWorkspace, '.sift/materials.json');
const sampleDirectory = fileURLToPath(new URL('./runtime/samples/', import.meta.url));

/** True when the path exists, re-throwing anything that is not a plain "no such file". */
async function exists(path) {
  try { await readFile(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

/**
 * Development preview fixture: give the Sift workspace one reference per preview renderer so the
 * material tabs, the type badges and the read-only previews are visible without preparing files by
 * hand. Never overwrites an existing relation file or an existing sample file.
 */
export async function seedPreviewMaterials() {
  if (await exists(materialsPath)) return { seeded: false, items: [] };
  const names = (await readdir(sampleDirectory)).sort();
  for (const name of names) {
    const target = resolve(siftWorkspace, name);
    if (await exists(target)) continue;
    await copyFile(resolve(sampleDirectory, name), target);
  }
  const items = names.map(name => ({ id: randomUUID(), name, kind: 'file', target: name }));
  await writeFile(materialsPath, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, { flag: 'wx' });
  return { seeded: true, items };
}

export async function setupWorkspaceProfile() {
  await mkdir(defaultWorkspace, { recursive: true });
  await mkdir(resolve(siftWorkspace, '.sift'), { recursive: true });
  try {
    const existing = await readFile(configPath, 'utf8');
    JSON.parse(existing);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`拒绝覆盖已有损坏配置：${configPath}`);
    await writeFile(configPath, `${JSON.stringify({ schemaVersion: 1, profile: 'sift' }, null, 2)}\n`, { flag: 'wx' });
  }
  const preview = await seedPreviewMaterials();
  return { defaultWorkspace, siftWorkspace, configPath, materialsPath, preview };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await setupWorkspaceProfile(), null, 2));
}
