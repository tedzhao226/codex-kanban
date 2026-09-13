import { renderMarkdown } from '/markdown.js';

export function createChatPanel({ getToken, openNative, onSelection }) {
  const $ = selector => document.querySelector(selector);
  const panel = $('#chat-panel'), timeline = $('#chat-timeline'), messages = $('#chat-messages'), input = $('#chat-input');
  let task = null, view = null, limit = 50, generation = 0, controller, reconnect, sending = false, stopping = false, oldLimit = 50;
  const rows = new Map(), drafts = new Map();
  let streamError = '', historyError = '', followLatest = true, lastScrollTop = 0;
  function showError(message) { $('#chat-error').textContent = message; $('#chat-error').hidden = !message; }
  function draft(id) {
    if (!drafts.has(id)) {
      try { drafts.set(id, JSON.parse(sessionStorage.getItem(`kanban:draft:${id}`) || 'null') || { text: '', pending: null }); }
      catch { drafts.set(id, { text: '', pending: null }); showError('The saved draft could not be read.'); }
    }
    return drafts.get(id);
  }
  function save(id) {
    try { sessionStorage.setItem(`kanban:draft:${id}`, JSON.stringify(draft(id))); }
    catch { showError('Your browser could not save this draft. Keep this panel open until you send it.'); }
  }
  async function api(id, action, body) {
    const response = await fetch(`/api/tasks/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kanban-token': getToken() }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { uncertain: value.uncertain });
    return value;
  }
  function controls() {
    if (!task) return;
    const pending = draft(task.id).pending, active = view?.runtime === 'running';
    $('#chat-send').textContent = sending ? 'Sending…' : active ? 'Steer ↑' : 'Send ↑';
    $('#chat-send').disabled = sending || stopping || Boolean(pending) || !input.value.trim() || !(active ? view?.canSteer : view?.canSend);
    $('#chat-stop').hidden = !view?.canStop;
    $('#chat-stop').disabled = stopping;
    $('#chat-stop').textContent = stopping ? 'Stopping…' : '■ Stop';
    input.disabled = sending;
    $('#chat-delivery').hidden = !pending || sending;
    $('#composer-hint').textContent = active ? 'Adds guidance to the current run' : '⌘ / Ctrl + Enter to send';
    $('#chat-status').textContent = view ? `${view.connected ? { running: 'Running', idle: 'Idle', 'needs-input': 'Waiting for you', error: 'Task error' }[view.runtime] ?? 'Connecting' : 'Saved conversation'}${view.model ? ' · ' + view.model : ''}` : 'Loading…';
    $('#chat-notice').hidden = !(view && (!view.connected || view.needsInput));
    $('#chat-notice-text').textContent = view?.needsInput ? 'This task needs an answer or approval in Codex.' : 'Read the saved conversation here. Connect the original task in Codex to continue it.';
    $('#chat-connect').textContent = view?.needsInput ? 'Answer in Codex ↗' : 'Connect in Codex ↗';
  }
  function row(item) {
    let entry = rows.get(item.id);
    if (!entry) {
      const node = document.createElement('article');
      node.className = `chat-message ${item.kind}`; node.dataset.messageId = item.id;
      if (item.kind === 'tool') {
        const details = document.createElement('details'), summary = document.createElement('summary'), detail = document.createElement('pre');
        detail.className = 'tool-detail'; details.append(summary, detail); node.append(details);
      } else {
        const label = document.createElement('span'), body = document.createElement('div');
        label.className = 'message-label'; label.textContent = item.kind === 'user' ? 'You' : 'Codex';
        body.className = 'message-body'; node.append(label, body);
      }
      entry = { node, signature: '' }; rows.set(item.id, entry);
    }
    const signature = JSON.stringify(item);
    if (entry.signature !== signature) {
      if (item.kind === 'tool') {
        entry.node.querySelector('summary').textContent = `${item.title} · ${item.status}`;
        entry.node.querySelector('pre').textContent = item.detail || 'No additional output.';
      } else {
        const id = task.id;
        renderMarkdown(entry.node.querySelector('.message-body'), item.text, { loadSvg: async path => (await api(id, 'svg', { path })).svg,
          onLayout: update => {
            update();
            if (task?.id !== id) return;
            if (followLatest && !window.getSelection()?.toString()) timeline.scrollTop = timeline.scrollHeight;
            lastScrollTop = timeline.scrollTop;
            $('#chat-latest').hidden = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 80;
          } });
      }
      entry.signature = signature;
    }
    return entry.node;
  }
  function render(next) {
    if (next.unavailable) { showError(next.error); view = { ...view, connected: false, canSend: false, canSteer: false, canStop: false }; controls(); return; }
    const first = !view, top = timeline.scrollTop, height = timeline.scrollHeight, bottom = height - timeline.clientHeight - top < 80;
    followLatest = first || (bottom && !window.getSelection()?.toString());
    view = next;
    const ids = new Set(view.items.map(item => item.id));
    for (const [id, entry] of rows) if (!ids.has(id)) { entry.node.remove(); rows.delete(id); }
    let cursor = messages.firstChild;
    for (const item of view.items) {
      const node = row(item);
      if (node !== cursor) messages.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    $('#chat-empty').hidden = view.items.length > 0;
    $('#chat-empty').textContent = view.loadingHistory ? 'Loading conversation…' : 'No messages to show yet.';
    $('#chat-earlier').hidden = !view.hasEarlier; $('#chat-earlier').disabled = limit >= 10000;
    $('#chat-earlier').textContent = limit >= 10000 ? 'Open in Codex for messages before these 10,000' : '↑ Load earlier';
    if (followLatest) timeline.scrollTop = timeline.scrollHeight;
    else if (limit > oldLimit) timeline.scrollTop = top + timeline.scrollHeight - height;
    else timeline.scrollTop = top;
    lastScrollTop = timeline.scrollTop;
    oldLimit = limit;
    $('#chat-latest').hidden = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 80;
    if (historyError && $('#chat-error').textContent === historyError) showError('');
    historyError = view.connected ? view.error : '';
    if (historyError) showError(historyError);
    const current = draft(task.id);
    if (current.pending && view.items.some(item => item.clientId === current.pending.id)) {
      if (current.text === current.pending.text) { current.text = ''; input.value = ''; }
      current.pending = null; save(task.id);
    }
    controls();
  }
  async function stream(id, round) {
    controller?.abort(); clearTimeout(reconnect);
    const abort = new AbortController(); controller = abort;
    try {
      const response = await fetch(`/api/tasks/${id}/events?limit=${limit}`, { headers: { 'x-kanban-token': getToken() }, signal: abort.signal });
      if (!response.ok) throw new Error((await response.json()).error);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error('The conversation connection closed. Reconnecting…');
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (event.startsWith('data: ') && round === generation && !abort.signal.aborted) {
            if (streamError && $('#chat-error').textContent === streamError) showError('');
            streamError = ''; render(JSON.parse(event.slice(6)));
          }
        }
      }
    } catch (error) {
      if (abort.signal.aborted || round !== generation) return;
      streamError = error.message; showError(streamError);
      view = { ...view, connected: false, canSend: false, canSteer: false, canStop: false }; controls();
      reconnect = setTimeout(() => { if (round === generation) stream(id, round); }, 2500);
    }
  }
  function close() {
    const id = task?.id;
    generation++; controller?.abort(); clearTimeout(reconnect);
    task = null; view = null; panel.hidden = true; onSelection(null);
    if (id) document.querySelector(`[data-id="${id}"] .card-title`)?.focus();
  }
  function open(selected) {
    if (task?.id === selected.id) { input.focus(); return; }
    task = selected; view = null; limit = 50; oldLimit = 50; generation++; sending = false; stopping = false;
    rows.clear(); messages.replaceChildren(); streamError = ''; historyError = ''; showError(''); input.value = draft(task.id).text;
    $('#chat-title').textContent = task.title;
    $('#chat-empty').hidden = false; $('#chat-empty').textContent = 'Loading conversation…';
    $('#chat-earlier').hidden = true; $('#chat-latest').hidden = true;
    panel.hidden = false; onSelection(task.id); controls(); stream(task.id, generation);
  }
  input.addEventListener('input', () => { if (task) { draft(task.id).text = input.value; save(task.id); controls(); } });
  $('#chat-composer').addEventListener('submit', async event => {
    event.preventDefault(); if (!task || $('#chat-send').disabled) return;
    const id = task.id, round = generation, current = draft(id);
    const pending = { id: crypto.randomUUID(), text: input.value, intent: view.runtime === 'running' ? 'steer' : 'send', expectedTurnId: view.activeTurnId };
    current.pending = pending; save(id); sending = true; showError(''); controls();
    try {
      const result = await api(id, 'message', { ...pending, messageId: pending.id });
      if (current.text === pending.text) current.text = '';
      current.pending = null; save(id);
      if (round === generation) { input.value = current.text; if (result.notice) showError(result.notice); }
    } catch (error) {
      if (error.uncertain === false) current.pending = null;
      save(id); if (round === generation) showError(error.message);
    } finally { if (round === generation) { sending = false; controls(); input.focus(); } }
  });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); $('#chat-composer').requestSubmit(); } });
  $('#chat-stop').addEventListener('click', async () => {
    if (!task || !view?.canStop || stopping) return;
    const id = task.id, round = generation, expectedTurnId = view.activeTurnId;
    stopping = true; controls(); showError('');
    try { const result = await api(id, 'interrupt', { expectedTurnId }); if (result.notice && round === generation) showError(result.notice); }
    catch (error) { if (round === generation) showError(error.message); }
    finally { if (round === generation) { stopping = false; controls(); } }
  });
  $('#chat-checked').addEventListener('click', () => { draft(task.id).pending = null; save(task.id); showError(''); controls(); input.focus(); });
  for (const selector of ['#chat-native', '#chat-connect']) $(selector).addEventListener('click', async () => {
    if (!task) return;
    try { await openNative(task.id); } catch (error) { showError(error.message); }
  });
  $('#chat-earlier').addEventListener('click', () => { limit = Math.min(limit + 50, 10000); $('#chat-earlier').disabled = true; stream(task.id, generation); });
  $('#chat-latest').addEventListener('click', () => { timeline.scrollTop = timeline.scrollHeight; $('#chat-latest').hidden = true; });
  timeline.addEventListener('scroll', () => {
    const bottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 80;
    if (timeline.scrollTop !== lastScrollTop) followLatest = bottom;
    lastScrollTop = timeline.scrollTop; $('#chat-latest').hidden = bottom;
  });
  $('#chat-close').addEventListener('click', close);
  $('#chat-expand').addEventListener('click', () => { const expanded = panel.classList.toggle('expanded'); $('#chat-expand').setAttribute('aria-label', expanded ? 'Restore conversation panel' : 'Expand conversation'); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && task) close(); });
  let resizing = false;
  function width(value) { panel.style.setProperty('--chat-width', Math.max(360, Math.min(800, innerWidth * .7, value)) + 'px'); }
  $('#chat-resize').addEventListener('pointerdown', event => { resizing = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); });
  $('#chat-resize').addEventListener('pointermove', event => { if (resizing) width(innerWidth - event.clientX); });
  $('#chat-resize').addEventListener('pointerup', () => { resizing = false; });
  $('#chat-resize').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); width(panel.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 40 : -40)); } });
  return { open, selectedId: () => task?.id ?? null };
}
