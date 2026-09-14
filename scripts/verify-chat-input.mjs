import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { BoardStore } from '../lib/board.mjs';

const directory = await mkdtemp(join(tmpdir(), 'kanban-input-'));
const id = '11111111-1111-1111-1111-111111111111';
const updatedAt = Date.now();
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const dataUrl = 'data:image/png;base64,' + png;
await writeFile(join(directory, 'screenshot.png'), Buffer.from(png, 'base64'));
await writeFile(join(directory, 'rollout.jsonl'), '');
const state = { cwd: directory, turns: [{ turnId: 'run-1', status: 'completed', turnStartedAtMs: 1, items: [{ id: 'question', type: 'userMessage',
  text: '<send_user_message_question_reply>' + JSON.stringify([{ questionItemId: 'internal-call', question: 'Where should setup finish?', answer: 'Finish entirely in Kanban' }]) + '</send_user_message_question_reply>' }] }] };
let requests = 0;
const feed = Object.assign(new EventEmitter(), { states: new Map([[id, { threadRuntimeStatus: { type: 'idle' } }]]),
  conversations: new Map([[id, { owner: 'fixture', revision: 1, state }]]), connected: true, protocolOK: true, message: 'Connected to Codex',
  sync() {}, close() {}, retain: () => () => {}, loadHistory: async () => {}, owner: async () => 'fixture',
  request: async (method, params) => {
    requests++;
    const input = method === 'thread-follower-start-turn' ? params.turnStart.request.input : params.input;
    const clientUserMessageId = params.clientUserMessageId ?? params.turnStart.request.clientUserMessageId;
    assert.equal(input.find(part => part.type === 'image').url, dataUrl);
    if (requests === 1) {
      assert.equal(method, 'thread-follower-start-turn');
      assert.equal(input.length, 1);
      state.turns[0].items.push({ id: 'image-only', type: 'userMessage', clientUserMessageId, content: input });
      state.turns[0].status = 'inProgress';
      feed.states.set(id, { threadRuntimeStatus: { type: 'active' } });
      feed.emit('conversation', id); feed.emit('change');
      return { result: { result: { turnId: 'run-1' } } };
    }
    assert.equal(method, 'thread-follower-steer-turn');
    if (requests >= 3) {
      assert.ok(requests <= 4, 'Reopened drafts must not cause duplicate deliveries');
      return { result: { result: { turnId: 'run-1' } } };
    }
    throw new Error('Fixture disconnected after submission');
  } });
const app = createApp({ index: { projects: () => [], list: () => [{ id, cwd: directory, projectId: 'fixture', projectName: 'Fixture', title: 'Question replies and images', updatedAt }], rolloutPath: () => join(directory, 'rollout.jsonl'), close() {} },
  feed, store: await BoardStore.open(join(directory, 'board.sqlite')), openThread: async () => { throw new Error('Fixture must not open Codex'); } });
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');

async function checkBrowser({ base, directory, dataUrl, space, screenshot }) {
  const { default: assert } = await import('node:assert/strict');
  const task = await taskSpace(space || 'Kanban question replies and image input');
  console.log({ taskSpaceId: task.spaceId });
  const page = task.page('p1');
  await page.goto(base); await page.waitForSelector('.card-title');
  console.log(await page.snapshot());
  await page.click('.card-title');
  await page.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('Finish entirely in Kanban'));
  const reply = await page.evaluate(() => document.querySelector('#chat-messages').textContent);
  assert.match(reply, /Where should setup finish\?/); assert.doesNotMatch(reply, /send_user_message_question_reply|questionItemId|internal-call/);
  await page.setInputFiles('#chat-image-files', [directory + '/screenshot.png']);
  await page.waitForFunction(() => document.querySelector('#chat-images img')?.naturalWidth > 0 && !document.querySelector('#chat-send').disabled);
  await page.click('#chat-close'); await page.click('.card-title');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-images img').length), 1);
  await page.reload(); await page.waitForSelector('.card-title'); await page.click('.card-title');
  await page.waitForFunction(() => document.querySelector('#chat-images img')?.naturalWidth > 0 && !document.querySelector('#chat-send').disabled);
  await page.click('#chat-images button');
  assert.equal(await page.evaluate(() => document.querySelector('#chat-send').disabled), true);
  await page.evaluate(dataUrl => {
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), char => char.charCodeAt(0));
    const clipboardData = new DataTransfer(); clipboardData.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.querySelector('#chat-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, dataUrl);
  await page.waitForFunction(() => document.querySelector('#chat-images img')?.naturalWidth > 0 && !document.querySelector('#chat-send').disabled);
  await page.click('#chat-send');
  await page.waitForFunction(() => document.querySelector('.message-images img')?.naturalWidth > 0 && document.querySelector('#chat-images').hidden && document.querySelector('#chat-send').textContent.includes('Steer'));
  console.log('PASS: readable question reply, file selection, panel/reload draft recovery, removal, paste, image-only delivery, and transcript image.');
  await page.setInputFiles('#chat-image-files', [directory + '/screenshot.png']);
  await page.fill('#chat-input', 'Look at this screenshot');
  await page.waitForFunction(() => !document.querySelector('#chat-send').disabled);
  await page.click('#chat-send');
  await page.waitForFunction(() => !document.querySelector('#chat-delivery').hidden && document.querySelector('#chat-error').textContent.includes('Fixture disconnected'));
  const pending = await page.evaluate(() => ({ text: document.querySelector('#chat-input').value, images: document.querySelectorAll('#chat-images img').length,
    disabled: document.querySelector('#chat-send').disabled, attachDisabled: document.querySelector('#chat-attach').disabled }));
  assert.deepEqual(pending, { text: 'Look at this screenshot', images: 1, disabled: true, attachDisabled: true });
  await page.reload(); await page.waitForSelector('.card-title'); await page.click('.card-title');
  await page.waitForFunction(() => !document.querySelector('#chat-delivery').hidden);
  assert.equal(await page.evaluate(() => document.querySelector('#chat-images img')?.alt), 'screenshot.png');
  await page.click('#chat-checked'); await page.click('#chat-images button');
  await page.evaluate(() => {
    const clipboardData = new DataTransfer(); clipboardData.items.add(new File(['<svg/>'], 'unsupported.svg', { type: 'image/svg+xml' }));
    document.querySelector('#chat-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#chat-error').textContent.includes('PNG, JPEG'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-images img').length), 0);
  console.log('PASS: image steering, uncertain-delivery draft retention across reload, duplicate-send guard, and unsupported image feedback.');
  await page.evaluate(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const response = await fetch(url, options);
      if (!String(url).endsWith('/message')) return response;
      return new Promise(resolve => { window.releaseMessage = () => { delete window.releaseMessage; resolve(response); }; });
    };
  });
  for (const nextDraft of ['', 'New guidance typed while delivery is pending']) {
    await page.setInputFiles('#chat-image-files', [directory + '/screenshot.png']);
    await page.fill('#chat-input', 'Guidance sent before reopening');
    await page.waitForFunction(() => !document.querySelector('#chat-send').disabled);
    await page.click('#chat-send');
    await page.waitForFunction(() => Boolean(window.releaseMessage));
    await page.click('#chat-close'); await page.click('.card-title');
    await page.waitForFunction(() => document.querySelector('#chat-status').textContent.includes('Running'));
    if (nextDraft) await page.fill('#chat-input', nextDraft);
    await page.evaluate(() => window.releaseMessage());
    await page.waitForFunction(text => document.querySelector('#chat-input').value === text && document.querySelector('#chat-images').hidden &&
      document.querySelector('#chat-delivery').hidden, nextDraft, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => ({ images: document.querySelectorAll('#chat-images img').length,
      sendDisabled: document.querySelector('#chat-send').disabled, attachDisabled: document.querySelector('#chat-attach').disabled })),
    { images: 0, sendDisabled: !nextDraft, attachDisabled: false });
  }
  await page.reload(); await page.waitForSelector('.card-title'); await page.click('.card-title');
  assert.equal(await page.evaluate(() => document.querySelector('#chat-input').value), 'New guidance typed while delivery is pending');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-images img').length), 0);
  console.log('PASS: reopening during delivery clears sent text and images, restores controls, and preserves newer draft text across reload.');
  if (screenshot) await page.screenshot({ path: screenshot });
  console.log(await page.snapshot());
  if (!space) await task.finish({ keep: [] });
  else await page.goto('about:blank');
}
try {
  const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(`const run = ${checkBrowser.toString()};\nawait run(${JSON.stringify({ base: `http://127.0.0.1:${app.server.address().port}`, directory, dataUrl,
    space: Number(process.env.KANBAN_BROWSER_SPACE) || undefined, screenshot: process.env.KANBAN_SCREENSHOT })});`);
  const [code] = await once(child, 'exit');
  if (code !== 0) process.exitCode = 1;
  else assert.equal(requests, 4);
} finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
