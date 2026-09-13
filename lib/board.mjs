import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

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
  constructor(path) {
    this.path = path;
    this.state = { version: 1, columns: {}, order: {} };
    if (existsSync(path)) {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (!state || state.version !== 1 || !state.columns || !state.order || Array.isArray(state.columns) || Array.isArray(state.order) || typeof state.columns !== 'object' || typeof state.order !== 'object' ||
          Object.entries(state.columns).some(([id, column]) => !isThreadId(id) || !COLUMNS.includes(column)) ||
          Object.entries(state.order).some(([column, ids]) => !COLUMNS.includes(column) || !Array.isArray(ids) || ids.some(id => !isThreadId(id)))) {
        throw new Error('Invalid board data. Check ' + path);
      }
      this.state = state;
    }
  }
  arrange(threads) {
    return threads.map(thread => ({ ...thread, manual: Object.hasOwn(this.state.columns, thread.id), column: this.state.columns[thread.id] ?? defaultColumn(thread.runtime) }))
      .sort((a, b) => {
        if (a.column !== b.column) return COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column);
        const order = this.state.order[a.column] ?? [];
        const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
        if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
        return b.updatedAt - a.updatedAt;
      });
  }
  move(id, column, beforeId, threads) {
    if (!isThreadId(id) || !COLUMNS.includes(column)) throw new Error('Invalid task or column.');
    if (!threads.some(thread => thread.id === id)) throw new Error('This task is no longer available. Refresh the board.');
    const target = this.arrange(threads).filter(thread => thread.column === column && thread.id !== id).map(thread => thread.id);
    if (beforeId != null && !target.includes(beforeId)) throw new Error('The destination card moved. Refresh and try again.');
    const next = structuredClone(this.state);
    next.columns[id] = column;
    for (const key of COLUMNS) next.order[key] = (next.order[key] ?? []).filter(value => value !== id);
    target.splice(beforeId == null ? target.length : target.indexOf(beforeId), 0, id);
    next.order[column] = target;
    this.save(next);
  }
  reset(id) {
    const next = structuredClone(this.state);
    delete next.columns[id];
    for (const key of COLUMNS) next.order[key] = (next.order[key] ?? []).filter(value => value !== id);
    this.save(next);
  }
  save(next) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.tmp';
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.path);
    this.state = next;
  }
}
