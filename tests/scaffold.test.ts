// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { apply as applyClient, inject } from '../src/client/index.js';
import { Config, name, SiftService } from '../src/host/index.js';

const root = resolve(import.meta.dirname, '..');

describe('Sift 轻量插件骨架', () => {
  it('Host 只依赖工作区与模型，不再注册 Document 专用工具', () => {
    expect(name).toBe('sift');
    expect(SiftService.inject).toEqual(['workspaceRegistry', 'llm']);
    expect(Object.values(Config.dict ?? {}).every(field => field.meta.volatile === true)).toBe(true);
  });

  it('只向 DSH 原生文件工具栏注册文章参考入口', async () => {
    const dispose = vi.fn();
    const registrations: Array<{ options: any; component: unknown }> = [];
    const slots = {
      inject: vi.fn((_name, factory) => factory()),
      register: vi.fn((options, component) => { registrations.push({ options, component }); return dispose; }),
    };
    const cleanups: Array<() => void | Promise<void>> = [];
    const effect = vi.fn((factory: () => () => void | Promise<void>) => { cleanups.push(factory()); });
    await applyClient({ slots, workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [] }), subscribe: () => () => {} } }, remote: { $mount: vi.fn(async () => vi.fn()) }, effect, get: () => ({}) });

    expect(inject).toEqual(['slots', 'workspaces', 'remote', 'remote.session', 'configForms']);
    expect(slots.inject).toHaveBeenCalledWith('sidebar.right.tab.document.actions', expect.any(Function));
    expect(registrations.map(entry => entry.options)).toEqual([{ name: 'sidebar.right.tab.document.actions', id: 'sift-reference', order: -100, inject: expect.any(Function) }]);
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it('发布最小 Sift bundle 契约', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8');
    expect(manifest.name).toBe('@songyanglin/dsh-sift');
    expect(manifest.exports).toHaveProperty('./client', './dist/client/index.js');
    expect(manifest.dsh.client.immediately).toBe(true);
    expect(patch).toContain("name: '@songyanglin/dsh-sift'");
  });

  it('Remote 不再暴露工作区类型和 Document 激活协议', async () => {
    const { descriptors } = await import('../src/remote.js');
    const methods = descriptors.map(descriptor => descriptor.method).sort();
    expect(methods).not.toContain('getWorkspaceProfile');
    expect(methods).not.toContain('setWorkspaceProfile');
    expect(methods).not.toContain('setActiveDocument');
    expect(methods).toContain('listReferences');
    expect(methods).toContain('getArticleRelations');
    expect(methods).toContain('setArticleRelations');
    for (const descriptor of descriptors) {
      expect(descriptor.service).toBe('sift');
      expect(descriptor.namespace).toBe('sift');
    }
  });
});
