import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { applyPatches } from './patches.mjs';

const MAX_FRAME = 256 * 1024 * 1024;
const KEYS = new Set(['threadRuntimeStatus', 'requests']);
const VERSIONS = { 'thread-owner-discovery': 1, 'thread-follower-load-complete-history': 1,
  'thread-follower-start-turn': 2, 'thread-follower-steer-turn': 1, 'thread-follower-interrupt-turn': 4 };

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
  const next = applyPatches(previous, change.patches ?? [], KEYS);
  next.revision = change.revision;
  return next;
}

export class DesktopFeed extends EventEmitter {
  states = new Map();
  owners = new Map();
  ids = new Set();
  connected = false;
  message = 'Connecting to Codex…';
  stopped = false;
  pending = new Map();
  watched = new Map();
  conversations = new Map();
  protocolOK = true;
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
      this.owners.clear();
      this.conversations.clear();
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Desktop disconnected; delivery could not be confirmed.')); }
      this.pending.clear();
      if (!this.stopped) {
        if (this.message === 'Connected to Codex') this.message = 'Desktop disconnected. Reconnecting…';
        this.emit('change');
        this.timer = setTimeout(() => this.start(), 3000);
        this.timer.unref();
      }
    });
  }
  send(message) { if (this.socket?.writable) this.socket.write(frame(message)); }
  request(method, params, targetClientId, timeout = 15000) {
    if (!this.connected || !this.protocolOK) return Promise.reject(new Error('Connect this task in Codex before continuing.'));
    if (!Object.hasOwn(VERSIONS, method)) return Promise.reject(new Error('Unsupported desktop operation.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Codex did not confirm the request. Check the conversation before retrying.')); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type: 'request', requestId, method, version: VERSIONS[method], params, ...(targetClientId ? { targetClientId } : {}) });
    });
  }
  async owner(id) {
    const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: id });
    if (typeof response.handledByClientId !== 'string' || !response.handledByClientId || response.result?.supportsUntrustedAppInput !== true) {
      throw new Error('This Codex task owner does not support Kanban input. Open it in Codex.');
    }
    return response.handledByClientId;
  }
  retain(id) {
    this.watched.set(id, (this.watched.get(id) ?? 0) + 1);
    if (this.watched.get(id) === 1 && this.connected) { this.follow(id, false); this.follow(id, true); }
    return () => {
      const count = (this.watched.get(id) ?? 1) - 1;
      if (count) this.watched.set(id, count);
      else { this.watched.delete(id); this.conversations.delete(id); }
    };
  }
  async loadHistory(id) {
    const owner = await this.owner(id);
    const response = await this.request('thread-follower-load-complete-history', { conversationId: id }, owner, 30000);
    const revision = response.result.revision;
    if (this.conversations.get(id)?.revision >= revision) return;
    await new Promise((resolve, reject) => {
      const check = () => { if (this.conversations.get(id)?.revision >= revision) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('The conversation stream did not catch up. Reconnect the task.')); }, 10000);
      const cleanup = () => { clearTimeout(timer); this.off('conversation', check); };
      this.on('conversation', check);
      check();
    });
  }
  follow(id, following) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId,
      params: { conversationId: id, hostId: 'local', following } });
  }
  sync(ids) {
    const next = new Set(ids);
    if (this.connected) {
      for (const id of this.ids) if (!next.has(id)) { this.follow(id, false); this.states.delete(id); this.owners.delete(id); this.conversations.delete(id); }
      for (const id of next) if (!this.ids.has(id)) this.follow(id, true);
    }
    this.ids = next;
  }
  receive(message) {
    if (message.type === 'response' && this.pending.has(message.requestId)) {
      const request = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      clearTimeout(request.timer);
      if (message.resultType === 'success') request.resolve(message);
      else request.reject(new Error(message.error === 'no-client-found' ? 'Connect this task in Codex before continuing.' : message.error));
      return;
    }
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.method === 'initialize' && message.resultType === 'success') {
      this.clientId = message.result.clientId;
      this.connected = true;
      this.protocolOK = true;
      this.message = 'Connected to Codex';
      for (const id of this.ids) this.follow(id, true);
      this.emit('change');
    }
    if (message.type !== 'broadcast') return;
    if (message.method === 'client-status-changed') {
      if (message.params.status === 'disconnected') {
        for (const [id, owner] of this.owners) if (owner === message.params.clientId) {
          this.conversations.delete(id); this.states.delete(id); this.owners.delete(id); this.emit('conversation', id);
        }
      }
      for (const id of this.ids) { this.follow(id, false); this.follow(id, true); }
      this.emit('change');
    }
    if (message.method === 'thread-stream-following-status-requested' && this.ids.has(message.params.conversationId)) this.follow(message.params.conversationId, true);
    if (message.method !== 'thread-stream-state-changed' || message.params.hostId !== 'local') return;
    const id = message.params.conversationId;
    if (!this.ids.has(id)) return;
    if (message.version !== 11) {
      this.states.clear();
      this.owners.clear();
      this.conversations.clear();
      this.protocolOK = false;
      this.message = 'Codex changed its status protocol. The board adapter needs an update.';
      this.emit('change');
      return;
    }
    const next = applyRuntimeChange(this.states.get(id), message.params.change);
    if (next) { this.states.set(id, next); this.owners.set(id, message.sourceClientId); }
    else { this.states.delete(id); this.owners.delete(id); this.follow(id, false); this.follow(id, true); }
    if (this.watched.has(id)) {
      const change = message.params.change, previous = this.conversations.get(id);
      if (change.type === 'snapshot') this.conversations.set(id, { owner: message.sourceClientId, revision: change.revision, state: change.conversationState });
      else if (previous?.owner === message.sourceClientId && previous.revision === change.baseRevision) {
        this.conversations.set(id, { ...previous, revision: change.revision, state: applyPatches(previous.state, change.patches ?? []) });
      } else { this.conversations.delete(id); this.follow(id, false); this.follow(id, true); }
      this.emit('conversation', id);
    }
    this.emit('change');
  }
  close() {
    this.stopped = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('The board server stopped.')); }
    this.pending.clear();
    clearTimeout(this.timer);
    if (this.connected) for (const id of this.ids) this.follow(id, false);
    this.socket?.end();
    this.socket?.destroy();
  }
}
