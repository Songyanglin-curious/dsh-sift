import { createServer } from 'node:http';
import { setupWorkspaceProfile } from '../workspace-profile.mjs';

export const inject = ['workspaceRegistry', 'connection'];

export function apply(ctx) {
  const startedAt = new Date().toISOString();
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!process.env.SIFT_DEV_TOKEN || req.headers.authorization !== `Bearer ${process.env.SIFT_DEV_TOKEN}`) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    if (req.method === 'GET' && req.url === '/browser-url') {
      res.setHeader('cache-control', 'no-store');
      const port = Number(process.env.SIFT_DEV_PROBE_PORT) - 1;
      res.end(JSON.stringify({ url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/workspace-profile/setup') {
      try {
        const directories = await setupWorkspaceProfile();
        const workspaces = [];
        for (const path of [directories.defaultWorkspace, directories.siftWorkspace]) {
          const workspace = await ctx.workspaceRegistry.create(path);
          workspaces.push({ workspaceId: workspace.id, title: workspace.title, path: workspace.path });
        }
        res.end(JSON.stringify({ workspaces }));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/sift') {
      // 宿主侧接缝的运行时证据：Sift 服务是否加载、工具是否真的注册进了 tools 注册表。
      const tools = ctx.get('tools');
      const names = tools === undefined ? [] : (() => {
        try { return tools.schemas().map(entry => (typeof entry === 'string' ? entry : entry?.name)).filter(Boolean); }
        catch { return []; }
      })();
      res.end(JSON.stringify({
        hasToolsService: tools !== undefined,
        hasSiftService: ctx.get('sift') !== undefined,
        toolCount: names.length,
        siftTools: names.filter(name => name.startsWith('sift_')),
      }));
      return;
    }
    // 用真实 Host 服务跑一遍 Source 主链：添加三种来源 → 读回。
    if (req.method === 'POST' && req.url === '/sources/verify') {
      try {
        const directories = await setupWorkspaceProfile();
        const workspace = await ctx.workspaceRegistry.create(directories.siftWorkspace);
        const sift = ctx.get('sift');
        const added = [
          await sift.addSource({ workspaceId: workspace.id, type: 'file', location: 'workspace', target: '01-素材说明.md' }),
          await sift.addSource({ workspaceId: workspace.id, type: 'url', target: 'https://example.com/doc' }),
          await sift.createSourceFile({ workspaceId: workspace.id, name: 'probe-paste', content: '来自探针的粘贴内容' }),
        ];
        const index = await sift.listSources({ workspaceId: workspace.id });
        res.end(JSON.stringify({
          workspace: { id: workspace.id, path: workspace.path },
          added: added.map(entry => entry.source ?? entry),
          count: index.items.length,
          items: index.items,
        }));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    // 只读地列出 sift 工作区当前的 Source，用于验证「重启后恢复」。
    if (req.method === 'GET' && req.url === '/sources') {
      try {
        const directories = await setupWorkspaceProfile();
        const workspace = await ctx.workspaceRegistry.create(directories.siftWorkspace);
        const index = await ctx.get('sift').listSources({ workspaceId: workspace.id });
        res.end(JSON.stringify({ workspaceId: workspace.id, path: workspace.path, count: index.items.length, items: index.items }));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (req.method !== 'GET' || req.url !== '/state') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: '未知开发操作。' }));
      return;
    }
    res.end(JSON.stringify({
      package: '@songyanglin/dsh-sift',
      pid: process.pid,
      running: true,
      startedAt,
    }));
  });
  ctx.effect(() => () => new Promise(resolvePromise => {
    server.close(resolvePromise);
    server.closeAllConnections();
  }));
  server.listen(Number(process.env.SIFT_DEV_PROBE_PORT), '127.0.0.1');
}
