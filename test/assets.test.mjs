import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTaskSvg } from '../lib/assets.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kanban-svg-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, workspace };
}

test('SVG assets can be read by relative or absolute workspace path', async t => {
  const { workspace } = await fixture(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>';
  await writeFile(join(workspace, 'drawing.svg'), svg);
  assert.equal(await readTaskSvg(workspace, 'drawing.svg'), svg);
  assert.equal(await readTaskSvg(workspace, join(workspace, 'drawing.svg')), svg);
});

test('SVG asset reads reject traversal, other workspaces and escaping symlinks', async t => {
  const { directory, workspace } = await fixture(t);
  const outside = join(directory, 'private.svg');
  await writeFile(outside, '<svg/>');
  await symlink(outside, join(workspace, 'link.svg'));
  for (const path of ['../private.svg', outside, 'link.svg']) {
    await assert.rejects(readTaskSvg(workspace, path), { status: 403 });
  }
});

test('SVG reads reject remote, non-SVG, missing and oversized files', async t => {
  const { workspace } = await fixture(t);
  for (const path of ['https://example.com/a.svg', 'notes.txt', null, 'a\0.svg']) {
    await assert.rejects(readTaskSvg(workspace, path), { status: 400 });
  }
  await assert.rejects(readTaskSvg(workspace, 'missing.svg'), { status: 404 });
  await writeFile(join(workspace, 'large.svg'), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(readTaskSvg(workspace, 'large.svg'), { status: 413 });
  await mkdir(join(workspace, 'folder.svg'));
  await assert.rejects(readTaskSvg(workspace, 'folder.svg'), { status: 400 });
  await writeFile(join(workspace, 'notes.txt'), 'Private note');
  await symlink(join(workspace, 'notes.txt'), join(workspace, 'fake.svg'));
  await assert.rejects(readTaskSvg(workspace, 'fake.svg'), { status: 400 });
});
