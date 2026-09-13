import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once, EventEmitter } from 'node:events';
import http from 'node:http';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { BoardStore } from '../lib/board.mjs';

const id = '11111111-1111-1111-1111-111111111111';
const entry = new URL('../server.mjs', import.meta.url);

test('starting without a Codex task database exits with a clear message instead of a stack trace', async t => {
  const home = mkdtempSync(join(tmpdir(), 'kanban-empty-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(entry)], { env: { ...process.env, CODEX_HOME: home, PORT: '4317' } }).catch(error => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no Codex task database at .*state_5\.sqlite/);
  assert.match(result.stderr, /CODEX_HOME/);
  assert.doesNotMatch(result.stderr, /at .* \(.*:\d+:\d+\)/);
});
async function fixture(t, ids = [id], options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-server-'));
  const opened = [];
  const storePath = join(directory, 'board.sqlite');
  const rolloutPath = join(directory, 'rollout.jsonl');
  writeFileSync(rolloutPath, '');
  const feed = Object.assign(new EventEmitter(), { states: new Map(), conversations: new Map(), connected: true, protocolOK: true,
    message: 'Connected to Codex', sync() {}, close() {}, retain: () => () => {}, loadHistory: async () => {} });
  const projects = [];
  const index = { projects: () => projects, list: () => ids.map(id => ({ id, cwd: directory, title: 'Existing native chat', updatedAt: 1 })), rolloutPath: () => rolloutPath, close() {} };
  const app = createApp({
    index,
    feed,
    store: await BoardStore.open(storePath), openThread: async value => { opened.push(value); },
    openProject: async url => { projects.push({ id: 'new-project', name: 'New project', rootPaths: [new URL(url).searchParams.get('path')] }); },
    requestDirectory: join(directory, 'task-requests'),
    saveTask: options.saveTask ?? (async () => { throw new Error('Unexpected native task creation in a fixture.'); }),
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const board = await (await fetch(base + '/api/board')).json();
  const post = (action, body = {}, headers = {}, taskId = id) => fetch(`${base}/api/tasks/${taskId}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kanban-token': board.token, ...headers }, body: JSON.stringify(body) });
  return { app, base, board, opened, post, storePath, feed, directory, index };
}

async function boardEvents(t, base) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(base + '/api/board/events', { signal: controller.signal, headers: { Connection: 'close' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  async function* events() {
    let buffer = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (event.startsWith('data: ')) yield event.slice(6);
      }
    }
  }
  const stream = events();
  await stream.next();
  return stream;
}

test('native index changes notify board viewers without a desktop status event', { timeout: 3000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { base, index } = await fixture(t);
  const events = await boardEvents(t, base);
  t.mock.method(index, 'list', () => []);
  t.mock.timers.tick(5000);
  assert.equal((await events.next()).done, false);
  assert.deepEqual((await (await fetch(base + '/api/board')).json()).tasks, []);
});

test('an index read failure and its recovery notify viewers without a refresh loop', { timeout: 3000 }, async t => {
  const { setTimeout: delay } = await import('node:timers/promises');
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { base, index } = await fixture(t);
  const events = await boardEvents(t, base);
  const list = t.mock.method(index, 'list', () => { throw new Error('Native SQLite is busy.'); });
  t.mock.timers.tick(5000);
  assert.equal((await events.next()).done, false);
  assert.equal((await fetch(base + '/api/board')).status, 500);
  const next = events.next();
  assert.equal(await Promise.race([next, delay(350, 'no repeated notification')]), 'no repeated notification');
  list.mock.restore();
  t.mock.timers.tick(5000);
  assert.equal((await next).done, false);
  assert.equal((await fetch(base + '/api/board')).status, 200);
});

for (const [status, runtime, column] of [
  [{ type: 'active', activeFlags: [] }, 'running', 'running'],
  [{ type: 'active', activeFlags: ['waitingOnApproval'] }, 'needs-input', 'needs-input'],
  [{ type: 'idle' }, 'idle', 'review'],
  [{ type: 'systemError' }, 'error', 'needs-input'],
]) test(`board viewers are notified when Codex becomes ${runtime}`, { timeout: 3000 }, async t => {
  const { base, feed } = await fixture(t);
  const events = await boardEvents(t, base);
  feed.states.set(id, { threadRuntimeStatus: status });
  feed.emit('change');
  assert.equal((await events.next()).done, false);
  const board = await (await fetch(base + '/api/board')).json();
  assert.equal(board.tasks[0].runtime, runtime);
  assert.equal(board.tasks[0].column, column);
});

test('board viewers receive layout edits and desktop disconnection', { timeout: 3000 }, async t => {
  const { base, feed, post } = await fixture(t);
  const events = await boardEvents(t, base);
  await post('move', { column: 'done', expectedLayoutRevision: 0 });
  assert.equal((await events.next()).done, false);
  assert.equal((await (await fetch(base + '/api/board')).json()).tasks[0].column, 'done');
  feed.connected = false;
  feed.message = 'Desktop disconnected. Reconnecting…';
  feed.emit('change');
  assert.equal((await events.next()).done, false);
  assert.equal((await (await fetch(base + '/api/board')).json()).connection.connected, false);
});

test('a run that finishes between board reads still releases manual Done', async t => {
  const { base, feed, post } = await fixture(t);
  await post('move', { column: 'done', expectedLayoutRevision: 0 });
  feed.states.set(id, { threadRuntimeStatus: { type: 'active', activeFlags: [] } });
  feed.emit('change');
  feed.states.set(id, { threadRuntimeStatus: { type: 'idle' } });
  feed.emit('change');
  const board = await (await fetch(base + '/api/board')).json();
  assert.equal(board.tasks[0].column, 'review');
  assert.equal(board.tasks[0].manual, false);
  assert.equal(board.tasks[0].layoutRevision, 2);
});

test('status synchronization retries after a SQLite lock without another desktop event', { timeout: 4000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { base, feed, post, storePath } = await fixture(t);
  assert.equal((await post('move', { column: 'done', expectedLayoutRevision: 0 })).status, 200);
  const events = await boardEvents(t, base);
  const db = new DatabaseSync(storePath);
  t.after(() => db.close());
  db.exec('BEGIN IMMEDIATE');
  try {
    feed.states.set(id, { threadRuntimeStatus: { type: 'active', activeFlags: [] } });
    feed.emit('change');
    assert.match(JSON.parse((await events.next()).value).error, /Cannot sync card status/);
    assert.equal(db.prepare('SELECT manual_lane FROM card_state WHERE thread_id = ?').get(id).manual_lane, 'done');
  } finally { db.exec('ROLLBACK'); }
  t.mock.timers.tick(5000);
  assert.deepEqual(JSON.parse((await events.next()).value), {});
  const saved = db.prepare('SELECT manual_lane, revision FROM card_state WHERE thread_id = ?').get(id);
  assert.equal(saved.manual_lane, null);
  assert.equal(saved.revision, 2);
  const board = await (await fetch(base + '/api/board')).json();
  assert.equal(board.tasks[0].column, 'running');
  assert.equal(board.tasks[0].layoutRevision, saved.revision);
});

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

test('project creation requires local authorization and publishes projects with no tasks', async t => {
  const { base, board, directory, feed } = await fixture(t, []);
  const input = { path: join(directory, 'empty-project') };
  const post = headers => fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ 'x-kanban-token': board.token, Origin: 'https://foreign.example' })).status, 403);
  feed.connected = false;
  assert.equal((await post({ 'x-kanban-token': board.token })).status, 503);
  feed.connected = true;
  const response = await post({ 'x-kanban-token': board.token });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).project.id, 'new-project');
  const refreshed = await (await fetch(base + '/api/board')).json();
  assert.equal(refreshed.projects[0].id, 'new-project');
  assert.deepEqual(refreshed.tasks, []);
});

test('invalid card actions return useful errors without changing the board', async t => {
  const { base, post, board } = await fixture(t);
  assert.equal((await post('move', { column: 'other' })).status, 400);
  assert.equal((await post('move', null)).status, 400);
  assert.equal((await post('move', { column: 'done', beforeId: id, expectedLayoutRevision: 0 })).status, 409);
  assert.equal((await fetch(`${base}/api/tasks/00000000-0000-0000-0000-000000000000/open`, { method: 'POST', headers: { 'x-kanban-token': board.token } })).status, 404);
  assert.equal((await (await fetch(base + '/api/board')).json()).tasks[0].column, 'backlog');
});

test('task creation requires local authorization and returns the confirmed native identity', async t => {
  let f, saves = 0, prompts = 0;
  f = await fixture(t, [], { saveTask: async params => {
    saves++; await params.onCreated(id);
    f.index.list = () => [{ id, projectId: 'project', title: 'New native task', cwd: f.directory }];
    f.feed.states.set(id, { threadRuntimeStatus: { type: 'idle' } });
    f.feed.conversations.set(id, { owner: 'fixture', state: { turns: [] } });
    return id;
  } });
  f.index.projects().push({ id: 'project', name: 'Fixture project', rootPaths: [f.directory] });
  f.feed.owner = async () => 'fixture';
  f.feed.request = async () => { prompts++; return { result: { result: { turnId: 'first-turn' } } }; };
  const body = JSON.stringify({ requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', projectId: 'project', prompt: 'Start the task.' });
  const post = headers => fetch(f.base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ 'x-kanban-token': f.board.token, Origin: 'https://foreign.example' })).status, 403);
  assert.equal(saves, 0);
  const response = await post({ 'x-kanban-token': f.board.token });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.task.id, id); assert.equal(created.turnId, 'first-turn');
  assert.equal((await post({ 'x-kanban-token': f.board.token })).status, 201);
  assert.equal(saves, 1); assert.equal(prompts, 1);
  assert.equal((await (await fetch(f.base + '/api/board')).json()).tasks[0].id, id);
});

test('page is served with no-cache and script isolation headers', async t => {
  const { base } = await fixture(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /Codex Kanban/);
});

test('image messages pass authenticated HTTP validation and reach the native input', async t => {
  const { post, feed } = await fixture(t);
  const images = [{ name: 'screenshot.png', dataUrl: 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(160000)]).toString('base64') }];
  const calls = [];
  feed.states.set(id, { threadRuntimeStatus: { type: 'idle' } });
  feed.conversations.set(id, { owner: 'fixture', state: { turns: [] } });
  feed.owner = async () => 'fixture';
  feed.request = async (method, params) => { calls.push(params.turnStart.request.input); return { result: { result: { turnId: 'run' } } }; };
  const input = { messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', text: '', intent: 'send', images };
  assert.equal((await post('message', input, { 'x-kanban-token': '' })).status, 403);
  assert.equal((await post('message', input, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('message', input)).status, 200);
  assert.deepEqual(calls, [[{ type: 'image', url: images[0].dataUrl }]]);
  assert.equal((await post('message', { ...input, images: [{ ...images[0], dataUrl: 'data:image/png;base64,SGVsbG8=' }] })).status, 400);
  assert.equal((await post('message', { ...input, images: [{ ...images[0], dataUrl: 'x'.repeat(4400000) }] })).status, 413);
  assert.equal(calls.length, 1);
});

test('SVG previews require the local token and return workspace assets as JSON', async t => {
  const { base, post, directory } = await fixture(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Local preview</text></svg>';
  writeFileSync(join(directory, 'diagram.svg'), svg);
  assert.equal((await post('svg', { path: 'diagram.svg' }, { 'x-kanban-token': '' })).status, 403);
  assert.equal((await post('svg', { path: 'diagram.svg' }, { Origin: 'https://untrusted.example' })).status, 403);
  const response = await post('svg', { path: 'diagram.svg' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), { svg });
  assert.equal((await fetch(base + '/vendor/mermaid/mermaid.esm.min.mjs')).status, 200);
  assert.equal((await fetch(base + '/vendor/mermaid/package.json')).status, 404);
  assert.equal((await fetch(base + '/vendor/mermaid/chunks/mermaid.esm.min/missing.mjs')).status, 404);
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
