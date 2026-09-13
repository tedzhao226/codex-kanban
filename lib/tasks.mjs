import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

export class TaskIndex {
  constructor(codexHome) {
    this.home = codexHome;
    this.db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
    this.db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    this.query = this.db.prepare(`SELECT id, COALESCE(NULLIF(name, ''), title) AS title,
      cwd, preview, model, created_at_ms, updated_at_ms, created_at, updated_at, is_pinned, project_id
      FROM threads WHERE archived = 0
      AND source IN ('cli', 'vscode', 'appServer', 'exec')
      ORDER BY COALESCE(recency_at_ms, updated_at_ms, updated_at * 1000) DESC`);
  }
  projects() {
    const global = JSON.parse(readFileSync(join(this.home, '.codex-global-state.json'), 'utf8'));
    return Object.values(global['local-projects'] ?? {}).map(({ id, name, rootPaths }) => ({ id, name, rootPaths }));
  }
  list() {
    const global = JSON.parse(readFileSync(join(this.home, '.codex-global-state.json'), 'utf8'));
    const projects = Object.values(global['local-projects'] ?? {});
    const assignments = global['thread-project-assignments'] ?? {};
    return this.query.all().map(row => {
      const assigned = assignments[row.id];
      const explicit = projects.find(project => project.id === ((typeof assigned === 'string' ? assigned : assigned?.projectId) ?? row.project_id));
      const roots = projects.flatMap(project => (project.rootPaths ?? []).map(root => ({ project, root })))
        .filter(({ root }) => row.cwd === root || row.cwd.startsWith(root + sep)).sort((a, b) => b.root.length - a.root.length);
      const project = explicit ?? roots[0]?.project;
      return {
        id: row.id, title: row.title || 'Untitled task', cwd: row.cwd,
        preview: (row.preview ?? '').slice(0, 260), model: row.model ?? '',
        createdAt: row.created_at_ms ?? row.created_at * 1000,
        updatedAt: row.updated_at_ms ?? row.updated_at * 1000,
        pinned: Boolean(row.is_pinned),
        projectId: project?.id ?? 'no-project',
        projectName: project?.name ?? 'No project',
      };
    });
  }
  rolloutPath(id) {
    return this.db.prepare('SELECT rollout_path FROM threads WHERE id = ? AND archived = 0').get(id)?.rollout_path;
  }
  close() { this.db.close(); }
}
