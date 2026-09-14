import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Integration experiment: all projects and tasks belong to a temporary Codex home.
const binary = process.env.KANBAN_CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex';
const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-kanban-shared-')));
const codexDirectory = join(directory, 'codex');
const workspace = join(directory, 'project');
await Promise.all([mkdir(codexDirectory), mkdir(workspace)]);

const answer = 'Shared-server fixture completed.';
let modelRequests = 0;
let releaseModel;
const modelMayRespond = new Promise(resolve => { releaseModel = resolve; });
const fixture = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/responses') {
    response.writeHead(404); response.end(); return;
  }
  await request.toArray();
  modelRequests++;
  await modelMayRespond;
  const item = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: answer, annotations: [] }] };
  const completed = { id: 'resp_probe', object: 'response', status: 'completed', model: 'kanban-fixture', output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
await writeFile(join(codexDirectory, 'config.toml'), `model = "kanban-fixture"
model_provider = "kanban_fixture"
cli_auth_credentials_store = "file"

[model_providers.kanban_fixture]
name = "Local Kanban fixture"
base_url = "http://127.0.0.1:${fixture.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false

[features]
apps = false
remote_plugin = false
recommended_plugins = false
`);

const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const url = `ws://127.0.0.1:${reservation.address().port}`;
await new Promise(resolve => reservation.close(resolve));

const server = spawn(binary, ['app-server', '--listen', url], {
  cwd: workspace,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), CODEX_HOME: codexDirectory },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverError;
const logs = [];
server.on('error', error => { serverError = error; });
server.stdout.on('data', value => logs.push(value.toString()));
server.stderr.on('data', value => logs.push(value.toString()));
const exited = new Promise(resolve => server.once('close', resolve));
const clients = [];
const checks = [];
const result = { directory, binary, url, checks };

async function connect(name) {
  let socket;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error(`App Server exited with code ${server.exitCode}.`);
    const candidate = new WebSocket(url);
    const opened = await new Promise(resolve => {
      candidate.addEventListener('open', () => resolve(true), { once: true });
      candidate.addEventListener('error', () => resolve(false), { once: true });
    });
    if (opened) { socket = candidate; break; }
    if (attempt === 99) throw new Error('App Server did not accept a connection.');
    await delay(100);
  }
  const pending = new Map(), notifications = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method) {
      notifications.push(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}`));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`${name} disconnected during ${request.method}.`));
    }
    pending.clear();
  });
  const client = {
    socket, notifications,
    request(method, params) {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${name}: ${method} timed out.`));
        }, 15000);
        pending.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
  clients.push(client);
  await client.request('initialize', { clientInfo: { name, version: '0.1.0' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized' }));
  return client;
}

async function check(name, action) {
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function eventually(test) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (test()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for a shared turn notification.');
}

try {
  const creator = await connect('kanban_creation_probe');
  const observer = await connect('kanban_observer_probe');
  let project, thread;
  const input = { idempotencyKey: randomUUID(), name: 'Kanban shared-server probe', roots: [{ path: workspace }] };
  await check('Create a project through the experimental API', async () => {
    ({ project } = await creator.request('project/create', input));
    assert.ok(project.id);
    assert.equal(project.name, input.name);
    result.projectId = project.id;
  });
  await check('The second client sees the same project', async () => {
    const read = await observer.request('project/read', { projectId: project.id });
    assert.equal(read.project.id, project.id);
    const list = await observer.request('project/list', {});
    assert.ok(list.data.some(item => item.id === project.id));
  });
  await check('Repeating a creation key returns the same project', async () => {
    const repeated = await creator.request('project/create', input);
    assert.equal(repeated.project.id, project.id);
  });
  await check('Create a task assigned to the project', async () => {
    ({ thread } = await creator.request('thread/start', { cwd: workspace, projectId: project.id, sandbox: 'read-only', approvalPolicy: 'on-request' }));
    assert.ok(thread.id);
    assert.equal(thread.projectId, project.id);
    result.threadId = thread.id;
  });
  await check('The second client reads the new task metadata', async () => {
    const read = await observer.request('thread/read', { threadId: thread.id, includeTurns: false });
    assert.equal(read.thread.id, thread.id);
    result.projectIdBeforeFirstTurn = read.thread.projectId;
  });
  await check('Both clients receive a completed turn from the local model fixture', async () => {
    const { turn } = await creator.request('turn/start', { threadId: thread.id,
      input: [{ type: 'text', text: 'Run the local fixture.', text_elements: [] }] });
    await eventually(() => modelRequests > 0);
    const resumed = await observer.request('thread/resume', { threadId: thread.id });
    assert.equal(resumed.thread.id, thread.id);
    releaseModel();
    for (const client of [creator, observer]) {
      await eventually(() => client.notifications.some(event => event.method === 'turn/completed' && event.params.turn.id === turn.id));
      const completed = client.notifications.find(event => event.method === 'turn/completed' && event.params.turn.id === turn.id);
      assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn.error));
      assert.ok(client.notifications.some(event => event.method === 'item/completed' && event.params.item.type === 'agentMessage' && event.params.item.text === answer));
    }
    assert.equal(modelRequests, 1);
    result.turnId = turn.id;
  });
  await check('The task project assignment is readable after its first turn', async () => {
    const read = await observer.request('thread/read', { threadId: thread.id, includeTurns: false });
    assert.equal(read.thread.projectId, project.id);
    const list = await observer.request('thread/list', { projectId: project.id });
    assert.ok(list.data.some(item => item.id === thread.id));
  });
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  for (const client of clients) client.socket.close();
  if (server.exitCode === null) server.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
  if (!stopped) { server.kill('SIGKILL'); await exited; }
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  result.modelRequests = modelRequests;
  await writeFile(join(directory, 'app-server.log'), logs.join(''));
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Results: ${join(directory, 'result.json')}`);
}
