// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, ICON_SIZE, createIconElement, iconSvg, setIcon, type IconName } from '../src/client/icons.js';
import { SIFT_PLUGIN_ID } from '../src/client/renderer/inject-style.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 直接读源码文件，不走 `?inline` 导入：Vitest 默认不做 CSS 处理，`*.css?inline`
 * 解析出来是空字符串（真实客户端构建里则由 esbuild 插件内联成 CSS 文本）。
 * 路径用 process.cwd()（Vitest 的 cwd 就是项目根），因为这里的 import.meta.url
 * 已被 Vite 转换，不再是 file: 协议，无法直接构造文件 URL。
 */
const ICONS_CSS = readFileSync(resolve(process.cwd(), 'src/client/icons.css'), 'utf8');

/** 去掉注释后的 CSS 声明，避免守卫被注释里提到的属性名误判。 */
const ICONS_DECLARATIONS = ICONS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const PANEL_TS = readFileSync(resolve(process.cwd(), 'src/client/reference/panel.ts'), 'utf8');
const CONVERSATION_VIEW_TS = readFileSync(resolve(process.cwd(), 'src/client/reference/conversation-view.ts'), 'utf8');
const PANEL_CSS = readFileSync(resolve(process.cwd(), 'src/client/reference/panel.css'), 'utf8');

/** 把代码里的 `dataset.fooBar = ...` 还原成浏览器真实生成的属性名 data-foo-bar。 */
function datasetAttributes(src: string): Set<string> {
  const attrs = new Set<string>();
  for (const match of src.matchAll(/\.dataset\.([A-Za-z0-9]+)\s*=/g)) {
    attrs.add(`data-${match[1]!.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`);
  }
  return attrs;
}

/** CSS 里被当作选择器使用的 data-* 属性名。 */
function cssAttributes(css: string): Set<string> {
  const attrs = new Set<string>();
  for (const match of css.matchAll(/\[(data-[a-z0-9-]+)/g)) attrs.add(match[1]!);
  return attrs;
}

function elementFor(name: IconName): SVGSVGElement {
  const el = createIconElement(name);
  expect(el, `图标 ${name} 应该能解析出元素`).not.toBeNull();
  return el!;
}

describe('Sift 图标集', () => {
  it('每个图标都是单个 16px 的 svg，颜色跟随 currentColor，且不含文本', () => {
    expect(ICON_SIZE).toBe(16);
    for (const name of ICON_NAMES) {
      const el = elementFor(name);
      expect(el.namespaceURI, `${name} 应处于 SVG 命名空间`).toBe(SVG_NS);
      expect(el.getAttribute('width'), `${name} 宽度`).toBe('16');
      expect(el.getAttribute('height'), `${name} 高度`).toBe('16');
      expect(el.getAttribute('viewBox'), `${name} 画布`).toBe('0 0 16 16');
      expect(el.getAttribute('aria-hidden'), `${name} 应装饰性隐藏`).toBe('true');
      // 描边图标与实心图标都只能通过 currentColor 取色，否则 hover 变色会失效。
      const followsCurrentColor = el.getAttribute('stroke') === 'currentColor'
        || el.getAttribute('fill') === 'currentColor';
      expect(followsCurrentColor, `${name} 必须使用 currentColor`).toBe(true);
      // 图标层不允许再出现字符文本（旧实现的问题根源）。
      expect(el.textContent, `${name} 不应含文本节点`).toBe('');
    }
  });

  it('每个图标都有几何内容，且内部只用 path/circle', () => {
    for (const name of ICON_NAMES) {
      const el = elementFor(name);
      expect(el.children.length, `${name} 应有几何子节点`).toBeGreaterThan(0);
      for (const child of Array.from(el.children)) {
        expect(['path', 'circle'], `${name} 含不支持的元素 ${child.tagName}`).toContain(child.tagName);
      }
    }
  });

  it('图标之间互不相同（不会两个入口长得一样）', () => {
    const svgs = ICON_NAMES.map(name => iconSvg(name));
    expect(new Set(svgs).size).toBe(ICON_NAMES.length);
  });

  it('list-plus 与 plus 形状可区分（添加已有参考 vs 新建参考）', () => {
    const plus = elementFor('plus');
    const listPlus = elementFor('list-plus');
    expect(iconSvg('list-plus')).not.toBe(iconSvg('plus'));
    expect(listPlus.children.length).not.toBe(plus.children.length);
  });

  it('setIcon 后元素内唯一子元素就是 svg，重复调用不累积', () => {
    const button = document.createElement('button');
    button.textContent = '⊞';
    setIcon(button, 'list-plus');
    setIcon(button, 'list-plus');
    expect(button.children.length).toBe(1);
    expect(button.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(button.textContent).toBe('');
  });

  it('图标基类样式按 pluginId/cssId 只注入一次', () => {
    setIcon(document.createElement('button'), 'close');
    setIcon(document.createElement('button'), 'plus');
    const tags = document.head.querySelectorAll(`style[data-plugin-css="${SIFT_PLUGIN_ID}/icons.css"]`);
    expect(tags.length).toBe(1);
    expect(tags[0]?.getAttribute('data-plugin')).toBe(SIFT_PLUGIN_ID);
  });

  it('icons.css 给出 24×24 按钮盒与 16px 纯图标热区，且不再用 font-size 排版字符图标', () => {
    // 防回潮：尺寸只允许来自这一处；一旦有人改回字符图标并按 font-size 排版，这条会失败。
    expect(ICONS_DECLARATIONS).toContain('.sift-icon-button');
    expect(ICONS_DECLARATIONS).toContain('width: 24px');
    expect(ICONS_DECLARATIONS).toContain('height: 24px');
    expect(ICONS_DECLARATIONS).toContain('.sift-icon-plain');
    expect(ICONS_DECLARATIONS).toContain('width: 16px');
    expect(ICONS_DECLARATIONS).not.toMatch(/font-size\s*:/);
  });
});

describe('样式钩子与 DOM 属性一致（防 data-* 命名漂移）', () => {
  /** 由别的模块设置或浏览器内置，不属于 panel.ts 的责任范围。 */
  const EXTERNAL_HOOKS = new Set(['data-plugin', 'data-plugin-css', 'data-active']);

  it('panel.css 引用的每个 data-* 属性都真的会被 panel.ts 设置', () => {
    const set = datasetAttributes(`${PANEL_TS}\n${CONVERSATION_VIEW_TS}`);
    const missing = [...cssAttributes(PANEL_CSS)].filter(attr => !set.has(attr) && !EXTERNAL_HOOKS.has(attr));
    // 这里曾经出过 bug：CSS 写 [data-sift-ref-addref]，而 dataset.siftRefAddRef 生成的是
    // data-sift-ref-add-ref，规则永不命中 → 按钮回落 UA 样式、被拉伸成 33×32。
    expect(missing).toEqual([]);
  });

  it('图标按钮不再依赖 data-* 选择器定样式', () => {
    expect(PANEL_CSS).not.toMatch(/\[data-sift-ref-(edit|add|add-ref|addref)\]/);
  });

  it('panel.ts 里每个 setIcon 的宿主按钮都带 .sift-icon-button', () => {
    const hosts = [...PANEL_TS.matchAll(/setIcon\((\w+),/g)].map(match => match[1]!);
    expect(hosts.length).toBeGreaterThanOrEqual(4);
    for (const name of hosts) {
      const assignment = new RegExp(`${name}\\.className\\s*=\\s*'([^']*)'`).exec(PANEL_TS);
      expect(assignment?.[1], `${name} 应带 .sift-icon-button`).toContain('sift-icon-button');
    }
  });
});
