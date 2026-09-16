import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addSource,
  browseExternal,
  browseWorkspace,
  createSourceFile,
  readSourceIndex,
  removeSource,
} from '../src/host/source/store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sift-sources-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'fiber.md'), '# Fiber', 'utf8');
  await writeFile(join(root, 'notes.txt'), 'hello', 'utf8');
});

describe('Source 登记', () => {
  it('缺失时返回空登记表', async () => {
    expect(await readSourceIndex(root)).toEqual({ schemaVersion: 1, items: [] });
  });

  it('登记工作区文件时保存相对路径', async () => {
    const { source, index } = await addSource(root, { type: 'file', location: 'workspace', target: 'docs/fiber.md' });
    expect(source).toMatchObject({ type: 'file', location: 'workspace', target: 'docs/fiber.md', title: 'fiber.md' });
    expect(source.id).toBeTruthy();
    expect(index.items).toHaveLength(1);
  });

  it('登记本机外部文件时保存绝对路径', async () => {
    const external = join(tmpdir(), `sift-external-${Date.now()}.txt`);
    await writeFile(external, 'x', 'utf8');
    const { source } = await addSource(root, { type: 'file', location: 'external', target: external });
    expect(source).toMatchObject({ type: 'file', location: 'external', target: external, title: external.split(/[\\/]/).at(-1) });
  });

  it('登记网页时规范化 URL', async () => {
    const { source } = await addSource(root, { type: 'url', target: 'https://example.com/a b' });
    expect(source.type).toBe('url');
    expect(source.target).toBe('https://example.com/a%20b');
    expect(source.location).toBeUndefined();
  });

  it('重复添加同一目标不会产生第二条', async () => {
    const first = await addSource(root, { type: 'file', location: 'workspace', target: 'docs/fiber.md' });
    const second = await addSource(root, { type: 'file', location: 'workspace', target: 'docs/fiber.md' });
    expect(second.source.id).toBe(first.source.id);
    expect(second.index.items).toHaveLength(1);
  });

  it('拒绝目录、越界路径与非法网页地址', async () => {
    await expect(addSource(root, { type: 'file', location: 'workspace', target: 'docs' })).rejects.toThrow('请选择文件，而不是目录');
    await expect(addSource(root, { type: 'file', location: 'workspace', target: '../outside.md' })).rejects.toThrow('只能访问当前工作区内的文件');
    await expect(addSource(root, { type: 'file', location: 'external', target: 'relative.txt' })).rejects.toThrow('本机文件需要绝对路径');
    await expect(addSource(root, { type: 'url', target: 'ftp://example.com' })).rejects.toThrow('HTTP 或 HTTPS');
    await expect(addSource(root, { type: 'url', target: 'https://user:pass@example.com' })).rejects.toThrow('HTTP 或 HTTPS');
  });

  it('登记表损坏时抛错而不是静默覆盖', async () => {
    await mkdir(join(root, '.sift'), { recursive: true });
    await writeFile(join(root, '.sift', 'sources.json'), '{broken', 'utf8');
    await expect(readSourceIndex(root)).rejects.toThrow('Source 登记表无法解析');
    await expect(addSource(root, { type: 'url', target: 'https://example.com' })).rejects.toThrow('Source 登记表无法解析');
    expect(await readFile(join(root, '.sift', 'sources.json'), 'utf8')).toBe('{broken');
  });

  it('移除只解除登记，原文件保持不变', async () => {
    const { source } = await addSource(root, { type: 'file', location: 'workspace', target: 'docs/fiber.md' });
    const index = await removeSource(root, source.id);
    expect(index.items).toHaveLength(0);
    expect(existsSync(join(root, 'docs', 'fiber.md'))).toBe(true);
  });
});

describe('粘贴创建 Source', () => {
  it('在工作区根目录落盘并登记为工作区文件', async () => {
    const { source } = await createSourceFile(root, { name: 'remote-notes', content: '来自远端的内容' });
    expect(source).toMatchObject({ type: 'file', location: 'workspace', target: 'remote-notes.md', title: 'remote-notes.md' });
    expect(await readFile(join(root, 'remote-notes.md'), 'utf8')).toBe('来自远端的内容');
  });

  it('文件名重复时另取一个名字', async () => {
    await createSourceFile(root, { name: 'note.md', content: 'A' });
    const second = await createSourceFile(root, { name: 'note.md', content: 'B' });
    expect(second.source.target).toBe('note 2.md');
    expect(await readFile(join(root, 'note 2.md'), 'utf8')).toBe('B');
  });

  it('清洗掉文件名里的非法字符', async () => {
    const { source } = await createSourceFile(root, { name: 'a/b:c*.md', content: 'x' });
    expect(source.target).toBe('a b c.md');
  });
});

describe('来源浏览', () => {
  it('工作区浏览返回相对路径、目录在前，并跳过数据目录', async () => {
    await mkdir(join(root, '.sift'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, '.sift', 'sources.json'), '{}', 'utf8');
    const listing = await browseWorkspace(root, '');
    expect(listing.map(entry => entry.path)).toEqual(['docs', 'notes.txt']);
    expect(listing[0]).toMatchObject({ name: 'docs', directory: true });
    expect(listing[1]).toMatchObject({ name: 'notes.txt', directory: false });
  });

  it('工作区浏览可以进入子目录，且拒绝越界', async () => {
    const listing = await browseWorkspace(root, 'docs');
    expect(listing.map(entry => entry.path)).toEqual(['docs/fiber.md']);
    await expect(browseWorkspace(root, '..')).rejects.toThrow('只能访问当前工作区内的文件');
  });

  it('本机浏览返回绝对路径，并要求绝对路径输入', async () => {
    const listing = await browseExternal(join(root, 'docs'));
    expect(listing.map(entry => entry.path)).toEqual([join(root, 'docs', 'fiber.md')]);
    await expect(browseExternal('docs')).rejects.toThrow('本机目录需要绝对路径');
  });
});

describe('重启后恢复', () => {
  it('重新读取登记表能拿回全部 Source', async () => {
    await addSource(root, { type: 'file', location: 'workspace', target: 'docs/fiber.md' });
    await addSource(root, { type: 'file', location: 'workspace', target: 'notes.txt' });
    await addSource(root, { type: 'url', target: 'https://example.com/doc' });
    await createSourceFile(root, { name: 'pasted', content: 'x' });

    // 模拟重启：完全重新从磁盘读取，不复用任何内存状态。
    const reloaded = await readSourceIndex(root);
    expect(reloaded.items).toHaveLength(4);
    expect(reloaded.items.map(item => item.target)).toEqual([
      'docs/fiber.md', 'notes.txt', 'https://example.com/doc', 'pasted.md',
    ]);
    expect(reloaded.items.every(item => item.id && item.createdAt && item.title)).toBe(true);
  });
});
