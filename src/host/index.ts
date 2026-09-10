import type { Context } from '@deepseek-ai/cordis';

export const name = 'sift';

export function apply(ctx: Context): void {
  ctx.logger.info('Sift 插件已加载。');
  ctx.effect(() => () => ctx.logger.info('Sift 插件已卸载。'));
}
