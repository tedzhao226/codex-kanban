import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, runtimeLabel } from '../lib/board.mjs';

const a = '11111111-1111-1111-1111-111111111111';
const b = '22222222-2222-2222-2222-222222222222';
const c = '33333333-3333-3333-3333-333333333333';
const tasks = [
  { id: a, runtime: 'not-loaded', updatedAt: 3 },
  { id: b, runtime: 'idle', updatedAt: 2 },
  { id: c, runtime: 'running', updatedAt: 1 },
];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'board.json');
}

test('defaults reflect native status and never infer completion', t => {
  const store = new BoardStore(fixture(t));
  const arranged = store.arrange(tasks);
  assert.equal(arranged.find(task => task.id === a).column, 'backlog');
  assert.equal(arranged.find(task => task.id === b).column, 'review');
  assert.equal(arranged.find(task => task.id === c).column, 'running');
  assert.equal(arranged.some(task => task.column === 'done'), false);
  assert.equal(runtimeLabel({ threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } }), 'needs-input');
  assert.equal(runtimeLabel({ threadRuntimeStatus: { type: 'idle' }, requests: [{ id: 'question' }] }), 'needs-input');
});

test('moving and ordering survive restart; manual lanes survive runtime changes', t => {
  const path = fixture(t);
  const store = new BoardStore(path);
  store.move(a, 'done', null, tasks);
  store.move(b, 'done', a, tasks);
  store.move(c, 'done', a, tasks);
  const restarted = new BoardStore(path);
  const result = restarted.arrange(tasks.map(task => ({ ...task, runtime: 'running' })));
  assert.deepEqual(result.map(task => task.id), [b, c, a]);
  assert.ok(result.every(task => task.column === 'done' && task.manual));
  restarted.reset(a);
  const reset = new BoardStore(path).arrange(tasks).find(task => task.id === a);
  assert.equal(reset.column, 'backlog');
  assert.equal(reset.manual, false);
});

test('a stale drop fails without losing saved positions', t => {
  const path = fixture(t);
  const store = new BoardStore(path);
  store.move(a, 'done', null, tasks);
  assert.throws(() => store.move(b, 'done', c, tasks), /destination card moved/);
  assert.deepEqual(new BoardStore(path).arrange(tasks), store.arrange(tasks));
});

test('corrupt board storage is reported instead of silently discarding it', t => {
  const path = fixture(t);
  writeFileSync(path, JSON.stringify({ version: 1, columns: { [a]: 'typo' }, order: {} }));
  assert.throws(() => new BoardStore(path), /Invalid board data/);
});
