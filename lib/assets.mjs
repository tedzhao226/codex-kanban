import { realpath, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep, extname } from 'node:path';

const MAX_SVG_BYTES = 1024 * 1024;

export async function readTaskSvg(cwd, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || extname(path).toLowerCase() !== '.svg' || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw Object.assign(new Error('Choose a local SVG file in this task’s workspace.'), { status: 400 });
  }
  if (!cwd) throw Object.assign(new Error('This task has no local workspace.'), { status: 404 });
  try {
    const root = await realpath(cwd), file = await realpath(resolve(root, path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw Object.assign(new Error('SVG files must be inside this task’s workspace.'), { status: 403 });
    if (extname(file).toLowerCase() !== '.svg') throw Object.assign(new Error('The resolved file must be an SVG.'), { status: 400 });
    const expected = await stat(file);
    if (!expected.isFile()) throw Object.assign(new Error('The SVG path is not a file.'), { status: 400 });
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino || await realpath(file) !== file) {
        throw Object.assign(new Error('The SVG file changed while opening it. Try again.'), { status: 409 });
      }
      const buffer = Buffer.alloc(MAX_SVG_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_SVG_BYTES) throw Object.assign(new Error('SVG files must be 1 MB or smaller.'), { status: 413 });
      return buffer.toString('utf8', 0, length);
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw Object.assign(new Error('The SVG file is no longer available in this workspace.'), { status: 404 });
    if (error.code === 'ELOOP') throw Object.assign(new Error('The SVG path changed to a symbolic link. Try again.'), { status: 409 });
    throw error;
  }
}
