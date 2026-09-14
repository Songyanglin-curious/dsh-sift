import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDsh, runPnpm } from './runtime/process.mjs';

const PACKAGE_NAME = '@songyanglin/dsh-sift';
const root = fileURLToPath(new URL('../', import.meta.url));
const home = resolve(root, '.debug/verify');
const profile = 'web';
const packagesDir = join(home, 'packages');
const profileDir = join(home, 'profiles', profile);
const installedDir = join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'));
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
const REQUIRED_FILES = [
  'dist/host/index.js',
  'dist/host/typert.js',
  'dist/client/index.js',
  'dist/types/host/index.d.ts',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'LICENSE',
];

function fail(message) {
  throw new Error(message);
}

function assertInsideRoot(path) {
  const value = resolve(path);
  if (value === root || !value.startsWith(`${resolve(root)}${sep}`)) {
    fail(`拒绝清理仓库之外的路径：${value}`);
  }
}

async function pack() {
  await mkdir(packagesDir, { recursive: true });
  for (const file of await readdir(packagesDir)) {
    if (file.endsWith('.tgz')) await rm(join(packagesDir, file), { force: true });
  }
  await runPnpm(['pack', '--pack-destination', packagesDir], { cwd: root, env });
  const tarballs = (await readdir(packagesDir)).filter(file => file.endsWith('.tgz'));
  if (tarballs.length !== 1) fail(`预期只生成一个压缩包，实际找到 ${tarballs.length} 个。`);
  return join(packagesDir, tarballs[0]);
}

async function installed() {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
    return Boolean(manifest.dependencies?.[PACKAGE_NAME]);
  } catch {
    return false;
  }
}

async function add(tarball) {
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  koffi: true\n  esbuild: true\n');
  await runDsh(['plugin', '--profile', profile, 'add', tarball], { env });
}

async function remove() {
  if (await installed()) {
    await runDsh(['plugin', '--profile', profile, 'remove', PACKAGE_NAME], { env });
  }
}

async function assertInstalled() {
  if (!(await installed())) fail(`${PACKAGE_NAME} 未出现在隔离 Profile 依赖中。`);
  const missing = REQUIRED_FILES.filter(file => !existsSync(join(installedDir, file)));
  if (missing.length) fail(`安装结果缺少交付文件：${missing.join(', ')}`);
  for (const forbidden of ['presets', 'resources']) {
    if (existsSync(join(installedDir, forbidden))) fail(`发布包不应包含 ${forbidden}/。`);
  }
}

async function assertComposed() {
  const config = await runDsh(['--profile', profile, '--dump-config'], { env });
  if (!config.includes('sift')) fail('组合配置缺少 sift。');
  if (config.toLowerCase().includes('apb')) fail('组合配置不应包含 APB 标识。');
}

async function verify() {
  await remove();
  const tarball = await pack();
  console.log(`tarball：${relative(root, tarball)}`);
  try {
    await add(tarball);
    await assertInstalled();
    await assertComposed();
    console.log('组合校验通过：Host、Client、声明文件和 Bundle patch 均已就绪。');
  } finally {
    await remove();
  }
  console.log('卸载检查通过：Sift bundle 已移除。');
}

async function status() {
  console.log(`仓库目录：${root}`);
  console.log(`隔离 DSH_HOME：${home}`);
  console.log(`bundle 状态：${await installed() ? '已安装' : '未安装'}`);
}

const action = process.argv[2] ?? 'verify';
try {
  if (action === 'verify') await verify();
  else if (action === 'setup') {
    const tarball = await pack();
    await remove();
    await add(tarball);
    await assertInstalled();
    await assertComposed();
  } else if (action === 'remove') await remove();
  else if (action === 'status') await status();
  else if (action === 'clean') {
    assertInsideRoot(home);
    await remove();
    await rm(home, { recursive: true, force: true });
    console.log(`已清理隔离 Home：${home}`);
  } else fail('用法：node scripts/verify-package.mjs verify|setup|remove|status|clean');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
