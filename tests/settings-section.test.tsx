// @vitest-environment jsdom

import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiftSettingsSection, type ModelCatalog, type SettingsScope } from '../src/client/settings/section.js';
import type { ConversationAnalysisSettings } from '../src/settings-contract.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalog: ModelCatalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        reasoning: {
          defaultEffort: 'high',
          efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        },
      },
      { id: 'deepseek-flash', name: 'DeepSeek Flash' },
    ],
  }],
  failures: [],
};

function createScope(value: ConversationAnalysisSettings = {}) {
  let snapshot = { status: 'ready' as const, value, writable: true };
  const listeners = new Set<() => void>();
  const mutate = vi.fn(async (ops: readonly any[]) => {
    const next: Record<string, unknown> = { ...snapshot.value };
    for (const op of ops) {
      if (op.op === 'set') next[op.path[0]] = op.value;
      else delete next[op.path[0]];
    }
    snapshot = { ...snapshot, value: next };
    listeners.forEach(listener => listener());
  });
  const scope: SettingsScope<ConversationAnalysisSettings> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    mutate,
  };
  return { scope, mutate };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll('style[data-plugin-id="dsh-sift"]').forEach(node => node.remove());
});

describe('Sift 设置页', () => {
  it('复用 DSH 模型目录并显示模型支持的思考强度', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const { scope } = createScope();
    await act(async () => {
      root.render(<SiftSettingsSection settings={scope} loadModelCatalog={async () => catalog} />);
    });

    const selects = host.querySelectorAll('select');
    expect(selects).toHaveLength(2);
    expect(selects[0]?.textContent).toContain('DeepSeek-V4-Pro · DeepSeek');
    expect(selects[1]?.textContent).toContain('High');
    expect((selects[0] as HTMLSelectElement).value).toContain('deepseek-v4-pro');
    expect((selects[1] as HTMLSelectElement).value).toBe('high');
    await act(async () => root.unmount());
  });

  it('切换模型时原子保存 provider、model 和模型默认思考强度', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const { scope, mutate } = createScope();
    await act(async () => {
      root.render(<SiftSettingsSection settings={scope} loadModelCatalog={async () => catalog} />);
    });

    const model = host.querySelector('select[aria-label="会话解析模型"]') as HTMLSelectElement;
    await act(async () => {
      model.value = `deepseek-official\u0000deepseek-flash`;
      model.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['provider'], value: 'deepseek-official' },
      { op: 'set', path: ['model'], value: 'deepseek-flash' },
      { op: 'unset', path: ['reasoningEffort'] },
    ]);
    await act(async () => root.unmount());
  });
});
