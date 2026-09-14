import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCreator } from '../lib/projects.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kanban-projects-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = [], opened = [];
  const create = projectCreator({ listProjects: () => projects, openProject: async value => {
    opened.push(value);
    projects.push({ id: 'created', name: 'Created', rootPaths: [new URL(value).searchParams.get('path')] });
  } });
  return { directory, projects, opened, create };
}

test('project creation makes a folder and returns the native registration, including paths with URL characters', async t => {
  const { directory, create, opened } = await fixture(t);
  const path = join(directory, 'A & B #1');
  const result = await create({ path });
  assert.equal(result.project.id, 'created');
  assert.equal((await stat(path)).isDirectory(), true);
  assert.equal(new URL(opened[0]).protocol, 'codex:');
  assert.equal(new URL(opened[0]).host, 'new');
  assert.equal(new URL(opened[0]).searchParams.get('path'), path);
  assert.equal(new URL(opened[0]).searchParams.size, 1);
});

test('concurrent and repeated requests for a folder reuse one native project', async t => {
  const { directory, create, opened } = await fixture(t);
  const input = { path: join(directory, 'same') };
  const [one, two] = await Promise.all([create(input), create(input)]);
  assert.equal(one.project.id, two.project.id);
  assert.equal((await create(input)).existing, true);
  assert.equal(opened.length, 1);
});

test('invalid paths and files do not invoke native registration', async t => {
  const { directory, create, opened } = await fixture(t);
  const file = join(directory, 'file');
  await writeFile(file, 'existing');
  for (const path of ['', 'relative/path', null, '/bad\u0000path', file, join(directory, 'missing-parent', 'child')]) {
    await assert.rejects(create({ path }), { status: 400 });
  }
  assert.deepEqual(opened, []);
});

test('opening Codex without confirmed registration returns an uncertain error', async t => {
  const { directory } = await fixture(t);
  const create = projectCreator({ listProjects: () => [], openProject: async () => {}, timeout: 1 });
  await assert.rejects(create({ path: join(directory, 'waiting') }), { status: 504, uncertain: true });
});
