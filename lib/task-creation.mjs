import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isThreadId } from './board.mjs';

export async function saveNativeTask({ cwd, title, codexHome, onCreated }) {
  const child = spawn(process.env.KANBAN_CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex', ['app-server'], {
    cwd, env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  const fail = error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  let failure;
  child.on('error', error => { failure = error; fail(error); });
  child.stdin.on('error', error => { failure = error; fail(error); });
  const closed = new Promise(resolve => child.once('close', code => { failure ??= new Error(`Task setup engine closed (${code}).`); fail(failure); resolve(); }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { failure = new Error('Task setup engine returned invalid JSON.'); fail(failure); child.kill('SIGTERM'); return; }
    if (message.method) {
      if (message.id != null) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No interactive setup requests are supported.' } }) + '\n');
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  function call(method, params) {
    if (failure) return Promise.reject(failure);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Task setup timed out during ${method}.`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    await call('initialize', { clientInfo: { name: 'codex_kanban', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const { thread } = await call('thread/start', { cwd, historyMode: 'legacy' });
    if (!isThreadId(thread?.id)) throw new Error('Task setup did not return a native task ID.');
    await onCreated(thread.id);
    // Naming flushes the empty native history without running a model turn.
    await call('thread/name/set', { threadId: thread.id, name: title });
    await call('thread/unsubscribe', { threadId: thread.id });
    return thread.id;
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await closed; } finally { clearTimeout(timer); }
  }
}

export function taskCreator({ index, feed, conversations, openThread, requestDirectory, saveTask = saveNativeTask }) {
  const pending = new Map();
  return async input => {
    if (!isThreadId(input.requestId) || typeof input.projectId !== 'string' || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) {
      throw Object.assign(new Error('A request ID, project, and prompt of up to 32,000 characters are required.'), { status: 400 });
    }
    const signature = createHash('sha256').update(JSON.stringify([input.projectId, input.prompt])).digest('hex');
    const prior = pending.get(input.requestId);
    if (prior) {
      if (prior.signature !== signature) throw Object.assign(new Error('This request ID was already used for different task input.'), { status: 409 });
      return prior.promise;
    }
    const promise = create(input, signature).finally(() => pending.delete(input.requestId));
    pending.set(input.requestId, { signature, promise });
    return promise;
  };

  async function create(input, signature) {
    await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    const file = join(requestDirectory, input.requestId + '.json');
    let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (record) {
      if (record.signature !== signature) throw Object.assign(new Error('This request ID was already used for different task input.'), { status: 409 });
      if (record.result) return record.result;
      throw Object.assign(new Error(record.error || 'Earlier task creation was not confirmed. Check the task library before starting another task.'), {
        status: 409, uncertain: record.uncertain ?? true, threadId: record.threadId ?? null,
      });
    }
    if (!feed.connected || !feed.protocolOK) throw Object.assign(new Error('Open Codex normally before creating a task.'), { status: 503 });
    const project = index.projects().find(project => project.id === input.projectId);
    if (!project?.rootPaths?.[0]) throw Object.assign(new Error('Select an existing local project.'), { status: 400 });
    const cwd = project.rootPaths[0];
    if (!(await stat(cwd)).isDirectory()) throw Object.assign(new Error('The project folder is not a directory.'), { status: 400 });
    record = { signature, threadId: null };
    await writeFile(file, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    const save = async () => {
      const temporary = file + '.tmp';
      await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
      await rename(temporary, file);
    };
    let release, attempted = false;
    try {
      const threadId = await saveTask({ cwd, codexHome: index.home, title: input.prompt.trim().split('\n')[0].slice(0, 80),
        onCreated: async id => { record.threadId = id; await save(); } });
      const tasks = index.list(), task = tasks.find(task => task.id === threadId);
      if (!task || task.projectId !== project.id) throw new Error('The saved task could not be confirmed in the selected project.');
      feed.sync(tasks.map(task => task.id));
      await openThread(threadId);
      release = conversations.subscribe(threadId);
      const deadline = Date.now() + 30000;
      while (true) {
        await conversations.load(threadId);
        const view = await conversations.view(threadId);
        if (view.canSend && !view.error) break;
        if (Date.now() >= deadline || !feed.connected) throw new Error('The task was saved, but Codex did not connect it for the first prompt. Open its conversation to continue.');
        await delay(200);
      }
      attempted = true;
      const delivery = await conversations.act(threadId, 'message', { messageId: input.requestId, intent: 'send', text: input.prompt });
      record.result = { task, requestId: input.requestId, accepted: true, turnId: delivery.turnId };
      await save();
      return record.result;
    } catch (error) {
      record.error = error.message;
      record.uncertain = error.uncertain ?? (attempted || !record.threadId);
      await save();
      throw Object.assign(error, { status: error.status ?? 503, uncertain: record.uncertain, threadId: record.threadId });
    } finally { release?.(); }
  }
}
