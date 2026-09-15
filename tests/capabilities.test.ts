import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Solution, TextDocument } from '../src/domain/model.js';
import { configureProjectAgent, createNoteTools } from '../src/host/capabilities.js';
import { SiftRepository } from '../src/host/repository.js';

describe('Sift project-session capabilities', () => {
  let root: string;
  let repository: SiftRepository;
  let project: Project;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sift-capabilities-'));
    repository = new SiftRepository(join(root, 'relations'));
    const solution = await repository.dispatch({
      type: 'solution.create', name: '主题', description: '', workspaceId: 'workspace-1', workspacePath: root,
    }) as Solution;
    project = await repository.dispatch({
      type: 'project.create', solutionId: solution.id, title: '成果', goal: '', notePath: join(root, 'note.md'),
    }) as Project;
    await repository.dispatch({ type: 'project.session.bind', projectId: project.id, sessionId: 'session-a', activate: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves the note from the calling session and never accepts a target path', async () => {
    const tools = createNoteTools(repository, 'session-a');
    expect(tools.every(tool => !JSON.stringify(tool.parameters).includes('path'))).toBe(true);
    const read = tools.find(tool => tool.name === 'sift_note_read')!;
    const initial = await read.execute({}, { agent: { id: 'session-a' }, signal: new AbortController().signal }) as TextDocument;
    expect(initial.content).toContain('1: # 成果');

    const insert = tools.find(tool => tool.name === 'sift_note_insert')!;
    await insert.execute({ after_line: 1, content: '\n证据', expected_version: initial.version }, {
      agent: { id: 'session-a' }, signal: new AbortController().signal,
    });
    expect(await readFile(project.notePath, 'utf8')).toContain('证据');
    await expect(insert.execute({ after_line: 0, content: '越权', expected_version: initial.version }, {
      agent: { id: 'another-session' }, signal: new AbortController().signal,
    })).rejects.toThrow('只能由关联的项目会话调用');
  });

  it('keeps only read-only inherited tools and contributes scoped Sift note tools', () => {
    const registered: string[] = [];
    const confine = vi.fn().mockReturnValue(vi.fn());
    const guard = vi.fn().mockReturnValue(vi.fn());
    const prompt = vi.fn().mockReturnValue(vi.fn());
    const agent = {
      id: 'session-a',
      ctx: {
        tools: { confine, guard, register: vi.fn(tool => { registered.push(tool.name); return vi.fn(); }) },
        systemPrompt: { section: prompt, getSectionOrder: vi.fn().mockReturnValue(50) },
      },
    };
    const dispose = configureProjectAgent({
      agents: { get: vi.fn().mockReturnValue(agent) },
      tools: { schemas: vi.fn().mockReturnValue([
        { name: 'read' }, { name: 'grep' }, { name: 'pwsh' }, { name: 'write' }, { name: 'subagent' },
      ]) },
    }, repository, 'session-a');
    expect(dispose).not.toBeNull();
    expect(registered).toEqual(['sift_note_read', 'sift_note_insert', 'sift_note_replace_lines', 'sift_note_replace_text']);
    expect(confine).toHaveBeenCalledWith({ allow: [
      'read', 'grep', 'sift_note_read', 'sift_note_insert', 'sift_note_replace_lines', 'sift_note_replace_text',
    ] });
    expect(guard).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ name: 'sift:project-note' }));
  });

  it('rejects binding one DSH session to two projects', async () => {
    const catalog = await repository.readCatalog();
    const second = await repository.dispatch({
      type: 'project.create', solutionId: catalog.solutions[0]!.id, title: '另一个成果', goal: '', notePath: join(root, 'other.md'),
    }) as Project;
    await expect(repository.dispatch({
      type: 'project.session.bind', projectId: second.id, sessionId: 'session-a', activate: true,
    })).rejects.toThrow('已经关联其他 Sift 项目');
  });
});
