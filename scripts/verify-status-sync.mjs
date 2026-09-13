import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { BoardStore } from '../lib/board.mjs';
import { DesktopFeed } from '../lib/desktop.mjs';

const directory = await mkdtemp(join(tmpdir(), 'kanban-status-browser-'));
const id = '11111111-1111-1111-1111-111111111111';
const rollout = join(directory, 'rollout.jsonl');
await writeFile(rollout, '');
const feed = new DesktopFeed('/unused.sock');
feed.connected = true;
feed.message = 'Connected to Codex';
feed.loadHistory = async () => {};
let revision = 0, status = { type: 'idle' };
function publish(next = status) {
  status = next;
  if (next.type === 'disconnected') {
    feed.connected = false;
    feed.message = 'Desktop disconnected. Reconnecting…';
    feed.states.clear(); feed.conversations.clear(); feed.emit('change');
    return;
  }
  feed.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'fixture-owner',
    params: { hostId: 'local', conversationId: id, change: { type: 'snapshot', revision: ++revision,
      conversationState: { threadRuntimeStatus: status, requests: [], turns: [] } } } });
}
const retain = feed.retain.bind(feed);
feed.retain = id => { const release = retain(id); publish(); return release; };
const app = createApp({ index: { list: () => [{ id, title: 'Status sync fixture', cwd: directory, updatedAt: Date.now(), projectId: 'fixture', projectName: 'Status tests' }],
  rolloutPath: () => rollout, close() {} }, feed, store: await BoardStore.open(join(directory, 'board.sqlite')),
  openThread: async () => { throw new Error('Native actions are disabled in this fixture.'); } });
publish();
const control = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  publish(JSON.parse(body));
  res.end('{}');
});
app.server.listen(0, '127.0.0.1'); control.listen(0, '127.0.0.1');
await Promise.all([once(app.server, 'listening'), once(control, 'listening')]);

async function checkBrowser({ base, controlURL, space }) {
  const { default: assert } = await import('node:assert/strict');
  const task = await taskSpace(space || 'Card status synchronization');
  console.log({ taskSpaceId: task.spaceId });
  const first = task.page('p1'), second = await task.newPage();
  const setup = `
    window.statusTest = { holdNext: false, held: [], released: 0 };
    const interval = window.setInterval;
    window.setInterval = (fn, delay, ...args) => delay === 4000 ? 0 : interval(fn, delay, ...args);
    window.EventSource = class extends EventSource { constructor(...args) { super(...args); window.statusTest.stream = this; } };
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const response = await fetchOriginal(url, options);
      if (url === '/api/board' && window.statusTest.holdNext) {
        window.statusTest.holdNext = false;
        await new Promise(resolve => window.statusTest.held.push(resolve));
        window.statusTest.released++;
      }
      return response;
    };`;
  for (const page of [first, second]) {
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: setup });
    await page.goto(base);
    await page.waitForSelector('.runtime.idle');
    await page.waitForFunction(() => window.statusTest.stream?.readyState === 1);
  }
  console.log(await first.snapshot());
  await first.selectOption('.lane-select', 'done');
  await first.waitForSelector('[data-column="done"] .card');
  await first.evaluate(() => document.activeElement?.blur());
  await second.waitForSelector('[data-column="done"] .card', { timeout: 3000 });
  console.log('PASS: manual lane edits reach another tab with polling disabled.');
  await first.click('.card-title');
  await first.waitForFunction(() => document.querySelector('#chat-status').textContent === 'Idle');
  const publish = status => fetch(controlURL, { method: 'POST', body: JSON.stringify(status) });
  for (const [status, runtime, column, chat] of [
    [{ type: 'active', activeFlags: [] }, 'running', 'running', 'Running'],
    [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, 'needs-input', 'needs-input', 'Waiting for you'],
    [{ type: 'idle' }, 'idle', 'review', 'Idle'],
  ]) {
    await publish(status);
    for (const page of [first, second]) await page.waitForSelector(`[data-column="${column}"] .runtime.${runtime}`, { timeout: 3000 });
    await first.waitForFunction(text => document.querySelector('#chat-status').textContent === text, chat, { timeout: 3000 });
    assert.equal(await first.evaluate(() => document.querySelector('.lane-select').value), 'auto');
  }
  console.log('PASS: cards in both tabs and the conversation agree on running, waiting, and idle; resumed Done returns to automatic lanes.');

  await first.evaluate(() => { window.statusTest.holdNext = true; });
  await first.click('#refresh');
  await first.waitForFunction(() => window.statusTest.held.length === 1);
  await publish({ type: 'active', activeFlags: [] });
  await first.waitForSelector('[data-column="running"] .runtime.running', { timeout: 3000 });
  await first.evaluate(() => window.statusTest.held.shift()());
  await first.waitForFunction(() => window.statusTest.released === 1);
  assert.equal(await first.evaluate(() => document.querySelector('.card').closest('.column').dataset.column), 'running');
  console.log('PASS: a delayed old board response cannot roll back the live status.');

  await second.evaluate(() => document.querySelector('.lane-select').focus());
  await publish({ type: 'systemError' });
  await second.waitForSelector('.runtime.error', { timeout: 3000 });
  assert.equal(await second.evaluate(() => document.querySelector('.card').closest('.column').dataset.column), 'running');
  await second.evaluate(() => document.activeElement.blur());
  await second.waitForSelector('[data-column="needs-input"] .runtime.error', { timeout: 3000 });
  console.log('PASS: runtime badges stay current while lane movement waits for a menu interaction to finish.');
  await publish({ type: 'disconnected' });
  await first.waitForSelector('#connection.offline', { timeout: 3000 });
  await first.waitForSelector('.runtime.not-loaded', { timeout: 3000 });
  console.log('PASS: desktop disconnection clears stale runtime status.');
  console.log(await first.snapshot());
  if (!space) await task.finish({ keep: [] });
  else await second.close();
}

try {
  const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(`const run = ${checkBrowser.toString()};\nawait run(${JSON.stringify({ base: `http://127.0.0.1:${app.server.address().port}`,
    controlURL: `http://127.0.0.1:${control.address().port}`, space: Number(process.env.KANBAN_BROWSER_SPACE) || undefined })});`);
  const [code] = await once(child, 'exit');
  if (code !== 0) process.exitCode = 1;
} finally {
  await app.close();
  await new Promise(resolve => control.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
