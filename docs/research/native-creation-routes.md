# Native task and project creation routes

Research date: 2026-09-13.

**The installed Codex engine supports project creation, but Kanban's existing Desktop IPC socket does not expose that operation.**
A shared App Server is a plausible next experiment for creating tasks through the same engine as Desktop.
It is not a demonstrated solution in this installation.

Follow-up: the [shared-server experiment](shared-server-prototype.md) verified engine creation and a native WebSocket connection.
It also found that WebSocket mode disables Desktop's IPC coordination and breaks Kanban's existing live connection.
The investigation below describes the earlier source and read-only findings; the follow-up records the later launch experiment.

## Implemented project creation route

The native `codex://new?path=ABSOLUTE_FOLDER` route registers a missing project through Desktop's own `createProjectForRoot` manager, updates its cache, and selects it.
Kanban's New Project form now creates or validates the folder, opens that route, and waits for the native project record before reporting success.
This works with Desktop's normal stdio transport and retains Kanban's IPC connection.
The browser flow was verified with a temporary project under the repository's ignored `.data` directory; the native project listing confirmed its project ID.
No task was started by that check.

Source: main bundle `P2e`'s `newThread` branch and `V2e`, plus `WD` in `.vite/build/window-all-closed-BxbCP6YG.js`, inside the installed app archive.
The same route can prefill a task composer, but it does not submit its prompt, so it does not provide complete task creation inside Kanban.

## Implemented task creation route

A later isolated probe found that `thread/name/set` saves an empty task created with `thread/start` and `historyMode: "legacy"`.
The setup engine can then exit before any model turn starts.
Desktop can load that saved task through `codex://threads/<id>` and publish its normal owner/follower connection.
Kanban sends the user's first prompt through that native owner.
This preserves Desktop's normal transport and avoids the WebSocket regression.

The production implementation is [task-creation.mjs](../../lib/task-creation.mjs), with an isolated reproduction in [probe-native-task-setup.mjs](../../scripts/probe-native-task-setup.mjs).
The local sidebar project ID was rejected by the separate setup engine's project lookup, so setup uses the selected project's folder.
Kanban confirms the resulting native task's project membership before sending the prompt.
Request IDs are journaled before setup and retained across restarts; partial or uncertain results cannot automatically create another task or repeat the prompt.

An isolated native task proved Desktop ownership, first-prompt delivery, and successful native `get_usage_limits` tool execution.
The browser form created another task and displayed its expected reply in Kanban.
The installed CLI created an isolated task, accepted steering and stop requests, and completed a subsequent follow-up.
These checks used the existing `kanban-creation-test` project and did not restart Desktop.
Native approval prompts were not forced during verification; approvals and user questions remain in Codex, as for existing Kanban conversations.

The sections below preserve the earlier investigation and rejected routes.

## Verified routes

| Route | Evidence | Assessment |
| --- | --- | --- |
| Existing `~/.codex/ipc/ipc.sock` | Initialization and owner discovery succeed; `project/list` and `thread/loaded/list` return `no-client-found`. | Registered owner/follower requests work; general App Server methods have no connected handler. |
| Desktop app-tools pipe | Implements tool listing/calling and a feature-gated `create_project`; live logs reject clients with `missing-code-signing-identity`. | Not an available standalone Node bridge here. |
| Experimental App Server API | Installed schema includes `project/create` and `thread/start.projectId`; stable schema excludes them. | Creation capability exists in the engine. |
| Current Desktop engine connection | Desktop and core process communicate through unnamed stdin/stdout/stderr socketpairs; no named control socket or core TCP listener was found. | Kanban cannot attach to this running engine through a normal public listener. |
| Shared WebSocket App Server | Desktop source accepts a configured WebSocket address before its usual transport. | Candidate experiment requiring launch changes and a restart. |

Sources: installed source, generated schemas, read-only probes, and logs described below.

## Existing IPC and protected app tools

The shared IPC broker finds a connected client that advertises a request handler, then forwards the request.
Desktop's conversation registration contains owner discovery and follower operations without a generic App Server forwarder.
The live owner-discovery response for the active task included `supportsUntrustedAppInput: true`; the two general read-only API requests returned `resultType: "error"`, `error: "no-client-found"`.
This confirms missing routing on the existing connection, not an inherent limitation of IPC.
Source: the installed Desktop app's generated bundle, including `handleRequest`, `findClientForRequest`, `handleClientDiscoveryRequest`, and `y9`.

The separate app-tools pipe starts at launch with a random socket path published as `CODEX_APP_TOOLS_PIPE_PATH`.
It dispatches `tools/list` and `tools/call` through a ready app window, with caller thread/turn context.
This production macOS build checks the socket peer's code-signing identity before accepting requests.
The plain Node probe closed without a tool response; a local Desktop log recorded repeated `dynamic_app_tools_peer_rejected reason=missing-code-signing-identity` events during the 2026-09-13 investigation.
Source: the installed Desktop app's main bundle, launch setup, and native authorization module.
The exact native allowlist was not reconstructed, and authorization was not changed or bypassed.

## Project creation capability and Desktop synchronization

The Desktop `create_project` tool validates source folders against the caller's workspace roots and calls native `projects.createLocal`.
It is included only when `projectToolsEnabled` is true and is absent from this investigation's available tool catalog.
The native manager can create a default workspace folder, writes the project through its backend, updates ordering and selection, and broadcasts state changes.
Source: the installed Desktop app's webview and main bundle, including `ProjectsManager.createLocal`.

Desktop always installs the App Server project backend around a legacy global-state cache.
The backend uses server project operations when the connected engine satisfies the `projects` version capability, whose minimum is `0.148.0-alpha.21`; otherwise it writes the legacy cache alone.
`localProjectTaskMembership` separately gates task assignment synchronization.
However, the native project list still reads global state, and the inspected backend observes task/connection events without handling `project/changed` notifications.
No webview handler for `project/changed` or `thread/project/updated` was found either.
Therefore a project created directly through App Server cannot yet be assumed to appear in Desktop's sidebar, even with a shared engine.
Source: main bundle `ZJe.start`, `initializeProjects`, `getLocalProjects`, backend installation; shared bundle's `projects` capability and notification tables.

Schema generation from the installed CLI confirms experimental `project/list`, `read`, `create`, `import`, `update`, `move`, and `delete` methods.
`project/create` requires `idempotencyKey`, `name`, and `roots: [{path}]`, with optional metadata.
`thread/start.projectId` persists the project assignment for durable tasks.
Stable generation excludes the project methods and that field.
Sources: generated project and task parameter schemas and stable request fixtures from the dated investigation (kept outside the repository).
Temporary schema files are investigation outputs, not repository dependencies.

Public documentation describes App Server transports, task creation, version-specific schema generation, and experimental API opt-in; its API overview does not document these project methods.
See [official App Server documentation](https://learn.chatgpt.com/docs/app-server).

## Practical next step

Desktop's transport factory checks `CODEX_APP_SERVER_WS_URL` or the host's `websocket_url` before its usual local transport.
A shared local daemon branch also exists, but it requires no configuration overrides; this build supplies a local app-tools override, so setting the daemon opt-in alone is not a demonstrated solution.
The default control socket `~/.codex/app-server-control/app-server-control.sock` was absent (`codex app-server daemon version` returned `ENOENT`).
Live `lsof` inspection paired Desktop PID 88886's descriptors 120/126/128 with core PID 88993's stdin/stdout/stderr, confirming the current stdio connection.
The core process had no TCP listener.
Source: main `W5`/`G5`, shared bundle `DH`/`SU.createTransport`, and read-only process/socket inspection.

The next proof should use reversible launch configuration to connect Desktop and Kanban to one App Server, preserving the current launch setup for rollback.
Before recommending it, verify native task ownership, multiple-client routing, approval delivery, Desktop tool availability, and project sidebar/membership synchronization.
The observed cache behavior makes project synchronization a material concern.
No restart or configuration experiment was performed here.

A separate Kanban-owned App Server remains an alternative supported by the documented client architecture, but Kanban would own its execution lifecycle and approval UI.
That alone does not establish native Desktop ownership or sidebar synchronization.
See [official client lifecycle documentation](https://learn.chatgpt.com/docs/app-server#getting-started).

## Reproduction and limits

Inspected app: version `26.908.40834`, build `8881`, production flavor; bundled CLI: `0.154.0-alpha.6.2`.
Source: app archive `package.json` and CLI version output.

```sh
path/to/codex app-server generate-json-schema --experimental --out ./generated-schemas/experimental
path/to/codex app-server generate-json-schema --out ./generated-schemas/stable
```

Useful byte offsets in `.vite/build/src-CCXHtyvY.js`: handler discovery 1553412, owner/follower registration 1559611, WebSocket override 897201, daemon opt-in 932468.
Its SHA-256 is `a42da38cbb14b28399f1d54fcf453bffc5e9802663e7e098f187c8378f4c7a40`.
Main bundle SHA-256: `0765260be74e8843630d5a92e30bca574783892688e67180c119a5c58679bb61`.
These implementation details are specific to this installed build.

Investigation used source inspection, schema generation, read-only socket requests, and targeted logs.
No mutation API was called, no task or project was created, no app configuration was changed, and no App Server or Desktop process was started or restarted.
The live Markdown rule was unavailable during this dated research pass; authoring used a local backup.
