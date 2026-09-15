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
