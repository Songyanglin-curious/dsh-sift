// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountThreeColumn, type ColumnSpec } from '../src/client/dsh-adapter/layout.js';
import { SIFT_ATTR } from '../src/client/dsh-adapter/selectors.js';

const COLUMNS: readonly [ColumnSpec, ColumnSpec] = [
  { id: 'reference', label: '参考', title: 'Reference Board', description: '当前有效参考' },
  { id: 'document', label: '文档', title: 'Document', description: 'Markdown 正文' },
];

/** jsdom 不提供 ResizeObserver，这里给一个最小替身。 */
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  localStorage.clear();
  // 上一个用例失败时可能没走到 dispose，这里保证每个用例从干净 DOM 开始。
  document.body.replaceChildren();
  document.head.querySelectorAll('style[data-sift-layout]').forEach(node => node.remove());
});

function fixture(storageKey = 'layout-test') {
  const center = document.createElement('div');
  const container = document.createElement('div');
  container.appendChild(center);
  document.body.appendChild(container);
  const mounted: string[] = [];
  const disposed: string[] = [];
  const dispose = mountThreeColumn(center, {
    columns: COLUMNS,
    storageKey,
    mount: (id, section) => {
      mounted.push(id);
      const body = document.createElement('p');
      body.textContent = `${id} 内容`;
      section.appendChild(body);
      return () => disposed.push(id);
    },
  });
  return { center, dispose, mounted, disposed, container };
}

describe('三栏布局', () => {
  it('在宿主里追加工具栏、两栏与两条分隔线', () => {
    const f = fixture();
    expect(f.center.hasAttribute(SIFT_ATTR.threeColumn)).toBe(true);
    expect(f.mounted).toEqual(['reference', 'document']);
    expect(f.center.querySelectorAll('[data-sift-column]')).toHaveLength(2);
    expect(f.center.querySelectorAll('[data-sift-resizer]')).toHaveLength(2);
    expect(f.center.querySelector('[data-sift-column="reference"]')?.textContent).toContain('reference 内容');
    expect(f.center.querySelector('[data-sift-column="document"] header')?.textContent).toContain('Document');
    // 原生对话栏不在这里创建：它由 DSH 自己渲染在第三栏。
    expect(f.center.querySelectorAll('[data-slot=main]')).toHaveLength(0);
    f.dispose();
  });

  it('工具栏提供参考、文档、对话三个开关与重置', () => {
    const f = fixture();
    const tabs = [...f.center.querySelectorAll<HTMLButtonElement>('[data-sift-panel-toggle]')];
    expect(tabs.map(tab => tab.textContent)).toEqual(['参考', '文档', '对话']);
    expect(tabs.map(tab => tab.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true']);
    expect(f.center.querySelector('[data-action=reset]')?.textContent).toBe('重置');
    f.dispose();
  });

  it('关闭一栏时标记折叠，关闭对话栏时通知宿主', () => {
    const f = fixture();
    const tabs = [...f.center.querySelectorAll<HTMLButtonElement>('[data-sift-panel-toggle]')];
    tabs[0]!.click();
    expect(f.center.querySelector('[data-sift-column="reference"]')?.hasAttribute(SIFT_ATTR.collapsed)).toBe(true);
    expect(tabs[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(tabs[0]!.title).toBe('显示参考');
    expect(f.center.hasAttribute(SIFT_ATTR.chatCollapsed)).toBe(false);

    tabs[2]!.click();
    expect(f.center.hasAttribute(SIFT_ATTR.chatCollapsed)).toBe(true);
    expect(f.center.style.getPropertyValue('--sift-w2')).toBe('0px');

    f.center.querySelector<HTMLButtonElement>('[data-action=reset]')!.click();
    expect(f.center.hasAttribute(SIFT_ATTR.chatCollapsed)).toBe(false);
    expect(f.center.querySelector('[data-sift-column="reference"]')?.hasAttribute(SIFT_ATTR.collapsed)).toBe(false);
    expect(tabs.map(tab => tab.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true']);
    f.dispose();
  });

  it('按工作区把折叠状态记进 localStorage 并在重新挂载时恢复', () => {
    const first = fixture('dsh-sift:layout:ws-1');
    first.center.querySelectorAll<HTMLButtonElement>('[data-sift-panel-toggle]')[0]!.click();
    first.dispose();

    const second = fixture('dsh-sift:layout:ws-1');
    expect(second.center.querySelector('[data-sift-column="reference"]')?.hasAttribute(SIFT_ATTR.collapsed)).toBe(true);
    expect(second.center.querySelectorAll<HTMLButtonElement>('[data-sift-panel-toggle]')[0]!.getAttribute('aria-pressed')).toBe('false');
    second.dispose();

    // 另一个工作区不受影响。
    const other = fixture('dsh-sift:layout:ws-2');
    expect(other.center.querySelector('[data-sift-column="reference"]')?.hasAttribute(SIFT_ATTR.collapsed)).toBe(false);
    other.dispose();
  });

  it('卸载时清理自己追加的一切并反序释放栏内容', () => {
    const f = fixture();
    const styles = document.head.querySelectorAll('style[data-sift-layout]').length;
    expect(styles).toBe(1);
    f.dispose();
    expect(f.center.hasAttribute(SIFT_ATTR.threeColumn)).toBe(false);
    expect(f.center.querySelectorAll('[data-sift-column]')).toHaveLength(0);
    expect(f.center.querySelectorAll('[data-sift-resizer]')).toHaveLength(0);
    expect(f.center.querySelectorAll('[data-sift-layout-toolbar]')).toHaveLength(0);
    expect(document.head.querySelectorAll('style[data-sift-layout]')).toHaveLength(0);
    expect(f.disposed).toEqual(['document', 'reference']);
    expect(f.center.style.getPropertyValue('--sift-w0')).toBe('');
  });

  it('重复卸载是安全的', () => {
    const f = fixture();
    f.dispose();
    expect(() => f.dispose()).not.toThrow();
    expect(f.disposed).toEqual(['document', 'reference']);
  });

  it('宿主容器被移除后仍能安全卸载', () => {
    const f = fixture();
    f.container.remove();
    expect(() => f.dispose()).not.toThrow();
    expect(f.disposed).toEqual(['document', 'reference']);
  });

  it('某一栏清理抛错时仍然撤掉 Sift 追加的全部节点', () => {
    const center = document.createElement('div');
    document.body.appendChild(center);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispose = mountThreeColumn(center, {
      columns: COLUMNS,
      storageKey: 'layout-throw',
      mount: (id, section) => {
        section.appendChild(document.createElement('p'));
        return id === 'reference' ? () => { throw new Error('清理失败'); } : () => {};
      },
    });
    expect(() => dispose()).not.toThrow();
    expect(center.hasAttribute(SIFT_ATTR.threeColumn)).toBe(false);
    expect(center.querySelectorAll('[data-sift-column]')).toHaveLength(0);
    expect(center.querySelectorAll('[data-sift-layout-toolbar]')).toHaveLength(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('最小宽度约束', () => {
  it('宿主很窄时仍保留各栏最小宽度设定', () => {
    const f = fixture();
    // jsdom 的 clientWidth 恒为 0，因此走的是「宽度不足」分支：全部取最小值。
    expect(f.center.style.getPropertyValue('--sift-w0')).toBe('220px');
    expect(f.center.style.getPropertyValue('--sift-w1')).toBe('320px');
    expect(f.center.style.getPropertyValue('--sift-w2')).toBe('360px');
    f.dispose();
  });
});
