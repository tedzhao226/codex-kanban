import { createReadStream } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export function turnsOf(state) {
  if (state?.turnHistory?.kind !== 'canonical') return state?.turns ?? [];
  const history = state.turnHistory.history;
  return history.islands.flatMap(island => island.entries.map(entry => {
    const turn = history.entitiesByKey[entry.value ?? entry.key];
    if (!turn) throw new Error('Native history references a missing turn.');
    return turn;
  }));
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part.text === 'string') return part.text;
    if (/image|audio|file/i.test(part.type ?? '')) return '[Attachment — open in Codex]';
    return '';
  }).filter(Boolean).join('\n');
}

function normalizeItem(item, turnId, timestamp) {
  const type = (item.type ?? '').toLowerCase();
  const base = { id: item.serverUserMessageId ?? item.id, turnId, timestamp,
    clientId: item.clientUserMessageId ?? item.client_id ?? item.clientId ?? null };
  if (!base.id) return null;
  if (['usermessage', 'steeringusermessage', 'agentmessage'].includes(type)) {
    const text = item.text ?? contentText(item.content ?? item.input);
    if (!text) return null;
    return { ...base, kind: type === 'agentmessage' ? 'assistant' : 'user', text,
      phase: item.phase ?? null, pending: type === 'steeringusermessage' && item.status === 'pending' };
  }
  if (type === 'commandexecution') {
    const command = Array.isArray(item.command) ? item.command.join(' ') : item.command ?? 'Command';
    return { ...base, kind: 'tool', title: String(command).slice(0, 180), status: item.status ?? 'completed',
      detail: String(item.aggregatedOutput ?? item.aggregated_output ?? item.stdout ?? '').slice(-4000) };
  }
  const toolTitles = { mcptoolcall: [item.server, item.tool].filter(Boolean).join(' / '),
    filechange: 'File changes', functioncall: item.name, customtoolcall: item.name,
    functioncalloutput: item.name, customtoolcalloutput: item.name,
    subagentactivity: 'Agent activity', websearch: 'Web search', imageview: 'Viewed an image',
    extension: item.kind, contextcompaction: 'Conversation compacted' };
  if (Object.hasOwn(toolTitles, type)) return { ...base, kind: 'tool', title: toolTitles[type] || 'Tool activity', status: item.status ?? 'completed', detail: '' };
  return null;
}

export function nativeItems(state) {
  return turnsOf(state).flatMap(turn => (turn.items ?? []).map(item => normalizeItem(item, turn.turnId,
    turn.turnStartedAtMs ?? 0)).filter(Boolean));
}

export function mergeItems(saved, live) {
  const byId = new Map();
  for (const item of [...saved, ...live]) byId.set(item.id, item);
  const clients = new Map();
  for (const item of byId.values()) if (item.clientId && !item.pending) clients.set(item.clientId, item.id);
  return [...byId.values()].filter(item => !item.clientId || !clients.has(item.clientId) || clients.get(item.clientId) === item.id)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export class RolloutReader {
  cache = new Map();
  async read(id, path) {
    if (!path) throw new Error('No saved conversation file is available for this task.');
    const info = await stat(path);
    const cached = this.cache.get(id);
    if (cached?.size === info.size && cached?.mtime === info.mtimeMs) return cached.items;
    const handle = await open(path, 'r'), lastByte = Buffer.alloc(1);
    try { if (info.size) await handle.read(lastByte, 0, 1, info.size - 1); } finally { await handle.close(); }
    const completeLastLine = lastByte[0] === 10;
    const items = [], legacy = [];
    let turnId = null, completedEvents = false, lineNumber = 0;
    const stream = createReadStream(path, { end: Math.max(0, info.size - 1) });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let previous = null;
    function consume(line) {
      lineNumber++;
      let record;
      try { record = JSON.parse(line); } catch { throw new SyntaxError(`Invalid saved conversation record at line ${lineNumber}.`); }
      const p = record.payload;
      if (record.type !== 'event_msg') return;
      if (p.type === 'task_started') turnId = p.turn_id;
      const time = p.started_at_ms ?? Date.parse(record.timestamp);
      const timestamp = Number.isFinite(time) ? time : 0;
      if (p.type === 'item_completed') {
        completedEvents = true;
        const item = normalizeItem(p.item, p.turn_id ?? turnId, timestamp);
        if (item) items.push(item);
      }
      if (p.type === 'user_message' || p.type === 'agent_message') legacy.push({ id: `legacy:${lineNumber}`,
        turnId, timestamp, kind: p.type === 'user_message' ? 'user' : 'assistant', text: p.message ?? '', clientId: null });
    }
    try {
      for await (const line of lines) { if (previous !== null) consume(previous); previous = line; }
      if (previous) {
        try { consume(previous); }
        catch (error) { if (completeLastLine || !(error instanceof SyntaxError)) throw error; }
      }
    } finally { lines.close(); stream.destroy(); }
    const result = mergeItems(completedEvents ? items : legacy, []);
    this.cache.set(id, { size: info.size, mtime: info.mtimeMs, items: result });
    return result;
  }
  release(id) { this.cache.delete(id); }
}
