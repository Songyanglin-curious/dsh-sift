/**
 * ReferencePanel：整个参考面板，卡片状态的事实源。
 *
 * 职责：
 * - 扫描 / 切换 / 新建当前 Reference（原生 select 单选 + 新建按钮）
 * - 持有当前 ReferenceDocument 内存副本
 * - 卡片任何变更（增/删/排序）→ 400ms 防抖 → saveReference 落盘；
 *   切换参考与 dispose 前先 flush
 * - Canvas 只做视图与交互，状态回传到这里
 *
 * 可见 Tabs 与 Output → References 关系由 WorkspaceController 统一协调。
 */

import panelCss from './panel.css?inline';
import { setIcon } from '../icons.js';
import { mountCanvas } from '../renderer/canvas.js';
import { injectStyle, SIFT_PLUGIN_ID } from '../renderer/inject-style.js';
import { mountReferenceEditor, triggerEdit } from './reference-edit.js';
import { mountCardEditor, triggerCardEdit } from '../renderer/card-edit.js';
import { mountRefSelector, triggerRefSelector } from './ref-selector.js';
import { createHistory } from './history.js';
import type { ReferenceCardData } from '../renderer/card.js';
import type { ClipboardSnapshot } from '../../host/clipboard/index.js';
import type { ReferenceDocument, ReferenceSummary } from '../../references.js';
import type { WorkspaceController } from '../workspace-controller.js';

export interface ReferenceApi {
  listReferences(): Promise<ReferenceSummary[]>;
  loadReference(path: string): Promise<ReferenceDocument>;
  createReference(name?: string): Promise<{ path: string }>;
  saveReference(path: string, reference: ReferenceDocument): Promise<void>;
  removeReference(path: string): Promise<void>;
  /** Host 的原生文件对话框（多选）；卡片来源只取第一个路径。 */
  pickSourceFiles(): Promise<{ paths: readonly string[]; cancelled: boolean; message?: string }>;
  /** 在本机打开一个文件；失败时抛出可读错误。 */
  openSourcePath(path: string): Promise<void>;
}

export interface ReferencePanelOptions {
  readonly api: ReferenceApi;
  /** Host 端剪贴板读取（Remote 代理），透传给 Canvas。 */
  readonly readClipboard?: () => Promise<ClipboardSnapshot>;
  /** 测试可替换；生产默认使用浏览器原生二次确认。 */
  readonly confirmDelete?: (name: string) => boolean;
  readonly workspace?: WorkspaceController;
}

const SAVE_DEBOUNCE_MS = 400;

export function mountReferencePanel(section: HTMLElement, options: ReferencePanelOptions): () => void {
  // ── 状态 ──────────────────────────────────────────────

  let summaries: ReferenceSummary[] = [];
  let currentPath: string | null = null;
  let currentDoc: ReferenceDocument | null = null;
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let history = createHistory<ReferenceCardData[]>([]);
  let deleting = false;
  // 当前工作区中"激活"的 Reference 路径；只有这些会出现在 Tab Bar。
  let freeReferenceTabs: string[] = [];
  const visiblePaths = (): string[] => options.workspace
    ? [...options.workspace.snapshot().visibleReferences]
    : [...freeReferenceTabs];

  // ── Tab Bar ────────────────────────────────────────

  const tabBar = document.createElement('div');
  tabBar.dataset.siftRefTabs = '';
  let addRefBtn: HTMLButtonElement | undefined;

  // ── 添加参考（弹窗）由 ref-selector.tsx 提供 ───────

  const renderTabs = () => {
    tabBar.replaceChildren();

    // 只显示 freeReferenceTabs 内的 reference
    const paths = visiblePaths();
    const visible = summaries.filter(s => paths.includes(s.path));
    for (const summary of visible) {
      const tab = document.createElement('div');
      tab.className = 'sift-ref-tab';
      if (summary.path === currentPath) tab.dataset.active = '';

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'sift-ref-tab-label';
      label.title = summary.name;
      label.textContent = summary.name;
      label.addEventListener('click', () => {
        if (summary.path !== currentPath) void selectReference(summary.path);
      });
      tab.appendChild(label);

      // 关闭只存在于自由模式；有关联 Output 时必须通过“编辑关联”明确修改。
      // 图标几何来自 icons.ts、按钮盒来自 icons.css 的 .sift-icon-button，
      // 这里只保留显隐与 hover 变红；样式一律走类名，data-* 仅作调试锚点。
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'sift-icon-button sift-ref-tab-close';
      closeBtn.title = '关闭';
      closeBtn.setAttribute('aria-label', '关闭');
      setIcon(closeBtn, 'close');
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (options.workspace) {
          options.workspace.closeFreeReference(summary.path);
          return;
        }
        const idx = freeReferenceTabs.indexOf(summary.path);
        if (idx === -1) return;
        freeReferenceTabs.splice(idx, 1);
        if (currentPath === summary.path) {
          // 关闭的是当前活跃 tab → 切到第一个剩下的（如有）
          if (freeReferenceTabs.length > 0) {
            void selectReference(freeReferenceTabs[0]!);
          } else {
            currentPath = null;
            currentDoc = null;
            updateSelectionVisibility();
            canvasApi.refresh();
            renderTabs();
          }
        } else {
          renderTabs();
        }
      });
      tab.appendChild(closeBtn);
      closeBtn.hidden = options.workspace?.snapshot().activeOutput !== undefined;

      tabBar.appendChild(tab);
    }

    // spacer —— 把操作按钮推到右侧
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;min-width:8px';
    tabBar.appendChild(spacer);

    // 右侧操作区：统一用 .sift-icon-button（24×24 盒 + 16px 图标），间距由容器 gap 给出
    const actions = document.createElement('div');
    actions.className = 'sift-ref-tab-actions';

    // 添加参考（选择已有）：列表 + 加号，与下方"新建参考"的纯加号在形状上可区分
    addRefBtn = document.createElement('button');
    addRefBtn.type = 'button';
    addRefBtn.className = 'sift-icon-button';
    addRefBtn.dataset.siftRefAddRef = '';
    addRefBtn.title = '添加已有参考';
    addRefBtn.setAttribute('aria-label', '添加已有参考');
    setIcon(addRefBtn, 'list-plus');
    addRefBtn.tabIndex = 0;
    addRefBtn.addEventListener('click', () => {
      addRefBtn!.blur();
      triggerRefSelector({
        all: summaries,
        checked: [],
        onSave: async (selected) => {
          if (options.workspace) {
            await options.workspace.addReferences(selected);
            return;
          }
          freeReferenceTabs = [...new Set([...freeReferenceTabs, ...selected])];
          // 如果当前 path 不在选中列表，切到第一个选中的或无
          if (currentPath && !freeReferenceTabs.includes(currentPath)) {
            if (freeReferenceTabs.length > 0) {
              void selectReference(freeReferenceTabs[0]!);
            } else {
              currentPath = null;
              currentDoc = null;
              updateSelectionVisibility();
              canvasApi.refresh();
            }
          }
          renderTabs();
        },
      });
    });
    actions.appendChild(addRefBtn);

    // 编辑当前参考
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'sift-icon-button';
    editBtn.dataset.siftRefEdit = '';
    editBtn.title = '编辑参考名称与描述';
    editBtn.setAttribute('aria-label', '编辑参考名称与描述');
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => {
      editBtn.blur();
      if (!currentDoc) return;
      triggerEdit(currentDoc.name, currentDoc.description, async (name, description) => {
        if (!currentDoc || !currentPath) return;
        currentDoc = { ...currentDoc, name, description };
        const summary = summaries.find(s => s.path === currentPath);
        if (summary) summary.name = name;
        schedulePersist();
        renderTabs();
      });
    });
    actions.appendChild(editBtn);

    // 删除当前参考：与编辑、关闭 Tab 分离，确认后才删除物理文件。
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'sift-icon-button';
    deleteBtn.dataset.siftRefDelete = '';
    deleteBtn.title = '删除当前参考';
    deleteBtn.setAttribute('aria-label', '删除当前参考');
    deleteBtn.disabled = currentDoc === null || currentPath === null || deleting;
    setIcon(deleteBtn, 'trash');
    deleteBtn.addEventListener('click', () => {
      deleteBtn.blur();
      if (!currentDoc || !currentPath || deleting) return;
      const path = currentPath;
      const name = currentDoc.name;
      const confirmed = options.confirmDelete?.(name)
        ?? window.confirm(`删除参考“${name}”？\n\n这会永久删除该参考及其中的所有卡片，并从相关产出的关联中移除。此操作无法撤销。`);
      if (!confirmed) return;
      void (async () => {
        deleting = true;
        renderTabs();
        try {
          // 先结束挂起的保存，避免删除成功后被防抖写入重新创建。
          await persistNow();
          await options.api.removeReference(path);
          const removedIndex = freeReferenceTabs.indexOf(path);
          freeReferenceTabs = freeReferenceTabs.filter(item => item !== path);
          summaries = summaries.filter(item => item.path !== path);
          options.workspace?.forgetReference(path);
          if (currentPath === path) {
            currentPath = null;
            currentDoc = null;
            history.reset([]);
            const workspaceNext = options.workspace?.snapshot().activeReference;
            const nextIndex = Math.min(Math.max(removedIndex, 0), freeReferenceTabs.length - 1);
            const nextPath = workspaceNext ?? (nextIndex >= 0 ? freeReferenceTabs[nextIndex] : undefined);
            if (nextPath) {
              await selectReference(nextPath);
            } else {
              updateSelectionVisibility();
              canvasApi.refresh();
            }
          }
        } catch (error) {
          console.error('Sift: 删除参考失败', error);
          canvasApi.notify(error instanceof Error ? error.message : '删除参考失败。');
        } finally {
          deleting = false;
          renderTabs();
        }
      })();
    });
    actions.appendChild(deleteBtn);

    // 新建参考
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'sift-icon-button';
    addBtn.dataset.siftRefAdd = '';
    addBtn.title = '新建参考';
    addBtn.setAttribute('aria-label', '新建参考');
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => {
      addBtn.blur();
      void (async () => {
        try {
          const { path } = await options.api.createReference();
          await refreshSummaries();
          await options.workspace?.addReferences([path]);
          renderTabs();
          await selectReference(path);
        } catch (error) {
          console.error('Sift: 新建参考失败', error);
        }
      })();
    });
    actions.appendChild(addBtn);

    tabBar.appendChild(actions);
  };

  // ── DOM ───────────────────────────────────────────────

  // 样式注入（head + data-plugin-css 去重，见 inject-style.ts）。
  // 严禁在 <style> 上设置与 CSS 根选择器（如 [data-sift-ref-panel]）相同的属性，
  // 否则 <style> 会命中自身规则，把 CSS 文本渲染成可见内容。
  const disposePanelCss = injectStyle(SIFT_PLUGIN_ID, 'panel.css', panelCss);

  const panel = document.createElement('div');
  panel.dataset.siftRefPanel = '';

  const canvasHost = document.createElement('div');
  canvasHost.dataset.siftRefCanvasHost = '';

  const emptyState = document.createElement('div');
  emptyState.dataset.siftRefEmpty = '';
  emptyState.textContent = '暂无打开的参考';

  // ── 落盘：内存改完 → 防抖 → 写当前文件 ────────────────

  const persistNow = async (): Promise<void> => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (!dirty || !currentPath || !currentDoc) return;
    const path = currentPath;
    const document = currentDoc;
    dirty = false;
    try {
      await options.api.saveReference(path, document);
    } catch (error) {
      console.error('Sift: 参考落盘失败', error);
      dirty = true; // 允许下一次变更重试
    }
  };

  const schedulePersist = () => {
    if (!currentPath || !currentDoc) return;
    dirty = true;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void persistNow();
    }, SAVE_DEBOUNCE_MS);
  };

  // ── 统一卡片变更收口 & Undo / Redo ────────────────

  const applyCardsChange = (next: readonly ReferenceCardData[]) => {
    if (!currentDoc) return;
    history.record([...next]);
    currentDoc = { ...currentDoc, cards: [...next] };
    canvasApi.refresh();
    schedulePersist();
  };

  const handleUndo = () => {
    const prev = history.undo();
    if (prev === null || !currentDoc) return;
    currentDoc = { ...currentDoc, cards: prev };
    canvasApi.refresh();
    schedulePersist();
  };

  const handleRedo = () => {
    const next = history.redo();
    if (next === null || !currentDoc) return;
    currentDoc = { ...currentDoc, cards: next };
    canvasApi.refresh();
    schedulePersist();
  };

  // ── 当前参考切换：先 flush，再加载 ────────────────────

  const updateSelectionVisibility = () => {
    canvasHost.hidden = currentDoc === null;
    emptyState.hidden = currentDoc !== null;
  };

  const selectReference = async (path: string | null, publishSelection = true): Promise<void> => {
    await persistNow();
    currentPath = path;
    if (path === null) {
      currentDoc = null;
    } else {
      if (!options.workspace && !freeReferenceTabs.includes(path)) freeReferenceTabs.push(path);
      try {
        currentDoc = await options.api.loadReference(path);
        history.reset([...currentDoc.cards]);
      } catch (error) {
        console.error('Sift: 加载参考失败', error);
        currentDoc = null;
        currentPath = null;
      }
    }
    updateSelectionVisibility();
    canvasApi.refresh();
    renderTabs();
    if (publishSelection) options.workspace?.setActiveReference(currentPath ?? undefined);
  };

  // ── Canvas（视图 + 交互） ─────────────────────────────

  const canvasApi = mountCanvas(canvasHost, {
    readCards: () => currentDoc?.cards ?? [],
    ...(options.readClipboard === undefined ? {} : { readClipboard: options.readClipboard }),
    onCardsChange: applyCardsChange,
    pasteBoundary: panel,
    isActive: () => currentDoc !== null,
    onCardEdit: (id: string) => {
      const card = currentDoc?.cards.find(c => c.id === id);
      if (!card || !currentDoc) return;
      triggerCardEdit(
        { content: card.content, source: card.source },
        async (content, source) => {
          if (!currentDoc) return;
          applyCardsChange(currentDoc.cards.map(c => c.id === id
            ? { ...c, content, ...(source ? { source } : { source: undefined }) }
            : c));
        },
      );
    },
    onCardOpenSource: uri => {
      void (async () => {
        try {
          await options.api.openSourcePath(uri);
        } catch (error) {
          canvasApi.notify(error instanceof Error ? error.message : '打开文件失败。');
        }
      })();
    },
  });

  // mountCanvas 成功后把 DOM 挂进 section；
  // 之前任何抛错都保持 section 干净，由调用方回落，避免拖垮三栏布局。
  panel.append(tabBar, canvasHost, emptyState);
  section.append(panel);
  updateSelectionVisibility();

  // layout.ts 创建的 section header（Reference Board / 当前有效参考）不再显示标题文字，
  // 引用管理的入口已移到 tab bar。
  section.querySelector('header')?.setAttribute('hidden', '');

  const disposeEditor = mountReferenceEditor();
  const disposeRefSelector = mountRefSelector();
  const disposeCardEditor = mountCardEditor({
    pickFilePath: async () => {
      const result = await options.api.pickSourceFiles();
      const path = result?.paths?.[0];
      return {
        ...(path === undefined ? {} : { path }),
        ...(result?.cancelled === true ? { cancelled: true } : {}),
        ...(result?.message === undefined ? {} : { message: result.message }),
      };
    },
  });

  // ── Ctrl+Z / Ctrl+Y 键盘监听 ─────────────────────
  // 只对焦点在参考面板内时生效；聊天框等外部可编辑区不拦截。

  const isEditableOutside = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return !panel.contains(target);
    return target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]') !== null && !panel.contains(target);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (!currentDoc) return;
    if (!panel.matches(':hover') && !panel.contains(document.activeElement)) return;
    if (isEditableOutside(event.target)) return;

    if (event.key === 'z') {
      event.preventDefault();
      handleUndo();
    } else if (event.key === 'y') {
      event.preventDefault();
      handleRedo();
    }
  };
  document.addEventListener('keydown', onKeydown);

  const refreshSummaries = async (): Promise<void> => {
    try {
      summaries = await options.api.listReferences();
    } catch (error) {
      console.error('Sift: 读取参考列表失败', error);
      summaries = [];
    }
  };

  const syncWorkspaceSelection = (): void => {
    if (!options.workspace) return;
    const snapshot = options.workspace.snapshot();
    const existing = new Set(summaries.map(item => item.path));
    const validVisible = snapshot.visibleReferences.filter(path => existing.has(path));
    const next = snapshot.activeReference && existing.has(snapshot.activeReference)
      ? snapshot.activeReference
      : validVisible[0];
    if (next !== snapshot.activeReference) options.workspace.setActiveReference(next);
    if ((next ?? null) !== currentPath) void selectReference(next ?? null, false);
  };

  // 启动时只扫描可选 Reference；创建和打开都由用户显式触发。
  const initialize = async (): Promise<void> => {
    await refreshSummaries();
    syncWorkspaceSelection();
    renderTabs();
  };

  // ── 启动 ──────────────────────────────────────────────

  void initialize();
  const disposeWorkspace = options.workspace?.subscribe(() => {
    syncWorkspaceSelection();
    renderTabs();
  });

  // ── 清理：flush → 销毁 ────────────────────────────────

  return () => {
    document.removeEventListener('keydown', onKeydown);
    disposeWorkspace?.();
    void persistNow(); // 尽力而为：dispose 前把挂起的修改写掉
    canvasApi.dispose();
    disposeEditor();
    disposeRefSelector();
    disposeCardEditor();
    disposePanelCss();
    panel.remove();
  };
}
