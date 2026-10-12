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
import { mountConversationView } from './conversation-view.js';
import type { CardReferenceDocument } from '../../references.js';

export interface ReferenceApi {
  listReferences(): Promise<ReferenceSummary[]>;
  loadReference(path: string): Promise<ReferenceDocument>;
  createReference(name?: string): Promise<{ path: string }>;
  importConversationReference(sourcePath: string): Promise<{ path: string }>;
  saveReference(path: string, reference: ReferenceDocument): Promise<void>;
  analyzeConversation(path: string, anchorGroupId: string, signal?: AbortSignal): Promise<ReferenceDocument>;
  analyzeConversationTopic(path: string, topic: string, signal?: AbortSignal): Promise<ReferenceDocument>;
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
  let disposeConversationView: (() => void) | undefined;
  let conversationAnalysisRunning = false;
  let conversationAnalysisTarget: { type: 'group'; groupId: string } | { type: 'topic'; topic: string } | undefined;
  let conversationAnalysisController: AbortController | undefined;
  let conversationAnalysisStartedAt: number | undefined;
  let conversationTopicDraft = '';
  const cardDocument = (): CardReferenceDocument | null => currentDoc && 'cards' in currentDoc ? currentDoc : null;
  // 当前工作区中"激活"的 Reference 路径；只有这些会出现在 Tab Bar。
  let freeReferenceTabs: string[] = [];
  const visiblePaths = (): string[] => options.workspace
    ? [...options.workspace.snapshot().visibleReferences]
    : [...freeReferenceTabs];

  // ── 文章参考工具栏 ──────────────────────────────────

  const toolbar = document.createElement('div');
  toolbar.dataset.siftArticleReferenceToolbar = '';

  const addExisting = () => {
    triggerRefSelector({
      all: summaries,
      checked: visiblePaths(),
      onSave: async selected => {
        const additions = selected.filter(path => !visiblePaths().includes(path));
        if (options.workspace) await options.workspace.addReferences(additions);
        else freeReferenceTabs = [...new Set([...freeReferenceTabs, ...additions])];
        const next = additions.at(-1) ?? selected.at(-1);
        if (next) await selectReference(next);
        renderToolbar();
      },
    });
  };

  const importConversation = () => {
    void (async () => {
      const selected = await options.api.pickSourceFiles();
      const sourcePath = selected.paths[0];
      if (!sourcePath) return;
      try {
        const { path } = await options.api.importConversationReference(sourcePath);
        await refreshSummaries();
        await options.workspace?.addReferences([path]);
        if (!options.workspace) freeReferenceTabs = [...new Set([...freeReferenceTabs, path])];
        await selectReference(path);
      } catch (error) {
        console.error('Sift: 导入会话失败', error);
        canvasApi.notify(error instanceof Error ? error.message : '导入会话失败。');
      }
    })();
  };

  const pasteIntoArticle = async () => {
    if (!cardDocument()) {
      try {
        const { path } = await options.api.createReference();
        await refreshSummaries();
        await options.workspace?.addReferences([path]);
        if (!options.workspace) freeReferenceTabs = [...new Set([...freeReferenceTabs, path])];
        await selectReference(path);
      } catch (error) {
        canvasApi.notify(error instanceof Error ? error.message : '创建文章参考失败。');
        return;
      }
    }
    canvasApi.addFromClipboard();
  };

  const editCurrent = () => {
    if (!currentDoc) return;
    triggerEdit(currentDoc.name, currentDoc.description, async (name, description) => {
      if (!currentDoc || !currentPath) return;
      currentDoc = { ...currentDoc, name, description };
      const summary = summaries.find(item => item.path === currentPath);
      if (summary) summary.name = name;
      schedulePersist(); renderToolbar();
    });
  };

  const deleteCurrent = () => {
    if (!currentDoc || !currentPath || deleting) return;
    const path = currentPath; const name = currentDoc.name;
    const confirmed = options.confirmDelete?.(name)
      ?? window.confirm(`删除参考“${name}”？\n\n这会永久删除该参考及其中的全部内容，并从相关文章中移除。此操作无法撤销。`);
    if (!confirmed) return;
    void (async () => {
      deleting = true; renderToolbar();
      try {
        await persistNow(); await options.api.removeReference(path);
        freeReferenceTabs = freeReferenceTabs.filter(item => item !== path);
        summaries = summaries.filter(item => item.path !== path);
        options.workspace?.forgetReference(path);
        currentPath = null; currentDoc = null; history.reset([]);
        const next = options.workspace?.snapshot().activeReference ?? visiblePaths()[0];
        if (next) await selectReference(next); else { updateSelectionVisibility(); canvasApi.refresh(); }
      } catch (error) {
        canvasApi.notify(error instanceof Error ? error.message : '删除参考失败。');
      } finally { deleting = false; renderToolbar(); }
    })();
  };

  const menuButton = (label: string, action: () => void, dataName?: string) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    if (dataName) button.dataset[dataName] = '';
    button.addEventListener('click', action); return button;
  };

  const renderToolbar = () => {
    toolbar.replaceChildren();
    const visible = summaries.filter(item => visiblePaths().includes(item.path));
    if (visible.length > 1) {
      const select = document.createElement('select'); select.dataset.siftReferenceSwitch = ''; select.setAttribute('aria-label', '当前参考内容');
      for (const summary of visible) {
        const option = document.createElement('option'); option.value = summary.path; option.textContent = summary.name; option.selected = summary.path === currentPath; select.appendChild(option);
      }
      select.addEventListener('change', () => { void selectReference(select.value); }); toolbar.appendChild(select);
    } else if (visible.length === 1 && currentDoc) {
      const name = document.createElement('span'); name.dataset.siftReferenceName = ''; name.textContent = currentDoc.name; toolbar.appendChild(name);
    }
    const spacer = document.createElement('span'); spacer.dataset.siftReferenceToolbarSpacer = ''; toolbar.appendChild(spacer);
    const add = document.createElement('details'); add.dataset.siftReferenceAddMenu = '';
    const addSummary = document.createElement('summary'); addSummary.textContent = '＋ 添加参考'; add.appendChild(addSummary);
    const addItems = document.createElement('div'); addItems.dataset.siftReferenceMenu = '';
    addItems.append(menuButton('粘贴剪贴板内容', () => { add.open = false; void pasteIntoArticle(); }, 'siftPasteReference'));
    addItems.append(menuButton('添加已有材料', () => { add.open = false; addExisting(); }, 'siftAddExisting'));
    addItems.append(menuButton('导入会话', () => { add.open = false; importConversation(); }, 'siftImportConversation'));
    add.appendChild(addItems); toolbar.appendChild(add);
    if (currentDoc) {
      const manage = document.createElement('details'); manage.dataset.siftReferenceManageMenu = '';
      const manageSummary = document.createElement('summary'); manageSummary.textContent = '⋯'; manageSummary.setAttribute('aria-label', '管理当前参考'); manage.appendChild(manageSummary);
      const manageItems = document.createElement('div'); manageItems.dataset.siftReferenceMenu = '';
      manageItems.append(menuButton('重命名', () => { manage.open = false; editCurrent(); }, 'siftRenameReference'));
      const deleteButton = menuButton('删除', () => { manage.open = false; deleteCurrent(); }, 'siftDeleteReference');
      deleteButton.dataset.siftDeleteReference = '';
      manageItems.append(deleteButton);
      manage.appendChild(manageItems); toolbar.appendChild(manage);
    }
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

  const conversationHost = document.createElement('div');
  conversationHost.dataset.siftConversationHost = '';

  const emptyState = document.createElement('div');
  emptyState.dataset.siftRefEmpty = '';
  const emptyTitle = document.createElement('strong'); emptyTitle.textContent = '暂无参考';
  const emptyHint = document.createElement('span'); emptyHint.textContent = '粘贴内容，或从已有材料和会话开始';
  const emptyPrimary = menuButton('粘贴剪贴板内容', () => { void pasteIntoArticle(); }, 'siftEmptyPaste');
  emptyPrimary.dataset.siftEmptyPaste = '';
  const emptyLinks = document.createElement('div'); emptyLinks.dataset.siftReferenceEmptyLinks = '';
  emptyLinks.append(menuButton('添加已有材料', addExisting, 'siftEmptyExisting'), menuButton('导入会话', importConversation, 'siftEmptyConversation'));
  emptyState.append(emptyTitle, emptyHint, emptyPrimary, emptyLinks);

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
    const card = cardDocument();
    if (!card) return;
    history.record([...next]);
    currentDoc = { ...card, cards: [...next] };
    canvasApi.refresh();
    schedulePersist();
  };

  const handleUndo = () => {
    const prev = history.undo();
    const card = cardDocument();
    if (prev === null || !card) return;
    currentDoc = { ...card, cards: prev };
    canvasApi.refresh();
    schedulePersist();
  };

  const handleRedo = () => {
    const next = history.redo();
    const card = cardDocument();
    if (next === null || !card) return;
    currentDoc = { ...card, cards: next };
    canvasApi.refresh();
    schedulePersist();
  };

  // ── 当前参考切换：先 flush，再加载 ────────────────────

  /** 执行一次可取消的会话分析，并在失败时保留当前文档中的旧分析。 */
  const runConversationAnalysis = async (
    target: { type: 'group'; groupId: string } | { type: 'topic'; topic: string },
  ): Promise<void> => {
    if (!currentPath || conversationAnalysisRunning) return;
    const path = currentPath;
    const controller = new AbortController();
    let timedOut = false;
    conversationAnalysisRunning = true;
    conversationAnalysisTarget = target;
    conversationAnalysisController = controller;
    conversationAnalysisStartedAt = Date.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    updateSelectionVisibility();
    try {
      const next = target.type === 'group'
        ? await options.api.analyzeConversation(path, target.groupId, controller.signal)
        : await options.api.analyzeConversationTopic(path, target.topic, controller.signal);
      if (conversationAnalysisController === controller && currentPath === path) currentDoc = next;
    } catch (error) {
      if (timedOut) {
        canvasApi.notify('分析已超时（60 秒），已保留上一次结果。');
      } else if (controller.signal.aborted) {
        canvasApi.notify('已取消分析，已保留上一次结果。');
      } else {
        const message = error instanceof Error ? error.message : target.type === 'group' ? '会话关联分析失败。' : '会话主题分析失败。';
        canvasApi.notify(`${message} 已保留上一次结果。`);
      }
    } finally {
      clearTimeout(timeout);
      if (conversationAnalysisController === controller) {
        conversationAnalysisRunning = false;
        conversationAnalysisTarget = undefined;
        conversationAnalysisController = undefined;
        conversationAnalysisStartedAt = undefined;
        updateSelectionVisibility();
      }
    }
  };

  const updateSelectionVisibility = () => {
    const isConversation = currentDoc !== null && 'kind' in currentDoc && currentDoc.kind === 'conversation';
    canvasHost.hidden = currentDoc === null || isConversation;
    conversationHost.hidden = !isConversation;
    emptyState.hidden = currentDoc !== null;
    disposeConversationView?.();
    disposeConversationView = undefined;
    if (isConversation && currentDoc && 'groups' in currentDoc) {
      disposeConversationView = mountConversationView(conversationHost, currentDoc, next => {
        currentDoc = next;
        schedulePersist();
        updateSelectionVisibility();
      }, anchorGroupId => {
        return runConversationAnalysis({ type: 'group', groupId: anchorGroupId });
      }, topic => {
        return runConversationAnalysis({ type: 'topic', topic });
      }, conversationAnalysisRunning, conversationAnalysisTarget, conversationTopicDraft, value => {
        conversationTopicDraft = value;
      }, conversationAnalysisStartedAt, () => conversationAnalysisController?.abort());
    } else {
      conversationHost.replaceChildren();
    }
  };

  const selectReference = async (path: string | null, publishSelection = true): Promise<void> => {
    conversationAnalysisController?.abort();
    await persistNow();
    currentPath = path;
    if (path === null) {
      currentDoc = null;
    } else {
      if (!options.workspace && !freeReferenceTabs.includes(path)) freeReferenceTabs.push(path);
      try {
        currentDoc = await options.api.loadReference(path);
        conversationTopicDraft = 'kind' in currentDoc && currentDoc.kind === 'conversation'
          ? currentDoc.analysis?.topic ?? ''
          : '';
        history.reset('cards' in currentDoc ? [...currentDoc.cards] : []);
      } catch (error) {
        console.error('Sift: 加载参考失败', error);
        currentDoc = null;
        currentPath = null;
      }
    }
    updateSelectionVisibility();
    if (currentDoc && currentPath) {
      panel.dataset.annotationUri = currentPath;
      panel.dataset.annotationTitle = currentDoc.name;
    } else {
      delete panel.dataset.annotationUri;
      delete panel.dataset.annotationTitle;
    }
    canvasApi.refresh();
    renderToolbar();
    if (publishSelection) options.workspace?.setActiveReference(currentPath ?? undefined);
  };

  // ── Canvas（视图 + 交互） ─────────────────────────────

  const canvasApi = mountCanvas(canvasHost, {
    readCards: () => cardDocument()?.cards ?? [],
    ...(options.readClipboard === undefined ? {} : { readClipboard: options.readClipboard }),
    onCardsChange: applyCardsChange,
    pasteBoundary: panel,
    isActive: () => currentDoc !== null,
    onCardEdit: (id: string) => {
      const document = cardDocument();
      const card = document?.cards.find(c => c.id === id);
      if (!card || !document) return;
      triggerCardEdit(
        { content: card.content, source: card.source },
        async (content, source) => {
          const latest = cardDocument();
          if (!latest) return;
          applyCardsChange(latest.cards.map(c => c.id === id
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
  panel.append(toolbar, canvasHost, conversationHost, emptyState);
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
  const onEmptyPaste = (event: ClipboardEvent) => {
    if (currentDoc || !panel.matches(':hover')) return;
    event.preventDefault(); void pasteIntoArticle();
  };
  document.addEventListener('paste', onEmptyPaste);

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
    renderToolbar();
  };

  // ── 启动 ──────────────────────────────────────────────

  void initialize();
  const disposeWorkspace = options.workspace?.subscribe(() => {
    syncWorkspaceSelection();
    renderToolbar();
  });

  // ── 清理：flush → 销毁 ────────────────────────────────

  return () => {
    conversationAnalysisController?.abort();
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('paste', onEmptyPaste);
    disposeWorkspace?.();
    disposeConversationView?.();
    void persistNow(); // 尽力而为：dispose 前把挂起的修改写掉
    canvasApi.dispose();
    disposeEditor();
    disposeRefSelector();
    disposeCardEditor();
    disposePanelCss();
    panel.remove();
  };
}
