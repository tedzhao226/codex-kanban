import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskCreator } from '../lib/task-creation.mjs';

const id = '11111111-1111-1111-1111-111111111111';
const input = { requestId: '22222222-2222-2222-2222-222222222222', projectId: 'project', prompt: 'Build the requested feature.' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kanban-create-test-')), cwd = join(root, 'project');
  await mkdir(cwd); t.after(() => rm(root, { recursive: true, force: true }));
  const tasks = [], saved = [], opened = [], sent = [];
  let retained = 0;
  const dependencies = {
    index: { home: root, projects: () => [{ id: 'project', rootPaths: [cwd] }], list: () => tasks },
    feed: { connected: true, protocolOK: true, sync() {} },
    conversations: { subscribe: () => { retained++; return () => retained--; }, load: async () => {}, view: async () => ({ canSend: true }),
      act: async (id, action, message) => { sent.push({ id, action, message }); return { accepted: true, turnId: 'turn' }; } },
    openThread: async id => opened.push(id), requestDirectory: join(root, 'requests'),
    saveTask: async params => { saved.push(params); await params.onCreated(id); tasks.push({ id, projectId: 'project', title: params.title, cwd }); return id; },
  };
  return { dependencies, saved, opened, sent, retained: () => retained, create: taskCreator(dependencies) };
}

test('creation saves a native task, opens its owner, and sends exactly the submitted first prompt', async t => {
  const f = await fixture(t);
  const result = await f.create(input);
  assert.equal(result.task.id, id); assert.equal(result.task.projectId, input.projectId); assert.equal(result.accepted, true);
  assert.deepEqual(f.opened, [id]);
  assert.deepEqual(f.sent, [{ id, action: 'message', message: { messageId: input.requestId, intent: 'send', text: input.prompt } }]);
  assert.equal(f.retained(), 0);
});

test('concurrent retries and retries after server restart reuse the task and first prompt', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.create(input), f.create({ ...input })]);
  const replay = await taskCreator(f.dependencies)(input);
  assert.deepEqual(replay, results[0]); assert.deepEqual(results[0], results[1]);
  assert.equal(f.saved.length, 1); assert.equal(f.sent.length, 1);
});

test('a request ID cannot be reused with another prompt', async t => {
  const f = await fixture(t);
  await f.create(input);
  await assert.rejects(f.create({ ...input, prompt: 'Different work' }), error => error.status === 409);
  assert.equal(f.saved.length, 1); assert.equal(f.sent.length, 1);
});

test('invalid input, missing projects, and offline Codex never create tasks', async t => {
  const f = await fixture(t);
  for (const changed of [{ requestId: '../escape' }, { prompt: '' }, { prompt: 'x'.repeat(32001) }, { projectId: 'missing' }]) {
    await assert.rejects(f.create({ ...input, ...changed }), error => error.status === 400);
  }
  f.dependencies.feed.connected = false;
  await assert.rejects(f.create(input), error => error.status === 503 && !error.uncertain);
  assert.equal(f.saved.length, 0);
  f.dependencies.feed.connected = true;
  assert.equal((await f.create(input)).accepted, true);
});

test('a saved task with a disconnected owner is returned for recovery without sending a prompt', async t => {
  const f = await fixture(t);
  f.dependencies.openThread = async () => { f.dependencies.feed.connected = false; };
  f.dependencies.conversations.view = async () => ({ canSend: false });
  await assert.rejects(taskCreator(f.dependencies)(input), error => error.threadId === id && error.uncertain === false);
  await assert.rejects(f.create(input), error => error.threadId === id && error.status === 409);
  assert.equal(f.saved.length, 1); assert.equal(f.sent.length, 0); assert.equal(f.retained(), 0);
});

test('uncertain first-prompt delivery is never repeated, including after restart', async t => {
  const f = await fixture(t);
  let deliveries = 0;
  f.dependencies.conversations.act = async () => { deliveries++; throw Object.assign(new Error('Connection lost after sending'), { uncertain: true }); };
  await assert.rejects(f.create(input), error => error.uncertain && error.threadId === id);
  await assert.rejects(taskCreator(f.dependencies)(input), error => error.uncertain && error.threadId === id);
  assert.equal(deliveries, 1); assert.equal(f.saved.length, 1); assert.equal(f.retained(), 0);
});

test('setup with an unknown native result is retained as uncertain and cannot create a duplicate', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.dependencies.saveTask = async () => { calls++; throw new Error('Setup response was lost'); };
  const create = taskCreator(f.dependencies);
  await assert.rejects(create(input), error => error.uncertain === true);
  await assert.rejects(taskCreator(f.dependencies)(input), error => error.uncertain === true);
  assert.equal(calls, 1);
});
