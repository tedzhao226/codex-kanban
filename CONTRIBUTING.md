## Development setup

Codex Kanban is an unofficial local macOS alpha for people who already use Codex Desktop tasks. It is not a hosted service. Use Node.js 24 or newer and a signed-in Codex Desktop installation with local tasks.

```sh
npm ci
npm run check
npm test
```

Run the local board with `npm start`. The default browser address is `http://127.0.0.1:4317`. `npm link` installs the optional `codex-kanban` CLI; without linking, use `npm run cli -- --help`.

The default tests use deterministic temporary directories and fixtures. They do not require a Codex account, credentials, or signed-in Desktop. Native probes are separate: run `npm run probe:native-setup` or `npm run probe:shared-server` only when you intentionally have the required local macOS environment. Browser checks require Ego Lite and an isolated fixture server, and are optional (`npm run test:browser`, `npm run test:time-filter`, `npm run test:board:browser`, `node scripts/verify-status-sync.mjs`, or `node scripts/verify-chat-input.mjs`). Do not run native task actions as part of routine CI.

Keep changes focused and document behavior that depends on private Codex Desktop IPC. Before opening a change, run the default checks and inspect `npm pack --dry-run` for accidental files. Do not add credentials, transcripts, local databases, personal paths, or generated output.

## Module layout

- `server.mjs` and `lib/`: local HTTP boundary, native adapter, board storage, task and transcript readers, and CLI implementation.
- `public/`: browser UI and its bundled static assets.
- `bin/`: executable CLI entry point.
- `scripts/`: syntax, browser, synchronization, and native probe checks.
- `test/`: locked fixture-based acceptance tests.
- `docs/`, `README.md`, and `ARCHITECTURE.md`: user, compatibility, and design documentation.

## Bug reports and contributions

Only share redacted, reproducible details: operating-system and Node versions, app version observations, commands, sanitized logs, and a minimal fixture. Never disclose credentials, tokens, task transcripts, absolute personal paths, or private database contents. The project does not yet have a public issue or vulnerability-reporting address; configuring a private reporting channel is a release prerequisite. Until then, do not disclose security details publicly.

Hosted login, remote execution, cloud storage, and multi-user authorization remain proposed future work and are outside this local release.
