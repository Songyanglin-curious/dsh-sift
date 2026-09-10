import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { apply as applyClient, inject } from '../src/client/index.js';
import { apply as applyHost, name } from '../src/host/index.js';

const root = resolve(import.meta.dirname, '..');

describe('Sift plugin scaffold', () => {
  it('loads and unloads the empty Host contribution', () => {
    const info = vi.fn();
    let cleanup = () => {};
    applyHost({
      logger: { info },
      effect: (factory: () => () => void) => { cleanup = factory(); },
    } as never);

    expect(name).toBe('sift');
    expect(info).toHaveBeenCalledWith('Sift 插件已加载。');
    cleanup();
    expect(info).toHaveBeenCalledWith('Sift 插件已卸载。');
  });

  it('registers one disposable Client scaffold marker', () => {
    const dispose = vi.fn();
    let registered;
    let marker;
    const slots = {
      inject: vi.fn((_name, factory) => factory()),
      register: vi.fn((options, component) => {
        registered = options;
        marker = component;
        return dispose;
      }),
    };

    applyClient({ slots });
    expect(inject).toEqual(['slots']);
    expect(slots.inject).toHaveBeenCalledWith('conversation.input.right', expect.any(Function));
    expect(registered).toEqual({ name: 'conversation.input.right', id: 'sift-scaffold', order: 90 });
    expect(marker().props.children).toBe('Sift');
    expect(slots.inject.mock.results[0].value).toBe(dispose);
  });

  it('publishes only the minimal Sift bundle contract', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8');
    const combined = `${JSON.stringify(manifest)}\n${patch}`.toLowerCase();

    expect(manifest.name).toBe('@songyanglin/dsh-sift');
    expect(manifest.exports).toHaveProperty('./client', './dist/client/index.js');
    expect(manifest.exports).not.toHaveProperty('./typert');
    expect(manifest.files).toEqual(['dist', 'cordis.patch.yml', 'README.md', 'LICENSE']);
    expect(patch).toContain("name: '@songyanglin/dsh-sift'");
    expect(combined).not.toContain('apb');
  });
});
