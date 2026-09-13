import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const invalid = message => Object.assign(new Error(message), { status: 400 });

export function projectCreator({ listProjects, openProject, timeout = 15000 }) {
  const pending = new Map();
  return async input => {
    if (typeof input.path !== 'string' || !input.path.trim() || input.path.length > 4096 || /[\x00-\x1f]/.test(input.path)) throw invalid('Enter a valid project folder path.');
    const path = input.path.trim();
    const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    if (!isAbsolute(expanded)) throw invalid('Use an absolute folder path, such as ~/workspace/my-project.');
    const target = resolve(expanded);
    if (pending.has(target)) return pending.get(target);
    const operation = (async () => {
      try { await mkdir(target); }
      catch (error) {
        if (error.code === 'ENOENT') throw invalid('The parent folder does not exist. Choose an existing parent folder.');
        if (error.code !== 'EEXIST') throw error;
      }
      if (!(await stat(target)).isDirectory()) throw invalid('That path is a file. Choose a folder.');
      const root = await realpath(target);
      const find = () => listProjects().find(project => project.rootPaths.includes(root));
      const existing = find();
      if (existing) return { project: existing, existing: true };
      const url = new URL('codex://new');
      url.searchParams.set('path', root);
      await openProject(url.href);
      const deadline = Date.now() + timeout;
      do {
        const project = find();
        if (project) return { project, existing: false };
        await delay(200);
      } while (Date.now() < deadline);
      throw Object.assign(new Error('Codex has not confirmed the project yet. The folder is ready; refresh the board before trying again.'), { status: 504, uncertain: true });
    })();
    pending.set(target, operation);
    try { return await operation; }
    finally { pending.delete(target); }
  };
}
