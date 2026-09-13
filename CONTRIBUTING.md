## Development setup

Codex Kanban is an unofficial local macOS alpha for people who already use Codex Desktop tasks. It is not a hosted service. Use Node.js 24 or newer. A signed-in Codex Desktop installation with local tasks is needed only for native features, not for the fixture tests below.

```sh
npm ci
npm run check
npm test
```

Run the local board with `npm start`. The default browser address is `http://127.0.0.1:4317`. `npm link` installs the optional `codex-kanban` CLI; without linking, use `npm run cli -- --help`.

The default tests use deterministic temporary directories and fixtures. Node.js and the installed dependencies are sufficient for fixture checks; a Codex account or signed-in Desktop is not required. Developer tests and the browser and native probe commands need a source checkout: the smaller runtime tarball from `npm pack` intentionally omits `test/`, its fixtures, and the probe scripts. The two scripted native probes, `npm run probe:native-setup` and `npm run probe:shared-server`, use temporary Codex homes and do not need account credentials, but they do need the installed Codex executable (macOS with Codex Desktop, or `KANBAN_CODEX_BIN`); run them only when you intentionally have that environment. Real native board actions require running, signed-in Desktop. Browser checks require Ego Lite and an isolated fixture server, and are optional (`npm run test:browser`, `npm run test:time-filter`, `npm run test:board:browser`, `node scripts/verify-status-sync.mjs`, or `node scripts/verify-chat-input.mjs`). Do not run native task actions as part of routine CI.

Keep changes focused and document behavior that depends on private Codex Desktop IPC. Before opening a change, run the default checks and inspect `npm pack --dry-run` for accidental files. Do not add credentials, transcripts, local databases, personal paths, or generated output.

## Module layout

- `server.mjs` and `lib/`: local HTTP boundary, native adapter, board storage, task and transcript readers, and CLI implementation.
- `public/`: browser UI and its bundled static assets.
- `bin/`: executable CLI entry point.
- `scripts/`: syntax, browser, synchronization, and native probe checks.
- `test/`: fixture-based tests.
- `docs/`, `README.md`, and `ARCHITECTURE.md`: user, compatibility, and design documentation.

## Bug reports and contributions

Only share redacted, reproducible details: operating-system and Node versions, app version observations, commands, sanitized logs, and a minimal fixture. Never disclose credentials, tokens, task transcripts, absolute personal paths, or private database contents. The project does not yet have a public issue or vulnerability-reporting address; configuring a private reporting channel is a release prerequisite. Until then, do not disclose security details publicly.

Hosted login, remote execution, cloud storage, and multi-user authorization remain proposed future work and are outside this local release.
