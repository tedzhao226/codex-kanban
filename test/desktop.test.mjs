import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DesktopFeed, FrameReader, frame, applyRuntimeChange } from '../lib/desktop.mjs';
import { runtimeLabel } from '../lib/board.mjs';

test('IPC framing accepts split packets and consecutive messages', () => {
  const reader = new FrameReader();
  const messages = [{ hello: '世界' }, { count: 2 }];
  const bytes = Buffer.concat(messages.map(frame));
  assert.deepEqual(reader.push(bytes.subarray(0, 2)), []);
  assert.deepEqual(reader.push(bytes.subarray(2, 6)), []);
  assert.deepEqual(reader.push(bytes.subarray(6)), messages);
  assert.throws(() => new FrameReader().push(Buffer.alloc(4)), /Invalid Codex IPC frame/);
});

test('runtime patches track approval and completion without retaining conversation text', () => {
  const initial = applyRuntimeChange(null, { type: 'snapshot', revision: 1, conversationState: { threadRuntimeStatus: { type: 'active', activeFlags: [] }, requests: [], turns: [{ text: 'private conversation' }] } });
  assert.equal(initial.turns, undefined);
  const waiting = applyRuntimeChange(initial, { type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'add', path: ['requests', 0], value: { id: 'approval' } },
    { op: 'replace', path: ['turns', 0, 'text'], value: 'other private text' },
  ] });
  assert.equal(runtimeLabel(waiting), 'needs-input');
  assert.equal(waiting.turns, undefined);
  const idle = applyRuntimeChange(waiting, { type: 'patches', baseRevision: 2, revision: 3, patches: [
    { op: 'remove', path: ['requests', 0] },
    { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } },
  ] });
  assert.equal(runtimeLabel(idle), 'idle');
  assert.equal(applyRuntimeChange(idle, { type: 'patches', baseRevision: 1, revision: 4, patches: [] }), null);
  assert.throws(() => applyRuntimeChange(idle, { type: 'patches', baseRevision: 3, revision: 4, patches: [{ op: 'add', path: ['requests', '__proto__', 'polluted'], value: true }] }), /Unsafe IPC patch/);
});

test('desktop client subscribes to existing tasks and receives runtime snapshots', { timeout: 5000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-ipc-'));
  const socketPath = join(directory, 'ipc.sock');
  const id = '11111111-1111-1111-1111-111111111111';
  const received = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const reader = new FrameReader();
    socket.on('data', chunk => {
      for (const message of reader.push(chunk)) {
        received.push(message);
        if (message.method === 'initialize') socket.write(frame({ type: 'response', method: 'initialize', resultType: 'success', result: { clientId: 'test-client' } }));
        if (message.method === 'thread-stream-following-changed' && message.params.following) socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, params: { conversationId: id, hostId: 'local', change: { type: 'snapshot', revision: 1, conversationState: { threadRuntimeStatus: { type: 'active', activeFlags: [] }, requests: [] } } } }));
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const feed = new DesktopFeed(socketPath);
  t.after(async () => {
    feed.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const status = new Promise(resolve => feed.on('change', () => { if (feed.states.has(id)) resolve(); }));
  feed.sync([id]);
  feed.start();
  await status;
  assert.equal(feed.connected, true);
  assert.equal(runtimeLabel(feed.states.get(id)), 'running');
  assert.ok(received.some(message => message.params?.conversationId === id && message.params.following));
  assert.equal(received.some(message => /start|resume|turn/.test(message.method)), false);
});

test('selected conversation updates retain one transcript and recover from a missing revision', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const feed = new DesktopFeed('/unused.sock'), sent = [];
  feed.connected = true; feed.send = message => sent.push(message); feed.sync([id]);
  const release = feed.retain(id), releaseOtherViewer = feed.retain(id);
  const publish = change => feed.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
    sourceClientId: 'native-owner', params: { conversationId: id, hostId: 'local', change } });
  const state = { threadRuntimeStatus: { type: 'idle' }, requests: [], turns: [{ items: [{ text: 'Hello' }] }] };
  publish({ type: 'snapshot', revision: 1, conversationState: state });
  publish({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['turns', 0, 'items', 0, 'text'], value: 'Hello again' }] });
  assert.equal(feed.conversations.get(id).state.turns[0].items[0].text, 'Hello again');
  assert.equal(feed.states.get(id).turns, undefined);
  release();
  assert.ok(feed.conversations.has(id));
  sent.length = 0;
  publish({ type: 'patches', baseRevision: 3, revision: 4, patches: [] });
  assert.equal(feed.conversations.has(id), false);
  assert.equal(feed.states.has(id), false);
  assert.ok(sent.some(message => message.params.following === false));
  assert.ok(sent.some(message => message.params.following === true));
  publish({ type: 'snapshot', revision: 4, conversationState: state });
  assert.equal(feed.conversations.get(id).revision, 4);
  releaseOtherViewer();
  assert.equal(feed.conversations.has(id), false);
  assert.equal(runtimeLabel(feed.states.get(id)), 'idle');
  feed.close();
});

test('desktop RPC uses the native owner and rejects pending delivery on shutdown', async () => {
  const feed = new DesktopFeed('/unused.sock'), sent = [];
  feed.connected = true; feed.send = message => sent.push(message);
  const pending = feed.request('thread-follower-steer-turn', { conversationId: 'existing-task' }, 'native-owner');
  assert.equal(sent[0].targetClientId, 'native-owner');
  assert.equal(sent[0].version, 1);
  assert.equal(sent[0].hostId, undefined);
  feed.receive({ type: 'response', requestId: sent[0].requestId, resultType: 'success', result: { turnId: 'same-run' } });
  assert.equal((await pending).result.turnId, 'same-run');
  const interrupted = feed.request('thread-follower-start-turn', {}, 'native-owner');
  const rejected = assert.rejects(interrupted, /server stopped/);
  feed.close();
  await rejected;
});

test('unsupported owner discovery cannot route a message to an unspecified client', async () => {
  const feed = new DesktopFeed('/unused.sock');
  feed.request = async () => ({ result: { supportsUntrustedAppInput: true } });
  await assert.rejects(feed.owner('existing-task'), /does not support/);
  feed.request = async () => ({ handledByClientId: 'native-owner', result: { supportsUntrustedAppInput: true } });
  assert.equal(await feed.owner('existing-task'), 'native-owner');
});

test('owner disconnection clears its board status even without an open conversation', () => {
  const feed = new DesktopFeed('/unused.sock');
  feed.ids = new Set(['first', 'second']);
  for (const id of feed.ids) feed.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
    sourceClientId: id + '-owner', params: { conversationId: id, hostId: 'local', change: { type: 'snapshot', revision: 1,
      conversationState: { threadRuntimeStatus: { type: 'active', activeFlags: [] }, requests: [] } } } });
  feed.receive({ type: 'broadcast', method: 'client-status-changed', params: { status: 'disconnected', clientId: 'first-owner' } });
  assert.equal(feed.states.has('first'), false);
  assert.equal(runtimeLabel(feed.states.get('second')), 'running');
  assert.equal(feed.conversations.size, 0);
});
