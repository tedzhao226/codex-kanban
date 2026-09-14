import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../bin/codex-kanban.mjs', import.meta.url));
const id = '11111111-1111-1111-1111-111111111111', requestId = '22222222-2222-2222-2222-222222222222';
async function fixture(t) {
  const token = 'private-fixture-token', calls = [];
  const task = { id, title: 'Existing task', preview: 'hello', projectId: 'project', projectName: 'Example', column: 'review', runtime: 'idle', layoutRevision: 7 };
  const board = { token, tasks: [task], projects: [{ id: 'project', name: 'Example', rootPaths: ['/tmp/example'] }] };
  const view = { id, runtime: 'idle', connected: true, canSend: true, canSteer: false, canStop: false, activeTurnId: null, items: [{ id: 'message', kind: 'assistant', text: 'hello' }] };
  const state = { failure: null };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: url.pathname, query: url.search, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/board') { res.end(JSON.stringify(board)); return; }
    assert.equal(req.headers['x-kanban-token'], token);
    if (url.pathname.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify(view) + '\n\n'); return;
    }
    if (req.method === 'POST' && state.failure) { res.writeHead(state.failure.status); res.end(JSON.stringify(state.failure.body)); return; }
    let result;
    if (url.pathname.endsWith('/conversation')) result = view;
    else if (url.pathname === '/api/tasks') result = { task, accepted: true, requestId: JSON.parse(body).requestId };
    else if (url.pathname === '/api/projects') result = { project: board.projects[0] };
    else if (/\/(move|reset)$/.test(url.pathname)) result = board;
    else result = { accepted: true };
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  function cli(args, { input = '', stopOn } = {}) {
    const child = spawn(process.execPath, [entry, ...args, '--port', String(server.address().port)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stopOn && stdout.includes(stopOn)) { stopOn = null; child.kill('SIGINT'); } });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(input);
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); });
  }
  return { cli, calls, token, view, state, task };
}

test('CLI lists projects and filtered tasks as JSON without exposing its request token', async t => {
  const { cli, token } = await fixture(t);
  const projects = await cli(['project', 'list', '--json']);
  assert.equal(projects.code, 0); assert.equal(JSON.parse(projects.stdout)[0].id, 'project');
  const tasks = await cli(['task', 'list', '--project', 'project', '--column', 'review', '--search', 'hello', '--json']);
  assert.equal(tasks.code, 0); assert.equal(JSON.parse(tasks.stdout)[0].id, id);
  assert.doesNotMatch(tasks.stdout + projects.stdout, new RegExp(token));
  assert.deepEqual(JSON.parse((await cli(['task', 'list', '--search', 'absent', '--json'])).stdout), []);
});

test('CLI creation reads a multiline prompt from stdin and forwards the exact request identity', async t => {
  const { cli, calls } = await fixture(t);
  const prompt = 'First line\nLiteral `code` and $(text)\n';
  const result = await cli(['task', 'create', '--project', 'project', '--file', '-', '--request-id', requestId, '--json'], { input: prompt });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).task.id, id);
  assert.deepEqual(calls.at(-1).body, { requestId, projectId: 'project', prompt });
});

test('CLI sends, steers and stops with a freshly loaded native turn identity', async t => {
  const { cli, calls, view } = await fixture(t);
  assert.equal((await cli(['task', 'send', id, '--text', 'Continue', '--request-id', requestId])).code, 0);
  assert.equal(calls.at(-2).query, '?live=1'); assert.equal(calls.at(-1).body.intent, 'send');
  Object.assign(view, { runtime: 'running', canSend: false, canSteer: true, canStop: true, activeTurnId: 'native-turn' });
  assert.equal((await cli(['task', 'steer', id, '--text', 'Focus', '--request-id', requestId])).code, 0);
  assert.equal(calls.at(-1).body.expectedTurnId, 'native-turn'); assert.equal(calls.at(-1).body.intent, 'steer');
  assert.equal((await cli(['task', 'stop', id])).code, 0);
  assert.deepEqual(calls.at(-1).body, { expectedTurnId: 'native-turn' });
});

test('CLI uses the board revision for moves and resets and opens the original task ID', async t => {
  const { cli, calls, token } = await fixture(t);
  const moved = await cli(['task', 'move', id, 'done', '--json']);
  assert.equal(moved.code, 0); assert.equal(JSON.parse(moved.stdout).id, id); assert.doesNotMatch(moved.stdout, new RegExp(token));
  assert.deepEqual(calls.at(-1).body, { expectedLayoutRevision: 7, column: 'done', beforeId: null });
  assert.equal((await cli(['task', 'reset', id])).code, 0);
  assert.deepEqual(calls.at(-1).body, { expectedLayoutRevision: 7 });
  assert.equal((await cli(['task', 'open', id])).code, 0); assert.equal(calls.at(-1).path, `/api/tasks/${id}/open`);
});

test('CLI creates projects through the same HTTP operation', async t => {
  const { cli, calls } = await fixture(t);
  const result = await cli(['project', 'create', '/tmp/folder with spaces', '--json']);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).project.id, 'project');
  assert.deepEqual(calls.at(-1), { path: '/api/projects', query: '', body: { path: '/tmp/folder with spaces' } });
});

test('CLI reports conflicts, unavailability, and uncertain delivery with distinct exits and no automatic retry', async t => {
  const { cli, calls, state } = await fixture(t);
  for (const [status, uncertain, code] of [[409, false, 4], [503, false, 3], [503, true, 5]]) {
    state.failure = { status, body: { error: 'Fixture failure', uncertain, threadId: id } };
    const before = calls.length;
    const result = await cli(['task', 'create', '--project', 'project', '--prompt', 'Work', '--request-id', requestId, '--json']);
    assert.equal(result.code, code); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).threadId, id); assert.equal(JSON.parse(result.stderr).requestId, requestId);
    assert.equal(calls.length - before, 2);
  }
});

test('invalid CLI arguments fail before contacting the server', async t => {
  const { cli, calls } = await fixture(t);
  for (const args of [['task', 'open', 'bad-id'], ['task', 'create', '--project', 'project', '--prompt', ''], ['task', 'create', '--project', 'project', '--prompt', 'text', '--file', '-'], ['task', 'list', '--unknown'], ['task', 'move', id, 'wrong']]) {
    const result = await cli(args); assert.equal(result.code, 2, result.stderr);
  }
  assert.equal(calls.length, 0);
});

test('CLI reads saved history and follows JSON events until interrupted', async t => {
  const { cli } = await fixture(t);
  const read = await cli(['task', 'show', id, '--limit', '20', '--json']);
  assert.equal(read.code, 0); assert.equal(JSON.parse(read.stdout).items[0].text, 'hello');
  assert.match((await cli(['task', 'show', id])).stdout, /\[assistant\] hello/);
  const follow = await cli(['task', 'show', id, '--follow', '--json'], { stopOn: 'hello' });
  assert.equal(follow.code, 0); assert.equal(JSON.parse(follow.stdout.trim()).id, id); assert.equal(follow.stderr, '');
});

const controls = '\u001b]52;c;YXR0YWNrZXI=\u0007\r\b\u007f\u009b31m';
const unsafeControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

test('CLI history and follow output escape controls and retain text layout and tool results', async t => {
  const { cli, view } = await fixture(t);
  view.items = [
    { id: 'message', kind: 'assistant', text: 'First\n\tSecond ' + controls },
    { id: 'tool', kind: 'tool', title: 'npm test ' + controls, status: 'failed', detail: 'Assertion failed\n\texpected 1, got 2' },
  ];
  for (const args of [[], ['--follow']]) {
    const result = await cli(['task', 'show', id, ...args], { stopOn: 'expected 1, got 2' });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, unsafeControls);
    assert.match(result.stdout, /First\n\tSecond/);
    assert.ok(result.stdout.includes('\\u001b]52;c;YXR0YWNrZXI=\\u0007\\u000d\\u0008\\u007f\\u009b31m'));
    assert.match(result.stdout, /\[tool\] npm test/);
    assert.match(result.stdout, /failed/);
    assert.match(result.stdout, /Assertion failed\n\texpected 1, got 2/);
  }
});

test('CLI JSON history safely round-trips transcript controls and tool fields', async t => {
  const { cli, view } = await fixture(t);
  view.items = [{ id: 'tool', kind: 'tool', title: 'npm test', status: 'failed', detail: 'Failure\n\t' + controls }];
  const result = await cli(['task', 'show', id, '--json']);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, unsafeControls);
  assert.deepEqual(JSON.parse(result.stdout).items, view.items);
});

test('CLI creation output escapes controls in returned identifiers', async t => {
  const { cli, task } = await fixture(t);
  task.id = id + controls;
  const result = await cli(['task', 'create', '--project', 'project', '--prompt', 'Work']);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, unsafeControls);
  assert.ok(result.stdout.includes(id + '\\u001b'));
});

test('CLI diagnostics escape server errors and identifiers in plain and JSON output', async t => {
  const { cli, state } = await fixture(t);
  state.failure = { status: 503, body: { error: 'Failed\n\t' + controls, threadId: id + controls } };
  const plain = await cli(['task', 'create', '--project', 'project', '--prompt', 'Work']);
  assert.equal(plain.code, 3);
  assert.doesNotMatch(plain.stderr, unsafeControls);
  assert.ok(plain.stderr.includes('Failed\n\t\\u001b'));
  assert.ok(plain.stderr.includes('Task: ' + id + '\\u001b'));
  const json = await cli(['task', 'create', '--project', 'project', '--prompt', 'Work', '--json']);
  assert.equal(json.code, 3);
  assert.doesNotMatch(json.stderr, unsafeControls);
  assert.equal(JSON.parse(json.stderr).error, state.failure.body.error);
  assert.equal(JSON.parse(json.stderr).threadId, state.failure.body.threadId);
});
