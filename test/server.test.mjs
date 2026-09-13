import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import http from 'node:http';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { BoardStore } from '../lib/board.mjs';

const id = '11111111-1111-1111-1111-111111111111';
async function fixture(t, ids = [id]) {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-server-'));
  const opened = [];
  const storePath = join(directory, 'board.sqlite');
  const rolloutPath = join(directory, 'rollout.jsonl');
  writeFileSync(rolloutPath, '');
  const feed = Object.assign(new EventEmitter(), { states: new Map(), conversations: new Map(), connected: true, protocolOK: true,
    message: 'Connected to Codex', sync() {}, close() {}, retain: () => () => {}, loadHistory: async () => {} });
  const app = createApp({
    index: { list: () => ids.map(id => ({ id, title: 'Existing native chat', runtime: 'idle', updatedAt: 1 })), rolloutPath: () => rolloutPath, close() {} },
    feed,
    store: await BoardStore.open(storePath), openThread: async value => { opened.push(value); },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const board = await (await fetch(base + '/api/board')).json();
  const post = (action, body = {}, headers = {}, taskId = id) => fetch(`${base}/api/tasks/${taskId}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kanban-token': board.token, ...headers }, body: JSON.stringify(body) });
  return { app, base, board, opened, post, storePath, feed };
}

test('board action opens the same native task ID; moves persist separately', async t => {
  const { board, opened, post, storePath } = await fixture(t);
  assert.equal(board.tasks[0].id, id);
  assert.equal((await post('open')).status, 200);
  assert.deepEqual(opened, [id]);
  const moved = await (await post('move', { column: 'done', expectedLayoutRevision: 0 })).json();
  assert.equal(moved.tasks[0].column, 'done');
  const db = new DatabaseSync(storePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT manual_lane FROM card_state WHERE thread_id = ?').get(id).manual_lane, 'done'); }
  finally { db.close(); }
  assert.equal(moved.boardRevision, 1);
  assert.equal(moved.tasks[0].layoutRevision, 1);
  assert.equal((await (await post('reset', { expectedLayoutRevision: 1 })).json()).tasks[0].manual, false);
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
  assert.equal((await post('move', { column: 'done', beforeId: id, expectedLayoutRevision: 0 })).status, 409);
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

const other = '22222222-2222-2222-2222-222222222222';
const anchor = '33333333-3333-3333-3333-333333333333';

test('simultaneous HTTP edits to different cards retain both placements', async t => {
  const { base, post } = await fixture(t, [id, other, anchor]);
  assert.equal((await post('move', { column: 'done', expectedLayoutRevision: 0 }, {}, anchor)).status, 200);
  const responses = await Promise.all([id, other].map(taskId => post('move', { column: 'done', beforeId: anchor, expectedLayoutRevision: 0 }, {}, taskId)));
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  const board = await (await fetch(base + '/api/board')).json();
  assert.deepEqual(new Set(board.tasks.slice(0, 2).map(task => task.id)), new Set([id, other]));
  assert.equal(board.tasks[2].id, anchor);
  assert.equal(board.boardRevision, 3);
});

for (const action of ['move', 'reset']) test(`same-card HTTP move/${action} conflict rejects the stale edit`, async t => {
  const { base, post } = await fixture(t);
  const responses = await Promise.all([post('move', { column: 'done', expectedLayoutRevision: 0 }), post(action, { column: 'review', expectedLayoutRevision: 0 })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const board = await (await fetch(base + '/api/board')).json();
  assert.equal(board.boardRevision, 1);
  assert.equal(board.tasks[0].layoutRevision, 1);
});

test('layout revision is required and must be a nonnegative safe integer', async t => {
  const { base, post } = await fixture(t);
  for (const expectedLayoutRevision of [undefined, null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await post('move', { column: 'done', expectedLayoutRevision })).status, 400);
    assert.equal((await post('reset', { expectedLayoutRevision })).status, 400);
  }
  assert.equal((await (await fetch(base + '/api/board')).json()).boardRevision, 0);
});

test('shutdown rejects unfinished and pipelined requests on an existing connection', { timeout: 5000 }, async t => {
  const { app, base, board, storePath } = await fixture(t);
  const url = new URL(base);
  const socket = connect(Number(url.port), '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  let responses = '';
  socket.setEncoding('utf8').on('data', data => { responses += data; });
  const body = JSON.stringify({ column: 'done', expectedLayoutRevision: 0 });
  const incoming = once(app.server, 'request');
  socket.write(`POST /api/tasks/${id}/move HTTP/1.1\r\nHost: ${url.host}\r\nx-kanban-token: ${board.token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 1)}`);
  await incoming;
  const stopped = app.close();
  assert.equal(app.server.address(), null);
  const closed = once(socket, 'close');
  socket.write(body.slice(1) + `GET /api/board HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
  await closed;
  await stopped;
  assert.equal((responses.match(/HTTP\/1\.1 503/g) || []).length, 2);
  const db = new DatabaseSync(storePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT revision FROM board_meta').get().revision, 0); }
  finally { db.close(); }
});

test('HTTP and conversation streams stay responsive during a board write lock', { timeout: 5000 }, async t => {
  const { base, board, post, storePath, feed } = await fixture(t);
  const abort = new AbortController();
  const response = await fetch(`${base}/api/tasks/${id}/events`, { headers: { 'x-kanban-token': board.token }, signal: abort.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  await reader.read();
  const lock = new DatabaseSync(storePath);
  lock.exec('BEGIN IMMEDIATE');
  let writeFinished = false;
  const write = post('move', { column: 'done', expectedLayoutRevision: 0 }).then(response => { writeFinished = true; return response; });
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal(writeFinished, false);
    feed.conversations.set(id, { owner: 'native-owner', revision: 1, state: { turns: [{ turnId: 'run', turnStartedAtMs: 1,
      items: [{ id: 'answer', type: 'agentMessage', text: 'Still streaming while board is locked' }] }] } });
    feed.emit('conversation', id);
    let streamed = '';
    while (!streamed.includes('Still streaming while board is locked')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      streamed += decoder.decode(value);
    }
    assert.equal(writeFinished, false);
    const failed = await write;
    assert.equal(failed.status, 503);
    assert.match((await failed.json()).error, /not saved/);
  } finally {
    lock.exec('ROLLBACK'); lock.close(); abort.abort();
    await reader.cancel().catch(error => { if (error.name !== 'AbortError') throw error; });
    await write;
  }
  assert.equal((await (await fetch(base + '/api/board')).json()).boardRevision, 0);
});
