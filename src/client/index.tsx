import { useEffect, useSyncExternalStore, useState, useRef } from 'react';
import type { ComponentType } from 'react';
import { TYPERT_REMOTE } from '../remote.js';
import { mountDocumentEditor } from './document-editor.js';

interface WorkspaceView { workspaceId: string; title: string; sessionIds: readonly string[] }
interface WorkspaceSnapshot { items: readonly WorkspaceView[]; phase: 'pending' | 'ready' }
interface SessionSnapshot { current?: string; phase?: 'pending' | 'ready'; sessions?: readonly { id: string }[] }
interface ProfileResult { workspaceId: string; title: string; profile: 'default' | 'sift'; status: 'ready' | 'missing' | 'invalid'; message?: string }
interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface LayoutState { widths: [number, number, number]; collapsed: [boolean, boolean, boolean] }
interface ClientContext {
  slots: { inject(name: string, factory: () => unknown): unknown; register(options: { name: string; id?: string; key?: string; order?: number }, component: ComponentType): () => void }
  workspaces?: { list: Source<WorkspaceSnapshot>; create(input: { path: string }): Promise<WorkspaceView> }
  sessions?: { list: Source<SessionSnapshot> }
  uiWorkspace?: { pickDirectory(): Promise<string | null>; openWorkspace(workspaceId: string): Promise<void> }
  remote: { $mount(contribution: typeof TYPERT_REMOTE): Promise<() => void | Promise<void>>; sift?: { getWorkspaceProfile(input: { workspaceId: string }): Promise<ProfileResult>; setWorkspaceProfile(input: { workspaceId: string; profile: 'default' | 'sift' }): Promise<ProfileResult> } }
  get?(name: string): unknown
  effect?(factory: () => () => void | Promise<void>, label?: string): unknown
  startupError?: string
}

export function createLatestProfileReader(reader: (workspaceId: string) => Promise<ProfileResult>) {
  let generation = 0;
  return async (workspaceId: string): Promise<ProfileResult | undefined> => {
    const request = ++generation;
    const result = await reader(workspaceId);
    return request === generation ? result : undefined;
  };
}

function WorkspaceProfileBadge({ ctx }: { ctx: ClientContext }) {
  const workspaces = ctx.workspaces?.list;
  const sessions = ctx.sessions?.list;
  const workspaceSnapshot = useSyncExternalStore(workspaces ? listener => workspaces.subscribe(listener) : noopSubscribe, workspaces ? () => workspaces.getSnapshot() : emptyWorkspaces);
  const sessionSnapshot = useSyncExternalStore(sessions ? listener => sessions.subscribe(listener) : noopSubscribe, sessions ? () => sessions.getSnapshot() : emptySessions);
  const currentId = sessionSnapshot.current;
  const workspace = currentId === undefined ? undefined : workspaceSnapshot.items.find(item => item.sessionIds.includes(currentId));
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
  }, [ctx, currentId, workspace?.workspaceId, workspace?.title]);

  if (!workspace || workspaceSnapshot.phase !== 'ready' || sessionSnapshot.phase === 'pending') return <span data-dsh-sift-profile="unselected">未选择工作区</span>;
  if (state.id !== workspace.workspaceId || state.loading) return <span data-dsh-sift-profile="loading">正在读取工作区…</span>;
  const result = state.result;
  return <span data-dsh-sift-profile={result?.status === 'invalid' ? 'invalid' : result?.profile ?? 'default'} title={result?.message}>{workspace.title} · {result?.profile ?? 'default'}{result?.message ? `（${result.message}）` : ''}</span>;
}

function noopSubscribe() { return () => {} }
function emptyWorkspaces(): WorkspaceSnapshot { return { items: [], phase: 'pending' } }
function emptySessions(): SessionSnapshot { return { phase: 'pending' } }

const DEFAULT_LAYOUT: LayoutState = { widths: [280, 480, 520], collapsed: [false, false, false] };
const MIN_WIDTHS: [number, number, number] = [220, 320, 360];
const COLLAPSED_WIDTH = 0;

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

function installWorkspaceTypeCreator(ctx: ClientContext, setProfile: (input: { workspaceId: string; profile: 'default' | 'sift' }) => Promise<ProfileResult>): () => void {
  let replacement: HTMLButtonElement | undefined;
  let nativeButton: HTMLButtonElement | undefined;
  let overlay: HTMLElement | undefined;

  const close = () => { overlay?.remove(); overlay = undefined; };
  const show = () => {
    close();
    let profile: 'default' | 'sift' = 'sift';
    overlay = document.createElement('div');
    overlay.dataset.siftWorkspaceCreator = '';
    overlay.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="sift-create-title"><header><strong id="sift-create-title">创建工作区</strong><button type="button" data-action="close" aria-label="关闭">×</button></header><p>选择这个工作区使用的类型。</p><div class="types"><button type="button" data-profile="default"><strong>default</strong><small>保持原生单栏对话界面</small></button><button type="button" data-profile="sift" data-selected><strong>sift</strong><small>启用素材、产出、对话三栏界面</small></button></div><div data-error role="alert"></div><footer><button type="button" data-action="cancel">取消</button><button type="button" data-action="create">选择目录并创建</button></footer></div>`;
    document.body.appendChild(overlay);
    const select = (next: 'default' | 'sift') => {
      profile = next;
      overlay?.querySelectorAll('[data-profile]').forEach(node => node.toggleAttribute('data-selected', (node as HTMLElement).dataset.profile === next));
    };
    overlay.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach(button => button.addEventListener('click', () => select(button.dataset.profile as 'default' | 'sift')));
    overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
    overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
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
  const reconcile = () => {
    if (replacement?.isConnected) return;
    const found = document.querySelector<HTMLButtonElement>('button[aria-label="添加工作区"]');
    if (!found || found.dataset.siftReplaced !== undefined) return;
    nativeButton = found; nativeButton.dataset.siftReplaced = ''; nativeButton.hidden = true;
    replacement = found.cloneNode(true) as HTMLButtonElement;
    replacement.hidden = false; replacement.removeAttribute('data-sift-replaced'); replacement.dataset.siftCreateWorkspace = '';
    replacement.setAttribute('aria-label', '添加工作区（选择类型）');
    replacement.addEventListener('click', show);
    found.insertAdjacentElement('afterend', replacement);
  };
  const observer = new MutationObserver(reconcile);
  observer.observe(document.body, { childList: true, subtree: true });
  reconcile();
  return () => { observer.disconnect(); replacement?.remove(); if (nativeButton) { nativeButton.hidden = false; delete nativeButton.dataset.siftReplaced; } close(); };
}

export const inject = ['slots', 'workspaces', 'sessions', 'remote', 'uiWorkspace'];

export function apply(ctx: ClientContext): void {
  type MountedRemote = {
    getWorkspaceProfile(input: { workspaceId: string }): Promise<ProfileResult | { ok: true; value: ProfileResult }>;
    setWorkspaceProfile(input: { workspaceId: string; profile: 'default' | 'sift' }): Promise<ProfileResult | { ok: true; value: ProfileResult }>;
  };
  const mounted = (async (): Promise<MountedRemote> => {
    const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
    ctx.effect?.(() => disposeRemote, 'sift: workspace profile remote');
    const remote = ctx.get?.('remote.sift') as MountedRemote | undefined;
    if (!remote) throw new Error('Sift Remote 已挂载，但服务不可用。');
    return remote;
  })();
  const unwrap = (result: ProfileResult | { ok: true; value: ProfileResult }) => 'ok' in result ? result.value : result;
  const remoteContext = { ...ctx, remote: { sift: {
    getWorkspaceProfile: async (input: { workspaceId: string }) => unwrap(await (await mounted).getWorkspaceProfile(input)),
    setWorkspaceProfile: async (input: { workspaceId: string; profile: 'default' | 'sift' }) => unwrap(await (await mounted).setWorkspaceProfile(input)),
  } } } as ClientContext;
  if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.dataset.dshSiftLayout = 'three-column';
    style.textContent = `[data-sift-three-column]{position:relative;display:grid!important;grid-template-columns:var(--sift-w0) var(--sift-g0) var(--sift-w1) var(--sift-g1) var(--sift-w2)!important;grid-template-rows:36px minmax(0,1fr)!important;overflow:auto!important}[data-sift-layout-toolbar]{position:absolute;inset:0 0 auto 0;height:36px;z-index:7;display:flex;align-items:center;gap:2px;padding:0 10px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l4,#e5e7eb);background:var(--dsw-alias-bg-base,#fff)}[data-sift-panel-tabs]{display:flex;align-items:center;height:26px;padding:2px;border:1px solid var(--dsw-alias-border-l4,#e5e7eb);border-radius:6px;box-sizing:border-box}[data-sift-layout-toolbar] button{height:22px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b919a);font:inherit;font-size:12px;cursor:pointer}[data-sift-layout-toolbar] button:hover{background:var(--dsw-alias-bg-raised,#f4f5f6);color:var(--dsw-alias-label-primary,#111827)}[data-sift-layout-toolbar] button[aria-pressed=true]{background:var(--dsw-alias-bg-raised,#f1f2f3);color:var(--dsw-alias-label-primary,#111827);font-weight:500}[data-sift-layout-toolbar] [data-action=reset]{margin-left:auto}[data-sift-three-column]>[data-sift-column=materials]{grid-column:1}[data-sift-three-column]>[data-sift-resizer='0']{grid-column:2}[data-sift-three-column]>[data-sift-column=document]{grid-column:3}[data-sift-three-column]>[data-sift-resizer='1']{grid-column:4}[data-sift-three-column]>[data-slot=main]{display:block!important;grid-column:5;grid-row:2;min-width:0;min-height:0;overflow:hidden}[data-sift-three-column]>[data-slot=main]>[data-slot='main.conversation']{display:block!important;height:100%;min-width:0;min-height:0}[data-sift-column]{grid-row:2;min-width:0;overflow:auto;border-right:1px solid var(--dsw-alias-border-l4,#e5e7eb);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111827)}[data-sift-column]>header{padding:12px;min-height:68px;border-bottom:1px solid var(--dsw-alias-border-l4,#e5e7eb);display:grid;gap:4px;box-sizing:border-box}[data-sift-column]>header>small,[data-sift-column]>div{color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:12px}[data-sift-column]>div{padding:16px;font-size:13px}[data-sift-column][data-collapsed]{visibility:hidden;pointer-events:none}[data-sift-resizer]{grid-row:2;position:relative;cursor:col-resize;background:transparent;touch-action:none;z-index:4}[data-sift-resizer]::after{content:'';position:absolute;inset:0 auto 0 50%;width:1px;transform:translateX(-50%);background:var(--dsw-alias-border-l4,#e5e7eb)}[data-sift-resizer]:hover::after,[data-sift-resizer][data-dragging]::after{background:var(--dsw-alias-label-tertiary,#8b919a)}[data-sift-three-column][data-chat-collapsed]>[data-slot=main]{visibility:hidden;pointer-events:none}`;    style.textContent += 'button[data-sift-replaced]{display:none!important}[data-sift-workspace-creator]{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:#0006}[data-sift-workspace-creator]>[role=dialog]{width:min(520px,calc(100vw - 32px));padding:20px;border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 18px 60px #0004}[data-sift-workspace-creator] header,[data-sift-workspace-creator] footer{display:flex;align-items:center;justify-content:space-between;gap:12px}[data-sift-workspace-creator] header button{border:0;background:transparent;font-size:22px;cursor:pointer}[data-sift-workspace-creator] .types{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}[data-sift-workspace-creator] .types button{display:flex;min-height:96px;padding:16px;flex-direction:column;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l4,#d1d5db);border-radius:10px;background:transparent;color:inherit;cursor:pointer;text-align:left}[data-sift-workspace-creator] .types button[data-selected]{border-color:var(--dsw-alias-state-business-primary,#4f7cff);box-shadow:0 0 0 2px #4f7cff33}[data-sift-workspace-creator] small,[data-sift-workspace-creator]>[role=dialog]>p{color:var(--dsw-alias-label-tertiary,#6b7280)}[data-sift-workspace-creator] [data-error]{min-height:22px;color:#dc2626;font-size:13px}[data-sift-workspace-creator] footer{justify-content:flex-end}[data-sift-workspace-creator] footer button{padding:7px 14px;border:1px solid var(--dsw-alias-border-l4,#d1d5db);border-radius:7px;background:transparent;color:inherit;cursor:pointer}[data-sift-workspace-creator] footer [data-action=create]{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4f7cff);color:#fff}';
    document.head.appendChild(style);
    ctx.effect?.(() => () => style.remove(), 'sift: three-column styles');
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'sift-workspace-profile', order: 90 }, () => <WorkspaceProfileBadge ctx={remoteContext} />));
  if (typeof document !== 'undefined') {
    const disposeCreator = installWorkspaceTypeCreator(ctx, input => remoteContext.remote.sift!.setWorkspaceProfile(input));
    ctx.effect?.(() => disposeCreator, 'sift: workspace type creator');
  }
  if (typeof document !== 'undefined') {
    let generation = 0;
    let mountedCenter: HTMLElement | null = null;
    let activeWorkspaceId: string | undefined;
    let state: LayoutState = structuredClone(DEFAULT_LAYOUT);
    let resizeObserver: ResizeObserver | undefined;
    let disposeEditor: (() => void) | undefined;
    const storageKey = (workspaceId: string) => `dsh-sift:layout:${workspaceId}`;
    const loadState = (workspaceId: string): LayoutState => {
      try {
        const value = JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? 'null') as Partial<LayoutState> | null;
        if (value && Array.isArray(value.widths) && value.widths.length === 3 && Array.isArray(value.collapsed) && value.collapsed.length === 3) return { widths: value.widths.map(Number) as LayoutState['widths'], collapsed: value.collapsed.map(Boolean) as LayoutState['collapsed'] };
      } catch {}
      return structuredClone(DEFAULT_LAYOUT);
    };
    const persist = () => { if (activeWorkspaceId) localStorage.setItem(storageKey(activeWorkspaceId), JSON.stringify(state)); };
    const applyState = () => {
      if (!mountedCenter) return;
      const fitted = fitLayout(state, mountedCenter.clientWidth);
      fitted.widths.forEach((width, index) => {
        mountedCenter!.style.setProperty(`--sift-w${index}`, `${width}px`);
        if (!state.collapsed[index]) state.widths[index] = width;
      });
      mountedCenter.style.setProperty('--sift-g0', state.collapsed[0] || state.collapsed[1] ? '0px' : '6px');
      mountedCenter.style.setProperty('--sift-g1', state.collapsed[1] || state.collapsed[2] ? '0px' : '6px');
      mountedCenter.toggleAttribute('data-chat-collapsed', state.collapsed[2]);
      mountedCenter.querySelector<HTMLElement>('[data-sift-column="materials"]')?.toggleAttribute('data-collapsed', state.collapsed[0]);
      mountedCenter.querySelector<HTMLElement>('[data-sift-column="document"]')?.toggleAttribute('data-collapsed', state.collapsed[1]);
      mountedCenter.querySelectorAll<HTMLButtonElement>('[data-sift-panel-toggle]').forEach(button => {
        const index = Number(button.dataset.siftPanelToggle);
        button.setAttribute('aria-pressed', String(!state.collapsed[index]));
        button.title = state.collapsed[index] ? `显示${button.textContent}` : `隐藏${button.textContent}`;
      });
      window.dispatchEvent(new Event('resize'));
    };
    const clearLayout = () => {
      disposeEditor?.(); disposeEditor = undefined;
      resizeObserver?.disconnect(); resizeObserver = undefined;
      mountedCenter?.querySelectorAll('[data-sift-column],[data-sift-resizer],[data-sift-layout-toolbar]').forEach(node => node.remove());
      mountedCenter?.removeAttribute('data-sift-three-column');
      mountedCenter?.removeAttribute('data-chat-collapsed');
      mountedCenter?.style.removeProperty('--sift-w0'); mountedCenter?.style.removeProperty('--sift-w1'); mountedCenter?.style.removeProperty('--sift-w2');
      mountedCenter?.style.removeProperty('--sift-g0'); mountedCenter?.style.removeProperty('--sift-g1');
      mountedCenter = null;
    };
    const toggle = (index: number) => { state.collapsed[index] = !state.collapsed[index]; applyState(); persist(); };
    const addColumn = (center: Element, id: string, title: string, description: string) => {
      const section = document.createElement('section');
      section.dataset.siftColumn = id;
      section.innerHTML = `<header><strong>${title}</strong><small>${description}</small></header><div>此处为能力接线占位。</div>`;
      center.appendChild(section);
      return section;
    };
    const addToolbar = (center: Element) => {
      const toolbar = document.createElement('nav');
      toolbar.dataset.siftLayoutToolbar = '';
      toolbar.setAttribute('aria-label', 'Sift 布局');
      const tabs = document.createElement('div');
      tabs.dataset.siftPanelTabs = '';
      tabs.setAttribute('role', 'group');
      tabs.setAttribute('aria-label', '显示的栏目');
      ['素材', '产出', '对话'].forEach((label, index) => {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = label; button.dataset.siftPanelToggle = String(index);
        button.addEventListener('click', () => toggle(index)); tabs.appendChild(button);
      });
      toolbar.appendChild(tabs);
      const reset = document.createElement('button');
      reset.type = 'button'; reset.textContent = '重置'; reset.dataset.action = 'reset';
      reset.title = '显示全部栏目';
      reset.addEventListener('click', () => { state.collapsed = [false, false, false]; applyState(); persist(); });
      toolbar.appendChild(reset); center.appendChild(toolbar);
    };
    const addResizer = (center: Element, index: 0 | 1) => {
      const handle = document.createElement('div'); handle.dataset.siftResizer = String(index); handle.setAttribute('role', 'separator'); handle.tabIndex = 0;
      handle.addEventListener('pointerdown', event => {
        if (state.collapsed[index] || state.collapsed[index + 1]) return;
        event.preventDefault(); handle.setPointerCapture(event.pointerId); handle.dataset.dragging = '';
        const start = event.clientX; const left = state.widths[index]; const right = state.widths[index + 1];
        const move = (next: PointerEvent) => { const delta = next.clientX - start; state.widths[index] = Math.max(MIN_WIDTHS[index], left + delta); state.widths[index + 1] = Math.max(MIN_WIDTHS[index + 1], right - delta); applyState(); };
        const end = () => { handle.removeAttribute('data-dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); persist(); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', end, { once: true });
      });
      center.appendChild(handle);
    };
    const showLayout = (workspaceId: string) => {
      const center = document.querySelector('[data-rightbar-col]')?.previousElementSibling as HTMLElement | null;
      if (!center) return;
      if (mountedCenter === center && activeWorkspaceId === workspaceId) return;
      clearLayout();
      activeWorkspaceId = workspaceId; state = loadState(workspaceId);
      mountedCenter = center;
      center.setAttribute('data-sift-three-column', '');
      addToolbar(center);
      addColumn(center, 'materials', '素材', '工作区文件与参考关系'); addResizer(center, 0);
      const documentSection = addColumn(center, 'document', '产出', 'Markdown 阅读与编辑');
      disposeEditor = mountDocumentEditor(documentSection, workspaceId);
      addResizer(center, 1);
      resizeObserver = new ResizeObserver(entries => { if (entries.some(entry => entry.target === center)) applyState(); else window.dispatchEvent(new Event('resize')); });
      resizeObserver.observe(center); Array.from(center.children).forEach(child => resizeObserver!.observe(child)); applyState();
    };
    const reconcile = async () => {
      const request = ++generation;
      const workspaceState = ctx.workspaces?.list.getSnapshot();
      const sessionState = ctx.sessions?.list.getSnapshot();
      const currentId = sessionState?.current;
      const workspace = currentId === undefined ? undefined : workspaceState?.items.find(item => item.sessionIds.includes(currentId));
      if (!workspace || workspaceState?.phase !== 'ready' || sessionState?.phase === 'pending') { clearLayout(); return; }
      try {
        const profile = await remoteContext.remote.sift!.getWorkspaceProfile({ workspaceId: workspace.workspaceId });
        if (request !== generation) return;
        if (profile.profile === 'sift' && profile.status === 'ready') showLayout(workspace.workspaceId); else clearLayout();
      } catch { if (request === generation) clearLayout(); }
    };
    const disposeWorkspaces = ctx.workspaces?.list.subscribe(() => { void reconcile(); });
    const disposeSessions = ctx.sessions?.list.subscribe(() => { void reconcile(); });
    ctx.effect?.(() => () => { disposeWorkspaces?.(); disposeSessions?.(); clearLayout(); }, 'sift: native conversation three-column layout');
    void reconcile();
  }
}

export { WorkspaceProfileBadge };
