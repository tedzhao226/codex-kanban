import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COLUMNS, defaultColumn, isThreadId } from './board.mjs';

let db;
const failure = (message, status = 500) => Object.assign(new Error(message), { status });

function transaction(mode, operation) {
  db.exec(`BEGIN ${mode}`);
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) {
    try { db.exec('ROLLBACK'); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Board transaction and rollback failed. Restart the server.'); }
    throw error;
  }
}

function initialize(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
  db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== 0 && version !== 1) throw failure(`Unsupported board database version ${version}.`);
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw failure('Corrupt board database. Restore a verified backup.');
  if (db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') throw failure('Board storage requires SQLite WAL on a local disk.');
  const legacy = join(dirname(path), 'board.json');
  if (version === 0) transaction('IMMEDIATE', () => {
    if (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) throw failure('Unrecognized board database schema.');
    let state = { columns: {}, order: {} };
    if (existsSync(legacy)) {
      try { state = JSON.parse(readFileSync(legacy, 'utf8')); }
      catch (error) { throw failure(`Invalid board data in ${legacy}: ${error.message}`); }
      if (!state || state.version !== 1 || !state.columns || !state.order || Array.isArray(state.columns) || Array.isArray(state.order) || typeof state.columns !== 'object' || typeof state.order !== 'object' ||
          Object.entries(state.columns).some(([id, column]) => !isThreadId(id) || !COLUMNS.includes(column)) ||
          Object.entries(state.order).some(([column, ids]) => !COLUMNS.includes(column) || !Array.isArray(ids) || ids.some(id => !isThreadId(id)))) throw failure(`Invalid board data. Check ${legacy}`);
    }
    const lanes = COLUMNS.map(column => `'${column}'`).join(',');
    db.exec(`CREATE TABLE card_state (thread_id TEXT PRIMARY KEY, manual_lane TEXT CHECK (manual_lane IN (${lanes})), revision INTEGER NOT NULL CHECK (revision >= 0)) STRICT;
      CREATE TABLE lane_order (lane TEXT NOT NULL CHECK (lane IN (${lanes})), position INTEGER NOT NULL CHECK (position >= 0), thread_id TEXT NOT NULL, PRIMARY KEY (lane, position)) STRICT;
      CREATE TABLE board_meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 0)) STRICT;
      INSERT INTO board_meta VALUES (1, 0); PRAGMA user_version = 1;`);
    const insertCard = db.prepare('INSERT INTO card_state VALUES (?, ?, 0)');
    for (const [id, lane] of Object.entries(state.columns)) insertCard.run(id, lane);
    const insertOrder = db.prepare('INSERT INTO lane_order VALUES (?, ?, ?)');
    for (const [lane, ids] of Object.entries(state.order)) ids.forEach((id, position) => insertOrder.run(lane, position, id));
  });
  readState();
  let migrationWarning = null;
  if (existsSync(legacy)) {
    try { linkSync(legacy, legacy + '.bak'); unlinkSync(legacy); }
    catch (error) {
      if (error.code !== 'EEXIST') throw failure(`SQLite is ready, but the JSON backup could not be archived: ${error.message}`);
      migrationWarning = 'SQLite is authoritative. board.json was retained because board.json.bak already exists; the backup was not overwritten.';
    }
  }
  return { migrationWarning };
}

function readState() {
  const cards = new Map(db.prepare('SELECT * FROM card_state').all().map(card => [card.thread_id, card]));
  const order = Object.fromEntries(COLUMNS.map(lane => [lane, []]));
  for (const row of db.prepare('SELECT * FROM lane_order ORDER BY lane, position').all()) order[row.lane].push(row.thread_id);
  const meta = db.prepare('SELECT revision FROM board_meta WHERE id = 1').get();
  if (!meta) throw failure('Board revision record is missing.');
  return { cards, order, boardRevision: meta.revision };
}

function arrange(state, threads) {
  const tasks = threads.map(thread => {
    const card = state.cards.get(thread.id);
    return { ...thread, manual: card?.manual_lane != null, column: card?.manual_lane ?? defaultColumn(thread.runtime), layoutRevision: card?.revision ?? 0 };
  }).sort((a, b) => {
    if (a.column !== b.column) return COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column);
    const order = state.order[a.column];
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    return b.updatedAt - a.updatedAt;
  });
  return { tasks, boardRevision: state.boardRevision };
}

function edit(method, { id, column, beforeId, threads, expectedLayoutRevision }) {
  if (!isThreadId(id) || !Number.isSafeInteger(expectedLayoutRevision) || expectedLayoutRevision < 0) throw failure('A valid expectedLayoutRevision and task ID are required.', 400);
  if (method === 'move' && (!COLUMNS.includes(column) || (beforeId != null && !isThreadId(beforeId)))) throw failure('Invalid destination.', 400);
  if (!threads.some(thread => thread.id === id)) throw failure('This task is no longer available. Refresh the board.', 404);
  return transaction('IMMEDIATE', () => {
    const state = readState();
    const revision = state.cards.get(id)?.revision ?? 0;
    if (revision !== expectedLayoutRevision) throw failure('Another editor changed this card. Refresh the board and choose again.', 409);
    let target;
    if (method === 'move') {
      target = arrange(state, threads).tasks.filter(thread => thread.column === column && thread.id !== id).map(thread => thread.id);
      if (beforeId != null && !target.includes(beforeId)) throw failure('The destination card moved. Refresh and try again.', 409);
      target.splice(beforeId == null ? target.length : target.indexOf(beforeId), 0, id);
    }
    db.prepare('INSERT INTO card_state VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET manual_lane = excluded.manual_lane, revision = excluded.revision').run(id, method === 'move' ? column : null, revision + 1);
    db.prepare('DELETE FROM lane_order WHERE thread_id = ?').run(id);
    if (target) {
      db.prepare('DELETE FROM lane_order WHERE lane = ?').run(column);
      const insert = db.prepare('INSERT INTO lane_order VALUES (?, ?, ?)');
      target.forEach((taskId, position) => insert.run(column, position, taskId));
    }
    db.exec('UPDATE board_meta SET revision = revision + 1 WHERE id = 1');
    return arrange(readState(), threads);
  });
}

parentPort.on('message', ({ id, method, input }) => {
  try {
    let result;
    if (method === 'initialize') result = initialize(input.path);
    else if (method === 'arrange') result = transaction('DEFERRED', () => arrange(readState(), input.threads));
    else if (method === 'move' || method === 'reset') result = edit(method, input);
    else if (method === 'close') db.close();
    else throw failure(`Unknown board operation: ${method}`);
    parentPort.postMessage({ id, result });
    if (method === 'close') parentPort.close();
  } catch (error) {
    const busy = [5, 6].includes(error.errcode & 255);
    parentPort.postMessage({ id, error: { message: busy ? 'Board database is busy. The edit was not saved; try again.' : error.message, status: busy ? 503 : error.status ?? 500 } });
  }
});
