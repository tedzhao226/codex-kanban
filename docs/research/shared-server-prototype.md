# Shared App Server creation experiment

Tested on 2026-09-13 with the installed Codex CLI `0.154.0-alpha.6.2`.

**Project creation, task creation, and a shared task subscription pass against one real App Server with two WebSocket clients.**
This proves the engine route identified in [native creation research](native-creation-routes.md).
The later Desktop connection test succeeded, but that launch disabled the local IPC bridge used by Kanban.
Directly switching Desktop to WebSocket is therefore incompatible with the current Kanban adapter.

## Desktop test result

On 2026-09-13, the user restarted Desktop with `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4319`.
The native log recorded a successful WebSocket initialization handshake at 08:00:43 UTC.
`lsof` confirmed Desktop PID 96005 connected to shared App Server PID 94119 on that port.

Kanban's HTTP server remained available on port 4317, but `/api/board` reported `connection.connected: false` and `Open Codex to connect live task status.`
A new connection to `~/.codex/ipc/ipc.sock` failed with `ECONNREFUSED`.
Desktop's open Unix sockets did not include that endpoint.

Installed source explains the behavior: `registerIpcClientForWebContents` returns immediately when `getTransportKind() !== 'stdio'`.
The host manager coordination constructor also requires stdio.
These guards appear in `.vite/build/main-DaMR-wdT.js` at byte offsets 3368665 and 1515628 inside the [app archive](/Applications/ChatGPT.app/Contents/Resources/app.asar).
This is a transport restriction in this Desktop build, rather than a stale Kanban connection.
The native task-management tools were also absent from this task's available tool catalog after the restart.

Creation against the Desktop-connected server was paused when this regression was identified.
No new task or project was created in the user's normal Codex home by this test.
The earlier seven passing checks used the isolated home described below.

Recovery is to quit Desktop and reopen it normally, without the WebSocket environment override.
Keep the shared server running until Desktop has disconnected from it; stopping the active engine would interrupt its tasks.
After the normal launch is verified, stop the experimental server.
Native sidebar synchronization, approvals, and app-tool compatibility remain unverified.

After the user reopened Desktop normally, the same Kanban health check returned `connection.connected: true` and `Connected to Codex`.
The current task again reported `runtime: running` and appeared in the Running lane.
The native task-management tools also returned to the available tool catalog.
Desktop had disconnected from port 4319 before the experimental App Server was stopped.

## Run the isolated probe

Requires Node.js 24 or newer and the installed Codex CLI.

```sh
npm run probe:shared-server
```

Set `KANBAN_CODEX_BIN` to use a different CLI binary.
The [probe](../../scripts/probe-shared-app-server.mjs) creates a temporary Codex home and workspace, starts the bundled App Server on loopback, and connects a creator and an observer.
A local HTTP fixture supplies a deterministic model response; the probe copies no account credentials and makes no paid model call.
It stops both servers when the checks finish and retains `result.json`, `app-server.log`, and the isolated Codex data under the printed temporary directory.
Failures return a nonzero exit code.

Seven checks passed:

1. Create a project with the experimental `project/create` API.
2. Read and list that project from the observer.
3. Repeat the creation key and receive the same project ID.
4. Create a task assigned to that project.
5. Read the new task's identity from the observer.
6. Start a turn, attach the observer, and receive the same completed assistant message on both clients.
7. Read the task's project assignment and find it through the project task filter after the turn.

A separate read-only inspection after shutdown found the task, matching project ID, and rollout path in the temporary SQLite database.
The successful run made exactly one request to the local model fixture.

## Task persistence affects the creation flow

In this build, `thread/start` returned the requested project ID, but an immediate `thread/read` returned `projectId: null`.
Attempting `thread/resume` before the first turn failed with `no rollout found`.
After the first prompt began, the observer could resume the task and receive its completion.
The saved task then exposed the correct project ID.

Without another operation that saves the empty task, the proposed New Task submission would need its first prompt:

```text
project/create (only for a new project)
  → thread/start with projectId and cwd
  → turn/start with the user's prompt
  → attach the other client after the rollout exists
```

The later [native creation route](native-creation-routes.md#implemented-task-creation-route) found that setting the task's name saves an empty legacy history before the first turn.
The implemented flow uses that operation, closes its setup engine, and lets Desktop receive the first prompt through native IPC.

The probe gates its model response so the observer can attach while the turn is active.
It does not yet define production readiness detection or recovery if the task is created but its first turn fails.
It also does not verify creating a new directory: the supplied project root already exists.

## Reproducing the Desktop connection test

The installed Desktop build reads `CODEX_APP_SERVER_WS_URL` at launch.
Testing that path requires quitting Desktop, which interrupts active tasks.
The commands below reproduce the tested configuration, including the IPC regression described above.
No persistent app setting or app binary needs changing.

After Desktop has quit, start the shared server in one terminal:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen ws://127.0.0.1:4319
```

Then launch Desktop from another terminal:

```sh
CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4319 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
```

Unlike the isolated probe, these commands use the normal Codex home and account configuration.
Keep the server terminal open while testing.
The current probe always creates its own isolated server.

The native test must verify that:

- Desktop connects to the selected server and opens an externally created task.
- The new project appears in the native sidebar and retains task membership after reopening.
- Native approvals, user questions, and app tools work for externally created tasks.
- Existing tasks still work through Kanban's current owner/follower connection.

Project sidebar updates are uncertain because Desktop reads a legacy project cache.
App tool availability is also uncertain because Desktop normally supplies tool configuration and a pipe path when it launches its engine.
The fixture uses no tools or approvals and cannot validate either behavior.

To roll back, quit the test Desktop instance, stop the shared server with Ctrl+C, and launch Desktop normally.
Any real tasks or projects created during the native test remain saved; rollback only changes the transport.

## Feature status

The isolated experiment is runnable and passes against the installed engine.
Kanban now has a New Project control using native folder registration, independently of this shared-server experiment.
New Task creation is now implemented through the empty-task setup route described above.
The direct Desktop WebSocket route breaks the current Kanban adapter and must not be used as its normal launch configuration.
The implemented route preserves Desktop's stdio coordination and the board's existing owner/follower integration.
