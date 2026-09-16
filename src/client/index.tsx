import { useEffect, useSyncExternalStore, useState, useRef } from 'react';
import type { ComponentType } from 'react';
import { TYPERT_REMOTE } from '../remote.js';
import type { DocumentsApi } from '../documents.js';
import type { SourcesApi } from '../sources.js';
import { mountDocumentEditor } from './document-editor.js';
import creatorCss from './workspace-creator.css?inline';
import { registerInputTriggerSource, type InputTriggerServiceContract } from './dsh-adapter/input-trigger.js';
import { mountThreeColumn, type ColumnSpec } from './dsh-adapter/layout.js';
import { findConversationCenter, findWorkspaceAddButton } from './dsh-adapter/selectors.js';
import {
  createLatestProfileReader,
  layoutStorageKey,
  resolveCurrentWorkspace,
  shouldEnableSift,
  type ProfileResult,
  type SessionSnapshot,
  type WorkspaceSnapshot,
  type WorkspaceView,
} from './dsh-adapter/workspace-entry.js';
import { mountReferencePanel } from './reference/panel.js';
import { createSiftReferenceSource } from './reference/source.js';
import type { SiftReferenceRecord } from './reference/codec.js';

interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }

interface SiftRemote {
  getWorkspaceProfile(input: { workspaceId: string }): Promise<ProfileResult>;
  setWorkspaceProfile(input: { workspaceId: string; profile: 'default' | 'sift' }): Promise<ProfileResult>;
  listDocuments: DocumentsApi['listDocuments'];
  saveDocument: DocumentsApi['saveDocument'];
  readDocumentContent: DocumentsApi['readDocumentContent'];
  removeDocument: DocumentsApi['removeDocument'];
  listSources: SourcesApi['listSources'];
  addSource: SourcesApi['addSource'];
  addExternalFiles: SourcesApi['addExternalFiles'];
  pickSourceFiles: SourcesApi['pickSourceFiles'];
  removeSource: SourcesApi['removeSource'];
  createSourceFile: SourcesApi['createSourceFile'];
  browseWorkspace: SourcesApi['browseWorkspace'];
  browseExternal: SourcesApi['browseExternal'];
}

interface ClientContext {
  slots: { inject(name: string, factory: () => unknown): unknown; register(options: { name: string; id?: string; key?: string; order?: number }, component: ComponentType): () => void }
  workspaces?: { list: Source<WorkspaceSnapshot>; create(input: { path: string }): Promise<WorkspaceView> }
  sessions?: { list: Source<SessionSnapshot> }
  uiWorkspace?: { pickDirectory(): Promise<string | null>; openWorkspace(workspaceId: string): Promise<void> }
  inputTriggers?: InputTriggerServiceContract
  remote: { $mount(contribution: typeof TYPERT_REMOTE): Promise<() => void | Promise<void>>; sift?: SiftRemote }
  get?(name: string): unknown
  effect?(factory: () => () => void | Promise<void>, label?: string): unknown
  startupError?: string
}

/**
 * Phase 0 spike：硬编码三条参考，只用于验证
 * `@参考` → chip → codec.serialize → 模型收到正文 这条通道。
 * Phase 5 接入真正的 Reference Board 后整体删除。
 */
const SPIKE_RECORDS: readonly SiftReferenceRecord[] = [
  { id: 'R1', label: 'Workspace 与实际目录绑定', content: 'Workspace 注册的是已有目录，不复制文件。', sourceTitle: 'architecture.md', locator: 'L120-L150' },
  { id: 'R2', label: '相同路径复用已有 Workspace', content: '同一规范化路径只会有一条 Workspace 记录。', sourceTitle: 'workspace.ts', locator: 'L42' },
  { id: 'R3', label: '删除 Workspace 不删除目录', content: '移除登记关系不会触碰磁盘上的目录。', sourceTitle: 'workspace.ts', locator: 'L88' },
];

/** Sift 三栏：左 Reference Board、中 Document、右原生对话。 */
const SIFT_COLUMNS: readonly [ColumnSpec, ColumnSpec] = [
  { id: 'reference', label: '参考', title: 'Reference Board', description: '当前有效参考' },
  { id: 'document', label: '文档', title: 'Document', description: 'Markdown 正文' },
];

function noopSubscribe() { return () => {} }
function emptyWorkspaces(): WorkspaceSnapshot { return { items: [], phase: 'pending' } }
function emptySessions(): SessionSnapshot { return { phase: 'pending' } }

function WorkspaceProfileBadge({ ctx }: { ctx: ClientContext }) {
  const workspaces = ctx.workspaces?.list;
  const sessions = ctx.sessions?.list;
  const workspaceSnapshot = useSyncExternalStore(workspaces ? listener => workspaces.subscribe(listener) : noopSubscribe, workspaces ? () => workspaces.getSnapshot() : emptyWorkspaces);
  const sessionSnapshot = useSyncExternalStore(sessions ? listener => sessions.subscribe(listener) : noopSubscribe, sessions ? () => sessions.getSnapshot() : emptySessions);
  const workspace = resolveCurrentWorkspace(workspaceSnapshot, sessionSnapshot);
  const [state, setState] = useState<{ id?: string; result?: ProfileResult; loading: boolean }>({ loading: false });
  const latestReader = useRef<ReturnType<typeof createLatestProfileReader> | undefined>(undefined);

  useEffect(() => {
    let active = true;
    if (!workspace) {
      setState({ loading: false });
      return () => { active = false };
    }
    setState({ id: workspace.workspaceId, loading: true });
    const reader = ctx.remote?.sift?.getWorkspaceProfile;
    if (!reader) {
      setState({ id: workspace.workspaceId, result: { workspaceId: workspace.workspaceId, title: workspace.title, profile: 'default', status: 'invalid', message: ctx.startupError ?? '工作区类型服务不可用。' }, loading: false });
      return () => { active = false };
    }
    latestReader.current ??= createLatestProfileReader(id => reader({ workspaceId: id }));
    void latestReader.current(workspace.workspaceId).then(result => {
      if (active && result) setState({ id: workspace.workspaceId, result, loading: false });
    }, error => {
      if (active) setState({ id: workspace.workspaceId, result: { workspaceId: workspace.workspaceId, title: workspace.title, profile: 'default', status: 'invalid', message: error instanceof Error ? error.message : '工作区类型读取失败。' }, loading: false });
    });
    return () => { active = false };
  }, [ctx, workspace?.workspaceId, workspace?.title]);

  if (!workspace || workspaceSnapshot.phase !== 'ready' || sessionSnapshot.phase === 'pending') return <span data-dsh-sift-profile="unselected">未选择工作区</span>;
  if (state.id !== workspace.workspaceId || state.loading) return <span data-dsh-sift-profile="loading">正在读取工作区…</span>;
  const result = state.result;
  return <span data-dsh-sift-profile={result?.status === 'invalid' ? 'invalid' : result?.profile ?? 'default'} title={result?.message}>{workspace.title} · {result?.profile ?? 'default'}{result?.message ? `（${result.message}）` : ''}</span>;
}

/**
 * 工作区类型选择入口的接管。
 *
 * 不修改、不移动原生"添加工作区"按钮（克隆插入曾造成按钮位移并与 React
 * 重渲染冲突）：在按钮正上方覆盖一个同尺寸的透明点击层（fixed 定位，
 * JS 实时同步按钮矩形）承接点击与回车/空格，再弹出类型选择对话框。
 * 原生按钮保持原位，布局零影响。
 */
export function installWorkspaceTypeCreator(ctx: ClientContext, setProfile: (input: { workspaceId: string; profile: 'default' | 'sift' }) => Promise<ProfileResult>): () => void {
  let nativeButton: HTMLButtonElement | undefined;
  let layer: HTMLDivElement | undefined;
  let overlay: HTMLElement | undefined;
  /** 弹窗级监听（Escape）随弹窗关闭而清理。 */
  let overlayCleanup: AbortController | undefined;
  /** 安装级全局监听（scroll/resize）的统一清理。 */
  const globalCleanup = new AbortController();
  /** 接管级监听（按钮 keydown）随按钮更换而清理。 */
  let attachCleanup: AbortController | undefined;

  const close = () => {
    overlayCleanup?.abort();
    overlayCleanup = undefined;
    overlay?.remove();
    overlay = undefined;
  };
  const show = () => {
    close();
    let profile: 'default' | 'sift' = 'sift';
    overlay = document.createElement('div');
    overlay.dataset.siftWorkspaceCreator = '';
    overlay.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="sift-create-title" data-sift-dialog><header><strong id="sift-create-title">创建工作区</strong><button type="button" data-action="close" aria-label="关闭">×</button></header><p>选择这个工作区使用的类型。</p><div class="types"><button type="button" data-profile="default"><strong>default</strong><small>保持原生单栏对话界面</small></button><button type="button" data-profile="sift" data-selected><strong>sift</strong><small>启用参考、文档、对话三栏界面</small></button></div><div data-error role="alert"></div><footer><button type="button" data-action="cancel">取消</button><button type="button" data-action="create">选择目录并创建</button></footer></div>`;
    document.body.appendChild(overlay);
    const select = (next: 'default' | 'sift') => {
      profile = next;
      overlay?.querySelectorAll('[data-profile]').forEach(node => node.toggleAttribute('data-selected', (node as HTMLElement).dataset.profile === next));
    };
    overlay.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach(button => button.addEventListener('click', () => select(button.dataset.profile as 'default' | 'sift')));
    overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
    overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    overlayCleanup = new AbortController();
    document.addEventListener('keydown', escape, { signal: overlayCleanup.signal });
    overlay.querySelector<HTMLButtonElement>('[data-action="create"]')?.addEventListener('click', async event => {
      const submit = event.currentTarget as HTMLButtonElement;
      const errorNode = overlay?.querySelector<HTMLElement>('[data-error]');
      submit.disabled = true; if (errorNode) errorNode.textContent = '';
      try {
        const path = await ctx.uiWorkspace?.pickDirectory();
        if (!path) { submit.disabled = false; return; }
        if (!ctx.workspaces) throw new Error('工作区服务不可用。');
        const workspace = await ctx.workspaces.create({ path });
        const result = await setProfile({ workspaceId: workspace.workspaceId, profile });
        if (result.status !== 'ready') throw new Error(result.message ?? '工作区类型保存失败。');
        close();
        await ctx.uiWorkspace?.openWorkspace(workspace.workspaceId);
      } catch (error) {
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : '创建工作区失败。';
        submit.disabled = false;
      }
    });
  };
  const positionLayer = () => {
    if (!layer || !nativeButton?.isConnected) return;
    const rect = nativeButton.getBoundingClientRect();
    layer.style.left = `${rect.left}px`;
    layer.style.top = `${rect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    layer.style.display = rect.width === 0 || rect.height === 0 ? 'none' : 'block';
  };
  const detach = () => {
    attachCleanup?.abort();
    attachCleanup = undefined;
    // 只有按钮还活着时才摘标记；React 重建后旧节点引用已无意义。
    if (nativeButton?.isConnected) delete nativeButton.dataset.siftCreatorLayer;
    nativeButton = undefined;
    layer?.remove();
    layer = undefined;
  };
  const attach = (button: HTMLButtonElement) => {
    nativeButton = button;
    button.dataset.siftCreatorLayer = '';
    attachCleanup = new AbortController();
    layer = document.createElement('div');
    layer.dataset.siftCreateLayer = '';
    layer.setAttribute('role', 'button');
    layer.setAttribute('aria-label', '添加工作区（选择类型）');
    layer.addEventListener('click', show, { signal: attachCleanup.signal });
    // 键盘焦点仍落在原生按钮上：拦下 Enter/Space，避免绕过类型选择直接走原生目录流程。
    button.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      show();
    }, { signal: attachCleanup.signal });
    document.body.appendChild(layer);
    positionLayer();
  };
  const reconcile = () => {
    const found = findWorkspaceAddButton();
    if (!found) { detach(); return; }
    if (found === nativeButton) { positionLayer(); return; }
    // 已被某次接管占用（HMR 重复 apply 的防重入），等持有方自己释放。
    if (found.dataset.siftCreatorLayer !== undefined) return;
    detach();
    attach(found);
  };

  const style = document.createElement('style');
  style.dataset.siftCreator = '';
  style.textContent = creatorCss;
  document.head.appendChild(style);
  const observer = new MutationObserver(reconcile);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('scroll', positionLayer, { capture: true, passive: true, signal: globalCleanup.signal });
  window.addEventListener('resize', positionLayer, { passive: true, signal: globalCleanup.signal });
  reconcile();
  return () => {
    globalCleanup.abort();
    observer.disconnect();
    detach();
    style.remove();
    close();
  };
}

export const inject = ['slots', 'workspaces', 'sessions', 'remote', 'uiWorkspace', 'inputTriggers'];

export function apply(ctx: ClientContext): void {
  type MountedRemote = { [K in keyof SiftRemote]: (input: Parameters<SiftRemote[K]>[0]) => Promise<Awaited<ReturnType<SiftRemote[K]>> | { ok: true; value: Awaited<ReturnType<SiftRemote[K]>> }> };
  const mounted = (async (): Promise<MountedRemote> => {
    const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
    ctx.effect?.(() => disposeRemote, 'sift: workspace profile remote');
    const remote = ctx.get?.('remote.sift') as MountedRemote | undefined;
    if (!remote) throw new Error('Sift Remote 已挂载，但服务不可用。');
    return remote;
  })();
  const unwrap = <T extends object>(result: T | { ok: true; value: T }): T => 'ok' in result ? (result as { ok: true; value: T }).value : result;
  const documentsApi: DocumentsApi = {
    listDocuments: async input => unwrap(await (await mounted).listDocuments(input)),
    saveDocument: async input => unwrap(await (await mounted).saveDocument(input)),
    readDocumentContent: async input => unwrap(await (await mounted).readDocumentContent(input)),
    removeDocument: async input => unwrap(await (await mounted).removeDocument(input)),
  };
  const sourcesApi: SourcesApi = {
    listSources: async input => unwrap(await (await mounted).listSources(input)),
    addSource: async input => unwrap(await (await mounted).addSource(input)),
    addExternalFiles: async input => unwrap(await (await mounted).addExternalFiles({ workspaceId: input.workspaceId, paths: [...input.paths] })),
    pickSourceFiles: async input => unwrap(await (await mounted).pickSourceFiles(input)),
    removeSource: async input => unwrap(await (await mounted).removeSource(input)),
    createSourceFile: async input => unwrap(await (await mounted).createSourceFile(input)),
    browseWorkspace: async input => unwrap(await (await mounted).browseWorkspace(input)),
    browseExternal: async input => unwrap(await (await mounted).browseExternal(input)),
  };
  const remoteContext = { ...ctx, remote: { sift: {
    getWorkspaceProfile: async (input: { workspaceId: string }) => unwrap(await (await mounted).getWorkspaceProfile(input)),
    setWorkspaceProfile: async (input: { workspaceId: string; profile: 'default' | 'sift' }) => unwrap(await (await mounted).setWorkspaceProfile(input)),
    ...documentsApi,
  } } } as ClientContext;

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'sift-workspace-profile', order: 90 }, () => <WorkspaceProfileBadge ctx={remoteContext} />));
  if (ctx.inputTriggers) {
    registerInputTriggerSource(
      { inputTriggers: ctx.inputTriggers, effect: ctx.effect },
      createSiftReferenceSource(() => SPIKE_RECORDS),
    );
  }
  if (typeof document === 'undefined') return;

  const disposeCreator = installWorkspaceTypeCreator(ctx, input => remoteContext.remote.sift!.setWorkspaceProfile(input));
  ctx.effect?.(() => disposeCreator, 'sift: workspace type creator');

  let generation = 0;
  let mountedCenter: HTMLElement | null = null;
  let activeWorkspaceId: string | undefined;
  let disposeLayout: (() => void) | undefined;
  const latestProfile = createLatestProfileReader(id => remoteContext.remote.sift!.getWorkspaceProfile({ workspaceId: id }));

  const clearLayout = () => {
    disposeLayout?.();
    disposeLayout = undefined;
    mountedCenter = null;
    activeWorkspaceId = undefined;
  };

  const showLayout = (workspace: WorkspaceView) => {
    // 关键 DOM 锚点不存在时放弃启用三栏，而不是继续重排页面（实施文档 §7.2）。
    const center = findConversationCenter();
    if (!center) {
      console.error('Sift: 未找到 DSH center column 锚点，已跳过三栏布局。');
      clearLayout();
      return;
    }
    if (mountedCenter === center && activeWorkspaceId === workspace.workspaceId) return;
    clearLayout();
    mountedCenter = center;
    activeWorkspaceId = workspace.workspaceId;
    disposeLayout = mountThreeColumn(center, {
      columns: SIFT_COLUMNS,
      storageKey: layoutStorageKey(workspace.workspaceId),
      mount: (id, section) => id === 'reference'
        ? mountReferencePanel(section, {
          workspaceId: workspace.workspaceId,
          sources: sourcesApi,
          ...(ctx.uiWorkspace?.pickDirectory === undefined ? {} : { pickDirectory: () => ctx.uiWorkspace!.pickDirectory() }),
        })
        : mountDocumentEditor(section, { workspaceId: workspace.workspaceId, api: documentsApi }),
    });
  };

  const reconcile = async () => {
    const request = ++generation;
    const workspace = resolveCurrentWorkspace(ctx.workspaces?.list.getSnapshot(), ctx.sessions?.list.getSnapshot());
    if (!workspace) { clearLayout(); return; }
    try {
      const profile = await latestProfile(workspace.workspaceId);
      if (request !== generation) return;
      if (shouldEnableSift(profile)) showLayout(workspace);
      else clearLayout();
    } catch { if (request === generation) clearLayout(); }
  };

  const disposeWorkspaces = ctx.workspaces?.list.subscribe(() => { void reconcile(); });
  const disposeSessions = ctx.sessions?.list.subscribe(() => { void reconcile(); });
  ctx.effect?.(() => () => { disposeWorkspaces?.(); disposeSessions?.(); clearLayout(); }, 'sift: native conversation three-column layout');
  void reconcile();
}

export { WorkspaceProfileBadge };
