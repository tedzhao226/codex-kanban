import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { BoardStore } from '../lib/board.mjs';

const directory = await mkdtemp(join(tmpdir(), 'kanban-time-filter-'));
const now = Date.UTC(2026, 8, 13, 12);
const day = 86400000;
const ages = [3600000, day, day + 1, 3 * day, 3 * day + 1, 7 * day, 7 * day + 1, 30 * day];
const tasks = ages.map((age, index) => ({
  id: `11111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`,
  title: ['Recent activity', 'Day boundary', 'Beyond day', 'Three-day boundary', 'Beyond three days', 'Week boundary', 'Beyond week', 'Older task'][index],
  cwd: directory, preview: '', createdAt: now - 60 * day, updatedAt: now - age,
  projectId: [0, 1, 3, 6].includes(index) ? 'alpha' : 'beta',
  projectName: [0, 1, 3, 6].includes(index) ? 'Alpha' : 'Beta',
}));
const feed = Object.assign(new EventEmitter(), { states: new Map([[tasks[0].id, { threadRuntimeStatus: { type: 'active' } }]]),
  conversations: new Map(), connected: true, protocolOK: true, message: 'Connected to Codex', sync() {}, close() {} });
const app = createApp({ index: { projects: () => [], list: () => tasks, close() {} }, feed, store: await BoardStore.open(join(directory, 'board.sqlite')),
  openThread: async () => { throw new Error('Native actions are disabled in this fixture.'); },
  openProject: async () => { throw new Error('Native actions are disabled in this fixture.'); } });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');

async function checkBrowser({ base, now, ids, space, screenshot }) {
  const { default: assert } = await import('node:assert/strict');
  const task = await taskSpace(space || 'Kanban time filter regression tests');
  console.log({ taskSpaceId: task.spaceId });
  const page = task.page('p1');
  await page.cdp('Emulation.clearDeviceMetricsOverride');
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.kanbanTestNow = ${now}; Date.now = () => window.kanbanTestNow;` });
  await page.goto(base);
  await page.waitForSelector('.card');
  console.log(await page.snapshot());

  async function expectCards(expected) {
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.card')].map(node => node.dataset.id).sort()), expected.slice().sort());
    const counts = await page.evaluate(() => ({ summary: document.querySelector('#summary').textContent,
      lanes: [...document.querySelectorAll('.column .count')].reduce((sum, node) => sum + Number(node.textContent), 0) }));
    assert.equal(counts.lanes, expected.length);
    assert.equal(counts.summary, `${expected.length} ${expected.length === 1 ? 'task' : 'tasks'} · ${expected.includes(ids[0]) ? 1 : 0} running`);
  }
  async function expectProjectCounts(all, alpha, beta) {
    const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#projects [data-project]')]
      .map(node => [node.dataset.project, Number(node.querySelector('.project-count').textContent)])));
    assert.deepEqual(counts, { '': all, alpha, beta });
  }

  await expectCards(ids);
  await expectProjectCounts(8, 4, 4);
  for (const [value, count, alpha, beta] of [['1', 2, 2, 0], ['3', 4, 3, 1], ['7', 6, 3, 3], ['0', 8, 4, 4]]) {
    await page.selectOption('#time-filter', value);
    await expectCards(ids.slice(0, count));
    await expectProjectCounts(count, alpha, beta);
  }
  console.log('PASS: all ranges use last update and include exact cutoffs; summary, lane, and navigation counts match.');

  await page.selectOption('#time-filter', '1');
  await page.click('[data-project="beta"]');
  await expectCards([]);
  await expectProjectCounts(2, 2, 0);
  assert.equal(await page.evaluate(() => document.querySelector('[data-project="beta"]').getAttribute('aria-pressed')), 'true');
  await page.selectOption('#time-filter', '3');
  await expectCards([ids[2]]);
  console.log('PASS: projects with zero matching cards stay selectable and retain the current selection.');
  await page.click('[data-project="alpha"]');
  await expectCards([ids[0], ids[1], ids[3]]);
  await page.fill('#search', 'boundary');
  await expectCards([ids[1], ids[3]]);
  await expectProjectCounts(4, 3, 1);
  console.log('PASS: time, project, and search filters work together.');

  await page.reload();
  await page.waitForSelector('.card');
  assert.equal(await page.evaluate(() => document.querySelector('#time-filter').value), '3');
  await expectCards(ids.slice(0, 4));
  await expectProjectCounts(4, 3, 1);
  console.log('PASS: selected range survives reload.');

  await page.selectOption('#time-filter', '1');
  await page.evaluate(value => { window.kanbanTestNow = value; }, now + 1);
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1, undefined, { timeout: 10000 });
  await expectCards([ids[0]]);
  await expectProjectCounts(1, 1, 0);
  console.log('PASS: automatic refresh removes expired cards and updates navigation counts.');

  await page.fill('#search', 'older task');
  await expectCards([]);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.empty')].every(node => node.textContent.includes('time range'))), true);
  await page.selectOption('#time-filter', '0');
  await expectCards([ids[7]]);
  await page.fill('#search', '');
  await expectCards(ids);
  console.log('PASS: widening the range restores hidden cards and empty lanes explain the filter.');

  await page.selectOption('#time-filter', '7');
  if (screenshot) await page.screenshot({ path: screenshot });
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobile = await page.evaluate(() => {
    const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    return [...document.querySelectorAll('.toolbar > *')].every(node => {
      if (!node.getClientRects().length) return true;
      const box = node.getBoundingClientRect();
      return box.left >= toolbar.left && box.right <= toolbar.right + 1;
    });
  });
  assert.equal(mobile, true);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-mobile.png') });
  console.log('PASS: toolbar controls fit at 390px width.');
  await page.cdp('Emulation.clearDeviceMetricsOverride');
  if (!space) await task.finish({ keep: [] });
}

try {
  const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(`const run = ${checkBrowser.toString()};\nawait run(${JSON.stringify({ base: `http://127.0.0.1:${app.server.address().port}`,
    now, ids: tasks.map(task => task.id), space: Number(process.env.KANBAN_BROWSER_SPACE) || undefined, screenshot: process.env.KANBAN_SCREENSHOT })});`);
  const [code] = await once(child, 'exit');
  if (code !== 0) process.exitCode = 1;
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
