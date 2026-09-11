import { SIFT_REMOTE } from '../contracts/remote.js';
import { SiftWorkbenchButton, type WorkbenchInjected } from './workbench.js';
import type { SiftRemote } from './transport.js';

interface SlotRegistration {
  name: 'conversation.input.right';
  id: 'sift-workbench';
  order: number;
  inject(sessionId: string): WorkbenchInjected;
}

interface ClientContext {
  remote: { $mount(contribution: typeof SIFT_REMOTE): Promise<() => void | Promise<void>> };
  conversation: { input: { for(scope: unknown): { setDraft(text: string): void } } };
  sessions: { scope(sessionId: string): unknown };
  get(name: string): unknown;
  effect(factory: () => () => void | Promise<void>): unknown;
  slots: {
    inject(name: SlotRegistration['name'], factory: () => unknown): unknown;
    register(options: SlotRegistration, component: typeof SiftWorkbenchButton): unknown;
  };
}
export const inject = ['slots', 'remote', 'sessions', 'conversation'];

export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(SIFT_REMOTE);
  ctx.effect(() => disposeRemote);
  const remote = ctx.get('remote.sift') as SiftRemote | undefined;
  if (!remote) throw new Error('Sift Remote 未挂载。');
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'sift-workbench',
    order: 90,
    inject: sessionId => ({
      remote,
      setConversationDraft: text => {
        const scope = ctx.sessions.scope(sessionId);
        if (!scope) throw new Error('当前会话不可用。');
        ctx.conversation.input.for(scope).setDraft(text);
      },
    }),
  }, SiftWorkbenchButton));
}
