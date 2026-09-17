import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OpenPathError, launchPlan, openPathInEditor } from '../src/host/open-path.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
}

describe('launchPlan', () => {
  it('配置了编辑器时用编辑器打开文件', () => {
    expect(launchPlan('D:\\a\\b.md', 'D:\\ProgrameFiles\\Microsoft VS Code\\Code.exe', 'win32'))
      .toEqual({ command: 'D:\\ProgrameFiles\\Microsoft VS Code\\Code.exe', args: ['D:\\a\\b.md'] });
  });

  it('未配置时 Windows 交给 start', () => {
    expect(launchPlan('D:\\a\\b.md', undefined, 'win32')).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'D:\\a\\b.md'] });
  });

  it('未配置时 macOS 交给 open', () => {
    expect(launchPlan('/tmp/a.md', '   ', 'darwin')).toEqual({ command: 'open', args: ['/tmp/a.md'] });
  });

  it('未配置时 Linux 交给 xdg-open', () => {
    expect(launchPlan('/tmp/a.md', undefined, 'linux')).toEqual({ command: 'xdg-open', args: ['/tmp/a.md'] });
  });
});

describe('openPathInEditor', () => {
  it('拒绝相对路径', async () => {
    await expect(openPathInEditor('notes/a.md', { platform: 'win32' })).rejects.toBeInstanceOf(OpenPathError);
    await expect(openPathInEditor('notes/a.md', { platform: 'win32' })).rejects.toThrow('只能打开绝对路径');
  });

  it('目标不是已存在的普通文件时拒绝', async () => {
    const isFile = vi.fn(async () => false);
    await expect(openPathInEditor('D:\\missing.md', { platform: 'win32', isFile })).rejects.toThrow('文件不存在或不是普通文件');
  });

  it('命中校验后用配置的编辑器分离启动', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const promise = openPathInEditor('D:\\a\\b.md', {
      editorCommand: 'D:\\Code.exe', platform: 'win32', spawn: spawn as never, isFile: async () => true,
    });

    expect(spawn).toHaveBeenCalledWith('D:\\Code.exe', ['D:\\a\\b.md'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.emit('spawn');
    await expect(promise).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalled();
  });

  it('可执行文件不存在时给出可读错误', async () => {
    const child = fakeChild();
    const promise = openPathInEditor('D:\\a\\b.md', {
      editorCommand: 'D:\\nope\\Code.exe', platform: 'win32', spawn: vi.fn(() => child) as never, isFile: async () => true,
    });
    const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    child.emit('error', error);
    await expect(promise).rejects.toThrow('找不到可执行文件：D:\\nope\\Code.exe');
  });
});
