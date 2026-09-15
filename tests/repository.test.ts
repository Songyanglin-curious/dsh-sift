import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, Solution, Source, TextDocument } from '../src/domain/model.js';
import { SiftRepository } from '../src/host/repository.js';

describe('SiftRepository', () => {
  let root: string;
  let repository: SiftRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sift-'));
    repository = new SiftRepository(join(root, 'relations'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createProject(noteName = 'knowledge.md') {
    const solution = await repository.dispatch({
      type: 'solution.create', name: '学习主题', description: '', workspaceId: 'workspace-1', workspacePath: root,
    }) as Solution;
    const project = await repository.dispatch({
      type: 'project.create', solutionId: solution.id, title: '热更新', goal: '理清开发流程',
      notePath: join(root, noteName),
    }) as Project;
    return { solution, project };
  }

  it('keeps relation data separate from the Markdown note', async () => {
    const { project } = await createProject();
    expect((await readFile(project.notePath, 'utf8'))).toBe('# 热更新\n');
    expect(project.notePath.startsWith(repository.root)).toBe(false);

    const first = await repository.dispatch({ type: 'note.read', projectId: project.id }) as TextDocument;
    const saved = await repository.dispatch({
      type: 'note.write', projectId: project.id, content: '# 热更新\n\n正文\n', expectedVersion: first.version,
    }) as TextDocument;
    expect(saved.content).toContain('正文');
    await expect(repository.dispatch({
      type: 'note.write', projectId: project.id, content: '覆盖', expectedVersion: first.version,
    })).rejects.toThrow('其他位置发生变化');
  });

  it('lists host files for the authenticated picker and rejects relative locations', async () => {
    const { solution } = await createProject('existing.md');
    const listing = await repository.dispatch({ type: 'file.list', solutionId: solution.id, path: root }) as {
      path: string; entries: Array<{ name: string; kind: string }>;
    };
    expect(listing.path).toBe(root);
    expect(listing.entries).toContainEqual(expect.objectContaining({ name: 'existing.md', kind: 'file' }));
    await expect(repository.dispatch({ type: 'file.list', solutionId: solution.id, path: 'relative' }))
      .rejects.toThrow('绝对目录');
  });

  it('backs up and migrates v1 data, splitting cross-solution sources and keeping unowned sources pending classification', async () => {
    const relations = join(root, 'relations');
    await mkdir(relations, { recursive: true });
    const time = '2026-01-01T00:00:00.000Z';
    await writeFile(join(relations, 'catalog.json'), JSON.stringify({
      schemaVersion: 1,
      solutions: [
        { id: 'solution-a', name: 'A', description: '', createdAt: time, updatedAt: time },
        { id: 'solution-b', name: 'B', description: '', createdAt: time, updatedAt: time },
      ],
      projects: [
        { id: 'project-a', solutionId: 'solution-a', title: 'A1', goal: '', notePath: join(root, 'a.md'), sourceIds: ['shared'], createdAt: time, updatedAt: time },
        { id: 'project-b', solutionId: 'solution-b', title: 'B1', goal: '', notePath: join(root, 'b.md'), sourceIds: ['shared'], createdAt: time, updatedAt: time },
      ],
      sources: [
        { id: 'shared', kind: 'file', title: '跨方案素材', location: join(root, 'shared.txt'), mediaType: 'text/plain', createdAt: time, updatedAt: time },
        { id: 'orphan', kind: 'file', title: '无归属素材', location: join(root, 'orphan.txt'), mediaType: 'text/plain', createdAt: time, updatedAt: time },
      ],
      annotations: [{ id: 'annotation-old', projectId: 'project-b', target: 'source', targetId: 'shared', quote: '旧引文', comment: '旧评论', createdAt: time }],
    }), 'utf8');
    repository = new SiftRepository(relations);

    const catalog = await repository.readCatalog();
    const firstSource = catalog.projects.find(item => item.id === 'project-a')!.sourceIds[0]!;
    const secondSource = catalog.projects.find(item => item.id === 'project-b')!.sourceIds[0]!;
    expect(catalog.schemaVersion).toBe(2);
    expect(catalog.solutions).toEqual(expect.arrayContaining([expect.objectContaining({ workspaceId: null, workspacePath: null })]));
    expect(firstSource).not.toBe(secondSource);
    expect(catalog.sources.filter(item => item.title === '跨方案素材')).toHaveLength(2);
    expect(catalog.sources.find(item => item.id === 'orphan')).toMatchObject({ solutionId: null, originalLocation: join(root, 'orphan.txt') });
    expect(catalog.annotations[0]).toMatchObject({ targetId: secondSource, snapshot: { quote: '旧引文', documentVersion: 'legacy-location-unavailable', anchor: null }, currentCommentVersion: 1 });
    expect((await readdir(root)).some(name => name.startsWith('relations.backup-'))).toBe(true);

    await repository.dispatch({ type: 'source.classify', id: 'orphan', solutionId: 'solution-a' });
    expect((await repository.readCatalog()).sources.find(item => item.id === 'orphan')?.solutionId).toBe('solution-a');
  });

  it('stores pasted material as a referenced file and preserves it when detached', async () => {
    const { project } = await createProject();
    const source = await repository.dispatch({
      type: 'source.create', projectId: project.id, kind: 'text', title: '讨论记录',
      location: '', content: '先失败，后来修正。', mediaType: 'text/markdown',
    }) as Source;
    const preview = await repository.dispatch({ type: 'source.preview', id: source.id }) as { content: string };
    expect(preview.content).toBe('先失败，后来修正。');

    await repository.dispatch({
      type: 'annotation.create', projectId: project.id, target: 'source', targetId: source.id,
      snapshot: { quote: '后来修正', title: source.title, location: source.location, documentVersion: 'v1', anchor: null },
      comment: '保留纠错原因',
    });
    await repository.dispatch({ type: 'source.detach', projectId: project.id, id: source.id });
    await expect(stat(source.location)).resolves.toBeDefined();
    const catalog = await repository.readCatalog();
    expect(catalog.annotations).toHaveLength(1);
  });

  it('reuses one source across projects without duplicating content', async () => {
    const { solution, project: first } = await createProject('one.md');
    const second = await repository.dispatch({
      type: 'project.create', solutionId: solution.id, title: '第二篇', goal: '', notePath: join(root, 'two.md'),
    }) as Project;
    const materialPath = join(root, 'source.txt');
    await writeFile(materialPath, 'shared', 'utf8');
    const source = await repository.dispatch({
      type: 'source.create', projectId: first.id, kind: 'file', title: '共享素材',
      location: materialPath, mediaType: 'text/plain',
    }) as Source;

    await repository.dispatch({ type: 'source.attach', projectId: second.id, id: source.id });
    await repository.dispatch({ type: 'source.detach', projectId: first.id, id: source.id });
    const catalog = await repository.readCatalog();
    expect(catalog.sources).toHaveLength(1);
    expect(catalog.projects.find(item => item.id === second.id)?.sourceIds).toEqual([source.id]);
  });

  it('confirms every affected project before removing a shared source and preserves the file and snapshots', async () => {
    const { solution, project: first } = await createProject('one.md');
    const second = await repository.dispatch({
      type: 'project.create', solutionId: solution.id, title: '第二篇', goal: '', notePath: join(root, 'two.md'),
    }) as Project;
    const materialPath = join(root, 'shared.txt');
    await writeFile(materialPath, 'shared evidence', 'utf8');
    const source = await repository.dispatch({
      type: 'source.create', projectId: first.id, kind: 'file', title: '共享素材', location: materialPath, mediaType: 'text/plain',
    }) as Source;
    await repository.dispatch({ type: 'source.attach', projectId: second.id, id: source.id });
    await repository.dispatch({
      type: 'annotation.create', projectId: first.id, target: 'source', targetId: source.id,
      snapshot: { quote: 'evidence', title: source.title, location: source.location, documentVersion: 'v1', anchor: null }, comment: '保留快照',
    });

    await expect(repository.dispatch({ type: 'source.remove', solutionId: solution.id, id: source.id, affectedProjectIds: [first.id] }))
      .rejects.toThrow('引用关系已变化');
    await repository.dispatch({ type: 'source.remove', solutionId: solution.id, id: source.id, affectedProjectIds: [first.id, second.id] });

    await expect(stat(materialPath)).resolves.toBeDefined();
    const catalog = await repository.readCatalog();
    expect(catalog.sources.some(item => item.id === source.id)).toBe(false);
    expect(catalog.projects.every(item => !item.sourceIds.includes(source.id))).toBe(true);
    expect(catalog.annotations).toEqual([expect.objectContaining({ snapshot: expect.objectContaining({ quote: 'evidence', location: materialPath }) })]);
  });

  it('versions editable comments while keeping the source snapshot immutable across relocation', async () => {
    const { project } = await createProject();
    const original = join(root, 'original.txt');
    const relocated = join(root, 'relocated.txt');
    await writeFile(original, 'original evidence', 'utf8');
    await writeFile(relocated, 'new edition', 'utf8');
    const source = await repository.dispatch({ type: 'source.create', projectId: project.id, kind: 'file', title: '材料', location: original, mediaType: 'text/plain' }) as Source;
    const annotation = await repository.dispatch({
      type: 'annotation.create', projectId: project.id, target: 'source', targetId: source.id,
      snapshot: { quote: 'evidence', title: '材料', location: original, documentVersion: 'version-1', anchor: { kind: 'text', start: 9, end: 17, prefix: 'original ', suffix: '' } }, comment: '初稿',
    }) as { id: string };
    await repository.dispatch({ type: 'annotation.comment.update', id: annotation.id, comment: '修订评论' });
    await repository.dispatch({ type: 'source.relocate', id: source.id, location: relocated });

    let catalog = await repository.readCatalog();
    expect(catalog.sources.find(item => item.id === source.id)).toMatchObject({ location: relocated, originalLocation: original });
    expect(catalog.annotations.find(item => item.id === annotation.id)).toMatchObject({
      snapshot: { quote: 'evidence', location: original, documentVersion: 'version-1' },
      currentCommentVersion: 2,
      comments: [{ version: 1, comment: '初稿' }, { version: 2, comment: '修订评论' }],
    });
    await repository.dispatch({ type: 'annotation.delete', id: annotation.id });
    catalog = await repository.readCatalog();
    expect(catalog.annotations.some(item => item.id === annotation.id)).toBe(false);
  });

  it('refreshes missing local source status and keeps project work states independent', async () => {
    const { solution, project: first } = await createProject('first.md');
    const second = await repository.dispatch({
      type: 'project.create', solutionId: solution.id, title: '第二篇', goal: '', notePath: join(root, 'second.md'),
    }) as Project;
    const materialPath = join(root, 'temporary.txt');
    await writeFile(materialPath, 'temporary', 'utf8');
    const source = await repository.dispatch({
      type: 'source.create', projectId: first.id, kind: 'file', title: '临时素材', location: materialPath, mediaType: 'text/plain',
    }) as Source;
    await rm(materialPath);
    await repository.dispatch({
      type: 'workstate.update', projectId: first.id,
      state: { openTabs: ['note', source.id], activeTab: source.id, readingLocations: { [source.id]: { scrollTop: 88 } }, noteDraft: '草稿一', noteDraftBaseVersion: 'v1', selectedAnnotationIds: [], materialWidth: 333, conversationWidth: 555, materialTreeCollapsed: false },
    });
    await repository.dispatch({ type: 'workstate.update', projectId: first.id, state: { activeTab: 'note' } });
    const catalog = await repository.dispatch({ type: 'catalog.get' }) as Awaited<ReturnType<typeof repository.readCatalog>>;
    expect(catalog.sources.find(item => item.id === source.id)).toMatchObject({ status: 'missing' });
    expect(catalog.workStates.find(item => item.projectId === first.id)).toMatchObject({ activeTab: 'note', materialWidth: 333, noteDraft: '草稿一', readingLocations: { [source.id]: { scrollTop: 88 } } });
    expect(catalog.workStates.find(item => item.projectId === second.id)).toMatchObject({ activeTab: 'note', materialWidth: 280, noteDraft: null });
  });
});
