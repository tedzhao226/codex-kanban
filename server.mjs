import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskIndex } from './lib/tasks.mjs';
import { DesktopFeed } from './lib/desktop.mjs';
import { BoardStore, isThreadId, COLUMNS, runtimeLabel } from './lib/board.mjs';
import { Conversations } from './lib/conversations.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const assets = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'],
  '/chat.js': ['public/chat.js', 'text/javascript'], '/markdown.js': ['public/markdown.js', 'text/javascript'],
  '/styles.css': ['public/styles.css', 'text/css'], '/chat.css': ['public/chat.css', 'text/css'], '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
  '/vendor/marked.js': ['node_modules/marked/lib/marked.esm.js', 'text/javascript'],
  '/vendor/purify.js': ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript'] };

export function createApp({ index, feed, store, openThread = id => execute('/usr/bin/open', [`codex://threads/${id}`]) }) {
  const token = randomBytes(32).toString('hex');
  const conversations = new Conversations(index, feed);
  const streams = new Set();
  let threads = [], indexError = null, closing;
  const refresh = () => {
    try { threads = index.list(); feed.sync(threads.map(thread => thread.id)); indexError = null; }
    catch (error) { indexError = error.message; }
  };
  refresh();
  const timer = setInterval(refresh, 5000);
  timer.unref();
  const nativeTasks = () => threads.map(thread => ({ ...thread, runtime: runtimeLabel(feed.states.get(thread.id)) }));
  const boardResponse = board => ({ ...board, columns: COLUMNS, connection: { connected: feed.connected, message: feed.message }, token, refreshedAt: Date.now() });
  async function snapshot() {
    if (indexError) throw new Error('Cannot read native Codex tasks: ' + indexError);
    return boardResponse(await store.arrange(nativeTasks()));
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (closing) return send(503, { error: 'The server is shutting down.' });
    const port = server.address().port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!hosts.has(req.headers.host) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'This board only accepts requests from its own local page.' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/api/board') { refresh(); return send(200, await snapshot()); }
      if (req.method === 'GET' && assets[url.pathname]) {
        const [name, type] = assets[url.pathname];
        const data = await readFile(join(root, name));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return res.end(data);
      }
      const match = /^\/api\/tasks\/([^/]+)\/(open|move|reset|conversation|events|message|interrupt)$/.exec(url.pathname);
      if (!match) return send(404, { error: 'Not found.' });
      if (req.headers['x-kanban-token'] !== token) return send(403, { error: 'Reload the board before making changes.' });
      const [, id, action] = match;
      if (!isThreadId(id) || !threads.some(thread => thread.id === id)) return send(404, { error: 'Native task not found.' });
      if (['conversation', 'events'].includes(action)) {
        if (req.method !== 'GET') return send(405, { error: 'Use GET for conversation reads.' });
        const limit = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 10000) return send(400, { error: 'Invalid history limit.' });
        if (action === 'conversation') return send(200, await conversations.view(id, limit));
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
        res.flushHeaders();
        streams.add(res);
        const release = conversations.subscribe(id);
        let scheduled, sending = false, dirty = false, last = '', closed = false;
        const update = async () => {
          if (closed) return;
          if (sending) { dirty = true; return; }
          sending = true;
          try {
            const value = JSON.stringify(await conversations.view(id, limit));
            if (!closed && value !== last) { last = value; res.write(`data: ${value}\n\n`); }
          } catch (error) { if (!closed) res.write(`data: ${JSON.stringify({ error: error.message, unavailable: true })}\n\n`); }
          finally { sending = false; if (dirty) { dirty = false; schedule(id); } }
        };
        const schedule = changedId => {
          if (changedId !== id || scheduled || closed) return;
          scheduled = setTimeout(() => { scheduled = null; update(); }, 150);
        };
        conversations.on('update', schedule);
        const heartbeat = setInterval(() => { if (!closed) { res.write(': heartbeat\n\n'); update(); } }, 10000);
        res.on('close', () => { closed = true; clearTimeout(scheduled); clearInterval(heartbeat); conversations.off('update', schedule); release(); streams.delete(res); });
        update();
        return;
      }
      if (req.method !== 'POST') return send(405, { error: 'Use POST for task actions.' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 150000) return send(413, { error: 'Request is too large.' }); }
      let input;
      try { input = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'Invalid JSON.' }); }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'Expected a JSON object.' });
      if (action === 'message' || action === 'interrupt') return send(200, await conversations.act(id, action, input));
      if (action === 'open') { await openThread(id); return send(200, { opened: true, threadId: id }); }
      if (!Number.isSafeInteger(input.expectedLayoutRevision) || input.expectedLayoutRevision < 0) return send(400, { error: 'A valid expectedLayoutRevision is required.' });
      if (closing) return send(503, { error: 'The server is shutting down.' });
      refresh();
      if (indexError) throw new Error('Cannot read native Codex tasks: ' + indexError);
      let board;
      if (action === 'reset') board = await store.reset(id, nativeTasks(), input.expectedLayoutRevision);
      else {
        if (!COLUMNS.includes(input.column) || (input.beforeId != null && !isThreadId(input.beforeId))) return send(400, { error: 'Invalid destination.' });
        board = await store.move(id, input.column, input.beforeId ?? null, nativeTasks(), input.expectedLayoutRevision);
      }
      return send(200, boardResponse(board));
    } catch (error) { return send(error.status ?? 500, { error: error.message, uncertain: error.uncertain ?? false }); }
  });
  return { server, snapshot, close() {
    if (!closing) closing = (async () => {
      clearInterval(timer);
      const stopped = new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
      for (const stream of streams) stream.end();
      await stopped;
      conversations.close(); feed.close(); index.close();
      await store.close();
    })();
    return closing;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const index = new TaskIndex(codexHome);
  const feed = new DesktopFeed(join(codexHome, 'ipc', 'ipc.sock'));
  const store = await BoardStore.open(join(root, '.data', 'board.sqlite'));
  if (store.migrationWarning) console.warn(store.migrationWarning);
  const app = createApp({ index, feed, store });
  feed.start();
  app.server.on('error', async error => { console.error(error.message); process.exitCode = 1; await app.close(); });
  app.server.listen(port, '127.0.0.1', () => console.log(`Codex Kanban: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
