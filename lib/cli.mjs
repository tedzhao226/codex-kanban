import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isThreadId, COLUMNS } from './board.mjs';

const help = `Usage: codex-kanban <project|task> <command> [options]

  project list
  project create PATH
  task list [--project ID] [--column COLUMN] [--search TEXT]
  task show ID [--limit N] [--follow]
  task create --project ID --prompt TEXT
  task send ID --text TEXT
  task steer ID --text TEXT
  task stop ID
  task move ID COLUMN [--before ID]
  task reset ID
  task open ID

Use --file PATH (or --file - for stdin) instead of --prompt or --text.
Use --request-id UUID with create/send/steer to identify a repeated request.
Global options: --json, --port PORT (default 4317), --help.
JSON follow output is one conversation snapshot per line.
Columns: ${COLUMNS.join(', ')}. Moving a card does not start or stop a run.
The local Kanban server must be running; native operations also require Codex.
Exit codes: 0 success, 1 failure, 2 input, 3 unavailable, 4 conflict, 5 uncertain delivery.
`;

const optionsByCommand = {
  'project list': {}, 'project create': {},
  'task list': { project: 'string', column: 'string', search: 'string' },
  'task show': { limit: 'string', follow: 'boolean' },
  'task create': { project: 'string', prompt: 'string', file: 'string', 'request-id': 'string' },
  'task send': { text: 'string', file: 'string', 'request-id': 'string' },
  'task steer': { text: 'string', file: 'string', 'request-id': 'string' },
  'task stop': {}, 'task move': { before: 'string' }, 'task reset': {}, 'task open': {},
};
const clean = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'token' ? undefined : item));
const usage = message => Object.assign(new Error(message), { status: 400 });
const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, signal } = {}) {
  let json = argv.includes('--json'), requestId;
  try {
    if (!argv.length || argv.includes('--help')) { stdout.write(help); return 0; }
    const command = argv.slice(0, 2).join(' '), extra = optionsByCommand[command];
    if (!extra) throw usage('Choose a command from codex-kanban --help.');
    let parsed;
    try { parsed = parseArgs({ args: argv.slice(2), allowPositionals: true, options: Object.fromEntries(Object.entries({ json: 'boolean', port: 'string', ...extra }).map(([name, type]) => [name, { type }])) }); }
    catch (error) { throw usage(error.message); }
    const { values, positionals } = parsed;
    json = Boolean(values.json);
    const expected = command.endsWith(' list') || command === 'task create' ? 0 : command === 'task move' ? 2 : 1;
    if (positionals.length !== expected) throw usage(`Expected ${expected} positional argument(s) for ${command}. See --help.`);
    const port = values.port ?? '4317';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw usage('Port must be an integer from 1 to 65535.');
    const base = `http://127.0.0.1:${Number(port)}`;
    const id = command.startsWith('task ') && !['task create', 'task list'].includes(command) ? positionals[0] : null;
    if (id && !isThreadId(id)) throw usage('Use the complete native task ID from task list.');
    if (values.before && !isThreadId(values.before)) throw usage('--before requires a complete task ID.');
    if (values.column && !COLUMNS.includes(values.column) || command === 'task move' && !COLUMNS.includes(positionals[1])) throw usage('Unknown column. See --help.');
    const limit = values.limit ?? '50';
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 10000) throw usage('--limit must be from 1 to 10000.');
    let text;
    if (['task create', 'task send', 'task steer'].includes(command)) {
      requestId = values['request-id'] ?? randomUUID();
      if (!isThreadId(requestId)) throw usage('--request-id requires a UUID.');
      const direct = command === 'task create' ? values.prompt : values.text;
      if ((direct !== undefined) === (values.file !== undefined)) throw usage('Supply exactly one of the text option or --file.');
      if (values.file === '-') {
        const chunks = []; let bytes = 0;
        for await (const chunk of stdin) { bytes += Buffer.byteLength(chunk); if (bytes > 128000) throw usage('Input is too long.'); chunks.push(Buffer.from(chunk)); }
        text = Buffer.concat(chunks).toString('utf8');
      } else text = values.file !== undefined ? await readFile(values.file, 'utf8') : direct;
      if (!text.trim() || text.length > 32000) throw usage('Enter text of up to 32,000 characters.');
      if (command === 'task create' && !values.project) throw usage('--project is required. Use project list to find its ID.');
    }
    let token;
    async function request(path, body, streaming = false) {
      let response;
      const timeout = AbortSignal.timeout(body === undefined ? 45000 : 150000);
      try {
        response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          signal: signal ? AbortSignal.any([signal, ...(streaming ? [] : [timeout])]) : streaming ? undefined : timeout,
          headers: { ...(token ? { 'x-kanban-token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (error) {
        if (signal?.aborted && body === undefined) throw error;
        throw Object.assign(new Error(body === undefined ? `Cannot reach Kanban on port ${port}: ${error.cause?.code || error.message}` : 'Delivery was not confirmed. Check the task before retrying.'), { status: 503, uncertain: body !== undefined });
      }
      if (streaming && response.ok) return response;
      let data;
      try { data = await response.json(); }
      catch { throw Object.assign(new Error('Kanban returned an invalid response.'), { status: 503, uncertain: body !== undefined }); }
      if (!response.ok) throw Object.assign(new Error(data.error || `Kanban returned HTTP ${response.status}.`), { status: response.status, uncertain: data.uncertain, threadId: data.threadId });
      return data;
    }
    const board = await request('/api/board');
    if (typeof board.token !== 'string' || !Array.isArray(board.tasks) || !Array.isArray(board.projects)) throw new Error('The local server returned an invalid Kanban board.');
    token = board.token;
    const task = id ? board.tasks.find(task => task.id === id) : null;
    if (id && !task) throw Object.assign(new Error('Native task not found.'), { status: 404 });
    const emit = (value, readable) => stdout.write(json ? JSON.stringify(clean(value)) + '\n' : readable + '\n');
    const taskLine = task => [task.id, task.column, task.runtime, task.projectName, task.title].map(oneLine).join('\t');
    const printView = (view, seen) => {
      if (view.error) throw Object.assign(new Error(view.error), { status: 503 });
      if (json) { emit(view); return; }
      stdout.write(`${oneLine(task.title)} [${oneLine(view.runtime)}]\n`);
      for (const item of view.items) {
        const rendered = `[${oneLine(item.kind || item.role || item.type)}] ${item.text || ''}${item.images?.length ? `\n[${item.images.length} image(s)]` : ''}`;
        if (!seen || seen.get(item.id) !== rendered) { stdout.write(rendered + '\n'); seen?.set(item.id, rendered); }
      }
    };
    if (command === 'project list') emit(board.projects, board.projects.map(project => [project.id, project.name, project.rootPaths.join(', ')].map(oneLine).join('\t')).join('\n') || 'No projects.');
    else if (command === 'project create') {
      const result = await request('/api/projects', { path: positionals[0] });
      emit(result, `${result.existing ? 'Existing' : 'Created'} project ${result.project.id}: ${oneLine(result.project.name)}`);
    } else if (command === 'task list') {
      const tasks = board.tasks.filter(task => (!values.project || task.projectId === values.project) && (!values.column || task.column === values.column) && (!values.search || `${task.title} ${task.preview} ${task.projectName}`.toLowerCase().includes(values.search.toLowerCase())));
      emit(tasks, tasks.map(taskLine).join('\n') || 'No matching tasks.');
    } else if (command === 'task create') {
      const result = await request('/api/tasks', { requestId, projectId: values.project, prompt: text });
      emit(result, `Created task ${result.task.id}: ${oneLine(result.task.title)}`);
    } else if (command === 'task show') {
      if (!values.follow) printView(await request(`/api/tasks/${id}/conversation?limit=${limit}`));
      else {
        const response = await request(`/api/tasks/${id}/events?limit=${limit}`, undefined, true), seen = new Map();
        let buffer = '';
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk; let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) printView(JSON.parse(data), seen);
          }
        }
        throw Object.assign(new Error('The conversation connection closed. Run the command again to reconnect.'), { status: 503 });
      }
    } else if (['task send', 'task steer', 'task stop'].includes(command)) {
      const view = await request(`/api/tasks/${id}/conversation?live=1`);
      if (view.error) throw Object.assign(new Error(view.error), { status: 503 });
      const stopping = command === 'task stop', steering = command === 'task steer';
      if (!(stopping ? view.canStop : steering ? view.canSteer : view.canSend)) throw Object.assign(new Error(`Task cannot ${command.split(' ')[1]} in its current state (${view.runtime}).`), { status: view.connected ? 409 : 503 });
      const result = await request(`/api/tasks/${id}/${stopping ? 'interrupt' : 'message'}`, stopping ? { expectedTurnId: view.activeTurnId } : { messageId: requestId, text, intent: steering ? 'steer' : 'send', expectedTurnId: view.activeTurnId });
      emit(result, `${stopping ? 'Stop' : steering ? 'Guidance' : 'Message'} accepted for ${id}${result.notice ? ': ' + oneLine(result.notice) : ''}`);
    } else if (command === 'task open') emit(await request(`/api/tasks/${id}/open`, {}), `Opened ${id} in Codex.`);
    else {
      const moving = command === 'task move';
      const result = await request(`/api/tasks/${id}/${moving ? 'move' : 'reset'}`, { expectedLayoutRevision: task.layoutRevision, ...(moving ? { column: positionals[1], beforeId: values.before ?? null } : {}) });
      const updated = result.tasks.find(task => task.id === id);
      emit(updated, taskLine(updated));
    }
    return 0;
  } catch (error) {
    if (signal?.aborted && !error.uncertain) return 0;
    const result = { error: error.message, ...(error.uncertain ? { uncertain: true } : {}), ...(error.threadId ? { threadId: error.threadId } : {}), ...(requestId ? { requestId } : {}) };
    stderr.write(json ? JSON.stringify(result) + '\n' : [result.error, result.threadId ? `Task: ${result.threadId}` : '', requestId ? `Request ID: ${requestId}` : ''].filter(Boolean).join('\n') + '\n');
    return error.uncertain ? 5 : error.status === 400 ? 2 : error.status === 409 ? 4 : error.status === 503 ? 3 : 1;
  }
}
