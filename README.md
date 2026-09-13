# Codex Kanban

Codex Kanban is an unofficial, local macOS alpha for people who already use Codex Desktop tasks. It provides a browser Kanban board and CLI for organizing and continuing those native tasks. It does not provide hosted accounts, remote execution, cloud storage, or multi-user isolation.

## Prerequisites

- macOS
- Node.js 24 or newer
- Codex Desktop installed, signed in, and containing local tasks for native features

The default tests do not require a Codex account or credentials. See [compatibility and support](docs/compatibility.md) for version observations and native smoke-test limits.

## Quick start

From a clean checkout:

```sh
npm ci
npm start
```

Open <http://127.0.0.1:4317>. Keep the server terminal running. To use another loopback port, run `PORT=4318 npm start`. `CODEX_HOME` can point to a different Codex data directory.

Useful checks:

```sh
npm run check
npm test
npm audit --omit=dev
npm pack --dry-run
```

## Board and CLI use

Create a project with an absolute path or a path beginning with `~/`, then create tasks from that project. The board reads native task metadata and saved history; Codex Desktop remains the owner of execution, credentials, approvals, and native task state. Keep the server on loopback. Do not expose it through a tunnel, proxy, or LAN bind.

The optional CLI can be linked once with `npm link`:

```sh
codex-kanban --help
codex-kanban project list
codex-kanban project create ~/workspace/example
codex-kanban task list --project PROJECT_ID --json
codex-kanban task create --project PROJECT_ID --prompt "Describe the work"
codex-kanban task show TASK_ID --follow
codex-kanban task send TASK_ID --text "Continue with the tests"
codex-kanban task steer TASK_ID --text "Focus on the API first"
codex-kanban task stop TASK_ID
codex-kanban task move TASK_ID done
codex-kanban task reset TASK_ID
codex-kanban task open TASK_ID
```

Without linking, use `npm run cli -- --help`. Use complete IDs returned by list commands. `--port 4318` selects another port and `--json` returns machine-readable output. Use `--file prompt.md` or `--file -` for longer input. See [board usage](docs/usage.md) for lanes, the conversation panel, and image attachments, and the [CLI reference](docs/cli.md) for all options and exit codes.

## Configuration and data

The server binds to `127.0.0.1` and uses a per-process request token for protected routes. This token is not login or user authentication. `PORT` changes the port; `CODEX_HOME` changes where Codex data is read. Kanban's layout and request records are stored under `.data/`, which is local state and is ignored by Git. Browser drafts remain in tab session storage.

Codex's database, rollout files, credentials, and Desktop IPC are private implementation details. This adapter was developed against Codex Desktop `26.908.40834` (build `8881`) and its bundled Codex CLI `0.154.0-alpha.6.2`, with IPC state version 11 and observed follower request versions. A Desktop update may require adapter changes; these observations are not compatibility promises. See [architecture and session state](ARCHITECTURE.md) and [compatibility](docs/compatibility.md).

Set `KANBAN_CODEX_BIN` to the bundled Codex CLI path when the Desktop app is installed outside `/Applications`. Task creation request records live in `.data/task-requests` and survive restarts; keep them, because they provide duplicate-submission protection. See [usage](docs/usage.md) for details.

## Troubleshooting

- Check `node --version` and install dependencies with `npm ci`.
- If port 4317 is busy, use `PORT=4318 npm start`.
- Keep the server process running while using the board.
- Native features require Codex Desktop to be installed and signed in with local tasks. The fixture-based default test suite does not validate native actions.
- Native probes are separate and intentional: `npm run probe:native-setup` and `npm run probe:shared-server`.
- Browser regression checks require Ego Lite and an isolated fixture server; they are optional contributor checks. See [contributing](CONTRIBUTING.md).

## Documentation

- [Board usage and configuration](docs/usage.md)
- [CLI reference](docs/cli.md)
- [Architecture and session state](ARCHITECTURE.md)
- [Compatibility and support](docs/compatibility.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Local source release checklist](docs/release-checklist.md)

The proposed hosted design in the architecture documents is planning material. The current release is local-only.

## Back up or reset local board state

Stop the server before copying `.data/board.sqlite`; while the server runs, committed data may also be in its WAL file. For an online backup, use SQLite's backup command with owner-only permissions:

```sh
umask 077
sqlite3 .data/board.sqlite ".backup '.data/board-backup.sqlite'"
```

To reset, stop the server, keep a backup, and remove `board.sqlite` together with any `board.sqlite-wal` and `board.sqlite-shm` sidecars. Restore only a verified backup with the server stopped.
