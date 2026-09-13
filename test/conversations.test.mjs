import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { turnsOf, nativeItems, mergeItems, RolloutReader } from '../lib/transcript.mjs';
import { applyPatches } from '../lib/patches.mjs';
import { Conversations } from '../lib/conversations.mjs';

const id = '11111111-1111-1111-1111-111111111111', messageId = '22222222-2222-2222-2222-222222222222';
const turn = { turnId: 'run-1', status: 'completed', turnStartedAtMs: 1000, items: [
  { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] },
  { id: 'reason-1', type: 'reasoning', raw_content: 'PRIVATE REASONING' },
  { id: 'agent-1', type: 'agentMessage', text: 'Hello back' },
] };
const canonical = { turns: [], turnHistory: { kind: 'canonical', history: { entitiesByKey: { first: turn }, islands: [{ entries: [{ key: 'first', value: 'first' }] }] } } };
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'kanban-chat-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'rollout.jsonl'); }
function record(item, timestamp = '2026-09-13T00:00:00Z') { return JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'item_completed', turn_id: 'run-1', item } }) + '\n'; }

test('canonical and legacy conversations show the same messages without internal reasoning', () => {
  assert.deepEqual(nativeItems(canonical), nativeItems({ turns: [turn] }));
  assert.deepEqual(nativeItems(canonical).map(item => item.text), ['Hello', 'Hello back']);
  assert.doesNotMatch(JSON.stringify(nativeItems(canonical)), /PRIVATE REASONING/);
});

test('streamed edits update existing bubbles and reconcile accepted message IDs', () => {
  const saved = nativeItems(canonical);
  const changed = applyPatches(canonical, [{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'first', 'items', 2, 'text'], value: 'Updated answer' }]);
  const merged = mergeItems(saved, nativeItems(changed));
  assert.equal(merged.length, 2);
  assert.equal(merged[1].text, 'Updated answer');
  assert.equal(mergeItems([{ ...saved[0], clientId: messageId, pending: true }], [{ ...saved[0], id: 'accepted-user', clientId: messageId }]).length, 1);
  assert.equal(turnsOf(canonical)[0].items[2].text, 'Hello back');
});

test('saved history omits system payloads, deduplicates events, and accepts an incomplete growing tail', async t => {
  const path = temp(t), reader = new RolloutReader();
  const user = { id: 'user-1', type: 'UserMessage', content: [{ type: 'text', text: 'Hello' }] };
  writeFileSync(path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: 'SECRET INSTRUCTIONS' } }) + '\n' + record(user) + record(user) + '{"type":');
  const items = await reader.read(id, path);
  assert.equal(items.length, 1); assert.equal(items[0].text, 'Hello');
  assert.doesNotMatch(JSON.stringify(items), /SECRET/);
  appendFileSync(path, '"other"}\n');
  assert.equal((await reader.read(id, path)).length, 1);
});

test('complete corrupt history fails clearly rather than silently dropping records', async t => {
  const path = temp(t); writeFileSync(path, 'invalid json\n');
  await assert.rejects(new RolloutReader().read(id, path), /Invalid saved conversation record/);
});

function fixture(t, active = false) {
  const path = temp(t); writeFileSync(path, '');
  const state = { turns: [{ ...structuredClone(turn), status: active ? 'inProgress' : 'completed' }], cwd: '/existing/worktree', latestModel: 'existing-model', latestCollaborationMode: { mode: 'plan' } };
  const calls = [];
  const feed = Object.assign(new EventEmitter(), { connected: true, protocolOK: true,
    states: new Map([[id, { threadRuntimeStatus: { type: active ? 'active' : 'idle' } }]]),
    conversations: new Map([[id, { owner: 'native-owner', revision: 1, state }]]),
    owner: async () => 'native-owner',
    request: async (method, params, owner) => { calls.push({ method, params, owner }); return { result: { ok: true, result: { turnId: 'run-1' } } }; },
  });
  const chats = new Conversations({ rolloutPath: () => path }, feed);
  t.after(() => chats.close());
  return { chats, feed, calls };
}

test('idle replies target the existing owner and inherit native settings', async t => {
  const { chats, calls } = fixture(t);
  const result = await chats.act(id, 'message', { messageId, text: 'Continue', intent: 'send' });
  assert.equal(result.accepted, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'native-owner');
  assert.equal(calls[0].method, 'thread-follower-start-turn');
  assert.deepEqual(calls[0].params.turnStart, { request: { threadId: id, clientUserMessageId: messageId, input: [{ type: 'text', text: 'Continue', text_elements: [] }] }, context: { inheritThreadSettings: true } });
});

test('an active run receives steering without a new turn or changed permissions', async t => {
  const { chats, calls } = fixture(t, true);
  await chats.act(id, 'message', { messageId, text: 'Focus on tests', intent: 'steer', expectedTurnId: 'run-1' });
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'thread-follower-steer-turn');
  assert.deepEqual(calls[0].params.input, [{ type: 'text', text: 'Focus on tests', text_elements: [] }]);
  assert.equal(calls[0].params.conversationId, id);
  assert.deepEqual(calls[0].params.restoreMessage.context.workspaceRoots, ['/existing/worktree']);
});

test('stale steering never starts a replacement turn', async t => {
  const { chats, calls } = fixture(t, true);
  await assert.rejects(chats.act(id, 'message', { messageId, text: 'Focus', intent: 'steer', expectedTurnId: 'old-run' }), /active run changed/);
  assert.equal(calls.length, 0);
});

test('stop targets the displayed active run', async t => {
  const { chats, calls } = fixture(t, true);
  await chats.act(id, 'interrupt', { expectedTurnId: 'run-1' });
  assert.deepEqual(calls[0], { method: 'thread-follower-interrupt-turn', params: { conversationId: id, mode: 'user-stop', expectedTurnId: 'run-1' }, owner: 'native-owner' });
});

test('a declined native stop is reported instead of acknowledged', async t => {
  const { chats, feed } = fixture(t, true);
  feed.request = async () => ({ result: { ok: false } });
  await assert.rejects(chats.act(id, 'interrupt', { expectedTurnId: 'run-1' }), /did not confirm/);
});

test('duplicate submissions share one native request even when delivery becomes uncertain', async t => {
  const { chats, feed, calls } = fixture(t);
  feed.request = async () => { calls.push('sent'); throw new Error('Desktop disconnected'); };
  const input = { messageId, text: 'Continue', intent: 'send' };
  await assert.rejects(chats.act(id, 'message', input), error => error.uncertain === true);
  await assert.rejects(chats.act(id, 'message', input), /disconnected/);
  assert.equal(calls.length, 1);
});

test('history pagination and disconnected controls remain read-only', async t => {
  const { chats, feed } = fixture(t);
  const page = await chats.view(id, 1);
  assert.equal(page.items.length, 1); assert.equal(page.hasEarlier, true);
  feed.connected = false;
  const offline = await chats.view(id);
  assert.equal(offline.canSend, false); assert.equal(offline.canSteer, false); assert.equal(offline.canStop, false);
});
