const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

export function applyPatches(state, patches, keys = null) {
  let next = structuredClone(state);
  for (const patch of patches) {
    const path = patch.path;
    if (!Array.isArray(path) || path.some(key => UNSAFE.has(String(key)))) throw new Error('Unsafe IPC patch path.');
    if (keys && path.length && !keys.has(path[0])) continue;
    if (!['add', 'remove', 'replace'].includes(patch.op)) throw new Error('Unknown Codex runtime patch operation.');
    if (!path.length) {
      if (patch.op !== 'replace') throw new Error('Invalid root patch.');
      next = keys ? Object.fromEntries(Object.entries(patch.value).filter(([key]) => keys.has(key))) : structuredClone(patch.value);
      continue;
    }
    let target = next;
    for (const key of path.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('Codex runtime patch is missing its parent.');
      target = target[key];
    }
    const key = path.at(-1);
    if (!target || typeof target !== 'object') throw new Error('Invalid IPC patch target.');
    if (Array.isArray(target) && (!Number.isInteger(key) || key < 0 || key > target.length)) throw new Error('Invalid IPC array index.');
    if (patch.op === 'remove') { if (Array.isArray(target)) target.splice(key, 1); else delete target[key]; }
    else if (patch.op === 'add' && Array.isArray(target)) target.splice(key, 0, structuredClone(patch.value));
    else target[key] = structuredClone(patch.value);
  }
  return next;
}
