import { EventEmitter } from 'node:events';
import { runtimeLabel, isThreadId } from './board.mjs';
import { RolloutReader, nativeItems, mergeItems, turnsOf } from './transcript.mjs';

export class Conversations extends EventEmitter {
  readers = new RolloutReader();
  subscriptions = new Map();
  historyLoads = new Map();
  errors = new Map();
  submissions = new Map();
  locks = new Set();
  constructor(index, feed) {
    super(); this.index = index; this.feed = feed;
    this.wasConnected = feed.connected;
    this.onConversation = id => {
      if (this.subscriptions.has(id)) {
        if (this.errors.has(id) && feed.conversations.has(id)) this.load(id);
        this.emit('update', id);
      }
    };
    this.onConnection = () => {
      for (const id of this.subscriptions.keys()) {
        this.emit('update', id);
        if (feed.connected && !this.wasConnected) this.load(id);
      }
      this.wasConnected = feed.connected;
    };
    feed.on('conversation', this.onConversation);
    feed.on('change', this.onConnection);
  }
  subscribe(id) {
    const release = this.feed.retain(id);
    this.subscriptions.set(id, (this.subscriptions.get(id) ?? 0) + 1);
    if (this.subscriptions.get(id) === 1) this.load(id);
    return () => {
      release();
      const count = this.subscriptions.get(id) - 1;
      if (count) this.subscriptions.set(id, count);
      else { this.subscriptions.delete(id); this.readers.release(id); this.errors.delete(id); }
    };
  }
  load(id) {
    if (this.historyLoads.has(id)) return;
    this.errors.delete(id);
    const operation = this.feed.loadHistory(id).catch(error => { if (this.subscriptions.has(id)) this.errors.set(id, error.message); })
      .finally(() => { this.historyLoads.delete(id); this.emit('update', id); });
    this.historyLoads.set(id, operation);
  }
  async view(id, limit = 50) {
    const live = this.feed.conversations.get(id);
    const saved = live && this.readers.cache.has(id) ? this.readers.cache.get(id).items : await this.readers.read(id, this.index.rolloutPath(id));
    const state = live?.state;
    const runtime = runtimeLabel(this.feed.states.get(id));
    const connected = Boolean(this.feed.connected && this.feed.protocolOK && live);
    const turns = turnsOf(state);
    const activeTurn = [...turns].reverse().find(turn => turn.status === 'inProgress');
    const activeTurnId = runtime === 'running' || runtime === 'needs-input' ? activeTurn?.turnId ?? null : null;
    const items = mergeItems(saved, nativeItems(state));
    return { id, items: items.slice(-limit), total: items.length, hasEarlier: items.length > limit,
      revision: live?.revision ?? null, runtime, connected, activeTurnId,
      canSend: connected && runtime === 'idle', canSteer: connected && runtime === 'running' && Boolean(activeTurnId),
      canStop: connected && ['running', 'needs-input'].includes(runtime) && Boolean(activeTurnId),
      needsInput: runtime === 'needs-input', loadingHistory: this.historyLoads.has(id),
      error: this.errors.get(id) ?? null, model: state?.latestModel ?? null };
  }
  async act(id, action, input) {
    if (action === 'message' && (!isThreadId(input.messageId) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000 || !['send', 'steer'].includes(input.intent))) {
      throw Object.assign(new Error('Enter a message of up to 32,000 characters.'), { status: 400 });
    }
    const key = `${id}:${input.messageId}`;
    if (action === 'message' && this.submissions.has(key)) {
      const prior = this.submissions.get(key);
      if (prior.text !== input.text || prior.intent !== input.intent) throw Object.assign(new Error('This message ID was already used.'), { status: 409 });
      return prior.promise;
    }
    if (this.locks.has(id)) throw Object.assign(new Error('Wait for the previous action to finish.'), { status: 409 });
    const operation = this.dispatch(id, action, input);
    if (action === 'message') {
      this.submissions.set(key, { text: input.text, intent: input.intent, promise: operation });
      if (this.submissions.size > 1000) this.submissions.delete(this.submissions.keys().next().value);
    }
    return operation;
  }
  async dispatch(id, action, input) {
    this.locks.add(id);
    let attempted = false;
    try {
      const owner = await this.feed.owner(id);
      const view = await this.view(id);
      if (this.feed.conversations.get(id)?.owner !== owner) throw Object.assign(new Error('The task connection changed. Wait for its conversation to reconnect.'), { status: 409 });
      const state = this.feed.conversations.get(id)?.state;
      if (action === 'interrupt' || input.intent === 'steer') {
        if (!input.expectedTurnId || input.expectedTurnId !== view.activeTurnId || !(action === 'interrupt' ? view.canStop : view.canSteer)) throw Object.assign(new Error('The active run changed. Review its status before trying again.'), { status: 409 });
      } else if (!view.canSend) throw Object.assign(new Error('The task is no longer idle. Review its status before sending.'), { status: 409 });
      let method, params;
      if (action === 'interrupt') {
        method = 'thread-follower-interrupt-turn';
        params = { conversationId: id, mode: 'user-stop', expectedTurnId: input.expectedTurnId };
      } else if (input.intent === 'steer') {
        method = 'thread-follower-steer-turn';
        params = { conversationId: id, input: [{ type: 'text', text: input.text, text_elements: [] }], clientUserMessageId: input.messageId,
          attachments: [], restoreMessage: { text: input.text, cwd: state.cwd,
            context: { workspaceRoots: [state.cwd], collaborationMode: state.latestCollaborationMode, commentAttachments: [] } } };
      } else {
        method = 'thread-follower-start-turn';
        params = { conversationId: id, turnStart: { request: { threadId: id, clientUserMessageId: input.messageId,
          input: [{ type: 'text', text: input.text, text_elements: [] }] }, context: { inheritThreadSettings: true } } };
      }
      attempted = true;
      const response = await this.feed.request(method, params, owner, 30000);
      if (action === 'interrupt' && response.result.ok !== true) throw new Error('Codex did not confirm that the run stopped. Check its current status.');
      this.emit('update', id);
      const acceptedTurnId = response.result.result?.turn?.id ?? response.result.result?.turnId ?? response.result.interruptedTurnId ?? null;
      return { accepted: true, messageId: input.messageId ?? null, turnId: acceptedTurnId,
        notice: response.result.goalPauseError ?? (input.intent === 'steer' && acceptedTurnId && acceptedTurnId !== input.expectedTurnId ? 'Your guidance was accepted, but the active run changed while sending.' : null) };
    } catch (error) {
      throw Object.assign(error, { status: error.status ?? 503, uncertain: attempted });
    } finally { this.locks.delete(id); }
  }
  close() {
    this.feed.off('conversation', this.onConversation);
    this.feed.off('change', this.onConnection);
  }
}
