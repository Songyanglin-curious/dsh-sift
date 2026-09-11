import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolve } from 'node:path';
import type { SiftRequest } from '../contracts/remote.js';
import { SiftRepository } from './repository.js';

export const name = 'sift';

declare module '@deepseek-ai/cordis' {
  interface Context {
    sift: SiftService;
  }
}

export class SiftService extends TypertRemoteService {
  private readonly repository: SiftRepository;

  constructor(ctx: Context) {
    super(ctx, 'sift');
    const home = process.env.DSH_HOME;
    if (!home) throw new Error('Sift 需要 DSH_HOME 来保存关系数据。');
    this.repository = new SiftRepository(resolve(home, 'sift'));
    ctx.logger.info('Sift 插件已加载。');
    ctx.effect(() => () => ctx.logger.info('Sift 插件已卸载。'));
  }

  remoteDispatch(request: SiftRequest): Promise<unknown> {
    return this.repository.dispatch(request);
  }
}

export default SiftService;
