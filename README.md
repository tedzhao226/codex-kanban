# Codex Kanban

A local Kanban board for your existing Codex desktop tasks.
Open a card to return to its original native conversation, with its history and workspace intact.

## Run

Requires macOS, Node.js 24 or newer, and the Codex desktop app installed with local tasks.
No npm packages or API keys are needed.

```sh
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
- Click a title or **Open in Codex** to open the original native task.

Automatic lanes use published desktop status: active tasks go to Running, approval requests and errors go to Needs input, and idle tasks go to Review.
Tasks without a live snapshot start in Backlog.
Codex may only publish status after a task has been loaded in the desktop app.
Done is always a manual choice.
Once you move a card, its lane stays fixed until you move it again or restore automatic placement.
Its runtime badge continues to show the current desktop status independently.

The board displays non-archived local user tasks.
Cloud tasks and subagents are outside this version’s scope.
Chat runs in the native app; this board does not embed the chat UI or send prompts.

## Local integration

The server reads `~/.codex/state_5.sqlite` in SQLite read-only mode and reads project metadata from `.codex-global-state.json`.
It subscribes to the desktop app’s existing `~/.codex/ipc/ipc.sock` for runtime snapshots, retaining status and pending requests in memory.
Conversation turns received in a snapshot are discarded.
It never resumes tasks, starts agents, responds to approvals, or writes to Codex’s data files.

The database schema and desktop IPC are private implementation details, not a public integration API.
This adapter targets IPC status version 11, observed with the installed app’s bundled Codex `0.154.0-alpha.6.2`.
A future desktop update may require changes to `lib/tasks.mjs` or `lib/desktop.mjs`.
Connection failures and protocol mismatches are shown on the board.

Native opening uses macOS `open` with `codex://threads/<task-id>`.
Board lanes and card order are stored separately in `.data/board.json`, excluded from Git.
Delete that file while the server is stopped to reset your board layout.

The server binds to `127.0.0.1` only.
It checks request hosts and origins, requires a per-process token for actions, and serves no cross-origin API.
Keep it local: it has access to your task titles, previews, and project paths.

## Verify

```sh
npm run check
npm test
```

Tests cover lane persistence and ordering, runtime updates over a fixture IPC socket, read-only task discovery, native-open routing, and HTTP request boundaries.
The source uses Node’s built-in HTTP, SQLite, and test modules, with a plain JavaScript browser UI.
