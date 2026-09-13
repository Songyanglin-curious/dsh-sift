import { createServer } from 'node:http';

export const inject = ['agents', 'tools'];

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function apply(ctx) {
  const startedAt = new Date().toISOString();
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!process.env.SIFT_DEV_TOKEN || req.headers.authorization !== `Bearer ${process.env.SIFT_DEV_TOKEN}`) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
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
