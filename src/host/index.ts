import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolve } from 'node:path';
import type { SiftRequest } from '../contracts/remote.js';
import { configureProjectAgent, type CapabilityHost } from './capabilities.js';
import { SiftRepository } from './repository.js';

export const name = 'sift';

declare module '@deepseek-ai/cordis' {
  interface Context {
    sift: SiftService;
  }
}

export class SiftService extends TypertRemoteService {
  static inject = ['agents', 'tools', 'systemPrompt'];
  private readonly repository: SiftRepository;
  private readonly capabilityHost: CapabilityHost;
  private readonly capabilityDisposers = new Map<string, () => void>();

  constructor(ctx: Context) {
    super(ctx, 'sift');
    const home = process.env.DSH_HOME;
    if (!home) throw new Error('Sift 需要 DSH_HOME 来保存关系数据。');
    this.repository = new SiftRepository(resolve(home, 'sift'));
    const services = ctx as unknown as CapabilityHost;
    this.capabilityHost = { agents: services.agents, tools: services.tools };
    const listen = ctx.on as unknown as (name: string, listener: (event: { agent: { id: string } }) => void) => () => void;
    listen.call(ctx, 'agent/created', ({ agent }) => {
      void this.configureSession(agent.id).catch(error => ctx.logger.warn(`Sift 会话能力配置失败：${messageOf(error)}`));
    });
    ctx.logger.info('Sift 插件已加载。');
    ctx.effect(() => () => {
      for (const dispose of this.capabilityDisposers.values()) dispose();
      this.capabilityDisposers.clear();
      ctx.logger.info('Sift 插件已卸载。');
    });
  }

  async remoteDispatch(request: SiftRequest): Promise<unknown> {
    const removedSessions = request.type === 'project.delete'
      ? (await this.repository.readCatalog()).projects.find(project => project.id === request.id)?.sessionIds ?? []
      : [];
    const result = await this.repository.dispatch(request);
    if (request.type === 'project.session.bind') await this.configureSession(request.sessionId);
    if (request.type === 'project.session.unbind') this.disposeSession(request.sessionId);
    for (const sessionId of removedSessions) this.disposeSession(sessionId);
    return result;
  }

  private async configureSession(sessionId: string): Promise<void> {
    if (this.capabilityDisposers.has(sessionId)) return;
    if (!await this.repository.projectForSession(sessionId)) return;
    const dispose = configureProjectAgent(this.capabilityHost, this.repository, sessionId);
    if (dispose) this.capabilityDisposers.set(sessionId, dispose);
  }

  private disposeSession(sessionId: string): void {
    this.capabilityDisposers.get(sessionId)?.();
    this.capabilityDisposers.delete(sessionId);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default SiftService;
