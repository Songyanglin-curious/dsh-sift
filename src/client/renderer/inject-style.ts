/**
 * 遵循 DSH 官方插件模式的样式注入工具。
 *
 * 官方做法（见 dsh-client-ui-sidebar lib/client.js:29-36）：
 * - 将 `<style>` 注入 `<head>`，不是业务容器内；
 * - 用 `data-plugin` + `data-plugin-css` 做去重标记，避免 HMR 重复注入；
 * - 返回 disposer 供清理时移除。
 *
 * 核心约束：CSS 根选择器使用的属性名（如 `[data-sift-canvas]`）
 * **绝不能**同时设置到 `<style>` 元素本身上，否则 `<style>` 会命中自身规则，
 * 把 UA 默认 `display:none` 覆盖掉，导致 CSS 源码被浏览器渲染成可见文本。
 */

export function injectStyle(pluginId: string, cssId: string, css: string): () => void {
  const dedupeKey = `${pluginId}/${cssId}`;
  if (document.querySelector(`style[data-plugin-css="${CSS.escape(dedupeKey)}"]`)) {
    // 已有同名样式，不重复注入；返回空 disposer 让调用方也能统一清理。
    return () => {};
  }

  const tag = document.createElement('style');
  tag.dataset.plugin = pluginId;
  tag.dataset.pluginCss = dedupeKey;
  tag.textContent = css;
  document.head.appendChild(tag);

  return () => { tag.remove(); };
}