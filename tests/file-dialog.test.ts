import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { FileDialogUnsupportedError, dialogFilter, pickFiles } from '../src/host/source/file-dialog.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('对话框 Filter', () => {
  it('没有扩展名限制时只给「所有文件」', () => {
    expect(dialogFilter(undefined)).toBe('所有文件 (*.*)|*.*');
    expect(dialogFilter([])).toBe('所有文件 (*.*)|*.*');
  });

  it('把扩展名拼成 WinForms 的 Filter 字符串', () => {
    expect(dialogFilter(['.md', 'txt'])).toBe('可用的来源文件 (*.md;*.txt)|*.md;*.txt|所有文件 (*.*)|*.*');
  });
});

describe('原生多选文件对话框', () => {
  it('不支持当前平台时抛出可识别错误', async () => {
    await expect(pickFiles({ platform: 'linux' })).rejects.toBeInstanceOf(FileDialogUnsupportedError);
    await expect(pickFiles({ platform: 'linux' })).rejects.toThrow('暂不支持原生文件选择');
  });

  it('Windows 上调用 powershell 并把选中的多个路径读回来', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const promise = pickFiles({ platform: 'win32', spawn: spawn as never, title: 'Sift：选择来源文件', extensions: ['.md'] });

    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-STA');
    expect(String(args.at(-1))).toContain('$dialog.Multiselect = $true');
    expect((options as { env: Record<string, string> }).env.SIFT_DIALOG_FILTER).toContain('*.md');

    child.stdout.emit('data', 'C:\\Downloads\\a.md\nC:\\Downloads\\b b.md\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ paths: ['C:\\Downloads\\a.md', 'C:\\Downloads\\b b.md'], cancelled: false });
  });

  it('用户取消（没有任何输出）时返回 cancelled', async () => {
    const child = fakeChild();
    const promise = pickFiles({ platform: 'win32', spawn: vi.fn(() => child) as never });
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ paths: [], cancelled: true });
  });

  it('忽略空行，保留顺序', async () => {
    const child = fakeChild();
    const promise = pickFiles({ platform: 'win32', spawn: vi.fn(() => child) as never });
    child.stdout.emit('data', '\nD:\\a.txt\n\nD:\\b.txt\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ paths: ['D:\\a.txt', 'D:\\b.txt'], cancelled: false });
  });

  it('启动失败时给出可识别错误', async () => {
    const child = fakeChild();
    const promise = pickFiles({ platform: 'win32', spawn: vi.fn(() => child) as never });
    child.emit('error', new Error('spawn powershell.exe ENOENT'));
    await expect(promise).rejects.toBeInstanceOf(FileDialogUnsupportedError);
    await expect(promise).rejects.toThrow('无法启动系统文件对话框');
  });

  it('只在 stderr 报错时把原因透出来', async () => {
    const child = fakeChild();
    const promise = pickFiles({ platform: 'win32', spawn: vi.fn(() => child) as never });
    child.stderr.emit('data', 'Add-Type : 找不到 System.Windows.Forms\n');
    child.emit('close', 1);
    await expect(promise).rejects.toThrow('系统文件对话框失败：Add-Type');
  });

  it('macOS 上走 osascript', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const promise = pickFiles({ platform: 'darwin', spawn: spawn as never });
    expect(spawn.mock.calls[0]![0]).toBe('osascript');
    child.stdout.emit('data', '/Users/me/a.md\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ paths: ['/Users/me/a.md'], cancelled: false });
  });
});
