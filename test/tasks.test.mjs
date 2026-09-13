import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskIndex } from '../lib/tasks.mjs';

test('task library includes native tasks with an unset legacy user-event flag and excludes archives and subagents', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-index-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state_5.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, preview TEXT, model TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER, created_at INTEGER, updated_at INTEGER, is_pinned INTEGER,
    project_id TEXT, archived INTEGER, has_user_event INTEGER, source TEXT, recency_at_ms INTEGER);
    INSERT INTO threads VALUES ('one', '0913｜FEA｜Original task', 'old prompt', '/work/repo/subdir', 'preview', 'model',
      NULL, NULL, 10, 20, 1, NULL, 0, 0, 'vscode', NULL);
    INSERT INTO threads SELECT 'archived', name, title, cwd, preview, model, created_at_ms, updated_at_ms, created_at, updated_at, is_pinned, project_id, 1, has_user_event, source, recency_at_ms FROM threads WHERE id='one';
    INSERT INTO threads SELECT 'subagent', name, title, cwd, preview, model, created_at_ms, updated_at_ms, created_at, updated_at, is_pinned, project_id, 0, has_user_event, '{"subagent":{}}', recency_at_ms FROM threads WHERE id='one';
    INSERT INTO threads SELECT 'worktree', name, title, '/codex/worktrees/123/repo', preview, model, created_at_ms, updated_at_ms, created_at, updated_at, is_pinned, project_id, 0, has_user_event, source, recency_at_ms FROM threads WHERE id='one';
    INSERT INTO threads SELECT 'projectless', name, title, '/documents/voice-chat', preview, model, created_at_ms, updated_at_ms, created_at, updated_at, is_pinned, project_id, 0, has_user_event, source, recency_at_ms FROM threads WHERE id='one';`);
  db.close();
  writeFileSync(join(directory, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { parent: { id: 'parent', name: 'Parent', rootPaths: ['/work'] }, repo: { id: 'repo', name: 'My repo', rootPaths: ['/work/repo'] } }, 'thread-project-assignments': { worktree: { projectKind: 'local', projectId: 'repo' } } }));
  const before = readFileSync(path);
  const index = new TaskIndex(directory);
  const tasks = index.list();
  assert.deepEqual(index.projects().map(project => project.id), ['parent', 'repo']);
  t.after(() => index.close());
  assert.equal(tasks.length, 3);
  assert.equal(tasks.find(task => task.id === 'worktree').projectId, 'repo');
  assert.equal(tasks.find(task => task.id === 'projectless').projectName, 'No project');
  assert.equal(tasks[0].title, '0913｜FEA｜Original task');
  assert.equal(tasks[0].projectId, 'repo');
  assert.equal(tasks[0].updatedAt, 20000);
  assert.equal(tasks[0].pinned, true);
  assert.deepEqual(readFileSync(path), before);
  const writer = new DatabaseSync(path);
  try {
    writer.exec("UPDATE threads SET name = 'Renamed in Codex', updated_at_ms = 30000 WHERE id = 'one'; UPDATE threads SET archived = 1 WHERE id = 'projectless';");
  } finally { writer.close(); }
  const refreshed = index.list();
  assert.equal(refreshed.find(task => task.id === 'one').title, 'Renamed in Codex');
  assert.equal(refreshed.find(task => task.id === 'one').updatedAt, 30000);
  assert.equal(refreshed.some(task => task.id === 'projectless'), false);
});
