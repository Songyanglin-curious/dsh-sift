import { useEffect, useSyncExternalStore, useState, useRef } from 'react';
import type { ComponentType } from 'react';
import { TYPERT_REMOTE } from '../remote.js';
import type { DocumentsApi } from '../documents.js';
/** 仅类型导入：编译期擦除，koffi 不会进浏览器 bundle。 */
import type { ClipboardSnapshot } from '../host/clipboard/index.js';
import type { ReferenceDocument, ReferenceSummary } from '../references.js';
import { mountDocumentEditor } from './document-editor.js';
import { mountReferencePanel } from './reference/panel.js';
import { type InputTriggerServiceContract } from './dsh-adapter/input-trigger.js';
import { mountThreeColumn, type ColumnSpec } from './dsh-adapter/layout.js';
import { findConversationCenter } from './dsh-adapter/selectors.js';
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

interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }

interface SiftRemote {
    getWorkspaceProfile(input: { workspaceId: string }): Promise<ProfileResult>;
    setWorkspaceProfile(input: { workspaceId: string; profile: 'default' | 'sift' }): Promise<ProfileResult>;
    listDocuments: DocumentsApi['listDocuments'];
    saveDocument: DocumentsApi['saveDocument'];
    readDocumentContent: DocumentsApi['readDocumentContent'];
    addExistingDocument: DocumentsApi['addExistingDocument'];
    detachDocument: DocumentsApi['detachDocument'];
    removeDocument: DocumentsApi['removeDocument'];
    /** 读取 Windows 原生剪贴板快照（Host 端 koffi 实现）。 */
    readClipboard(input: Record<string, never>): Promise<ClipboardSnapshot>;
    listReferences(input: { workspaceId: string }): Promise<ReferenceSummary[]>;
    loadReference(input: { workspaceId: string; path: string }): Promise<ReferenceDocument>;
    createReference(input: { workspaceId: string; name?: string }): Promise<{ path: string }>;
    saveReference(input: { workspaceId: string; path: string; reference: ReferenceDocument }): Promise<Record<string, never>>;
    removeReference(input: { workspaceId: string; path: string }): Promise<Record<string, never>>;
    getDocumentRelations(input: { workspaceId: string; target: string }): Promise<string[]>;
    setDocumentRelations(input: { workspaceId: string; target: string; references: string[] }): Promise<Record<string, never>>;
    /** Host 的原生文件对话框（在 Host 所在显示器弹出）。 */
    pickSourceFiles(input: Record<string, never>): Promise<{ paths: string[]; cancelled: boolean; message?: string }>;
    /** 在本机打开一个文件（配置的编辑器，未配置则系统默认程序）。 */
    openSourcePath(input: { path: string }): Promise<Record<string, never>>;
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

/** Sift 三栏：左 Reference Board、中 Document、右原生对话。 */
const SIFT_COLUMNS: readonly [ColumnSpec, ColumnSpec] = [
    { id: 'reference', label: '参考', title: 'Reference Board', description: '当前有效参考' },
    { id: 'document', label: '文档', title: 'Document', description: 'Markdown 正文' },
];

function noopSubscribe() { return () => { } }
const EMPTY_WORKSPACES: WorkspaceSnapshot = { items: [], phase: 'pending' };
const EMPTY_SESSIONS: SessionSnapshot = { phase: 'pending' };

function WorkspaceProfileBadge({ ctx }: { ctx: ClientContext }) {
    const workspaces = ctx.workspaces?.list;
    const sessions = ctx.sessions?.list;
    const workspaceSnapshot = useSyncExternalStore(workspaces ? listener => workspaces.subscribe(listener) : noopSubscribe, workspaces ? () => workspaces.getSnapshot() : () => EMPTY_WORKSPACES);
    const sessionSnapshot = useSyncExternalStore(sessions ? listener => sessions.subscribe(listener) : noopSubscribe, sessions ? () => sessions.getSnapshot() : () => EMPTY_SESSIONS);
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

// "添加工作区"按钮（installWorkspaceTypeCreator）
import { installWorkspaceTypeCreator } from './workspace-creator.js';
export { installWorkspaceTypeCreator };

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
        addExistingDocument: async input => unwrap(await (await mounted).addExistingDocument(input)),
        detachDocument: async input => unwrap(await (await mounted).detachDocument(input)),
        removeDocument: async input => unwrap(await (await mounted).removeDocument(input)),
    };
    const siftRemote = {
        getWorkspaceProfile: async (input: { workspaceId: string }) => unwrap(await (await mounted).getWorkspaceProfile(input)),
        setWorkspaceProfile: async (input: { workspaceId: string; profile: 'default' | 'sift' }) => unwrap(await (await mounted).setWorkspaceProfile(input)),
        readClipboard: async () => unwrap(await (await mounted).readClipboard({})),
        listReferences: async (input: { workspaceId: string }) => unwrap(await (await mounted).listReferences(input)),
        loadReference: async (input: { workspaceId: string; path: string }) => unwrap(await (await mounted).loadReference(input)),
        createReference: async (input: { workspaceId: string; name?: string }) => unwrap(await (await mounted).createReference(input)),
        saveReference: async (input: { workspaceId: string; path: string; reference: ReferenceDocument }) => unwrap(await (await mounted).saveReference(input)),
        removeReference: async (input: { workspaceId: string; path: string }) => unwrap(await (await mounted).removeReference(input)),
        getDocumentRelations: async (input: { workspaceId: string; target: string }) => unwrap(await (await mounted).getDocumentRelations(input)),
        setDocumentRelations: async (input: { workspaceId: string; target: string; references: string[] }) => unwrap(await (await mounted).setDocumentRelations(input)),
        pickSourceFiles: async () => unwrap(await (await mounted).pickSourceFiles({})),
        openSourcePath: async (input: { path: string }) => unwrap(await (await mounted).openSourcePath(input)),
        ...documentsApi,
    };
    const remoteContext = Object.create(ctx, {
        remote: { value: { sift: siftRemote }, writable: false, configurable: true, enumerable: true },
    }) as ClientContext;

    //侧边下方插槽展示当前的工作区是哪个以及类型
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'sift-workspace-profile', order: 90 }, () => <WorkspaceProfileBadge ctx={remoteContext} />));
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
                ? (() => {
                    try {
                        const disposePanel = mountReferencePanel(section, {
                            api: {
                                listReferences: () => remoteContext.remote.sift!.listReferences({ workspaceId: workspace.workspaceId }),
                                loadReference: path => remoteContext.remote.sift!.loadReference({ workspaceId: workspace.workspaceId, path }),
                                createReference: name => remoteContext.remote.sift!.createReference({ workspaceId: workspace.workspaceId, name }),
                                saveReference: (path, reference) => remoteContext.remote.sift!.saveReference({ workspaceId: workspace.workspaceId, path, reference }).then(() => undefined),
                                removeReference: path => remoteContext.remote.sift!.removeReference({ workspaceId: workspace.workspaceId, path }).then(() => undefined),
                                pickSourceFiles: () => remoteContext.remote.sift!.pickSourceFiles({}),
                                openSourcePath: path => remoteContext.remote.sift!.openSourcePath({ path }).then(() => undefined),
                            },
                            readClipboard: () => remoteContext.remote.sift!.readClipboard({}),
                        });
                        return () => disposePanel();
                    } catch (error) {
                        // 面板挂载失败只降级左栏，绝不拖垮三栏布局。
                        console.error('Sift: 参考面板挂载失败', error);
                        section.textContent = '参考面板加载失败';
                        return () => { section.textContent = ''; };
                    }
                })()
                : mountDocumentEditor(section, {
                    workspaceId: workspace.workspaceId,
                    api: documentsApi,
                    pickDirectory: () => ctx.uiWorkspace?.pickDirectory() ?? Promise.resolve(null),
                    pickOutputFiles: () => remoteContext.remote.sift!.pickSourceFiles({}),
                }),
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
