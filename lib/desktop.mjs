import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const MAX_FRAME = 256 * 1024 * 1024;
const KEYS = new Set(['threadRuntimeStatus', 'requests']);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameReader {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME) throw new Error('Invalid Codex IPC frame length.');
      if (this.buffer.length < length + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }
}

export function applyRuntimeChange(previous, change) {
  if (change.type === 'snapshot') {
    const state = change.conversationState;
    return { revision: change.revision, threadRuntimeStatus: state.threadRuntimeStatus, requests: state.requests ?? [] };
  }
  if (change.type !== 'patches' || previous?.revision !== change.baseRevision) return null;
  const next = structuredClone(previous);
  for (const patch of change.patches ?? []) {
    const path = patch.path;
    if (!Array.isArray(path) || !KEYS.has(path[0])) continue;
    if (path.some(key => UNSAFE.has(String(key)))) throw new Error('Unsafe IPC patch path.');
    let target = next;
    for (let i = 0; i < path.length - 1; i++) {
      if (target[path[i]] == null) throw new Error('Codex runtime patch is missing its parent.');
      target = target[path[i]];
    }
    const key = path.at(-1);
    if (patch.op === 'remove') {
      if (Array.isArray(target)) target.splice(Number(key), 1); else delete target[key];
    } else if (patch.op === 'add' && Array.isArray(target)) target.splice(Number(key), 0, patch.value);
    else if (patch.op === 'add' || patch.op === 'replace') target[key] = patch.value;
    else throw new Error('Unknown Codex runtime patch operation.');
  }
  next.revision = change.revision;
  return next;
}

export class DesktopFeed extends EventEmitter {
  states = new Map();
  ids = new Set();
  connected = false;
  message = 'Connecting to Codex…';
  stopped = false;
  constructor(socketPath) { super(); this.path = socketPath; }
  start() {
    const socket = net.createConnection(this.path);
    this.socket = socket;
    const reader = new FrameReader();
    socket.on('connect', () => this.send({ type: 'request', requestId: randomUUID(), method: 'initialize', version: 0, params: { clientType: 'codex-kanban' } }));
    socket.on('data', chunk => {
      try { for (const message of reader.push(chunk)) this.receive(message); }
      catch (error) { this.message = error.message; socket.destroy(error); }
    });
    socket.on('error', error => {
      this.message = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'Open Codex to connect live task status.' : `Desktop connection: ${error.message}`;
    });
    socket.on('close', () => {
      this.connected = false;
      this.states.clear();
      if (!this.stopped) {
        if (this.message === 'Connected to Codex') this.message = 'Desktop disconnected. Reconnecting…';
        this.emit('change');
        this.timer = setTimeout(() => this.start(), 3000);
        this.timer.unref();
      }
    });
  }
  send(message) { if (this.socket?.writable) this.socket.write(frame(message)); }
  follow(id, following) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId,
      params: { conversationId: id, hostId: 'local', following } });
  }
  sync(ids) {
    const next = new Set(ids);
    if (this.connected) {
      for (const id of this.ids) if (!next.has(id)) { this.follow(id, false); this.states.delete(id); }
      for (const id of next) if (!this.ids.has(id)) this.follow(id, true);
    }
    this.ids = next;
  }
  receive(message) {
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.method === 'initialize' && message.resultType === 'success') {
      this.clientId = message.result.clientId;
      this.connected = true;
      this.message = 'Connected to Codex';
      for (const id of this.ids) this.follow(id, true);
      this.emit('change');
    }
    if (message.type !== 'broadcast') return;
    if (message.method === 'client-status-changed') {
      if (message.params.status === 'disconnected') this.states.clear();
      for (const id of this.ids) { this.follow(id, false); this.follow(id, true); }
      this.emit('change');
    }
    if (message.method === 'thread-stream-following-status-requested' && this.ids.has(message.params.conversationId)) this.follow(message.params.conversationId, true);
    if (message.method !== 'thread-stream-state-changed' || message.params.hostId !== 'local') return;
    const id = message.params.conversationId;
    if (!this.ids.has(id)) return;
    if (message.version !== 11) {
      this.states.clear();
      this.message = 'Codex changed its status protocol. The board adapter needs an update.';
      this.emit('change');
      return;
    }
    const next = applyRuntimeChange(this.states.get(id), message.params.change);
    if (next) this.states.set(id, next);
    else { this.states.delete(id); this.follow(id, false); this.follow(id, true); }
    this.emit('change');
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.connected) for (const id of this.ids) this.follow(id, false);
    this.socket?.end();
    this.socket?.destroy();
  }
}
