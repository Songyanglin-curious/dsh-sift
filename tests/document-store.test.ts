import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  readDocumentIndex,
  readDocumentText,
  removeDocument,
  resolveInsideWorkspace,
  saveDocument,
  uniqueDocumentPath,
} from '../src/host/document/store.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sift-documents-')); });

describe('工作区路径校验', () => {
  it('拒绝越界路径与空路径', () => {
    expect(() => resolveInsideWorkspace(root, '../outside.md')).toThrow('只能访问当前工作区内的文件');
    expect(() => resolveInsideWorkspace(root, 'notes/../../outside.md')).toThrow('只能访问当前工作区内的文件');
    expect(() => resolveInsideWorkspace(root, '')).toThrow('文件路径不能为空');
  });

  it('允许尚不存在的文件（首次保存要创建新文件）', () => {
    expect(resolveInsideWorkspace(root, 'notes/新文档.md')).toBe(join(root, 'notes', '新文档.md'));
  });

  it('读取时拒绝越界', async () => {
    await expect(readDocumentText(root, '../secret.md')).rejects.toThrow('只能访问当前工作区内的文件');
  });
});

describe('Document 登记表', () => {
  it('缺失时返回空登记表', async () => {
    expect(await readDocumentIndex(root)).toEqual({ schemaVersion: 1, documents: [] });
  });

  it('损坏时抛错而不是静默覆盖', async () => {
    await mkdir(join(root, '.sift'), { recursive: true });
    await writeFile(join(root, '.sift', 'documents.json'), '{broken', 'utf8');
    await expect(readDocumentIndex(root)).rejects.toThrow('Document 登记表无法解析');
    await expect(saveDocument(root, { id: 'doc-1', title: '标题', content: 'x' })).rejects.toThrow('Document 登记表无法解析');
    expect(await readFile(join(root, '.sift', 'documents.json'), 'utf8')).toBe('{broken');
  });

  it('移除只解除登记，磁盘文件保持不变', async () => {
    const saved = await saveDocument(root, { id: 'doc-1', title: '保留我', content: '# 正文' });
    const path = saved.document.path!;
    expect(existsSync(join(root, path))).toBe(true);
    const index = await removeDocument(root, 'doc-1');
    expect(index.documents).toHaveLength(0);
    expect(existsSync(join(root, path))).toBe(true);
    expect(await readDocumentText(root, path)).toBe('# 正文');
  });
});

describe('首次落盘', () => {
  it('Untitled Document 在首次保存时才创建 notes/<标题>.md', async () => {
    expect(existsSync(join(root, 'notes'))).toBe(false);
    const result = await saveDocument(root, { id: 'doc-1', title: 'DSH Workspace理解', content: '# 一' });
    expect(result.created).toBe(true);
    expect(result.document.path).toBe('notes/DSH Workspace理解.md');
    expect(result.document.title).toBe('DSH Workspace理解');
    expect(await readDocumentText(root, result.document.path!)).toBe('# 一');
    expect((await readDocumentIndex(root)).documents).toEqual([{ id: 'doc-1', path: 'notes/DSH Workspace理解.md', title: 'DSH Workspace理解' }]);
  });

  it('没有标题时使用占位文件名与相应路径', async () => {
    const result = await saveDocument(root, { id: 'doc-1', content: '' });
    expect(result.document.path).toBe('notes/未命名文档.md');
    expect(result.document.title).toBeUndefined();
  });

  it('同名文件已存在时另取一个路径', async () => {
    const first = await saveDocument(root, { id: 'doc-1', title: '重复', content: 'A' });
    const second = await saveDocument(root, { id: 'doc-2', title: '重复', content: 'B' });
    expect(first.document.path).toBe('notes/重复.md');
    expect(second.document.path).toBe('notes/重复 2.md');
    expect(await readDocumentText(root, 'notes/重复.md')).toBe('A');
    expect(await readDocumentText(root, 'notes/重复 2.md')).toBe('B');
  });

  it('uniqueDocumentPath 跳过已被占用的名字', async () => {
    await mkdir(join(root, 'notes'), { recursive: true });
    await writeFile(join(root, 'notes', '占用.md'), 'x', 'utf8');
    expect(await uniqueDocumentPath(root, '占用')).toBe('notes/占用 2.md');
  });
});

describe('保存已有 Document', () => {
  it('写回同一路径且不重复登记', async () => {
    await saveDocument(root, { id: 'doc-1', title: '标题', content: 'v1' });
    const second = await saveDocument(root, { id: 'doc-1', title: '标题', content: 'v2' });
    expect(second.created).toBe(false);
    expect(second.document.path).toBe('notes/标题.md');
    expect(second.index.documents).toHaveLength(1);
    expect(await readDocumentText(root, 'notes/标题.md')).toBe('v2');
  });

  it('保留已有记录里的标题', async () => {
    await saveDocument(root, { id: 'doc-1', title: '原标题', content: 'v1' });
    const second = await saveDocument(root, { id: 'doc-1', content: 'v2' });
    expect(second.document.title).toBe('原标题');
    expect(second.document.path).toBe('notes/原标题.md');
  });

  it('并发保存不会互相覆盖登记表', async () => {
    await Promise.all(Array.from({ length: 5 }, (_value, index) =>
      saveDocument(root, { id: `doc-${index}`, title: `并发${index}`, content: `# ${index}` })));
    const index = await readDocumentIndex(root);
    expect(index.documents).toHaveLength(5);
    expect(new Set(index.documents.map(item => item.path)).size).toBe(5);
  });
});
