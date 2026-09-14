import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const roots = [
  ['.', ['server.mjs'], false],
  ['bin', ['.mjs'], false],
  ['lib', ['.mjs'], false],
  ['public', ['.js'], false],
  ['scripts', ['.mjs'], false],
  ['test', ['.mjs'], true],
];

const files = [];
for (const [directory, suffixes, optional] of roots) {
  let names;
  try {
    names = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error.code === 'ENOENT') continue;
    throw error;
  }
  for (const entry of names) {
    if (entry.isFile() && suffixes.some((suffix) => entry.name === suffix || entry.name.endsWith(suffix))) {
      files.push(join(directory, entry.name));
    }
  }
}
files.sort();

for (const file of files) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  if (result.code !== 0) process.exit(result.code);
}
