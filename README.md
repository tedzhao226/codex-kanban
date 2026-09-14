# Codex Kanban

See what’s running, what needs you, and what’s ready to review.
Codex Kanban brings your Codex Desktop tasks into a local board, with conversations one click away.

![Codex Kanban showing sample tasks across Backlog, Running, Needs input, Review, and Done](docs/images/board.png)

*The screenshots use sample projects and conversations in the app’s actual interface.*

- **Organize your work.** Drag cards between lanes, reorder them, and filter by project, search, or last update.
- **Follow live progress.** Running tasks, approval requests, and idle tasks update their lanes automatically.
- **Continue a conversation.** Read replies, attach images, send a follow-up, steer a run, or stop it from the side panel.
- **Start from the board or terminal.** Create local projects and tasks with the UI or optional CLI.

An unofficial macOS alpha that runs on your machine alongside Codex Desktop.
Your tasks keep their native history and workspace; approvals stay in Codex.
No separate API key is needed.

## Prerequisites

- macOS
- Node.js 24 or newer
- Codex Desktop installed, signed in, and containing local tasks for native features

See [compatibility and support](docs/compatibility.md) for tested version observations and limitations.

## Quick start

From a clean checkout:

```sh
git clone https://github.com/tedzhao226/codex-kanban.git
cd codex-kanban
npm ci
npm start
```

Open [the board](http://127.0.0.1:4317) and keep the server terminal running.
To use another port, run `PORT=4318 npm start`.
Set `CODEX_HOME` if your Codex data lives elsewhere.

Task creation defaults to `/Applications/ChatGPT.app/Contents/Resources/codex`, the app bundle used in the compatibility checks.
If your installation is named `Codex.app`, start the server with its executable path instead:

```sh
KANBAN_CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex npm start
```

For an installation elsewhere, set `KANBAN_CODEX_BIN` to its actual bundled executable.

To check your source checkout, run:

```sh
npm run check
npm test
npm audit --omit=dev
npm pack --dry-run
```

## Board and CLI use

Choose **+ New project** and enter a folder path, then use **+ New task** to describe the work.
Click any card to open its conversation beside the board.
Reply when it’s idle, or use **Steer** to give an active run new guidance.
For approvals and native tools, choose **Open in Codex**.

![A running task open beside the board, with its conversation, tool activity, and a draft steering message](docs/images/conversation.png)

Project paths must be absolute or start with `~/`.
Tasks use the project’s existing local folder; worktrees and cloud tasks are not supported.
See [board usage](docs/usage.md) for lane behavior, image attachments, and draft recovery.

For terminal access, run `npm link` once, then use the same running server:

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

Without linking, use `npm run cli -- --help`.
Use complete IDs returned by list commands.
`--port 4318` selects another port, and `--json` returns machine-readable output.
Use `--file prompt.md` or `--file -` for longer input.
The [CLI reference](docs/cli.md) covers all options and exit codes.

## Configuration and data

The server listens only on `127.0.0.1` and uses a per-process token to guard local requests.
It has no user login or multi-user isolation; keep it local and do not expose it through a tunnel, proxy, or LAN bind.
Codex Desktop owns execution and credentials.
Kanban stores board layout and task-creation records in the Git-ignored `.data/` folder, while browser drafts stay in tab session storage.

Codex's database, rollout files, credentials, and Desktop IPC are private implementation details. Dated observations on 2026-09-13 recorded Codex Desktop app version `26.908.40834`, build `8881`, with bundled Codex CLI `0.154.0-alpha.6.2`; the adapter also observed IPC state version 11 and follower request versions. A Desktop update may require adapter changes; these observations are not compatibility promises. See [architecture and session state](ARCHITECTURE.md) and [compatibility](docs/compatibility.md).

Set `KANBAN_CODEX_BIN` when the bundled executable differs from the default path shown above.
Keep `.data/task-requests` across restarts and restores: these records protect against duplicate task creation.
See [usage](docs/usage.md) for details.

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

Reference material is grouped in [architecture and data flow](docs/architecture-and-data-flow.md), [research](docs/research/), and [planning](docs/plans/). These documents contain dated observations and proposals, not additional compatibility promises.

The proposed hosted design in the architecture documents is planning material. The current release is local-only.

The source is publicly available, but no open-source license has been granted yet.

## Back up or reset local board state

Stop the server and wait for it to shut down cleanly before copying `.data/board.sqlite`; while the server runs, committed data may also be in the `board.sqlite-wal` sidecar. For an online backup, use SQLite's backup command with owner-only permissions:

```sh
umask 077
sqlite3 .data/board.sqlite ".backup '.data/board-backup.sqlite'"
```

To reset, stop the server, keep a backup, and remove `board.sqlite` together with both `board.sqlite-wal` and `board.sqlite-shm` sidecars. Ensure no active legacy `board.json` remains in `.data/`, or the next startup reimports it; `board.json.bak` is never imported.

To restore, use only a verified SQLite backup with the server stopped: copy it over `board.sqlite`, remove any stale `board.sqlite-wal` and `board.sqlite-shm` sidecars, then restart the server and reload open tabs. Preserve `.data/task-requests` when resetting or restoring, because those records provide duplicate-creation protection.
