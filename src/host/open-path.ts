import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * 在本机打开一个文件。
 *
 * 为什么必须由 Host 做：浏览器不能启动本地程序。
 *
 * 行为：优先使用插件配置里的编辑器（`config.editorCommand`），
 * 未配置时交给系统默认程序（Windows `start` / macOS `open` / Linux `xdg-open`）。
 *
 * 安全：只接受**绝对路径**且**必须是已存在的普通文件**，
 * 避免任意字符串被当作参数交给外部程序。
 */

/** 打开失败；message 可直接展示给用户。 */
export class OpenPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenPathError';
  }
}

export interface LaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * 决定用什么命令打开：配置了编辑器就用它，否则用平台默认打开器。
 * 纯函数，便于测试。
 */
export function launchPlan(path: string, editorCommand: string | undefined, platform: NodeJS.Platform): LaunchPlan {
  const editor = editorCommand?.trim() ?? '';
  if (editor !== '') return { command: editor, args: [path] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', path] };
  if (platform === 'darwin') return { command: 'open', args: [path] };
  return { command: 'xdg-open', args: [path] };
}

export interface OpenPathOptions {
  /** 插件配置里的编辑器可执行文件路径；留空表示用系统默认程序。 */
  readonly editorCommand?: string | undefined;
  readonly platform?: NodeJS.Platform;
  /** 注入点，便于测试；默认使用 `node:child_process` 的 spawn。 */
  readonly spawn?: typeof spawn;
  /** 注入的文件探测，便于测试；默认用 fs.stat。 */
  readonly isFile?: (path: string) => Promise<boolean>;
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 分离启动：不持有 stdio、立即 unref，让被打开的程序活过 Host。 */
function spawnDetached(command: string, args: readonly string[], run: typeof spawn): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; action(); } };

    const child = run(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', error => finish(() => reject(new OpenPathError(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `找不到可执行文件：${command}（若这是 editorCommand，请检查 cordis.patch.yml 中的路径）`
        : `启动失败：${error.message}`,
    ))));
    child.once('spawn', () => {
      child.unref();
      finish(() => resolvePromise());
    });
  });
}

/** 打开一个已存在的文件；失败抛 OpenPathError。 */
export async function openPathInEditor(path: string, options: OpenPathOptions = {}): Promise<void> {
  const target = path.trim();
  if (target === '') throw new OpenPathError('路径为空。');
  if (!isAbsolute(target)) throw new OpenPathError(`只能打开绝对路径：${target}`);
  if (!(await (options.isFile ?? defaultIsFile)(target))) throw new OpenPathError(`文件不存在或不是普通文件：${target}`);

  const { command, args } = launchPlan(target, options.editorCommand, options.platform ?? process.platform);
  await spawnDetached(command, args, options.spawn ?? spawn);
}
