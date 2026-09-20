import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createReference,
  getDocumentRelations,
  listReferences,
  loadReference,
  removeReference,
  removeDocumentRelations,
  saveReference,
  setDocumentRelations,
} from '../src/host/reference/store.js';
import { emptyReferenceDocument } from '../src/references.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sift-references-'));
});

describe('ReferenceStore', () => {
  it('create 生成随机文件名与默认内容', async () => {
    const path = await createReference(root);
    expect(path).toMatch(/^references\/[0-9a-f]{8}\.json$/);
    const document = await loadReference(root, path);
    expect(document).toEqual({ name: '未命名参考', description: '', cards: [] });
  });

  it('create 可指定初始名称', async () => {
    const path = await createReference(root, 'DSH 插件设计资料');
    const document = await loadReference(root, path);
    expect(document.name).toBe('DSH 插件设计资料');
  });

  it('save + load 保持卡片顺序与可选来源', async () => {
    const path = await createReference(root, '素材');
    const document = {
      name: '素材',
      description: '测试用',
      cards: [
        { id: 'card-a', content: '# 第一段', source: { type: 'web', uri: 'https://example.com/a' } },
        { id: 'card-b', content: '第二段', source: { type: 'file', uri: 'D:\\docs\\design.md' } },
        { id: 'card-c', content: '第三段' },
      ],
    };
    await saveReference(root, path, document);
    const loaded = await loadReference(root, path);
    expect(loaded).toEqual(document);
    expect(loaded.cards.map(card => card.id)).toEqual(['card-a', 'card-b', 'card-c']);
  });

  it('save 会剥掉 schema 之外的字段（文件里没有 id、路径等杂质）', async () => {
    const path = await createReference(root);
    const polluted = { ...emptyReferenceDocument('x'), id: 'ref-1', selfPath: 'references/x.json' } as Record<string, unknown>;
    await saveReference(root, path, polluted as never);
    const raw = JSON.parse(await readFile(join(root, '.sift', path), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['cards', 'description', 'name']);
  });

  it('list 返回所有 Reference 的摘要', async () => {
    await createReference(root, '甲');
    await createReference(root, '乙');
    const summaries = await listReferences(root);
    expect(summaries).toHaveLength(2);
    expect(summaries.map(summary => summary.name).sort()).toEqual(['乙', '甲'].sort());
    for (const summary of summaries) {
      expect(summary.path).toMatch(/^references\/[0-9a-f]{8}\.json$/);
      expect(summary.description).toBe('');
    }
  });

  it('list 跳过损坏的文件，不阻断面板', async () => {
    await createReference(root, '好的');
    await writeFile(join(root, '.sift', 'references', 'badcafe1.json'), '{ broken', 'utf8');
    const summaries = await listReferences(root);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('好的');
  });

  it('save 只更新目标文件，不影响其他 Reference', async () => {
    const pathA = await createReference(root, 'A');
    const pathB = await createReference(root, 'B');
    await saveReference(root, pathA, { name: 'A-改名', description: '', cards: [{ id: 'c1', content: 'x' }] });
    expect((await loadReference(root, pathB)).name).toBe('B');
    expect((await loadReference(root, pathA)).name).toBe('A-改名');
  });

  it('remove 删除文件后 load 报错、list 不再包含', async () => {
    const path = await createReference(root);
    await removeReference(root, path);
    await expect(loadReference(root, path)).rejects.toThrow('参考文件不存在');
    expect(await listReferences(root)).toHaveLength(0);
  });

  it('remove 同时从全部 Document 关系中清理目标 Reference', async () => {
    const removed = await createReference(root, '待删除');
    const kept = await createReference(root, '保留');
    await setDocumentRelations(root, 'documents/one.md', [removed, kept]);
    await setDocumentRelations(root, 'documents/two.md', [removed]);

    await removeReference(root, removed);

    expect(await getDocumentRelations(root, 'documents/one.md')).toEqual([kept]);
    expect(await getDocumentRelations(root, 'documents/two.md')).toEqual([]);
  });

  it('拒绝目录穿越与 references/ 之外的路径', async () => {
    await expect(loadReference(root, '../sources.json')).rejects.toThrow('非法');
    await expect(loadReference(root, 'relations.json')).rejects.toThrow('非法');
    await expect(loadReference(root, 'references/sub/../../x.json')).rejects.toThrow('非法');
    await expect(saveReference(root, 'references/..\\evil.json', emptyReferenceDocument())).rejects.toThrow('非法');
  });
});

describe('Document 关系清理', () => {
  it('删除产出时可同时清除 id 与历史路径关系，不影响其他产出', async () => {
    const reference = await createReference(root, '保留的参考');
    await setDocumentRelations(root, 'doc-1', [reference]);
    await setDocumentRelations(root, 'notes/旧路径.md', [reference]);
    await setDocumentRelations(root, 'doc-2', [reference]);
    await removeDocumentRelations(root, ['doc-1', 'notes/旧路径.md']);
    expect(await getDocumentRelations(root, 'doc-1')).toEqual([]);
    expect(await getDocumentRelations(root, 'notes/旧路径.md')).toEqual([]);
    expect(await getDocumentRelations(root, 'doc-2')).toEqual([reference]);
  });
});

describe('RelationStore', () => {
  it('文件缺失时返回空数组', async () => {
    expect(await getDocumentRelations(root, 'documents/design.md')).toEqual([]);
  });

  it('set + get 往返，且一个 Document 可关联多个 Reference', async () => {
    const refA = await createReference(root, 'A');
    const refB = await createReference(root, 'B');
    await setDocumentRelations(root, 'documents/design.md', [refA, refB]);
    expect(await getDocumentRelations(root, 'documents/design.md')).toEqual([refA, refB]);
  });

  it('一个 Reference 可以被多个 Document 复用', async () => {
    const refA = await createReference(root, 'A');
    await setDocumentRelations(root, 'documents/one.md', [refA]);
    await setDocumentRelations(root, 'documents/two.md', [refA]);
    expect(await getDocumentRelations(root, 'documents/one.md')).toEqual([refA]);
    expect(await getDocumentRelations(root, 'documents/two.md')).toEqual([refA]);
  });

  it('重复 set 同一 target 是覆盖，不是追加', async () => {
    const refA = await createReference(root);
    const refB = await createReference(root);
    await setDocumentRelations(root, 'documents/x.md', [refA]);
    await setDocumentRelations(root, 'documents/x.md', [refB]);
    expect(await getDocumentRelations(root, 'documents/x.md')).toEqual([refB]);
  });

  it('set 空数组时移除该条目', async () => {
    await setDocumentRelations(root, 'documents/x.md', ['references/ab12cd34.json']);
    await setDocumentRelations(root, 'documents/x.md', []);
    expect(await getDocumentRelations(root, 'documents/x.md')).toEqual([]);
    const raw = JSON.parse(await readFile(join(root, '.sift', 'relations.json'), 'utf8')) as { relations: unknown[] };
    expect(raw.relations).toHaveLength(0);
  });

  it('拒绝非法 target', async () => {
    await expect(setDocumentRelations(root, '../outside.md', [])).rejects.toThrow('非法');
    await expect(getDocumentRelations(root, 'C:\\abs\\path.md')).rejects.toThrow('非法');
  });

  it('relations.json 里引用不存在的 Reference 不报错（读取方容错）', async () => {
    await setDocumentRelations(root, 'documents/x.md', ['references/deadbeef.json']);
    expect(await getDocumentRelations(root, 'documents/x.md')).toEqual(['references/deadbeef.json']);
  });

  it('Reference 文件内容不感知关联关系', async () => {
    const path = await createReference(root, '独立');
    await setDocumentRelations(root, 'documents/x.md', [path]);
    const raw = JSON.parse(await readFile(join(root, '.sift', path), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['cards', 'description', 'name']);
  });

  it('清理临时目录', async () => {
    await rm(root, { recursive: true, force: true });
  });
});
