/**
 * Sift 图标集：自研内联 SVG，全插件唯一的图标几何与尺寸事实源。
 *
 * 为什么不用字符图标：旧实现直接用 ⊞ ✎ ⠿ 以及全角 ＋ 这些裸 Unicode 字符，它们分属
 * 不同 Unicode 区块，会落到不同系统字体——⊞ 与全角 ＋ 常命中 CJK 字体（字面大、笔画粗），
 * × 与 ✎ 走拉丁/符号字体（偏小），同字号下视觉必然不统一；来源用的 emoji 还自带彩色字形、
 * 不受 currentColor 控制，无法参与 hover 变色的 token 体系。
 *
 * 约定（新增图标必须遵守）：
 * - 固定 16px 画布、viewBox `0 0 16 16`、1.5 描边、颜色一律 currentColor；
 * - 只有 grip 是实心图标（fill=currentColor 的圆点）；
 * - 按钮盒尺寸由 icons.css 的 `.sift-icon-button` 统一给出（24×24），各业务 CSS 不得再写
 *   width/height/font-size；
 * - setIcon() 先清空再写入，保证按钮内唯一子元素就是 <svg>。
 */

import iconsCss from './icons.css?inline';
import { injectStyle, SIFT_PLUGIN_ID } from './renderer/inject-style.js';

export type IconName = 'close' | 'plus' | 'list-plus' | 'pencil' | 'trash' | 'grip' | 'link' | 'file';

/** 图标画布边长，同时是 <svg> 的 width/height。 */
export const ICON_SIZE = 16;

interface IconSpec {
  /** <svg> 内部静态标记。颜色一律 currentColor，由外层属性决定描边还是填充。 */
  readonly body: string;
  /** true = 实心图标（fill=currentColor，不描边）。 */
  readonly filled?: boolean;
}

const ICONS: Record<IconName, IconSpec> = {
  close: { body: '<path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"/>' },
  plus: { body: '<path d="M8 3.5v9M3.5 8h9"/>' },
  // 「添加已有参考」：列表 + 加号，与纯加号（新建参考）在形状上可区分，避免两个入口混淆。
  'list-plus': { body: '<path d="M2.5 4h6.5M2.5 8h4M2.5 12h6.5"/><path d="M12 7.5v5.5M9.25 10.25h5.5"/>' },
  pencil: { body: '<path d="M10.9 3.4 13 5.5 5.6 12.9 3 13.7 3.8 11.1z"/>' },
  trash: { body: '<path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6M7 7v4M9 7v4"/>' },
  // 拖拽把手：2×3 圆点。
  grip: { body: '<circle cx="5.6" cy="4" r="1.2"/><circle cx="10.4" cy="4" r="1.2"/><circle cx="5.6" cy="8" r="1.2"/><circle cx="10.4" cy="8" r="1.2"/><circle cx="5.6" cy="12" r="1.2"/><circle cx="10.4" cy="12" r="1.2"/>', filled: true },
  // 卡片来源：网页用 link，文件用 file。
  link: { body: '<path d="M6.8 9.2 9.2 6.8"/><path d="M7.6 4.4l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1"/><path d="M8.4 11.6l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1"/>' },
  file: { body: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>' },
};

/** 全部图标名，供遍历与测试使用。 */
export const ICON_NAMES = Object.keys(ICONS) as readonly IconName[];

/** 返回图标的完整 <svg> 字符串（按钮内应只有它一个子元素）。 */
export function iconSvg(name: IconName): string {
  const spec = ICONS[name];
  const paint = spec.filled === true
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" `
    + `viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" aria-hidden="true" focusable="false" ${paint}>${spec.body}</svg>`;
}

export function createIconElement(name: IconName): SVGSVGElement | null {
  const template = document.createElement('template');
  template.innerHTML = iconSvg(name);
  ensureIconStyles();
  return template.content.firstElementChild as SVGSVGElement | null;
}

/** 把图标写进元素：先清空，保证唯一子元素是 <svg>，不会残留旧字符或旧图标。 */
export function setIcon(el: HTMLElement, name: IconName): void {
  const svg = createIconElement(name);
  if (svg === null) return;
  el.replaceChildren(svg);
}

let iconStylesInjected = false;

/**
 * 图标基类样式的生命周期与插件一致：首个图标创建时注入一次，之后不再移除。
 *
 * 刻意不持有 disposer：injectStyle 已按 pluginId/cssId 去重，而基类样式可能同时被
 * 参考面板与卡片画布使用，任何一侧卸载时清掉它都会让另一侧失去尺寸定义。
 */
function ensureIconStyles(): void {
  if (iconStylesInjected) return;
  iconStylesInjected = true;
  injectStyle(SIFT_PLUGIN_ID, 'icons.css', iconsCss);
}
