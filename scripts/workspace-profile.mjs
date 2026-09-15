import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = resolve(process.env.SIFT_DEV_HOME ?? resolve(root, '.debug/development'));
export const workspaceRoot = resolve(home, 'workspace-profile');
export const defaultWorkspace = resolve(workspaceRoot, 'default');
export const siftWorkspace = resolve(workspaceRoot, 'sift');
const configPath = resolve(siftWorkspace, '.sift/config.json');

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
  return { defaultWorkspace, siftWorkspace, configPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await setupWorkspaceProfile(), null, 2));
}
