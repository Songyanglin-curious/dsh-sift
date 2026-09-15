import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
<<<<<<< HEAD
import { apply as applyClient, createLatestProfileReader, fitLayout, inject } from '../src/client/index.js';
import { name, readWorkspaceProfile, SiftService, writeWorkspaceProfile } from '../src/host/index.js';
=======
import { apply as applyClient, inject } from '../src/client/index.js';
import { applySuggestion, buildPrompt } from '../src/client/workbench.js';
import SiftService, { name } from '../src/host/index.js';
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0

const root = resolve(import.meta.dirname, '..');

describe('Sift plugin scaffold', () => {
<<<<<<< HEAD
  it('exports the workspace-profile Host service', () => {
    expect(name).toBe('sift');
    expect(SiftService.inject).toEqual(['workspaceRegistry']);
  });

  it('registers one disposable Client workspace profile marker', async () => {
    const dispose = vi.fn();
    const registrations: unknown[] = [];
=======
  it('publishes the Sift Host service', () => {
    expect(name).toBe('sift');
    expect(typeof SiftService).toBe('function');
  });

  it('mounts the native surface, annotation dock and submission extension', async () => {
    const disposeRemote = vi.fn();
    const disposeSubmission = vi.fn();
    const invalidate = vi.fn();
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0
    const slots = {
      inject: vi.fn((_name, factory) => factory()),
      register: vi.fn((options, component) => {
        registrations.push({ options, component });
<<<<<<< HEAD
        return dispose;
=======
        return vi.fn();
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0
      }),
    };
    const remote = { dispatch: vi.fn() };
    const effect = vi.fn();
    const list = { getSnapshot: () => ({ byId: {} }), subscribe: () => () => undefined };
    const submissions = { register: vi.fn().mockReturnValue({ invalidate, dispose: disposeSubmission }) };
    const layout = { openSurface: vi.fn(), closeSurface: vi.fn() };

<<<<<<< HEAD
    const disposeRemote = vi.fn();
    await applyClient({
      slots,
      remote: { $mount: vi.fn(async () => disposeRemote) },
      get: () => ({ getWorkspaceProfile: vi.fn() }),
    });
    expect(inject).toEqual(['slots', 'workspaces', 'sessions', 'remote', 'uiWorkspace']);
    expect(slots.inject).toHaveBeenCalledWith('sidebar.footer.action', expect.any(Function));
    expect(registrations.map((entry: any) => entry.options)).toEqual([
      { name: 'sidebar.footer.action', id: 'sift-workspace-profile', order: 90 },
    ]);
    expect(slots.inject.mock.results[0].value).toBe(dispose);
=======
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
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0
  });

  it('publishes only the minimal Sift bundle contract', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8');
    const combined = `${JSON.stringify(manifest)}\n${patch}`.toLowerCase();

    expect(manifest.name).toBe('@songyanglin/dsh-sift');
    expect(manifest.exports).toHaveProperty('./client', './dist/client/index.js');
    expect(manifest.exports).toHaveProperty('./typert', './dist/host/typert.js');
<<<<<<< HEAD
    expect(manifest.dsh.client.immediately).toBe(true);
=======
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0
    expect(manifest.files).toEqual(['dist', 'cordis.patch.yml', 'README.md', 'LICENSE']);
    expect(patch).toContain("name: '@songyanglin/dsh-sift'");
    expect(combined).not.toContain('apb');
  });
});

describe('Workspace profile metadata', () => {
  it('fits expanded and collapsed columns while preserving minimum widths', () => {
    expect(fitLayout({ widths: [280, 480, 520], collapsed: [false, false, false] }, 1400).widths.reduce((sum, value) => sum + value, 0)).toBe(1388);
    expect(fitLayout({ widths: [280, 480, 520], collapsed: [true, false, false] }, 1000)).toMatchObject({ collapsed: [true, false, false], widths: [0, expect.any(Number), expect.any(Number)] });
    expect(fitLayout({ widths: [280, 480, 520], collapsed: [true, true, true] }, 1000).widths).toEqual([0, 0, 0]);
    expect(fitLayout({ widths: [10, 10, 10], collapsed: [false, false, false] }, 600).widths).toEqual([220, 320, 360]);
  });

  it('drops an older response after a faster workspace switch', async () => {
    const resolvers = new Map<string, (value: any) => void>();
    const read = vi.fn((id: string) => new Promise<any>(resolve => resolvers.set(id, resolve)));
    const latest = createLatestProfileReader(read);
    const old = latest('old');
    const current = latest('current');
    resolvers.get('current')!({ workspaceId: 'current', title: 'Current', profile: 'sift', status: 'ready' });
    resolvers.get('old')!({ workspaceId: 'old', title: 'Old', profile: 'default', status: 'missing' });
    await expect(current).resolves.toMatchObject({ workspaceId: 'current' });
    await expect(old).resolves.toBeUndefined();
  });

  it('reads valid, missing, and invalid config without rewriting it', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const temp = await fs.mkdtemp(path.join(process.env.TEMP ?? process.cwd(), 'sift-profile-'));
    const workspace = { id: 'sift-id', title: 'Sift', path: temp };
    expect((await readWorkspaceProfile(workspace)).profile).toBe('default');
    await fs.mkdir(path.join(temp, '.sift'));
    const config = path.join(temp, '.sift', 'config.json');
    await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, profile: 'sift' }));
    expect((await readWorkspaceProfile(workspace)).profile).toBe('sift');
    await fs.writeFile(config, JSON.stringify({ schemaVersion: 9, profile: 'sift' }));
    const unsupported = await readWorkspaceProfile(workspace);
    expect(unsupported.status).toBe('invalid');
    expect(await fs.readFile(config, 'utf8')).toContain('schemaVersion');
    await fs.writeFile(config, '{broken');
    const invalid = await readWorkspaceProfile(workspace);
    expect(invalid.status).toBe('invalid');
    expect(await fs.readFile(config, 'utf8')).toBe('{broken');
  });

  it('writes the selected profile as durable workspace metadata', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const temp = await fs.mkdtemp(path.join(process.env.TEMP ?? process.cwd(), 'sift-profile-write-'));
    const workspace = { id: 'created-id', title: 'Created', path: temp };
    await writeWorkspaceProfile(workspace, 'default');
    expect(await readWorkspaceProfile(workspace)).toMatchObject({ profile: 'default', status: 'ready' });
    await writeWorkspaceProfile(workspace, 'sift');
    expect(await readWorkspaceProfile(workspace)).toMatchObject({ profile: 'sift', status: 'ready' });
  });
});
