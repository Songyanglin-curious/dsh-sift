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
 * 关联本文档（多选 + relations.json）在 Step 4 接入。
 */

import panelCss from './panel.css?inline';
import { mountCanvas } from '../renderer/canvas.js';
import { injectStyle, SIFT_PLUGIN_ID } from '../renderer/inject-style.js';
import { mountReferenceEditor, triggerEdit } from './reference-edit.js';
import { mountCardEditor, triggerCardEdit } from '../renderer/card-edit.js';
import { createHistory } from './history.js';
import type { ReferenceCardData } from '../renderer/card.js';
import type { ClipboardSnapshot } from '../../host/clipboard/index.js';
import type { ReferenceDocument, ReferenceSummary } from '../../references.js';

export interface ReferenceApi {
  listReferences(): Promise<ReferenceSummary[]>;
  loadReference(path: string): Promise<ReferenceDocument>;
  createReference(name?: string): Promise<{ path: string }>;
  saveReference(path: string, reference: ReferenceDocument): Promise<void>;
  /** Host 的原生文件对话框（多选）；卡片来源只取第一个路径。 */
  pickSourceFiles(): Promise<{ paths: readonly string[]; cancelled: boolean; message?: string }>;
  /** 在本机打开一个文件；失败时抛出可读错误。 */
  openSourcePath(path: string): Promise<void>;
}

export interface ReferencePanelOptions {
  readonly api: ReferenceApi;
  /** Host 端剪贴板读取（Remote 代理），透传给 Canvas。 */
  readonly readClipboard?: () => Promise<ClipboardSnapshot>;
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

  // ── Tab Bar ────────────────────────────────────────

  const tabBar = document.createElement('div');
  tabBar.dataset.siftRefTabs = '';

  const renderTabs = () => {
    tabBar.replaceChildren();

    for (const summary of summaries) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sift-ref-tab';
      if (summary.path === currentPath) btn.dataset.active = '';
      btn.title = summary.name;
      btn.textContent = summary.name;
      btn.addEventListener('click', () => {
        if (summary.path !== currentPath) void selectReference(summary.path);
      });
      tabBar.appendChild(btn);
    }

    // spacer —— 把操作按钮推到右侧
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;min-width:8px';
    tabBar.appendChild(spacer);

    // ✎ 编辑当前参考
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.dataset.siftRefEdit = '';
    editBtn.title = '编辑参考名称与描述';
    editBtn.textContent = '✎';
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
    tabBar.appendChild(editBtn);

    // ＋ 新建
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.dataset.siftRefAdd = '';
    addBtn.title = '新建参考';
    addBtn.textContent = '＋';
    addBtn.addEventListener('click', () => {
      addBtn.blur();
      void (async () => {
        try {
          const { path } = await options.api.createReference();
          await refreshSummaries();
          renderTabs();
          await selectReference(path);
        } catch (error) {
          console.error('Sift: 新建参考失败', error);
        }
      })();
    });
    tabBar.appendChild(addBtn);
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
  };

  const selectReference = async (path: string | null): Promise<void> => {
    await persistNow();
    currentPath = path;
    if (path === null) {
      currentDoc = null;
    } else {
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
  panel.append(tabBar, canvasHost);
  section.append(panel);

  // layout.ts 创建的 section header（Reference Board / 当前有效参考）不再显示标题文字，
  // 引用管理的入口已移到 tab bar。
  section.querySelector('header')?.setAttribute('hidden', '');

  const disposeEditor = mountReferenceEditor();
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

  // 新建：若无参考则自动创建，有则选第一个
  const autoSelectFirst = async (): Promise<void> => {
    await refreshSummaries();
    if (summaries.length > 0 && currentPath === null) {
      await selectReference(summaries[0]!.path);
    } else if (summaries.length === 0 && currentPath === null) {
      try {
        const { path } = await options.api.createReference();
        await refreshSummaries();
        await selectReference(path);
      } catch (error) {
        console.error('Sift: 新建参考失败', error);
      }
    }
  };

  // ── 启动 ──────────────────────────────────────────────

  void autoSelectFirst();

  // ── 清理：flush → 销毁 ────────────────────────────────

  return () => {
    document.removeEventListener('keydown', onKeydown);
    void persistNow(); // 尽力而为：dispose 前把挂起的修改写掉
    canvasApi.dispose();
    disposeEditor();
    disposeCardEditor();
    disposePanelCss();
    panel.remove();
  };
}
