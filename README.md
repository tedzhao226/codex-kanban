# Codex Kanban

A local Kanban board for your existing Codex desktop tasks.
Open a card to read its conversation, reply, steer an active run, or stop it.
Messages go to the original native task, keeping its history, workspace, model, and permissions.

## Run

Requires macOS, Node.js 24 or newer, and the Codex desktop app installed with local tasks.
No separate API key is needed.

```sh
npm ci
npm start
```

Open [Codex Kanban](http://127.0.0.1:4317).
Keep the terminal process running while using the board.
Set `PORT` to change the port or `CODEX_HOME` if your Codex data lives elsewhere.

```sh
PORT=4318 npm start
```

## Use

- Filter by project or search task titles and previews.
- Drag a card between lanes or use its lane menu.
- Drag above another card to set the order within a lane.
- Choose **Follow task status** to restore automatic placement.
- Click a card to open its conversation beside the board.
- Resize the panel with its left edge or arrow keys; expand it for more space.
- Read the newest 50 messages and activities, then use **Load earlier** for another 50.
- Send a reply when idle, **Steer** the current run, or **Stop** it.
- Press Cmd/Ctrl+Enter to send; drafts survive panel switches and reloads in the same browser tab.
- Use **Open in Codex** for native tools, approvals, questions, attachments, and file review.

Automatic lanes use published desktop status: active tasks go to Running, approval requests and errors go to Needs input, and idle tasks go to Review.
Tasks without a live snapshot start in Backlog.
Codex may only publish status after a task has been loaded in the desktop app.
Done is always a manual choice.
Once you move a card, its lane stays fixed until you move it again or restore automatic placement.
Its runtime badge continues to show the current desktop status independently.

The board displays non-archived local user tasks.
Cloud tasks and subagents are outside this version’s scope.
Older tasks show saved history immediately.
If a task is not loaded in the desktop app, choose **Connect in Codex** to open the original task and enable its controls.
The panel renders a local view of the native conversation; it does not embed the desktop interface.
Markdown and code blocks are supported, tool activity is collapsed, and images remain placeholders linking the workflow back to Codex.
Raw HTML and non-HTTP links are disabled.
History display is limited to the newest 10,000 messages and activities; use Codex for anything earlier.

Reading earlier messages does not pull the scroll position back to the bottom as replies arrive.
Use **Jump to latest** to follow the run again.
If delivery cannot be confirmed, the draft stays in place and requires checking the conversation before another submission.
Steering a finished or changed run fails explicitly instead of starting another run.

## Local integration

The server reads `~/.codex/state_5.sqlite` in SQLite read-only mode and reads project metadata from `.codex-global-state.json`.
It subscribes to the desktop app’s existing `~/.codex/ipc/ipc.sock` for runtime snapshots.
Only tasks with an open conversation panel retain full native snapshots and selected saved rollout history in memory.
The saved transcript reader includes user messages, assistant messages, and tool summaries; it excludes injected instructions and internal reasoning.
Closing the last panel for a task releases its transcript cache.

The adapter discovers the original task owner and uses native follower requests for complete history, starting a reply, steering, and interruption.
It does not create another session, launch a separate app server, or modify Codex’s database or rollout files directly.
Approval and question handling remains in Codex.
The browser receives normalized transcript items rather than raw native state.

The database schema and desktop IPC are private implementation details, not a public integration API.
This adapter targets IPC state version 11 and follower request versions observed with the installed app’s bundled Codex `0.154.0-alpha.6.2`.
A future desktop update may require adapter changes.
Connection failures and protocol mismatches are shown on the board.

Native opening uses macOS `open` with `codex://threads/<task-id>`.
Board lanes, card order, and layout revisions are stored separately in `.data/board.sqlite`, excluded from Git together with its WAL sidecar files.
A persistent worker owns the SQLite connection, keeping board reads, writes, and lock waits off the HTTP thread.
The supported setup is one local server with multiple browser tabs or API clients on the same Mac.
Different cards can be edited concurrently; moving a card from a stale view returns a conflict and refreshes that editor without retrying the move.
Other tabs refresh every four seconds, except that visible board replacement waits until an active drag or lane-selector interaction ends.

On first startup, the server imports the existing `board.json` transactionally and archives it as `board.json.bak`.
An existing backup is never overwritten; if it prevents archival, startup prints a warning and leaves both JSON files intact.
Once initialized, SQLite is authoritative and JSON is never reimported or used as a fallback.
Corrupt data and unsupported schema versions stop startup with an error.

### Board backup and reset

For a file backup, stop the server with Ctrl+C and wait for clean shutdown before copying `.data/board.sqlite`.
Do not copy only the main database while the server is running: committed data can still be in `board.sqlite-wal`.
For an online backup, use SQLite's backup command with owner-only file permissions:

```sh
umask 077
sqlite3 .data/board.sqlite ".backup '.data/board-backup.sqlite'"
```

To reset the layout, stop the server, keep a backup, and remove `board.sqlite` and any remaining `board.sqlite-wal` and `board.sqlite-shm` files together.
Ensure no active `board.json` remains, or startup will import it; `board.json.bak` is never imported.
Restart the server and reload open browser tabs.
To restore, stop the server, replace the database with a verified SQLite backup, remove stale sidecars, then restart and reload.

### Local request protection

The server binds to `127.0.0.1` only.
It checks request hosts and origins, requires a per-process token for transcript reads, streams, and actions, and serves no cross-origin API.
Browser streams reconnect after interruptions; unconfirmed message submissions are not retried automatically.
Drafts are stored per task in the tab’s `sessionStorage`.
Keep it local: it can read conversations and send messages through your signed-in desktop app.

## Verify

```sh
npm run check
npm test
```

Browser concurrency checks require Ego Lite and use an isolated fixture server with no native task actions:

```sh
npm run test:board:browser
```

Tests cover SQLite migration, concurrent layout edits, revision conflicts, rollback and worker lifecycle, task discovery, IPC updates and revision recovery, transcript filtering and pagination, native reply/steer/stop routing, duplicate submission handling, and HTTP/SSE boundaries.
The source uses Node’s built-in HTTP, SQLite, and test modules with a plain JavaScript browser UI.
`marked` parses Markdown and `dompurify` sanitizes the rendered output; both are served locally.
