import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
      type: 'solution.create', name: '学习主题', description: '',
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
      quote: '后来修正', comment: '保留纠错原因',
    });
    await repository.dispatch({ type: 'source.delete', projectId: project.id, id: source.id });
    await expect(stat(source.location)).resolves.toBeDefined();
    const catalog = await repository.readCatalog();
    expect(catalog.annotations).toHaveLength(0);
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
    await repository.dispatch({ type: 'source.delete', projectId: first.id, id: source.id });
    const catalog = await repository.readCatalog();
    expect(catalog.sources).toHaveLength(1);
    expect(catalog.projects.find(item => item.id === second.id)?.sourceIds).toEqual([source.id]);
  });
});
