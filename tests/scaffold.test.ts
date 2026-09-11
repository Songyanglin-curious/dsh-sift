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

  it('mounts Remote and registers one disposable Client workbench', async () => {
    const disposeRemote = vi.fn();
    const disposeSlot = vi.fn();
    const setDraft = vi.fn();
    let registered;
    let marker;
    const slots = {
      inject: vi.fn((_name, factory) => factory()),
      register: vi.fn((options, component) => {
        registered = options;
        marker = component;
        return disposeSlot;
      }),
    };
    const remote = { dispatch: vi.fn() };
    const effect = vi.fn();

    await applyClient({
      slots,
      remote: { $mount: vi.fn().mockResolvedValue(disposeRemote) },
      effect,
      get: vi.fn().mockReturnValue(remote),
      sessions: { scope: vi.fn().mockReturnValue({ id: 'session-1' }) },
      conversation: { input: { for: vi.fn().mockReturnValue({ setDraft }) } },
    });
    expect(inject).toEqual(['slots', 'remote', 'sessions', 'conversation']);
    expect(effect).toHaveBeenCalledWith(expect.any(Function));
    expect(effect.mock.calls[0][0]()).toBe(disposeRemote);
    expect(slots.inject).toHaveBeenCalledWith('conversation.input.right', expect.any(Function));
    expect(registered).toMatchObject({ name: 'conversation.input.right', id: 'sift-workbench', order: 90 });
    expect(typeof marker).toBe('function');
    registered.inject('session-1').setConversationDraft('请帮我梳理');
    expect(setDraft).toHaveBeenCalledWith('请帮我梳理');
    expect(slots.inject.mock.results[0].value).toBe(disposeSlot);
  });

  it('keeps prompt construction and suggestion application reviewable', () => {
    const project = { id: 'p', solutionId: 's', title: '主题', goal: '形成判断', notePath: 'D:/note.md', sourceIds: [], createdAt: '', updatedAt: '' };
    const prompt = buildPrompt(project, [{ id: 'a', projectId: 'p', target: 'note', targetId: null, quote: '原文', comment: '需要核实', createdAt: '' }], '# 笔记', null);
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
