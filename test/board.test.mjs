import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BoardStore, runtimeLabel } from '../lib/board.mjs';

const a = '11111111-1111-1111-1111-111111111111';
const b = '22222222-2222-2222-2222-222222222222';
const c = '33333333-3333-3333-3333-333333333333';
const absent = '44444444-4444-4444-4444-444444444444';
const tasks = [
  { id: a, runtime: 'not-loaded', updatedAt: 3 },
  { id: b, runtime: 'idle', updatedAt: 2 },
  { id: c, runtime: 'running', updatedAt: 1 },
];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-test-'));
  const path = join(directory, 'board.sqlite'), legacy = join(directory, 'board.json'), stores = [];
  t.after(async () => { for (const store of stores) await store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, legacy, async open() { const store = await BoardStore.open(path); stores.push(store); return store; } };
}

test('defaults reflect native status and never infer completion', async t => {
  const store = await fixture(t).open();
  const { tasks: arranged, boardRevision } = await store.arrange(tasks);
  assert.equal(boardRevision, 0);
  assert.deepEqual(arranged.map(task => [task.id, task.column, task.layoutRevision]), [[a, 'backlog', 0], [c, 'running', 0], [b, 'review', 0]]);
  assert.equal(runtimeLabel({ threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } }), 'needs-input');
  assert.equal(runtimeLabel({ threadRuntimeStatus: { type: 'idle' }, requests: [{ id: 'question' }] }), 'needs-input');
});

test('moving and ordering survive restart; reset retains the revision', async t => {
  const f = fixture(t), store = await f.open();
  await store.move(a, 'done', null, tasks, 0);
  await store.move(b, 'done', a, tasks, 0);
  await store.move(c, 'done', a, tasks, 0);
  await store.close();
  const restarted = await f.open();
  const result = await restarted.arrange(tasks.map(task => ({ ...task, runtime: 'running' })));
  assert.deepEqual(result.tasks.map(task => task.id), [b, c, a]);
  assert.ok(result.tasks.every(task => task.column === 'done' && task.manual && task.layoutRevision === 1));
  await restarted.reset(a, tasks, 1);
  await restarted.close();
  const reopened = await f.open();
  const reset = (await reopened.arrange(tasks)).tasks.find(task => task.id === a);
  assert.equal(reset.column, 'backlog');
  assert.equal(reset.manual, false);
  assert.equal(reset.layoutRevision, 2);
  await assert.rejects(reopened.move(a, 'done', null, tasks, 0), { status: 409 });
});

test('concurrent different-card moves before the same anchor both survive', async t => {
  const store = await fixture(t).open();
  await store.move(c, 'done', null, tasks, 0);
  await Promise.all([store.move(a, 'done', c, tasks, 0), store.move(b, 'done', c, tasks, 0)]);
  const board = await store.arrange(tasks);
  assert.deepEqual(board.tasks.map(task => task.id), [a, b, c]);
  assert.equal(board.boardRevision, 3);
});

for (const secondAction of ['move', 'reset']) test(`concurrent same-card move/${secondAction} accepts one edit`, async t => {
  const store = await fixture(t).open();
  const results = await Promise.allSettled([store.move(a, 'done', null, tasks, 0), secondAction === 'move' ? store.move(a, 'review', null, tasks, 0) : store.reset(a, tasks, 0)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.status, 409);
  const board = await store.arrange(tasks);
  assert.equal(board.tasks.find(task => task.id === a).column, 'done');
  assert.equal(board.boardRevision, 1);
});

test('stale destinations fail without changing stored positions', async t => {
  const store = await fixture(t).open();
  await store.move(a, 'done', null, tasks, 0);
  const before = await store.arrange(tasks);
  await assert.rejects(store.move(b, 'done', c, tasks, 0), { status: 409 });
  assert.deepEqual(await store.arrange(tasks), before);
});

test('legacy migration preserves layout and absent task IDs and archives the source', async t => {
  const f = fixture(t);
  const source = JSON.stringify({ version: 1, columns: { [a]: 'done', [b]: 'done', [absent]: 'done' }, order: { done: [b, absent, a], running: [c] } });
  writeFileSync(f.legacy, source, { mode: 0o600 });
  const store = await f.open();
  const board = await store.arrange([...tasks, { id: absent, runtime: 'idle', updatedAt: 0 }]);
  assert.deepEqual(board.tasks.map(task => task.id), [c, b, absent, a]);
  assert.equal(board.tasks.find(task => task.id === absent).manual, true);
  assert.equal(board.boardRevision, 0);
  assert.equal(readFileSync(f.legacy + '.bak', 'utf8'), source);
  assert.equal(existsSync(f.legacy), false);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test('an existing backup is preserved and initialized SQLite never reimports JSON', async t => {
  const f = fixture(t);
  writeFileSync(f.legacy, JSON.stringify({ version: 1, columns: { [a]: 'done' }, order: {} }));
  writeFileSync(f.legacy + '.bak', 'previous backup');
  const store = await f.open();
  assert.match(store.migrationWarning, /not overwritten/);
  await store.move(a, 'review', null, tasks, 0);
  await store.close();
  writeFileSync(f.legacy, 'interrupted archive; now invalid JSON');
  const restarted = await f.open();
  assert.equal((await restarted.arrange(tasks)).tasks.find(task => task.id === a).column, 'review');
  assert.equal(readFileSync(f.legacy + '.bak', 'utf8'), 'previous backup');
});

for (const source of ['{', JSON.stringify({ version: 1, columns: { [a]: 'typo' }, order: {} })]) test(`invalid migration is reported and can be retried: ${source}`, async t => {
  const f = fixture(t);
  writeFileSync(f.legacy, source);
  await assert.rejects(f.open(), /Invalid board data/);
  assert.equal(readFileSync(f.legacy, 'utf8'), source);
  assert.equal(existsSync(f.legacy + '.bak'), false);
  writeFileSync(f.legacy, JSON.stringify({ version: 1, columns: { [a]: 'done' }, order: {} }));
  const store = await f.open();
  assert.equal((await store.arrange(tasks)).tasks.find(task => task.id === a).column, 'done');
});

test('unsupported and corrupt databases fail explicitly', async t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  db.exec('PRAGMA user_version = 99'); db.close();
  await assert.rejects(f.open(), /Unsupported board database version 99/);
  writeFileSync(f.path, 'not a database');
  await assert.rejects(f.open(), /not a database/);
});

test('a failed transaction rolls back layout and revisions', async t => {
  const f = fixture(t), store = await f.open();
  const db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE ON board_meta BEGIN SELECT RAISE(ABORT, 'test write failure'); END;");
    await assert.rejects(store.move(a, 'done', null, tasks, 0), /test write failure/);
    const board = await store.arrange(tasks);
    assert.equal(board.boardRevision, 0);
    assert.equal(board.tasks.find(task => task.id === a).manual, false);
    assert.equal(board.tasks.find(task => task.id === a).layoutRevision, 0);
  } finally { db.close(); }
});

test('lock timeout reports an unsaved edit and allows later work', { timeout: 5000 }, async t => {
  const f = fixture(t), store = await f.open();
  const lock = new DatabaseSync(f.path);
  lock.exec('BEGIN IMMEDIATE');
  try { await assert.rejects(store.move(a, 'done', null, tasks, 0), { status: 503, message: /not saved/ }); }
  finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal((await store.arrange(tasks)).boardRevision, 0);
  assert.equal((await store.move(a, 'done', null, tasks, 0)).boardRevision, 1);
});

test('worker failure rejects pending operations without replaying them', async t => {
  const f = fixture(t), store = await f.open();
  const lock = new DatabaseSync(f.path);
  lock.exec('BEGIN IMMEDIATE');
  const write = assert.rejects(store.move(a, 'done', null, tasks, 0), { status: 503, uncertain: true });
  const read = assert.rejects(store.arrange(tasks), { status: 503 });
  await store.worker.terminate();
  await Promise.all([write, read]);
  lock.exec('ROLLBACK'); lock.close();
  const restarted = await f.open();
  assert.equal((await restarted.arrange(tasks)).boardRevision, 0);
});

test('shutdown drains accepted work and rejects new operations', async t => {
  const f = fixture(t), store = await f.open();
  const accepted = store.move(a, 'done', null, tasks, 0);
  const closing = store.close();
  await assert.rejects(store.move(b, 'done', null, tasks, 0), { status: 503 });
  await accepted;
  await closing;
  const reopened = await f.open();
  assert.equal((await reopened.arrange(tasks)).tasks.find(task => task.id === a).column, 'done');
});
