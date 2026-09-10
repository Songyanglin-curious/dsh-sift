import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function dshEntry() {
  if (process.env.SIFT_DSH_ENTRY) return resolve(process.env.SIFT_DSH_ENTRY);
  const volta = spawnSync('volta', ['which', 'dsh'], { encoding: 'utf8', windowsHide: true });
  if (volta.status === 0) {
    const candidate = resolve(dirname(volta.stdout.trim()), 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('无法定位已安装 DSH。请设置 SIFT_DSH_ENTRY 指向 DSH 的 lib/bin.js。');
}

export function launchDsh(args, options = {}) {
  return spawn(process.execPath, [dshEntry(), ...args], { windowsHide: true, ...options });
}

export async function runPnpm(args, options = {}) {
  const child = spawn('pnpm', args, {
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
    ...options,
  });
  await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolvePromise()
      : reject(new Error(`pnpm ${args.join(' ')} 退出 ${code}`)));
  });
}

export async function runDsh(args, options = {}) {
  const child = launchDsh(args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk; });
  child.stderr?.on('data', chunk => { output += chunk; });
  await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolvePromise()
      : reject(new Error(`dsh ${args.join(' ')} 退出 ${code}\n${output}`)));
  });
  return output;
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolvePromise => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  await exited;
}
