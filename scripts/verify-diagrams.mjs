import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { BoardStore } from '../lib/board.mjs';

const directory = await mkdtemp(join(tmpdir(), 'kanban-browser-'));
const id = '11111111-1111-1111-1111-111111111111';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 90"><rect width="300" height="90" rx="12" fill="#c5e4ab"/><text x="20" y="52" font-family="Arial" font-size="24" fill="#25351a">SVG asset preview</text></svg>';
const fence = (language, source) => '```' + language + '\n' + source + '\n```';
const text = '# Diagram previews\n\n' + fence('mermaid', 'flowchart LR\n Browser -->|HTTPS| Server\n Server --> Database') + '\n\n' +
  fence('mermaid', 'sequenceDiagram\n Browser->>Server: Send message\n Server->>Browser: Stream reply') + '\n\n' + fence('svg', svg) + '\n\n![Workspace SVG](diagram.svg)';
await writeFile(join(directory, 'diagram.svg'), svg);
await writeFile(join(directory, 'rollout.jsonl'), '');
const feed = Object.assign(new EventEmitter(), { states: new Map([[id, { threadRuntimeStatus: { type: 'idle' } }]]),
  conversations: new Map([[id, { revision: 1, state: { turns: [{ turnId: 'turn-1', turnStartedAtMs: 1, items: [{ id: 'answer', type: 'agentMessage', text }] }] } }]]),
  connected: true, protocolOK: true, message: 'Connected to fixture', sync() {}, close() {}, retain: () => () => {}, loadHistory: async () => {} });
const app = createApp({ index: { list: () => [{ id, cwd: directory, title: 'Diagram previews', updatedAt: 1 }], rolloutPath: () => join(directory, 'rollout.jsonl'), close() {} },
  feed, store: await BoardStore.open(join(directory, 'board.sqlite')), openThread: async () => {} });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
async function checkBrowser({ base, space, screenshot }) {
  const { default: assert } = await import('node:assert/strict');
  const task = await taskSpace(space || 'Kanban Markdown regression tests');
  console.log({ taskSpaceId: task.spaceId });
  const page = task.page('p1');
  await page.goto(base);
  await page.waitForSelector('.card-title');
  await page.click('.card-title');
  await page.waitForFunction(() => document.querySelectorAll('.diagram-preview img').length === 4 || Boolean(document.querySelector('.diagram-error')));
  const preview = await page.evaluate(() => ({ count: document.querySelectorAll('.diagram-preview img').length, errors: [...document.querySelectorAll('.diagram-error')].map(node => node.textContent) }));
  assert.deepEqual(preview, { count: 4, errors: [] });
  await page.waitForFunction(() => { const timeline = document.querySelector('#chat-timeline'); return timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 80; });
  console.log('PASS: conversation panel renders flowchart, sequence, SVG fence, and workspace SVG image.');

  const checks = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/markdown.js');
    const node = document.createElement('div'); document.body.append(node);
    const fence = (language, source) => '```' + language + '\n' + source + '\n```';
    const result = {};
    await renderMarkdown(node, fence('mermaid', 'not a real diagram'));
    result.invalidMermaid = Boolean(node.querySelector('.diagram-error')) && node.querySelector('code').textContent === 'not a real diagram';
    await renderMarkdown(node, fence('svg', '<svg><broken>'));
    result.invalidSvg = Boolean(node.querySelector('.diagram-error'));
    const malicious = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.svgExecuted=true" viewBox="0 0 40 40"><script>window.svgExecuted=true</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject><rect width="40" height="40" fill="red"/></svg>';
    await renderMarkdown(node, fence('svg', malicious));
    const image = node.querySelector('img');
    const clean = decodeURIComponent(image.src.split(',')[1]);
    result.svgIsolation = !window.svgExecuted && !node.querySelector('svg, script, foreignObject') && !/onload|<script|foreignObject/i.test(clean);
    await renderMarkdown(node, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40"/></svg>');
    result.rawSvg = Boolean(node.querySelector('img')) && !node.querySelector('svg');
    await renderMarkdown(node, '[Drawing](drawing.svg)', { loadSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40"/></svg>' });
    result.svgLink = Boolean(node.querySelector('img'));
    await renderMarkdown(node, '<img src=x onerror="window.htmlExecuted=true">\n\n[unsafe](javascript:alert(1))\n\n' + fence('js', '<svg>ordinary code</svg>'));
    result.markdownIsolation = !window.htmlExecuted && !node.querySelector('img, script, svg, a[href], .diagram') && node.querySelector('code').textContent.includes('<svg>');
    let resolveSvg;
    const pending = renderMarkdown(node, '![Old](old.svg)', { loadSvg: () => new Promise(resolve => { resolveSvg = resolve; }) });
    await renderMarkdown(node, 'New streamed reply');
    resolveSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40"/></svg>');
    await pending;
    result.staleUpdate = node.textContent.trim() === 'New streamed reply' && !node.querySelector('img');
    node.remove(); return result;
  });
  assert.deepEqual(checks, { invalidMermaid: true, invalidSvg: true, svgIsolation: true, rawSvg: true, svgLink: true, markdownIsolation: true, staleUpdate: true });
  console.log('PASS: invalid source, SVG/HTML isolation, ordinary code, and stale streamed updates.');
  if (screenshot) {
    await page.evaluate(() => { document.querySelector('#chat-timeline').scrollTop = 0; });
    await page.screenshot({ path: screenshot });
  }
  console.log(await page.snapshot());
  if (!space) await task.finish({ keep: [] });
}

try {
  const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(`const run = ${checkBrowser.toString()};\nconst verified = await run(${JSON.stringify({ base: `http://127.0.0.1:${app.server.address().port}`,
    space: Number(process.env.KANBAN_BROWSER_SPACE) || undefined, screenshot: process.env.KANBAN_SCREENSHOT })});`);
  const [code] = await once(child, 'exit');
  if (code !== 0) process.exitCode = 1;
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
