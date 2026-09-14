## Board usage

This page describes the board workflow, automatic lane placement, the conversation panel, and local configuration. For the CLI, see [CLI reference](cli.md). For storage and session state, see [architecture and session state](../ARCHITECTURE.md).

## Projects and tasks

- Click **+ New project**, enter an absolute folder path or a path starting with `~/`, then choose **Create project**. Kanban creates the folder if needed; its parent must already exist. Codex registers it, and the board shows the project even when it has no tasks. An already registered folder selects the existing project instead of creating a duplicate.
- Click **+ New task**, select a project, enter its first prompt, and choose **Create task**. The task uses the project's existing folder and opens its conversation inside Kanban. Codex loads the native task in the background. This version supports local project folders; it does not create worktrees or cloud tasks.
- If creation is interrupted, **Check creation** checks the same request without repeating its first prompt. Use **View task** when a task ID was returned but setup or delivery failed.
- Filter by project, search task titles and previews, or use **Updated** to show the last day, last 3 days, last week, or all time. Time ranges use the last update shown on each card; the browser remembers the time filter after reload.

## Lanes and placement

Automatic lanes follow the status Codex Desktop publishes: active tasks go to Running, approval requests and errors go to Needs input, and idle tasks go to Review. Tasks without a live snapshot start in Backlog. Codex may only publish status after a task has been loaded in the Desktop app. Done is always a manual choice.

- Drag a card between lanes or use its lane menu.
- Drag above another card to set the order within a lane. Reordering within the automatic lane keeps status tracking enabled.
- Manual placement lasts until you move the card again, choose **Follow task status**, or Codex starts running or needs attention. New activity releases the manual lane, including Done, so the card follows Codex again and returns to Review when idle.
- The runtime badge always shows the current Desktop status.

The board displays non-archived local user tasks. Cloud tasks and subagents are outside this version's scope.

## Conversation panel

- Click a card to open its conversation beside the board. Resize the panel with its left edge or arrow keys; expand it for more space.
- Older tasks show saved history immediately. If a task is not loaded in the Desktop app, choose **Connect in Codex** to open the original task and enable its controls.
- The panel shows the newest 50 messages and activities; **Load earlier** adds another 50. History display is limited to the newest 10,000 items; use Codex for anything earlier.
- Send a reply when idle, **Steer** the current run, or **Stop** it. Press Cmd/Ctrl+Enter to send. Drafts survive panel switches and reloads in the same browser tab.
- Choose **+ Image** or paste a screenshot into the composer; preview or remove images before sending or steering. Image-only messages are supported, with up to four PNG, JPEG, WebP, or GIF images totaling 3 MB per message. Image drafts stay with the text draft; if browser storage fills up, the panel warns you to keep the page open.
- Use **Open in Codex** for native tools, approvals, answering questions, other attachment types, and file review.
- Reading earlier messages does not pull the scroll position back to the bottom as replies arrive. Use **Jump to latest** to follow the run again.
- If delivery cannot be confirmed, the draft stays in place and requires checking the conversation before another submission. Steering a finished or changed run fails explicitly instead of starting another run.

Rendering: Markdown and code blocks are supported, and tool activity is collapsed. Mermaid and SVG code blocks render as diagrams with a **Source** disclosure below each preview. Standalone SVG markup and Markdown links or images pointing to `.svg` files in the task's workspace also show previews. Images sent from Kanban appear inline; historical local-file images, remote images, and other attachments remain placeholders linking back to Codex. SVG previews are static images with scripts, embedded HTML, animation, and external image references removed. Other raw HTML and non-HTTP links are disabled. Local SVG files are limited to 1 MB; Mermaid definitions are limited to 50,000 characters and 500 edges. Invalid or incomplete diagrams show an error with their source.

## Native integration

The server reads Codex's task database in SQLite read-only mode and project metadata from Codex's global state file under `CODEX_HOME` (normally `~/.codex`). It subscribes to the Desktop app's existing IPC socket for runtime snapshots and uses native follower requests for complete history, replies, steering, and interruption. Kanban never edits Codex's database or rollout files directly. Approval and question handling remains in Codex.

Project creation uses Codex's native `codex://new?path=…` entry point and waits for project metadata to confirm registration. Task creation briefly starts the bundled Codex CLI as an App Server to create and name an empty native task, closes that setup process, opens the task in Desktop, confirms project membership, and sends the first prompt through the task's native owner. Native opening uses macOS `open` with `codex://threads/<task-id>`.

The Codex database schema and Desktop IPC are private implementation details, not a public integration API; see [compatibility](compatibility.md) for the observed versions. Connection failures and protocol mismatches are shown on the board.

## Configuration

| Variable | Effect |
| --- | --- |
| `PORT` | Loopback port for the server (default `4317`). |
| `CODEX_HOME` | Codex data directory to read (default `~/.codex`). |
| `KANBAN_CODEX_BIN` | Path to the bundled Codex CLI used for task creation. Set it when the Desktop app is installed outside `/Applications`. |

The server binds to `127.0.0.1` only and uses a per-process request token for transcript reads, streams, and actions. This token is a request guard, not login or user authentication. The supported setup is one local server with multiple browser tabs or API clients on the same Mac. Do not expose the server through a tunnel, proxy, or LAN bind.

## Local data

Everything Kanban writes lives under `.data/`, which is ignored by Git.

- `.data/board.sqlite` (with `-wal` and `-shm` sidecars) stores lanes, card order, and layout revisions. A persistent worker owns the connection. Different cards can be edited concurrently; moving a card from a stale view returns a conflict and refreshes that editor without retrying the move.
- `.data/task-requests` stores task creation request records. They survive server restarts and provide duplicate-submission protection; an uncertain request is never automatically recreated. Keep these records.
- On first startup, the server imports an existing legacy `board.json` transactionally and archives it as `board.json.bak`. An existing backup is never overwritten; if it prevents archival, startup prints a warning and leaves both JSON files intact. Once initialized, SQLite is authoritative and JSON is never reimported. When resetting, ensure no active `board.json` remains or startup will import it; `board.json.bak` is never imported.
- Corrupt data and unsupported schema versions stop startup with an error.

See [backup and reset steps](#back-up-or-reset-local-board-state) below.

Codex status changes and card moves notify all open boards immediately, with a four-second refresh for reconciliation. Native task metadata is reread every five seconds. If SQLite is temporarily locked, status synchronization reports the failure and retries on refresh.

## Back up or reset local board state

Stop the server and wait for it to shut down cleanly before copying `.data/board.sqlite`; while the server runs, committed data may also be in the `board.sqlite-wal` sidecar. For an online backup, use SQLite's backup command with owner-only permissions:

```sh
umask 077
sqlite3 .data/board.sqlite ".backup '.data/board-backup.sqlite'"
```

To reset, stop the server, keep a backup, and remove `board.sqlite` together with both `board.sqlite-wal` and `board.sqlite-shm` sidecars. Ensure no active legacy `board.json` remains in `.data/`, or the next startup reimports it; `board.json.bak` is never imported.

To restore, use only a verified SQLite backup with the server stopped: copy it over `board.sqlite`, remove any stale `board.sqlite-wal` and `board.sqlite-shm` sidecars, then restart the server and reload open tabs. Preserve `.data/task-requests` when resetting or restoring, because those records provide duplicate-creation protection.
