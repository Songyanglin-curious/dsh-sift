import type { ComponentType } from 'react';
import articleDrawerCss from './article-drawer.css?inline';
import type { ClipboardSnapshot } from '../host/clipboard/index.js';
import type { ReferenceDocument, ReferenceSummary, RelationLookup } from '../references.js';
import type { ConversationAnalysisSettings } from '../settings-contract.js';
import { SIFT_SETTINGS_NAMESPACE } from '../settings-contract.js';
import { TYPERT_REMOTE } from '../remote.js';
import { installAnnotationAdapter } from './annotations/adapter.js';
import { installArticleActionPlacement, mountArticleReferenceDrawer, type ArticleReferencePane } from './article-drawer.js';
import { unwrapRemoteResult } from './dsh-adapter/remote-result.js';
import { resolveCurrentWorkspace, type WorkspaceSnapshot } from './dsh-adapter/workspace-entry.js';
import { injectStyle, SIFT_PLUGIN_ID } from './renderer/inject-style.js';
import { SiftSettingsSection, type ModelCatalog, type SettingsScope } from './settings/section.js';

interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface SiftRemote {
  readClipboard(input: Record<string, never>): Promise<ClipboardSnapshot>;
  listReferences(input: { workspaceId: string }): Promise<ReferenceSummary[]>;
  loadReference(input: { workspaceId: string; path: string }): Promise<ReferenceDocument>;
  createReference(input: { workspaceId: string; name?: string }): Promise<{ path: string }>;
  importConversationReference(input: { workspaceId: string; sourcePath: string }): Promise<{ path: string }>;
  saveReference(input: { workspaceId: string; path: string; reference: ReferenceDocument }): Promise<Record<string, never>>;
  analyzeConversation(input: { workspaceId: string; path: string; anchorGroupId: string }): Promise<ReferenceDocument>;
  analyzeConversationTopic(input: { workspaceId: string; path: string; topic: string }): Promise<ReferenceDocument>;
  removeReference(input: { workspaceId: string; path: string }): Promise<Record<string, never>>;
  getArticleRelations(input: { workspaceId: string; target: string }): Promise<RelationLookup>;
  setArticleRelations(input: { workspaceId: string; target: string; references: string[] }): Promise<Record<string, never>>;
  pickSourceFiles(input: Record<string, never>): Promise<{ paths: string[]; cancelled: boolean; message?: string }>;
  openSourcePath(input: { path: string }): Promise<Record<string, never>>;
}
interface ClientContext {
  slots: { inject(name: string, factory: () => unknown): unknown; register(options: { name: string; id?: string; order?: number; label?: () => string; inject?: (sessionId: string) => Record<string, unknown> }, component: ComponentType<any> | unknown): () => void };
  workspaces?: { list: Source<WorkspaceSnapshot> };
  remote: { $mount(contribution: typeof TYPERT_REMOTE): Promise<() => void | Promise<void>>; session?: { modelCatalog(): Promise<ModelCatalog | { ok: true; value: ModelCatalog }> } };
  configForms?: { get<T>(entryId: string): SettingsScope<T> };
  get?(name: string): unknown;
  effect?(factory: () => () => void | Promise<void>, label?: string): unknown;
}

interface ArticleActionProps {
  readonly absolutePath: string;
  readonly openSiftReferences: (absolutePath: string, previewElement: HTMLElement) => void;
  readonly registerSiftPreview: (absolutePath: string, previewElement: HTMLElement) => void;
}

function ArticleReferenceAction({ absolutePath, openSiftReferences, registerSiftPreview }: ArticleActionProps) {
  return <button ref={button => {
    const previewElement = button?.closest('[data-textpreview-url]') as HTMLElement | null;
    if (previewElement) registerSiftPreview(absolutePath, previewElement);
  }} type="button" data-sift-article-action="" title="当前文章的参考" aria-label="打开当前文章的参考" onClick={event => {
    const previewElement = event.currentTarget.closest('[data-textpreview-url]') as HTMLElement | null;
    if (previewElement) openSiftReferences(absolutePath, previewElement);
  }}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h4.2A1.8 1.8 0 0 1 8 4v9a1.8 1.8 0 0 0-1.3-.5H2.5zM13.5 3.5H9.3A1.8 1.8 0 0 0 8 4v9a1.8 1.8 0 0 1 1.3-.5h4.2z" /></svg>
  </button>;
}

export const inject = ['slots', 'workspaces', 'remote', 'remote.session', 'configForms'];

export function apply(ctx: ClientContext): void {
  type RemoteResult<K extends keyof SiftRemote> = SiftRemote[K] extends (...args: any[]) => Promise<infer R> ? R : never;
  type MountedRemote = { [K in keyof SiftRemote]: (input: Parameters<SiftRemote[K]>[0]) => Promise<Awaited<ReturnType<SiftRemote[K]>> | { ok: true; value: Awaited<ReturnType<SiftRemote[K]>> }> };
  const mounted = (async (): Promise<MountedRemote> => {
    const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
    ctx.effect?.(() => disposeRemote, 'sift: remote');
    const remote = ctx.get?.('remote.sift') as MountedRemote | undefined;
    if (!remote) throw new Error('Sift Remote 已挂载，但服务不可用。');
    return remote;
  })();
  const call = async <K extends keyof SiftRemote>(method: K, input: Parameters<SiftRemote[K]>[0]): Promise<RemoteResult<K>> => unwrapRemoteResult(await (await mounted)[method](input)) as RemoteResult<K>;

  if (ctx.configForms && ctx.remote.session) {
    const scope = ctx.configForms.get<ConversationAnalysisSettings>(SIFT_SETTINGS_NAMESPACE);
    const loadModelCatalog = async () => unwrapRemoteResult(await ctx.remote.session!.modelCatalog());
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'sift', order: 35, label: () => 'Sift', inject: () => ({ settings: scope, loadModelCatalog }) }, SiftSettingsSection));
  }
  if (typeof document === 'undefined') return;

  const disposeBaseCss = injectStyle(SIFT_PLUGIN_ID, 'article-action.css', articleDrawerCss);
  const disposeAnnotations = installAnnotationAdapter();
  const disposePlacement = installArticleActionPlacement();
  const panes = new Map<string, ArticleReferencePane>();
  const paneKey = (workspaceId: string, absolutePath: string) => `${workspaceId}:${absolutePath}`;
  const closePane = (key: string) => { panes.get(key)?.dispose(); panes.delete(key); };

  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'sift-reference', order: -100,
    inject: sessionId => ({
      registerSiftPreview: (absolutePath: string, previewElement: HTMLElement) => {
        const workspace = resolveCurrentWorkspace(ctx.workspaces?.list.getSnapshot(), sessionId);
        if (!workspace) return;
        panes.get(paneKey(workspace.workspaceId, absolutePath))?.attach(previewElement);
      },
      openSiftReferences: (absolutePath: string, previewElement: HTMLElement) => {
        const workspace = resolveCurrentWorkspace(ctx.workspaces?.list.getSnapshot(), sessionId);
        if (!workspace) return;
        const workspaceId = workspace.workspaceId;
        const key = paneKey(workspaceId, absolutePath);
        if (panes.has(key)) { closePane(key); return; }
        const pane = mountArticleReferenceDrawer({
          workspaceId, absolutePath, previewElement, onClose: () => closePane(key),
          readClipboard: () => call('readClipboard', {}),
          api: {
            listReferences: () => call('listReferences', { workspaceId }),
            loadReference: path => call('loadReference', { workspaceId, path }),
            createReference: name => call('createReference', { workspaceId, ...(name === undefined ? {} : { name }) }),
            importConversationReference: sourcePath => call('importConversationReference', { workspaceId, sourcePath }),
            saveReference: (path, reference) => call('saveReference', { workspaceId, path, reference }).then(() => undefined),
            analyzeConversation: (path, anchorGroupId) => call('analyzeConversation', { workspaceId, path, anchorGroupId }),
            analyzeConversationTopic: (path, topic) => call('analyzeConversationTopic', { workspaceId, path, topic }),
            removeReference: path => call('removeReference', { workspaceId, path }).then(() => undefined),
            pickSourceFiles: () => call('pickSourceFiles', {}),
            openSourcePath: path => call('openSourcePath', { path }).then(() => undefined),
            getDocumentRelations: ({ target }) => call('getArticleRelations', { workspaceId, target }),
            setDocumentRelations: ({ target, references }) => call('setArticleRelations', { workspaceId, target, references }).then(() => undefined),
          },
        });
        panes.set(key, pane);
      },
    }),
  }, ArticleReferenceAction));

  ctx.effect?.(() => () => { for (const pane of panes.values()) pane.dispose(); panes.clear(); disposePlacement(); disposeAnnotations(); disposeBaseCss(); }, 'sift: article references');
}

export { ArticleReferenceAction };
