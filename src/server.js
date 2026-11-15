// Plain-Node HTTP server for local dev (and the Tailscale Funnel fallback
// path, PLAN §5.2). No framework.
//
// Routes:
//   GET  /            -> {ok:true, protocolVersion:"v1"}  (preflight)
//   GET  /health      -> {ok:true, protocolVersion:"v1"}  (preflight)
//   GET  /api/health  -> {ok:true, protocolVersion:"v1"}  (preflight)
//   POST /task        -> task handler
//   POST /api/task    -> task handler
//
// Env: PORT (default 3000), HMAC_SECRET (required), STORE_BACKEND,
// STORE_FILE, STORE_REPO (see src/store.js).
import http from 'node:http';
import { createHandler, PREFLIGHT } from './handler.js';
import { SeenStore } from './store.js';

export function createServer({ hmacSecret, store, port = 3000 }) {
  const { handleTask } = createHandler({ hmacSecret, store });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const send = (status, obj, signature) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        'content-type': 'application/json',
        ...(signature ? { 'x-agent-games-signature': signature } : {}),
      });
      res.end(body);
    };

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/api/health')) {
      return send(200, PREFLIGHT);
    }
    if (req.method === 'POST' && (url.pathname === '/task' || url.pathname === '/api/task')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const result = await handleTask(Buffer.concat(chunks), req.headers);
          send(result.status, result.body, result.signature);
        } catch (e) {
          console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'server', msg: 'handler threw', error: String(e).slice(0, 300) }));
          send(500, { error: 'internal error' });
        }
      });
      return;
    }
    return send(404, { error: 'not found' });
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  const hmacSecret = process.env.HMAC_SECRET;
  const store = new SeenStore();
  await store.load();
  const server = createServer({ hmacSecret, store, port });
  server.listen(port, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'server', msg: `listening on :${port}`, backend: process.env.STORE_BACKEND || 'github' }));
  });
}
