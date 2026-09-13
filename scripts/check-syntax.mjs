import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const roots = [
  ['.', ['server.mjs']],
  ['bin', ['.mjs']],
  ['lib', ['.mjs']],
  ['public', ['.js']],
  ['scripts', ['.mjs']],
  ['test', ['.mjs']],
];

const files = [];
for (const [directory, suffixes] of roots) {
  const names = await readdir(directory, { withFileTypes: true });
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
