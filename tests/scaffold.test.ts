import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { apply as applyClient, inject } from '../src/client/index.js';
import { fitLayout } from '../src/client/dsh-adapter/layout.js';
import { createLatestProfileReader } from '../src/client/dsh-adapter/workspace-entry.js';
import { name, readWorkspaceProfile, SiftService, writeWorkspaceProfile } from '../src/host/index.js';

const root = resolve(import.meta.dirname, '..');

describe('Sift plugin scaffold', () => {
  it('exports the workspace-profile Host service', () => {
    expect(name).toBe('sift');
    expect(SiftService.inject).toEqual(['workspaceRegistry', 'tools']);
  });

  it('registers one disposable Client workspace profile marker', async () => {
    const dispose = vi.fn();
    const registrations: unknown[] = [];
    const slots = {
      inject: vi.fn((_name, factory) => factory()),
      register: vi.fn((options, component) => {
        registrations.push({ options, component });
        return dispose;
      }),
    };
    const effect = vi.fn();

    const disposeRemote = vi.fn();
    await applyClient({
      slots,
      remote: { $mount: vi.fn(async () => disposeRemote) },
      effect,
      get: () => ({ getWorkspaceProfile: vi.fn() }),
    });
    expect(inject).toEqual(['slots', 'workspaces', 'sessions', 'remote', 'uiWorkspace', 'inputTriggers']);
    expect(slots.inject).toHaveBeenCalledWith('sidebar.footer.action', expect.any(Function));
    expect(registrations.map((entry: any) => entry.options)).toEqual([
      { name: 'sidebar.footer.action', id: 'sift-workspace-profile', order: 90 },
    ]);
    expect(slots.inject.mock.results[0].value).toBe(dispose);
  });

  it('publishes only the minimal Sift bundle contract', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8');
    const combined = `${JSON.stringify(manifest)}\n${patch}`.toLowerCase();

    expect(manifest.name).toBe('@songyanglin/dsh-sift');
    expect(manifest.exports).toHaveProperty('./client', './dist/client/index.js');
    expect(manifest.exports).toHaveProperty('./typert', './dist/host/typert.js');
    expect(manifest.dsh.client.immediately).toBe(true);
    expect(manifest.files).toEqual(['dist', 'cordis.patch.yml', 'README.md', 'LICENSE']);
    expect(patch).toContain("name: '@songyanglin/dsh-sift'");
    expect(combined).not.toContain('apb');
  });

  it('为每个客户端会调用的 Remote 方法都声明了描述符', async () => {
    const { descriptors } = await import('../src/remote.js');
    const methods = descriptors.map(descriptor => descriptor.method).sort();
    // 少一个描述符，客户端调用就会在运行期失败，所以在这里钉住。
    expect(methods).toEqual([
      'addExistingDocument', 'addExternalFiles', 'addMaterial', 'addSource', 'browseExternal', 'browseWorkspace',
      'createReference', 'createSourceFile', 'detachDocument', 'getDocumentRelations', 'getMaterials', 'getWorkspaceProfile',
      'listDocuments', 'listMaterialFiles', 'listReferences', 'listSources', 'loadReference', 'openSourcePath',
      'pickSourceFiles', 'readClipboard', 'readDocumentContent', 'readMaterial', 'removeDocument', 'removeMaterial',
      'removeReference', 'removeSource', 'saveDocument', 'saveReference', 'setActiveDocument', 'setDocumentRelations', 'setWorkspaceProfile',
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.service).toBe('sift');
      expect(descriptor.namespace).toBe('sift');
    }
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
// @vitest-environment jsdom
