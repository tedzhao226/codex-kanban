import { Worker } from 'node:worker_threads';

export const COLUMNS = ['backlog', 'running', 'needs-input', 'review', 'done'];
export const isThreadId = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

export function runtimeLabel(live) {
  if (!live) return 'not-loaded';
  const status = live.threadRuntimeStatus;
  if (live.requests?.length || status?.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag))) return 'needs-input';
  if (status?.type === 'active') return 'running';
  if (status?.type === 'systemError') return 'error';
  return status?.type === 'idle' ? 'idle' : 'not-loaded';
}

export function defaultColumn(runtime) {
  return { running: 'running', 'needs-input': 'needs-input', error: 'needs-input', idle: 'review' }[runtime] ?? 'backlog';
}

export class BoardStore {
  static async open(path) {
    const store = new BoardStore();
    try {
      const result = await store.request('initialize', { path });
      store.migrationWarning = result.migrationWarning;
      return store;
    } catch (error) { await store.worker.terminate(); throw error; }
  }
  constructor() {
    this.worker = new Worker(new URL('./board-worker.mjs', import.meta.url));
    this.pending = new Map();
    this.sequence = 0;
    this.exited = new Promise(resolve => this.worker.once('exit', resolve));
    this.worker.on('message', ({ id, result, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error) pending.reject(Object.assign(new Error(error.message), error));
      else pending.resolve(result);
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => {
      if (!this.closing || this.pending.size) this.fail(new Error(`Board storage worker stopped (exit ${code}). Restart the server.`));
    });
  }
  fail(error) {
    this.failure = Object.assign(error, { status: 503 });
    for (const pending of this.pending.values()) pending.reject(Object.assign(new Error(error.message), { status: 503, uncertain: pending.mutation }));
    this.pending.clear();
  }
  request(method, input = {}) {
    if (this.failure || (this.closing && method !== 'close')) return Promise.reject(this.failure ?? Object.assign(new Error('Board storage is closing.'), { status: 503 }));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, mutation: method === 'move' || method === 'reset' });
      try { this.worker.postMessage({ id, method, input }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  arrange(threads) { return this.request('arrange', { threads }); }
  move(id, column, beforeId, threads, expectedLayoutRevision) { return this.request('move', { id, column, beforeId, threads, expectedLayoutRevision }); }
  reset(id, threads, expectedLayoutRevision) { return this.request('reset', { id, threads, expectedLayoutRevision }); }
  close() {
    if (!this.closing) {
      this.closing = this.failure ? this.exited.then(() => {}) : this.request('close').then(() => this.exited).then(() => {});
    }
    return this.closing;
  }
}
