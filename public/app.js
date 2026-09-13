import { createChatPanel } from '/chat.js';

const names = { backlog: 'Backlog', running: 'Running', 'needs-input': 'Needs input', review: 'Review', done: 'Done' };
const runtimeNames = { 'not-loaded': 'Status unavailable', running: 'Running in Codex', 'needs-input': 'Waiting for you', idle: 'Idle in Codex', error: 'Task error' };
const emptyText = { backlog: ['A clear starting point', 'Tasks without live status land here.'], running: ['Room to make progress', 'Active tasks appear here automatically.'], 'needs-input': ['Nothing waiting on you', 'Approvals and questions appear here.'], review: ['Ready when you are', 'Idle tasks land here for review.'], done: ['Make room for what’s next', 'Move finished work here.'] };
const $ = selector => document.querySelector(selector);
let state, project = '', search = '', signature = '', dragging = null, refreshPending, toastTimer;
let requestSequence = 0, appliedSequence = 0, renderDeferred = false;
const pendingCards = new Set();
const chat = createChatPanel({ getToken: () => state?.token, openNative: id => request(`/api/tasks/${id}/open`, {}),
  onSelection: id => document.querySelectorAll('.card').forEach(node => node.classList.toggle('selected', node.dataset.id === id)) });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function relativeTime(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function toast(message, failure = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = failure ? 'toast failure' : 'toast';
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kanban-token': state.token }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), { status: response.status, uncertain: data.uncertain });
  return data;
}

function renderProjects() {
  const projects = new Map();
  for (const task of state.tasks) {
    const value = projects.get(task.projectId) || { name: task.projectName, count: 0 };
    value.count++;
    projects.set(task.projectId, value);
  }
  if (project && !projects.has(project)) project = '';
  const choices = [['', { name: 'All projects', count: state.tasks.length }], ...[...projects].sort((a, b) => a[1].name.localeCompare(b[1].name))];
  $('#projects').replaceChildren(...choices.map(([id, item]) => {
    const button = element('button', 'project' + (id === project ? ' active' : ''));
    button.type = 'button';
    button.dataset.project = id;
    button.setAttribute('aria-pressed', String(id === project));
    button.append(element('span', 'project-icon', id ? '▱' : '▦'), element('span', 'project-name', item.name), element('span', 'project-count', item.count));
    return button;
  }));
  $('#heading').textContent = project ? projects.get(project).name : 'Task board';
}

function card(task) {
  const node = element('article', 'card' + (chat.selectedId() === task.id ? ' selected' : ''));
  node.dataset.id = task.id;
  node.dataset.layoutRevision = task.layoutRevision;
  node.draggable = !pendingCards.has(task.id);
  node.setAttribute('aria-busy', String(pendingCards.has(task.id)));
  const top = element('div', 'card-top');
  const when = element('time', 'card-time', relativeTime(task.updatedAt));
  when.dateTime = new Date(task.updatedAt).toISOString();
  when.title = new Date(task.updatedAt).toLocaleString();
  top.append(element('span', 'card-project', task.projectName), when);
  const title = element('button', 'card-title', task.title);
  title.type = 'button';
  title.dataset.action = 'chat';
  title.title = task.title;
  title.setAttribute('aria-label', `View conversation: ${task.title}`);
  node.append(top, title);
  if (task.preview && task.preview !== task.title) node.append(element('p', 'preview', task.preview));
  const runtime = element('span', `runtime ${task.runtime}`, runtimeNames[task.runtime]);
  runtime.title = task.runtime === 'not-loaded' ? 'Codex has not published a live status for this task. Open it in Codex to load it.' : 'Live status is separate from your chosen board lane.';
  node.append(runtime);
  const footer = element('div', 'card-footer');
  const select = element('select', 'lane-select');
  select.disabled = pendingCards.has(task.id);
  select.setAttribute('aria-label', `Move ${task.title}`);
  const auto = element('option', '', task.manual ? 'Follow task status' : `Auto · ${names[task.column]}`);
  auto.value = 'auto';
  select.append(auto);
  for (const [id, name] of Object.entries(names)) {
    const option = element('option', '', name);
    option.value = id;
    select.append(option);
  }
  select.value = task.manual ? task.column : 'auto';
  const open = element('button', 'open-button', 'Open in Codex ↗');
  open.type = 'button';
  open.dataset.action = 'open';
  footer.append(select, open);
  node.append(footer);
  return node;
}

function render(force = false) {
  if (!state) return;
  if (dragging || document.activeElement?.matches('.lane-select')) { renderDeferred = true; return; }
  renderDeferred = false;
  const next = JSON.stringify([state.tasks, state.connection, project, search, [...pendingCards]]);
  if (!force && signature === next) return;
  signature = next;
  renderProjects();
  const tasks = state.tasks.filter(task => (!project || task.projectId === project) && (!search || `${task.title} ${task.preview} ${task.projectName}`.toLowerCase().includes(search)));
  const running = tasks.filter(task => task.runtime === 'running').length;
  $('#summary').textContent = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} · ${running} running`;
  const connection = $('#connection');
  const healthy = state.connection.connected && state.connection.message === 'Connected to Codex';
  connection.textContent = healthy ? 'Codex connected' : 'Live status offline';
  connection.classList.toggle('offline', !healthy);
  connection.title = state.connection.message;
  $('#error').textContent = healthy ? '' : state.connection.message + ' Your saved task library and board remain available.';
  $('#error').hidden = healthy;
  const columns = state.columns.map(id => {
    const column = element('section', 'column');
    column.dataset.column = id;
    column.setAttribute('aria-label', names[id]);
    const matching = tasks.filter(task => task.column === id);
    const header = element('div', 'column-header');
    header.append(element('span', 'lane-dot'), element('h2', '', names[id]), element('span', 'count', matching.length));
    const list = element('div', 'card-list');
    list.append(...matching.map(card));
    if (!matching.length) {
      const empty = element('div', 'empty');
      empty.append(element('strong', '', search ? 'No matching tasks' : emptyText[id][0]), element('span', '', search ? 'Try a different search.' : emptyText[id][1]));
      list.append(empty);
    }
    column.append(header, list);
    return column;
  });
  $('#board').replaceChildren(...columns);
  $('#board').setAttribute('aria-busy', 'false');
}

function acceptSnapshot(updated, sequence) {
  if (state && (updated.boardRevision < state.boardRevision || (updated.boardRevision === state.boardRevision && sequence < appliedSequence))) return;
  state = updated;
  appliedSequence = Math.max(appliedSequence, sequence);
  render();
  $('#sync-time').textContent = `Synced ${new Date(state.refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

async function refresh(force = false) {
  if (refreshPending && !force) return refreshPending;
  const sequence = ++requestSequence;
  const operation = (async () => {
    try { acceptSnapshot(await request('/api/board'), sequence); }
    catch (error) {
      if (sequence < appliedSequence) return;
      $('#error').textContent = error.message + ' Check that the local server is running, then refresh.';
      $('#error').hidden = false;
      $('#connection').textContent = 'Board offline';
      $('#connection').classList.add('offline');
      $('#board').setAttribute('aria-busy', 'false');
      signature = '';
    }
  })();
  refreshPending = operation;
  try { await operation; }
  finally { if (refreshPending === operation) refreshPending = null; }
}

async function move(id, column, beforeId, expectedLayoutRevision, keyboard = false) {
  if (pendingCards.has(id)) return;
  pendingCards.add(id);
  render(true);
  const sequence = ++requestSequence;
  try {
    acceptSnapshot(await request(`/api/tasks/${id}/${column === 'auto' ? 'reset' : 'move'}`, { column, beforeId, expectedLayoutRevision }), sequence);
    toast(column === 'auto' ? 'Task now follows its Codex status' : `Moved to ${names[column]}`);
  } catch (error) {
    if (error.status === 409 || error.uncertain) await refresh(true);
    toast(error.uncertain ? error.message + ' Check the board before trying again.' : error.message, true);
  }
  finally {
    pendingCards.delete(id);
    render(true);
    if (keyboard && document.activeElement === document.body && !dragging) document.querySelector(`[data-id="${id}"] .lane-select`)?.focus();
  }
}

$('#projects').addEventListener('click', event => {
  const button = event.target.closest('[data-project]');
  if (!button) return;
  project = button.dataset.project;
  render(true);
});
$('#search').addEventListener('input', event => { search = event.target.value.toLowerCase().trim(); render(true); });
$('#refresh').addEventListener('click', () => { signature = ''; refresh(); });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { event.preventDefault(); $('#search').focus(); }
});
$('#board').addEventListener('click', async event => {
  const card = event.target.closest('.card');
  if (!card || event.target.closest('select')) return;
  const button = event.target.closest('[data-action="open"]');
  if (!button) { chat.open(state.tasks.find(task => task.id === card.dataset.id)); return; }
  button.disabled = true;
  try {
    await request(`/api/tasks/${button.closest('.card').dataset.id}/open`, {});
    toast('Opening the original conversation in Codex');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
$('#board').addEventListener('change', event => {
  if (!event.target.matches('.lane-select')) return;
  const card = event.target.closest('.card');
  const keyboard = document.activeElement === event.target;
  const column = event.target.value;
  event.target.blur();
  move(card.dataset.id, column, null, Number(card.dataset.layoutRevision), keyboard);
});
$('#board').addEventListener('focusout', () => queueMicrotask(() => { if (renderDeferred) render(true); }));

function clearDragMarks() { document.querySelectorAll('.drop-over,.drop-before').forEach(node => node.classList.remove('drop-over', 'drop-before')); }
function destination(event) {
  const column = event.target.closest('.column');
  if (!column) return null;
  const cards = [...column.querySelectorAll('.card')].filter(node => node.dataset.id !== dragging?.id);
  const before = cards.find(node => { const box = node.getBoundingClientRect(); return event.clientY < box.top + box.height / 2; });
  return { column, before };
}
$('#board').addEventListener('dragstart', event => {
  const node = event.target.closest('.card');
  if (!node || pendingCards.has(node.dataset.id) || event.target.closest('select')) { event.preventDefault(); return; }
  dragging = { id: node.dataset.id, revision: Number(node.dataset.layoutRevision) };
  event.dataTransfer.setData('text/plain', dragging.id);
  event.dataTransfer.effectAllowed = 'move';
  node.classList.add('dragging');
});
$('#board').addEventListener('dragover', event => {
  if (!dragging) return;
  const target = destination(event);
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearDragMarks();
  target.column.classList.add('drop-over');
  target.before?.classList.add('drop-before');
});
$('#board').addEventListener('drop', event => {
  if (!dragging) return;
  event.preventDefault();
  const target = destination(event);
  const { id, revision } = dragging;
  clearDragMarks();
  if (target) move(id, target.column.dataset.column, target.before?.dataset.id ?? null, revision);
});
$('#board').addEventListener('dragend', () => {
  dragging = null;
  clearDragMarks();
  document.querySelectorAll('.dragging').forEach(node => node.classList.remove('dragging'));
  render(true);
});

refresh();
setInterval(refresh, 4000);
