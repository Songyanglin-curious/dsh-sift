import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { apply as applyClient, inject } from '../src/client/index.js';
import { applySuggestion, buildPrompt } from '../src/client/workbench.js';
import SiftService, { name } from '../src/host/index.js';

const root = resolve(import.meta.dirname, '..');

describe('Sift plugin scaffold', () => {
  it('publishes the Sift Host service', () => {
    expect(name).toBe('sift');
    expect(typeof SiftService).toBe('function');
  });

  it('mounts the native surface, annotation dock and submission extension', async () => {
    const disposeRemote = vi.fn();
    const disposeSubmission = vi.fn();
    const invalidate = vi.fn();
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
    const slots = {
      inject: vi.fn((_name, factory) => factory()),
      register: vi.fn((options, component) => {
        registrations.push({ options, component });
        return vi.fn();
      }),
    };
    const remote = { dispatch: vi.fn() };
    const effect = vi.fn();
    const list = { getSnapshot: () => ({ byId: {} }), subscribe: () => () => undefined };
    const submissions = { register: vi.fn().mockReturnValue({ invalidate, dispose: disposeSubmission }) };
    const layout = { openSurface: vi.fn(), closeSurface: vi.fn() };

    await applyClient({
      slots,
      remote: { $mount: vi.fn().mockResolvedValue(disposeRemote) },
      effect,
      get: vi.fn((service: string) => service === 'remote.sift' ? remote : layout),
      sessions: { list, scope: vi.fn().mockReturnValue({ id: 'session-1' }), open: vi.fn(), create: vi.fn() },
      workspaces: { create: vi.fn() },
      conversation: { submissions, input: { for: vi.fn().mockReturnValue({ state: { getSnapshot: () => ({ draft: '' }), subscribe: () => () => undefined } }) } },
    });
    expect(inject).toEqual(['slots', 'remote', 'sessions', 'conversation', 'workspaces']);
    expect(effect.mock.calls[0][0]()).toBe(disposeRemote);
    expect(slots.inject.mock.calls.map(call => call[0])).toEqual([
      'sidebar.footer.action', 'shell.surface', 'conversation.input.dock',
    ]);
    expect(registrations.map(item => item.options.name)).toEqual([
      'sidebar.footer.action', 'shell.surface', 'conversation.input.dock',
    ]);
    const surface = registrations.find(item => item.options.name === 'shell.surface')!;
    expect((surface.options.select as (value: { activeSurface: string | null }) => unknown)({ activeSurface: 'sift' })).toBe(true);
    expect((surface.options.select as (value: { activeSurface: string | null }) => unknown)({ activeSurface: null })).toBeNull();
    expect(submissions.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'sift-annotations' }));
    const cleanup = effect.mock.calls.at(-1)![0]();
    cleanup();
    expect(disposeSubmission).toHaveBeenCalledOnce();
    expect(layout.closeSurface).toHaveBeenCalledWith('sift');
  });

  it('shows a compatibility notice instead of failing on an older DSH', async () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
    const slots = {
      inject: vi.fn((_name, factory) => factory()),
      register: vi.fn((options, component) => {
        registrations.push({ options, component });
        return vi.fn();
      }),
    };
    const remote = { dispatch: vi.fn() };
    await applyClient({
      slots,
      remote: { $mount: vi.fn().mockResolvedValue(vi.fn()) },
      effect: vi.fn(),
      get: vi.fn((service: string) => service === 'remote.sift' ? remote : undefined),
      sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => undefined }, scope: vi.fn(), open: vi.fn(), create: vi.fn() },
      workspaces: { create: vi.fn() },
      conversation: { input: { for: vi.fn() } },
    });
    expect(slots.inject.mock.calls.map(call => call[0])).toEqual(['sidebar.footer.action']);
    expect(registrations[0]?.options).toMatchObject({ id: 'sift-incompatible' });
  });

  it('keeps prompt construction and suggestion application reviewable', () => {
    const project = { id: 'p', solutionId: 's', title: '主题', goal: '形成判断', notePath: 'D:/note.md', sourceIds: [], sessionIds: [], activeSessionId: null, createdAt: '', updatedAt: '' };
    const prompt = buildPrompt(project, [{
      id: 'a', projectId: 'p', target: 'note', targetId: null,
      snapshot: { quote: '原文', title: '笔记', location: null, documentVersion: 'v1', anchor: null },
      comments: [{ version: 1, comment: '需要核实', createdAt: '' }],
      currentCommentVersion: 1, createdAt: '', updatedAt: '',
    }], '# 笔记', null);
    expect(prompt).toContain('形成判断');
    expect(prompt).toContain('需要核实');
    expect(applySuggestion('前旧后', 1, 2, '新')).toBe('前新后');
  });

  it('publishes only the minimal Sift bundle contract', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8');
    const combined = `${JSON.stringify(manifest)}\n${patch}`.toLowerCase();

    expect(manifest.name).toBe('@songyanglin/dsh-sift');
    expect(manifest.exports).toHaveProperty('./client', './dist/client/index.js');
    expect(manifest.exports).toHaveProperty('./typert', './dist/host/typert.js');
    expect(manifest.files).toEqual(['dist', 'cordis.patch.yml', 'README.md', 'LICENSE']);
    expect(patch).toContain("name: '@songyanglin/dsh-sift'");
    expect(combined).not.toContain('apb');
  });
});
