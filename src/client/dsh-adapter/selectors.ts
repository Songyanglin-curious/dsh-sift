/**
 * Sift 对 DSH Web DOM 的**全部**假设都集中在这里（实施文档 §7）。
 *
 * 业务组件禁止自己写 `document.querySelector(...)`；要新增加 DOM 依赖，
 * 必须先在这里加一个有名字、带说明的选择器，并在
 * docs/dsh-reference-api-research.md 同级的适配记录里注明目标 DSH 版本。
 *
 * 目标版本：DSH 0.1.5-rc.2。升级 DSH 后重跑适配验证，只改本文件与 layout.ts。
 */

/** 右侧栏（原生对话所在列）的锚点；DSH 会把它渲染成纵向两列容器。 */
const RIGHTBAR_COLUMN = '[data-rightbar-col]';

/** 主面板插槽，原生对话挂在它下面。 */
const SLOT_MAIN = '[data-slot="main"]';

/** 原生对话插槽。 */
const SLOT_CONVERSATION = '[data-slot="main.conversation"]';

/** 侧边栏的「添加工作区」按钮，Sift 用带类型选择的入口替换它。 */
const WORKSPACE_ADD_BUTTON = 'button[aria-label="添加工作区"]';

/**
 * 三栏布局的宿主容器。
 *
 * 0.1.5-rc.2 没有公开的 Conversation 包装插槽，因此通过右栏锚点的前一个兄弟
 * 节点取得 center column，再在它内部追加 Sift 栏位并用 CSS Grid 把原生对话排到最后。
 * 找不到时返回 null —— 调用方必须放弃启用三栏，而不是继续重排页面（§7.2）。
 */
export function findConversationCenter(): HTMLElement | null {
  const anchor = document.querySelector(RIGHTBAR_COLUMN);
  const center = anchor?.previousElementSibling;
  return center instanceof HTMLElement ? center : null;
}

/** 三栏宿主内部的 main 插槽；collapsed 时由 CSS 隐藏它。 */
export function findSlotMain(center: HTMLElement): HTMLElement | null {
  return center.querySelector<HTMLElement>(SLOT_MAIN);
}

/** 三栏宿主内部的对话插槽，用于断言原生对话确实被排到了第三栏。 */
export function findSlotConversation(center: HTMLElement): HTMLElement | null {
  return center.querySelector<HTMLElement>(SLOT_CONVERSATION);
}

/** 判断元素是否为原生"添加工作区"按钮。 */
export function isWorkspaceAddButton(element: HTMLElement | null): boolean {
  return element?.matches?.(WORKSPACE_ADD_BUTTON) === true;
}

export function findWorkspaceAddButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(WORKSPACE_ADD_BUTTON);
}

/** Sift 追加节点的 dataset 键，避免各处散落字符串字面量。 */
export const SIFT_DATA = {
  threeColumn: 'siftThreeColumn',
  column: 'siftColumn',
  resizer: 'siftResizer',
  layoutToolbar: 'siftLayoutToolbar',
  panelTabs: 'siftPanelTabs',
  panelToggle: 'siftPanelToggle',
  action: 'action',
} as const;

/**
 * 用属性名、而不是 dataset 键来读写的标记。
 * HTML 会把属性名小写化，所以 `data-chatCollapsed` 会变成 `data-chatcollapsed`，
 * 与 CSS 里的 `[data-chat-collapsed]` 不匹配；这里保留准确的 kebab 写法。
 */
export const SIFT_ATTR = {
  threeColumn: 'data-sift-three-column',
  collapsed: 'data-collapsed',
  chatCollapsed: 'data-chat-collapsed',
  dragging: 'data-dragging',
  /** dataset.siftPanelToggle 写出的属性名是 kebab 形式，查询时必须用它。 */
  panelToggle: 'data-sift-panel-toggle',
} as const;

/** Sift 追加到三栏宿主上的节点选择器，用于一次性清理。 */
export const SIFT_ADDED_NODES = '[data-sift-column],[data-sift-resizer],[data-sift-layout-toolbar]';
