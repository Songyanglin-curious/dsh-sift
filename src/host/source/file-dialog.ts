import { spawn } from 'node:child_process';

/**
 * 本机文件选择：多选的原生文件对话框。
 *
 * 为什么要自己实现：DSH 只提供**目录**选择器（`ctx.directoryPicker`），
 * 而且 `dsh-host-directory-picker-native` 把 Win32 `IFileOpenDialog` 固定成
 * 文件夹模式（标题 "Select Workspace Directory"），既不能选文件也不能多选。
 * 因此 Phase 2 的「添加本机文件」由 Sift 自己的 Host 打开系统文件对话框。
 *
 * 约束：
 * - 对话框出现在 **Host 所在的显示器**上。本机使用时没问题；如果将来通过远程
 *   浏览器使用，这里会失败，调用方需要回落到工作区/路径输入的浏览方式。
 * - 目前只实现 Windows（`System.Windows.Forms.OpenFileDialog`）与 macOS
 *   （`osascript`）。其他平台抛出明确错误，由调用方回落。
 */

/** 选择器在宿主平台上不可用；调用方应回落到目录浏览或手动输入路径。 */
export class FileDialogUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileDialogUnsupportedError';
  }
}

export interface FileDialogResult {
  readonly paths: readonly string[];
  /** 用户取消选择。 */
  readonly cancelled: boolean;
}

export interface PickFilesOptions {
  readonly title?: string;
  /** 允许的扩展名，例如 `['.md', '.txt']`；省略表示不限制。 */
  readonly extensions?: readonly string[];
  /** 注入点，便于测试；默认使用 `node:child_process` 的 spawn。 */
  readonly spawn?: typeof spawn;
  readonly platform?: NodeJS.Platform;
}

/** Windows 用 Windows PowerShell 5.1（默认 STA，WinForms 对话框最稳）。 */
const WINDOWS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
  '$dialog.Title = $env:SIFT_DIALOG_TITLE',
  '$dialog.Multiselect = $true',
  '$dialog.Filter = $env:SIFT_DIALOG_FILTER',
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($dialog.FileNames -join \"`n\")) }",
].join('; ');

const MACOS_SCRIPT = 'set theFiles to choose file with prompt (system attribute "SIFT_DIALOG_TITLE") with multiple selections allowed\nset theOutput to ""\nrepeat with aFile in theFiles\nset theOutput to theOutput & (POSIX path of aFile) & linefeed\nend repeat\nreturn theOutput';

/** 由扩展名列表拼出 WinForms 的 Filter 字符串。 */
export function dialogFilter(extensions: readonly string[] | undefined): string {
  if (!extensions || extensions.length === 0) return '所有文件 (*.*)|*.*';
  const patterns = extensions.map(extension => `*${extension.startsWith('.') ? extension : `.${extension}`}`).join(';');
  return `可用的来源文件 (${patterns})|${patterns}|所有文件 (*.*)|*.*`;
}

function parsePaths(stdout: string): string[] {
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
}

/** 执行一次原生多选文件对话框。 */
export function pickFiles(options: PickFilesOptions = {}): Promise<FileDialogResult> {
  const platform = options.platform ?? process.platform;
  const run = options.spawn ?? spawn;
  const title = options.title ?? 'Sift：选择来源文件';

  if (platform !== 'win32' && platform !== 'darwin') {
    return Promise.reject(new FileDialogUnsupportedError(`当前平台（${platform}）暂不支持原生文件选择，请改用目录浏览或直接填写路径。`));
  }

  const command = platform === 'win32' ? 'powershell.exe' : 'osascript';
  const args = platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-STA', '-Command', WINDOWS_SCRIPT]
    : ['-e', MACOS_SCRIPT];
  const env = {
    ...process.env,
    SIFT_DIALOG_TITLE: title,
    SIFT_DIALOG_FILTER: dialogFilter(options.extensions),
  };

  return new Promise<FileDialogResult>((resolvePromise, reject) => {
    const child = run(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; action(); } };

    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => finish(() => reject(new FileDialogUnsupportedError(`无法启动系统文件对话框：${error.message}`))));
    child.once('close', () => {
      finish(() => {
        if (stderr.trim() !== '' && stdout.trim() === '') {
          reject(new Error(`系统文件对话框失败：${stderr.trim().split(/\r?\n/)[0]}`));
          return;
        }
        const paths = parsePaths(stdout);
        resolvePromise({ paths, cancelled: paths.length === 0 });
      });
    });
  });
}
