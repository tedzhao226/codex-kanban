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
