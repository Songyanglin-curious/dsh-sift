import type { ReactNode } from 'react';
import { SIFT_REMOTE } from '../contracts/remote.js';
import { AnnotationDock, SiftNavigationButton, SiftSurface, type SiftSessions } from './workbench.js';
import { SiftClientRuntime, type SubmissionMode, type SubmitOutcome } from './runtime.js';
import type { SiftRemote } from './transport.js';

interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

interface SessionListState {
  current?: string;
  byId: Record<string, { id: string; displayTitle: string; running: boolean }>;
}

interface SubmissionExtension {
  id: string;
  transform(input: { sessionId: string; text: string; mode: SubmissionMode }): string;
  beforeSubmit(input: { sessionId: string; text: string; mode: SubmissionMode; signal: AbortSignal }): Promise<void>;
  settled(input: { sessionId: string; text: string; mode: SubmissionMode; outcome: SubmitOutcome }): Promise<void>;
}

interface SubmissionRegistration {
  invalidate(sessionId: string): void;
  dispose(): void;
}

interface LayoutService {
  openSurface(id: string): void;
  closeSurface(id?: string): void;
}

interface WorkspaceService {
  create(input: { path: string }): Promise<{ workspaceId: string; path: string; title: string }>;
}

interface ClientContext {
  remote: { $mount(contribution: typeof SIFT_REMOTE): Promise<() => void | Promise<void>> };
  conversation: {
    submissions?: { register(extension: SubmissionExtension): SubmissionRegistration };
    input: { for(scope: unknown): { state: Observable<{ draft: string }> } };
  };
  sessions: {
    list: Observable<SessionListState>;
    scope(sessionId: string): unknown;
    open(sessionId: string): void;
    create(options: { workspaceId: string }): Promise<string>;
  };
  workspaces: WorkspaceService;
  get(name: string): unknown;
  effect(factory: () => () => void | Promise<void>, label?: string): unknown;
  slots: {
    inject(name: string, factory: () => unknown): unknown;
    register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => ReactNode): unknown;
  };
}

export const inject = ['slots', 'remote', 'sessions', 'conversation', 'workspaces'];

export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(SIFT_REMOTE);
  ctx.effect(() => disposeRemote, 'sift: remote');
  const remote = ctx.get('remote.sift') as SiftRemote | undefined;
  if (!remote) throw new Error('Sift Remote 未挂载。');

  const layout = ctx.get('layout') as LayoutService | undefined;
  const submissions = ctx.conversation.submissions;
  const compatible = typeof layout?.openSurface === 'function'
    && typeof layout.closeSurface === 'function'
    && typeof submissions?.register === 'function';

  if (!compatible) {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'sift-incompatible', order: 80,
      inject: () => ({ message: '当前 DSH 不支持 Sift 工作台，请升级到包含组合布局与发送扩展接口的版本。' }),
    }, SiftCompatibilityNotice));
    return;
  }

  const runtime = new SiftClientRuntime(remote);
  const sessions: SiftSessions = {
    list: ctx.sessions.list,
    create: options => ctx.sessions.create(options),
    open: sessionId => ctx.sessions.open(sessionId),
    createWorkspace: input => ctx.workspaces.create(input),
  };

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'sift', order: 80,
    inject: () => ({ layout }),
  }, SiftNavigationButton as unknown as (props: Record<string, unknown>) => ReactNode));

  ctx.slots.inject('shell.surface', () => ctx.slots.register({
    name: 'shell.surface', priority: 20,
    select: ({ activeSurface }: { activeSurface: string | null }) => activeSurface === 'sift' ? true : null,
    inject: () => ({ runtime, sessions, layout }),
  }, SiftSurface as unknown as (props: Record<string, unknown>) => ReactNode));

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'sift-annotations', order: 80,
    inject: (sessionId: string) => {
      const scope = ctx.sessions.scope(sessionId);
      if (!scope) throw new Error(`Sift 无法解析会话 ${sessionId}。`);
      return { sessionId, runtime, inputState: ctx.conversation.input.for(scope).state };
    },
  }, AnnotationDock as unknown as (props: Record<string, unknown>) => ReactNode));

  const submission = submissions.register({
    id: 'sift-annotations',
    transform: input => runtime.transform(input),
    beforeSubmit: input => runtime.beforeSubmit(input),
    settled: input => runtime.settled(input),
  });
  const stopInvalidation = runtime.onInvalidate(sessionId => submission.invalidate(sessionId));
  ctx.effect(() => () => {
    stopInvalidation();
    submission.dispose();
    layout.closeSurface('sift');
  }, 'sift: native surface and submission extension');
}

function SiftCompatibilityNotice({ message }: { message?: string }) {
  return <button className="sift-nav-button" type="button" disabled title={message}>
    <span aria-hidden>⌘</span><span>Sift（需要升级 DSH）</span>
  </button>;
}
