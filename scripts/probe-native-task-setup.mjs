import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { saveNativeTask } from '../lib/task-creation.mjs';

const directory = await realpath(await mkdtemp(join(tmpdir(), 'kanban-native-setup-')));
const codexHome = join(directory, 'codex'), cwd = join(directory, 'workspace');
await Promise.all([mkdir(codexHome), mkdir(cwd)]);
await writeFile(join(codexHome, 'config.toml'), `model="fixture"
model_provider="fixture"
cli_auth_credentials_store="file"
[model_providers.fixture]
name="Offline fixture"
base_url="http://127.0.0.1:9/v1"
wire_api="responses"
requires_openai_auth=false
[features]
apps=false
remote_plugin=false
recommended_plugins=false
`);
let announcedId;
const id = await saveNativeTask({ cwd, codexHome, title: 'Native setup fixture', onCreated: async id => { announcedId = id; } });
assert.equal(id, announcedId);
const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
try {
  const row = db.prepare('SELECT id, cwd, name, rollout_path FROM threads WHERE id = ?').get(id);
  assert.equal(row.id, id); assert.equal(row.cwd, cwd);
  const records = (await readFile(row.rollout_path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.some(record => record.type === 'session_meta' && record.payload.id === id));
  assert.ok(!records.some(record => record.type === 'event_msg' && ['user_message', 'task_started'].includes(record.payload.type)));
  console.log('PASS: native task is durable after setup exits, with no first model turn.');
  console.log('Isolated results: ' + directory);
} finally { db.close(); }
