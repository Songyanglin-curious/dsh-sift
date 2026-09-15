import { createServer } from 'node:http';
import { setupWorkspaceProfile } from '../workspace-profile.mjs';

<<<<<<< HEAD
export const inject = ['workspaceRegistry', 'connection'];
=======
export const inject = ['agents', 'tools'];

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0

export function apply(ctx) {
  const startedAt = new Date().toISOString();
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!process.env.SIFT_DEV_TOKEN || req.headers.authorization !== `Bearer ${process.env.SIFT_DEV_TOKEN}`) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
<<<<<<< HEAD
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
=======
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/execute-tool') {
      const body = await jsonBody(req);
      const agent = typeof body.sessionId === 'string' ? ctx.agents.get(body.sessionId) : undefined;
      if (!agent || typeof body.name !== 'string') {
        res.writeHead(404);
        res.end(JSON.stringify({ error: '会话未运行或工具名无效。' }));
        return;
      }
      const result = await ctx.tools.execute({
        callId: `sift-probe-${Date.now()}`, name: body.name, arguments: body.arguments ?? {},
        agent, signal: new AbortController().signal,
      });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: '未知开发操作。' }));
      return;
    }
    if (url.pathname === '/session-tools') {
      const sessionId = url.searchParams.get('sessionId');
      const agent = sessionId ? ctx.agents.get(sessionId) : undefined;
      if (!agent) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: '会话未运行。' }));
        return;
      }
      res.end(JSON.stringify({ sessionId, tools: ctx.tools.schemas(agent).map(tool => tool.name).sort() }));
      return;
    }
    if (url.pathname !== '/state') {
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0
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
