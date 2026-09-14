import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { BoardStore } from '../lib/board.mjs';

const directory = await mkdtemp(join(tmpdir(), 'kanban-board-browser-'));
const tasks = ['Card A', 'Card B', 'Card C'].map((title, index) => ({
  id: `11111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`, title, cwd: directory,
  preview: '', updatedAt: Date.now(), projectId: 'fixture', projectName: 'Board verification',
}));
const feed = Object.assign(new EventEmitter(), { states: new Map(), conversations: new Map(), connected: true,
  protocolOK: true, message: 'Connected to Codex', sync() {}, close() {} });
const app = createApp({ index: { projects: () => [], list: () => tasks, close() {} }, feed,
  store: await BoardStore.open(join(directory, 'board.sqlite')),
  openThread: async () => { throw new Error('Native actions are disabled in this fixture.'); },
  openProject: async () => { throw new Error('Native actions are disabled in this fixture.'); } });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');

async function checkBrowser({ base, ids, space, screenshot }) {
  const { default: assert } = await import('node:assert/strict');
  const task = await taskSpace(space || 'SQLite board concurrency tests');
  console.log({ taskSpaceId: task.spaceId });
  const first = task.page('p1');
  const second = await task.newPage();
  const [a, b, c] = ids;
  const selector = id => `[data-id="${id}"] .lane-select`;
  const setup = `
    window.boardTest = { pausePolling: true, holdNextRead: false, holdActionId: null, held: [], replies: [], completedReads: 0 };
    const originalInterval = window.setInterval;
    window.setInterval = (fn, delay, ...args) => originalInterval(() => { if (delay !== 4000 || !boardTest.pausePolling) fn(...args); }, delay);
    window.EventSource = class extends EventSource {
      constructor(...args) { super(...args); this.addEventListener('message', event => { if (boardTest.pausePolling) event.stopImmediatePropagation(); }); }
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      let response = await originalFetch(input, options);
      const url = String(input), test = window.boardTest;
      if (url === '/api/board' && test.holdNextRead) {
        test.holdNextRead = false;
        const body = await response.clone().json();
        body.tasks[0].title = 'Stale response must not appear';
        response = new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        await new Promise(release => test.held.push(release));
      }
      if (/\\/(move|reset)$/.test(url)) {
        test.replies.push({ url, status: response.status, body: JSON.parse(options.body) });
        if (test.holdActionId && url.includes(test.holdActionId)) {
          test.holdActionId = null;
          await new Promise(release => test.held.push(release));
        }
      }
      if (url === '/api/board') test.completedReads++;
      return response;
    };`;
  for (const page of [first, second]) {
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: setup });
    await page.goto(base);
    await page.waitForSelector('.card');
  }
  console.log(await first.snapshot());
  await first.selectOption(selector(a), 'done');
  await first.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.dataset.layoutRevision === '1', a);

  await second.evaluate(() => { window.boardTest.holdNextRead = true; });
  await second.click('#refresh');
  await second.waitForFunction(() => window.boardTest.held.length === 1);
  await second.selectOption(selector(a), 'review');
  await second.waitForFunction(() => document.querySelector('#toast').textContent.includes('Another editor changed'));
  assert.equal(await second.evaluate(id => document.querySelector(`[data-id="${id}"]`).closest('.column').dataset.column, a), 'done');
  assert.equal(await second.evaluate(() => window.boardTest.replies.at(-1).status), 409);
  let reads = await second.evaluate(() => window.boardTest.completedReads);
  await second.evaluate(() => { window.boardTest.held.shift()(); document.activeElement?.blur(); });
  await second.waitForFunction(count => window.boardTest.completedReads > count, reads);
  assert.equal(await second.evaluate(() => document.body.textContent.includes('Stale response must not appear')), false);
  console.log('PASS: stale edit refreshes without retry; an older equal-revision response cannot replace the refreshed board.');

  await first.evaluate(id => { window.boardTest.holdActionId = id; document.activeElement?.blur(); }, a);
  await first.selectOption(selector(a), 'review');
  await first.waitForFunction(() => window.boardTest.held.length === 1);
  assert.equal(await first.evaluate(id => document.querySelector(`[data-id="${id}"] .lane-select`).disabled, a), true);
  assert.equal(await first.evaluate(id => document.querySelector(`[data-id="${id}"] .lane-select`).disabled, b), false);
  await first.selectOption(selector(b), 'done');
  await first.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.dataset.layoutRevision === '1', b);
  await first.evaluate(() => { window.boardTest.held.shift()(); document.activeElement?.blur(); });
  await first.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.getAttribute('aria-busy') === 'false', a);
  assert.equal(await first.evaluate(id => document.querySelector(`[data-id="${id}"]`).closest('.column').dataset.column, b), 'done');
  console.log('PASS: different cards can be edited while another request is pending; reversed mutation responses preserve both moves.');

  await second.evaluate(id => { document.querySelector(`[data-id="${id}"] .lane-select`).focus(); }, c);
  await first.selectOption(selector(c), 'done');
  await first.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.dataset.layoutRevision === '1', c);
  await second.evaluate(() => { window.boardTest.pausePolling = false; });
  await second.waitForFunction(() => document.querySelector('#sync-time').textContent.includes('Synced'), undefined);
  const latest = await second.fetch('/api/board');
  assert.equal(JSON.parse(latest.body).tasks.find(item => item.id === c).layoutRevision, 1);
  reads = await second.evaluate(() => window.boardTest.completedReads);
  await second.evaluate(() => document.querySelector('#refresh').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await second.waitForFunction(count => window.boardTest.completedReads > count, reads);
  assert.equal(await second.evaluate(id => document.querySelector(`[data-id="${id}"]`).dataset.layoutRevision, c), '0');
  await second.evaluate(() => document.activeElement.blur());
  await second.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.dataset.layoutRevision === '1', c);
  console.log('PASS: refresh defers board replacement while a lane selector has focus, then renders the latest state.');

  await second.evaluate(id => {
    const node = document.querySelector(`[data-id="${id}"]`);
    window.draggedCard = node;
    node.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
  }, c);
  await first.evaluate(() => document.activeElement?.blur());
  await first.selectOption(selector(c), 'review');
  await first.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.dataset.layoutRevision === '2', c);
  reads = await second.evaluate(() => window.boardTest.completedReads);
  await second.evaluate(() => document.querySelector('#refresh').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await second.waitForFunction(count => window.boardTest.completedReads > count, reads);
  assert.equal(await second.evaluate(() => window.draggedCard.isConnected), true);
  const replies = await second.evaluate(() => window.boardTest.replies.length);
  await second.evaluate(() => {
    const target = document.querySelector('.column[data-column="done"]');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: target.getBoundingClientRect().bottom, dataTransfer: new DataTransfer() }));
    window.draggedCard.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  });
  await second.waitForFunction(count => window.boardTest.replies.length > count, replies);
  assert.deepEqual(await second.evaluate(() => { const reply = window.boardTest.replies.at(-1); return [reply.status, reply.body.expectedLayoutRevision]; }), [409, 1]);
  await second.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.dataset.layoutRevision === '2', c);
  console.log('PASS: active drag nodes survive snapshots; dropping uses the observed revision and rejects a stale move.');

  await first.evaluate(() => document.activeElement?.blur());
  await first.selectOption(selector(b), 'review');
  await first.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.dataset.layoutRevision === '2', b);
  await second.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.dataset.layoutRevision === '2', b, { timeout: 7000 });
  console.log('PASS: another tab receives changes through live board synchronization.');
  if (screenshot) await second.screenshot({ path: screenshot });
  if (!space) await task.finish({ keep: [] });
  else await second.close();
}

try {
  const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(`const run = ${checkBrowser.toString()};\nawait run(${JSON.stringify({ base: `http://127.0.0.1:${app.server.address().port}`,
    ids: tasks.map(task => task.id), space: Number(process.env.KANBAN_BROWSER_SPACE) || undefined, screenshot: process.env.KANBAN_SCREENSHOT })});`);
  const [code] = await once(child, 'exit');
  if (code !== 0) process.exitCode = 1;
} finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
