/**
 * ReferenceCanvas：卡片画布（视图 + 交互层）。
 *
 * 卡片状态的事实源在 ReferencePanel（当前 Reference 文件）。
 * Canvas 只负责：
 * - 渲染 readCards() 给的卡片
 * - paste 事件 → Host readClipboard() → 新卡
 * - 删除、SortableJS 拖拽排序
 * - 任何变更通过 onCardsChange(next) 回传，由 Panel 决定何时落盘
 *
 * 核心交互：外部复制 → 鼠标在参考区 / Canvas 聚焦 → Ctrl+V → 出卡。
 * Canvas 不知道 Remote / DSH 的存在，剪贴板能力由调用方注入。
 */

import Sortable from 'sortablejs';
import { mountCard, type ReferenceCardData } from './card.js';
import { snapshotToCards, newCardId } from './clipboard-mapper.js';
import { injectStyle, SIFT_PLUGIN_ID } from './inject-style.js';
import canvasCss from './canvas.css?inline';

/** 同 clipboard-mapper 的约定：只允许 type-only 导入，防止 koffi 进浏览器 bundle。 */
import type { ClipboardSnapshot } from '../../host/clipboard/index.js';

export interface CanvasOptions {
  /** Panel 是事实源；每次渲染都从这里取最新卡片数组。 */
  readonly readCards: () => readonly ReferenceCardData[];
  /** Host 端剪贴板读取（Remote 代理）；未提供时 ＋ 按钮回落为空白卡片。 */
  readonly readClipboard?: () => Promise<ClipboardSnapshot>;
  /** 增 / 删 / 排序统一回传；Panel 更新内存并防抖落盘。 */
  readonly onCardsChange: (next: readonly ReferenceCardData[]) => void;
  /**
   * paste 事件的检测边界。
   * 默认使用 Canvas 自身；当 toolbar 等 UI 在 Canvas 外部时（如 panel），
   * 传入更大的容器让 paste 在参考区任何位置都能触发。
   */
  readonly pasteBoundary?: HTMLElement;
  /**
   * 当前参考区是否激活（即已选中一个 Reference）。
   * 未激活时 paste 不拦截、不 preventDefault，避免吞掉用户的粘贴操作。
   */
  readonly isActive?: () => boolean;
  /**
   * 编辑卡片；由 Panel 提供，打开卡片编辑弹窗并落盘。
   */
  readonly onCardEdit?: (id: string) => void;
  /**
   * 点击卡片的文件来源图标；由 Panel 提供（调用 Host 打开本机文件）。
   * 未提供时文件图标不可点击。
   */
  readonly onCardOpenSource?: (uri: string) => void;
}

export interface CanvasApi {
  /** 外部状态变化（如切换 Reference）后让 Canvas 重读重渲染。 */
  refresh(): void;
  dispose(): void;
  /** 在画布上方短暂显示一条提示（用于展示打开文件失败等原因）。 */
  notify(message: string): void;
}

export function mountCanvas(host: HTMLElement, options: CanvasOptions): CanvasApi {
  // 注入样式（对齐官方 DSH 插件模式：head + data-plugin-css 去重，见 inject-style.ts）
  const disposeStyle = injectStyle(SIFT_PLUGIN_ID, 'canvas.css', canvasCss);

  // Canvas 根容器：可聚焦，使 Ctrl+V 的 paste 事件能落到这里
  const canvas = document.createElement('div');
  canvas.dataset.siftCanvas = '';
  canvas.tabIndex = -1;

  // 卡片列表容器（SortableJS 挂载点）
  const list = document.createElement('div');
  list.dataset.siftCardList = '';

  // 底部 ＋：备用入口，与 Ctrl+V 走同一处理函数
  const footer = document.createElement('footer');
  footer.dataset.siftCanvasFooter = '';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.dataset.siftCanvasAdd = '';
  addBtn.title = '读取剪贴板，添加参考';
  addBtn.textContent = '＋';
  footer.appendChild(addBtn);

  canvas.append(list, footer);
  host.appendChild(canvas);

  // 临时提示条：只在需要时出现（如打开文件失败），几秒后自动消失。
  const notice = document.createElement('div');
  notice.dataset.siftCanvasNotice = '';
  notice.hidden = true;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (message: string) => {
    notice.textContent = message;
    notice.hidden = false;
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; noticeTimer = undefined; }, 5000);
  };
  canvas.insertBefore(notice, list);

  // 清理函数列表
  const disposeFns: (() => void)[] = [];

  // ── 渲染 ──────────────────────────────────────────────

  const renderAll = () => {
    for (const fn of disposeFns) fn();
    disposeFns.length = 0;
    list.replaceChildren();

    for (const card of options.readCards()) {
      const dispose = mountCard(list, {
        card,
        onRemove: (id) => {
          const next = options.readCards().filter(item => item.id !== id);
          options.onCardsChange(next);
          renderAll();
        },
        ...(options.onCardEdit ? { onEdit: options.onCardEdit } : {}),
        ...(options.onCardOpenSource ? { onOpenSource: options.onCardOpenSource } : {}),
      });
      disposeFns.push(dispose);
    }

    // 空状态：弱提示，第一张卡片出现后消失
    if (options.readCards().length === 0) {
      const empty = document.createElement('div');
      empty.dataset.siftCanvasEmpty = '';
      const line1 = document.createElement('span');
      line1.textContent = '粘贴内容到这里';
      const line2 = document.createElement('kbd');
      line2.textContent = 'Ctrl + V';
      empty.append(line1, line2);
      list.appendChild(empty);
    }
  };

  // ── 添加：唯一入口（paste 与 ＋ 按钮共用） ────────────

  let busy = false;
  const addReferenceFromClipboard = () => {
    if (busy) return;
    if (!options.readClipboard) {
      options.onCardsChange([...options.readCards(), { id: newCardId(), content: '# 新参考\n\n在此输入 Markdown 内容…' }]);
      renderAll();
      return;
    }
    busy = true;
    void (async () => {
      try {
        const snapshot = await options.readClipboard!();
        const created = snapshotToCards(snapshot);
        if (created.length > 0) {
          options.onCardsChange([...options.readCards(), ...created]);
          renderAll();
        }
        // 卡片出现本身就是反馈，不做 toast / 状态文字
      } catch (error) {
        console.error('Sift: 读取剪贴板失败', error);
      } finally {
        busy = false;
      }
    })();
  };

  addBtn.addEventListener('click', () => {
    addBtn.blur();
    addReferenceFromClipboard();
  });

  // ── paste 监听（document 级） ────────────────────────
  //
  // 只靠 `:hover` 判断：鼠标在参考区域内且已选中 Reference 就拦截。
  // 使用 pasteBoundary（若提供，即 panel 整体）或 canvas 自身做检测，
  // 确保 toolbar 区域也能触发粘贴。

  const pasteArea = options.pasteBoundary ?? canvas;
  const onDocumentPaste = (event: ClipboardEvent) => {
    if (!pasteArea.matches(':hover')) return;
    if (options.isActive !== undefined && !options.isActive()) return;
    event.preventDefault();
    addReferenceFromClipboard();
  };
  document.addEventListener('paste', onDocumentPaste);

  // ── SortableJS 拖拽：仅 ⠿ 把手可拖，正文保持可选中 ──

  let sortable: Sortable | undefined;
  const initSortable = () => {
    sortable?.destroy();
    sortable = Sortable.create(list, {
      handle: '[data-sift-card-handle]',
      animation: 200,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: (evt) => {
        if (evt.oldIndex === undefined || evt.newIndex === undefined) return;
        if (evt.oldIndex === evt.newIndex) return;
        const next = [...options.readCards()];
        const [moved] = next.splice(evt.oldIndex, 1);
        next.splice(evt.newIndex, 0, moved);
        options.onCardsChange(next);
        renderAll();
      },
    });
  };

  // 首次渲染
  renderAll();
  initSortable();

  return {
    refresh: renderAll,
    notify,
    dispose: () => {
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      document.removeEventListener('paste', onDocumentPaste);
      sortable?.destroy();
      disposeStyle();
      for (const fn of disposeFns) fn();
      canvas.remove();
    },
  };
}
