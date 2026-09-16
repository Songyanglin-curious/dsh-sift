import layoutCss from './layout.css?inline';
import { SIFT_ADDED_NODES, SIFT_ATTR, SIFT_DATA } from './selectors.js';

/**
 * 三栏布局引擎：把 Sift 的两栏追加到 DSH 的 center column 里，
 * 并让原生对话留在最后一栏。
 *
 * 这里只负责布局（网格、分隔线、宽度、折叠、工具栏）；
 * 栏内是什么由调用方通过 `mount` 决定。
 * 所有 DOM 假设来自 selectors.ts（实施文档 §7）。
 */

export interface LayoutState {
  widths: [number, number, number];
  collapsed: [boolean, boolean, boolean];
}

export const DEFAULT_LAYOUT: LayoutState = { widths: [280, 480, 520], collapsed: [false, false, false] };

/** 参考栏 / 文档栏 / 原生对话栏的最小宽度。 */
export const MIN_WIDTHS: [number, number, number] = [220, 320, 360];

const COLLAPSED_WIDTH = 0;

/** 纯函数：按容器宽度把三栏宽度约束到最小宽度之上。 */
export function fitLayout(state: LayoutState, containerWidth: number): LayoutState {
  const available = Math.max(0, containerWidth - 12);
  const widths = [...state.widths] as LayoutState['widths'];
  const expanded = [0, 1, 2].filter(index => !state.collapsed[index]);
  const fixed = state.collapsed.filter(Boolean).length * COLLAPSED_WIDTH;
  const minimum = expanded.reduce((sum, index) => sum + MIN_WIDTHS[index], fixed);
  if (available <= minimum) {
    for (const index of expanded) widths[index] = MIN_WIDTHS[index];
  } else {
    const extras = expanded.map(index => Math.max(0, widths[index] - MIN_WIDTHS[index]));
    const extraTotal = extras.reduce((sum, value) => sum + value, 0);
    const room = available - minimum;
    expanded.forEach((index, position) => { widths[index] = MIN_WIDTHS[index] + room * (extraTotal > 0 ? extras[position] / extraTotal : 1 / expanded.length); });
  }
  const rounded = widths.map((value, index) => state.collapsed[index] ? COLLAPSED_WIDTH : Math.round(value)) as LayoutState['widths'];
  if (available > minimum && expanded.length > 0) {
    const last = expanded.at(-1)!;
    rounded[last] += available - rounded.reduce((sum, value) => sum + value, 0);
  }
  return { widths: rounded, collapsed: [...state.collapsed] as LayoutState['collapsed'] };
}

export interface ColumnSpec {
  /** 同时作为 data-sift-column 的值与 CSS 里的定位键。 */
  readonly id: string;
  /** 工具栏上的切换标签。 */
  readonly label: string;
  readonly title: string;
  readonly description: string;
}

export interface ThreeColumnOptions {
  /** 左栏（Reference Board）与中栏（Document）；右栏固定是原生对话。 */
  readonly columns: readonly [ColumnSpec, ColumnSpec];
  /** 在给定 section 里挂载栏内容，返回清理函数。 */
  readonly mount: (id: string, section: HTMLElement) => () => void;
  /** 布局宽度与折叠状态的 localStorage 键。 */
  readonly storageKey: string;
}

const THIRD_TAB_LABEL = '对话';

function loadState(storageKey: string): LayoutState {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<LayoutState> | null;
    if (value && Array.isArray(value.widths) && value.widths.length === 3 && Array.isArray(value.collapsed) && value.collapsed.length === 3) {
      return { widths: value.widths.map(Number) as LayoutState['widths'], collapsed: value.collapsed.map(Boolean) as LayoutState['collapsed'] };
    }
  } catch { /* 损坏的偏好不该阻止布局加载，回落默认值。 */ }
  return structuredClone(DEFAULT_LAYOUT);
}

/** 挂载三栏布局，返回清理函数。 */
export function mountThreeColumn(center: HTMLElement, options: ThreeColumnOptions): () => void {
  const { columns, mount, storageKey } = options;
  let state = loadState(storageKey);
  let resizeObserver: ResizeObserver | undefined;
  const teardown: (() => void)[] = [];
  let teardownComplete = false;

  const style = document.createElement('style');
  style.dataset.siftLayout = 'three-column';
  style.textContent = layoutCss;

  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* 隐私模式下忽略。 */ } };

  const applyState = () => {
    const fitted = fitLayout(state, center.clientWidth);
    fitted.widths.forEach((width, index) => {
      center.style.setProperty(`--sift-w${index}`, `${width}px`);
      if (!state.collapsed[index]) state.widths[index] = width;
    });
    center.style.setProperty('--sift-g0', state.collapsed[0] || state.collapsed[1] ? '0px' : '6px');
    center.style.setProperty('--sift-g1', state.collapsed[1] || state.collapsed[2] ? '0px' : '6px');
    center.toggleAttribute(SIFT_ATTR.chatCollapsed, state.collapsed[2]);
    columns.forEach((spec, index) => {
      center.querySelector<HTMLElement>(`[data-sift-column="${spec.id}"]`)?.toggleAttribute(SIFT_ATTR.collapsed, state.collapsed[index]);
    });
    center.querySelectorAll<HTMLButtonElement>(`[${SIFT_ATTR.panelToggle}]`).forEach(button => {
      const index = Number(button.dataset[SIFT_DATA.panelToggle]);
      button.setAttribute('aria-pressed', String(!state.collapsed[index]));
      button.title = state.collapsed[index] ? `显示${button.textContent}` : `隐藏${button.textContent}`;
    });
    // 原生对话依赖 window resize 重新测量，切栏后必须通知它。
    window.dispatchEvent(new Event('resize'));
  };

  const toggle = (index: number) => { state.collapsed[index] = !state.collapsed[index]; applyState(); persist(); };

  const toolbar = document.createElement('nav');
  toolbar.dataset[SIFT_DATA.layoutToolbar] = '';
  toolbar.setAttribute('aria-label', 'Sift 布局');
  const tabs = document.createElement('div');
  tabs.dataset[SIFT_DATA.panelTabs] = '';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '显示的栏目');
  [...columns.map(spec => spec.label), THIRD_TAB_LABEL].forEach((label, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset[SIFT_DATA.panelToggle] = String(index);
    button.addEventListener('click', () => toggle(index));
    tabs.appendChild(button);
  });
  toolbar.appendChild(tabs);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = '重置';
  reset.dataset[SIFT_DATA.action] = 'reset';
  reset.title = '显示全部栏目';
  reset.addEventListener('click', () => { state.collapsed = [false, false, false]; applyState(); persist(); });
  toolbar.appendChild(reset);

  document.head.appendChild(style);
  center.appendChild(toolbar);

  const addResizer = (index: 0 | 1) => {
    const handle = document.createElement('div');
    handle.dataset[SIFT_DATA.resizer] = String(index);
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', '调整栏宽');
    handle.tabIndex = 0;
    handle.addEventListener('pointerdown', event => {
      if (state.collapsed[index] || state.collapsed[index + 1]) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.setAttribute(SIFT_ATTR.dragging, '');
      const start = event.clientX;
      const left = state.widths[index];
      const right = state.widths[index + 1];
      const move = (next: PointerEvent) => {
        const delta = next.clientX - start;
        state.widths[index] = Math.max(MIN_WIDTHS[index], left + delta);
        state.widths[index + 1] = Math.max(MIN_WIDTHS[index + 1], right - delta);
        applyState();
      };
      const end = () => {
        handle.removeAttribute(SIFT_ATTR.dragging);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        persist();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end, { once: true });
    });
    return handle;
  };

  columns.forEach((spec, index) => {
    const section = document.createElement('section');
    section.dataset[SIFT_DATA.column] = spec.id;
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = spec.title;
    const description = document.createElement('small');
    description.textContent = spec.description;
    header.append(title, description);
    section.appendChild(header);
    center.appendChild(section);
    teardown.push(mount(spec.id, section));
    // 每一栏后面都要一条分隔线：最后一条隔开 Document 与原生对话栏。
    center.appendChild(addResizer(index as 0 | 1));
  });

  center.setAttribute(SIFT_ATTR.threeColumn, '');
  resizeObserver = new ResizeObserver(entries => { if (entries.some(entry => entry.target === center)) applyState(); else window.dispatchEvent(new Event('resize')); });
  resizeObserver.observe(center);
  Array.from(center.children).forEach(child => resizeObserver!.observe(child));
  applyState();

  return () => {
    if (teardownComplete) return;
    teardownComplete = true;
    // 栏内容的清理是尽力而为：某一栏抛错也必须把 Sift 追加的 DOM 全部撤掉，
    // 否则页面会停在半重排的状态（实施文档 §7.2）。
    for (const dispose of teardown.reverse()) {
      try { dispose(); } catch (error) { console.error('Sift: 栏内容清理失败', error); }
    }
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    center.querySelectorAll(SIFT_ADDED_NODES).forEach(node => node.remove());
    style.remove();
    center.removeAttribute(SIFT_ATTR.threeColumn);
    center.removeAttribute(SIFT_ATTR.chatCollapsed);
    for (const property of ['--sift-w0', '--sift-w1', '--sift-w2', '--sift-g0', '--sift-g1']) center.style.removeProperty(property);
  };
}
