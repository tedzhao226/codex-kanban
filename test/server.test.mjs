import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { BoardStore } from '../lib/board.mjs';

const id = '11111111-1111-1111-1111-111111111111';
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-server-'));
  const opened = [];
  const storePath = join(directory, 'board.json');
  const rolloutPath = join(directory, 'rollout.jsonl');
  writeFileSync(rolloutPath, '');
  const feed = Object.assign(new EventEmitter(), { states: new Map(), conversations: new Map(), connected: true, protocolOK: true,
    message: 'Connected to Codex', sync() {}, close() {}, retain: () => () => {}, loadHistory: async () => {} });
  const app = createApp({
    index: { list: () => [{ id, title: 'Existing native chat', runtime: 'idle', updatedAt: 1 }], rolloutPath: () => rolloutPath, close() {} },
    feed,
    store: new BoardStore(storePath), openThread: async value => { opened.push(value); },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const board = await (await fetch(base + '/api/board')).json();
  const post = (action, body = {}, headers = {}) => fetch(`${base}/api/tasks/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kanban-token': board.token, ...headers }, body: JSON.stringify(body) });
  return { base, board, opened, post, storePath, feed };
}

test('board action opens the same native task ID; moves persist separately', async t => {
  const { board, opened, post, storePath } = await fixture(t);
  assert.equal(board.tasks[0].id, id);
  assert.equal((await post('open')).status, 200);
  assert.deepEqual(opened, [id]);
  const moved = await (await post('move', { column: 'done' })).json();
  assert.equal(moved.tasks[0].column, 'done');
  assert.equal(new BoardStore(storePath).arrange(board.tasks)[0].column, 'done');
  assert.equal((await (await post('reset')).json()).tasks[0].manual, false);
});

test('local API rejects foreign origins, hosts and missing mutation tokens', async t => {
  const { base, post, opened } = await fixture(t);
  assert.equal((await post('open', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('open', {}, { 'x-kanban-token': '' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/board', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(base + '/api/board', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.deepEqual(opened, []);
});

test('invalid card actions return useful errors without changing the board', async t => {
  const { base, post, board } = await fixture(t);
  assert.equal((await post('move', { column: 'other' })).status, 400);
  assert.equal((await post('move', null)).status, 400);
  assert.equal((await post('move', { column: 'done', beforeId: id })).status, 409);
  assert.equal((await fetch(`${base}/api/tasks/00000000-0000-0000-0000-000000000000/open`, { method: 'POST', headers: { 'x-kanban-token': board.token } })).status, 404);
  assert.equal((await (await fetch(base + '/api/board')).json()).tasks[0].column, 'backlog');
});

test('page is served with no-cache and script isolation headers', async t => {
  const { base } = await fixture(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /Codex Kanban/);
});

test('conversation reads and streams require the local token and stream updated messages', { timeout: 5000 }, async t => {
  const { base, board, feed } = await fixture(t);
  const url = `${base}/api/tasks/${id}`;
  assert.equal((await fetch(url + '/conversation')).status, 403);
  assert.equal((await fetch(url + '/events')).status, 403);
  const headers = { 'x-kanban-token': board.token };
  assert.equal((await fetch(url + '/conversation?limit=0', { headers })).status, 400);
  const empty = await (await fetch(url + '/conversation', { headers })).json();
  assert.deepEqual(empty.items, []); assert.equal(empty.canSend, false);
  const abort = new AbortController();
  const response = await fetch(url + '/events', { headers, signal: abort.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  async function nextData() {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (event.startsWith('data: ')) return JSON.parse(event.slice(6));
      } else { const { value, done } = await reader.read(); assert.equal(done, false); buffer += decoder.decode(value); }
    }
  }
  try {
    assert.deepEqual((await nextData()).items, []);
    feed.states.set(id, { threadRuntimeStatus: { type: 'idle' } });
    feed.conversations.set(id, { owner: 'native-owner', revision: 1, state: { turns: [{ turnId: 'same-run', turnStartedAtMs: 1,
      items: [{ id: 'answer', type: 'agentMessage', text: 'Streamed answer' }] }] } });
    feed.emit('conversation', id);
    let update;
    do { update = await nextData(); } while (!update.items.length);
    assert.equal(update.items[0].text, 'Streamed answer'); assert.equal(update.canSend, true);
  } finally { abort.abort(); await reader.cancel().catch(error => { if (error.name !== 'AbortError') throw error; }); }
});
