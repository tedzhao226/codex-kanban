# New Task and Kanban CLI plan

Status: implemented and verified, 2026-09-13.
This plan adds native task creation entirely inside Kanban and exposes Kanban operations through a local CLI.
The user approved execution after reviewing this plan.

## Execution result

The New Task form and `codex-kanban` CLI are implemented.
The native creation gate passed through empty-task setup followed by normal Desktop ownership; see [the verified route](../research/native-creation-routes.md#implemented-task-creation-route).
Browser creation displayed its completed reply entirely inside Kanban.
The installed CLI created a task, steered and stopped it, then sent a follow-up that completed with the expected response.
The full repository test suite passed, and the isolated native setup probe confirmed durable empty-task storage with no model turn.
The form was checked at desktop and 390-pixel mobile widths.
Native app-tool availability was verified; a forced approval prompt was not exercised.
Approval and question interactions retain the existing Codex window workflow.

## Decisions and constraints

- The web UI and CLI use the same Kanban HTTP interface and backend behavior.
- Project creation reuses the working native registration flow.
- New Task includes a project and first prompt.
  The implementation found that naming an empty task saves it before the first turn; this corrects the earlier probe's persistence assumption.
- Creation must preserve the task ID, saved history, project membership, native tool and approval behavior, and Kanban's live connection.
- The first version uses the selected project's existing folder.
- Task creation uses native settings by default; additional model configuration is outside this first proposal.

## 1. Resolve native creation first

At planning time, there was no proven route for standalone Kanban to create a task with the required native behavior.
The existing owner/follower socket operates on existing tasks and does not advertise task creation.
The native deep link prefills a composer without submitting it.
The assistant's native task-creation tool is available in this conversation but is not a callable interface for an arbitrary Node process.
The protected app-tools pipe rejected that process.
Switching Desktop directly to WebSocket disabled the live IPC connection.

Run a bounded investigation of a supported creation route that preserves normal Desktop coordination.
Any experiment involving a Desktop restart must be prepared for the user to restart manually.
Do not change app binaries, bypass peer authorization, or repeat the incompatible WebSocket launch as the production solution.

The acceptance gate is a real task created from a submitted project and prompt, with no native-window setup step, visible in both Kanban and Codex.
Verify its first prompt, durable identity, project assignment, native tools and approvals, live status, follow-up messaging, and stop behavior.
Existing tasks must remain connected throughout.
If meeting these conditions requires replacing execution ownership or the current IPC integration, present that concrete architecture trade-off before proceeding.

Evidence: [native creation routes](../research/native-creation-routes.md) and [shared-server experiment](../research/shared-server-prototype.md).

## 2. Add shared task creation

After the gate passes, add one task-creation module and a `POST /api/tasks` route.
The request includes a request ID, project ID, first prompt, and any workspace choice included in the agreed scope.
The module owns native creation, readiness detection, and the result returned to both clients.
Avoid a generic provider framework or broad server refactor.

Return the native task ID and confirmed creation state.
Distinguish failure before creation from partial success where a task exists but its first turn failed.
Retain enough request state to prevent duplicate first prompts on repeat submissions and reconcile uncertain results.
Do not automatically resubmit a mutation after an ambiguous timeout.

## 3. Add the New Task form

Place **New task** beside **New project**.
Preselect the active project, provide a first-prompt field, and include the agreed workspace options.
Allow access to project creation from the form when needed.
Submitting starts the native task and opens its conversation in Kanban when ready.
Show progress and actionable errors, preserve the prompt on failure, and prevent duplicate submission.
Report success only after native creation is confirmed.

## 4. Expose a local CLI

Add a Node CLI entry point named `codex-kanban` through `package.json`.
Reuse the running server at `http://127.0.0.1:4317`, with a configurable loopback port.
Keep native IPC and database handling inside the server.

| Commands | Behavior |
| --- | --- |
| `project list`, `project create PATH` | List native projects and reuse folder registration. |
| `task list`, `task show ID` | Filter board tasks and read conversation history. |
| `task create --project ID --prompt TEXT` | Use the same creation flow as the form. |
| `task send ID --text TEXT`, `task steer ID --text TEXT` | Start a follow-up or guide the active run. |
| `task stop ID` | Interrupt the current run. |
| `task move ID COLUMN`, `task reset ID` | Set a board lane or restore automatic placement. |
| `task open ID` | Open the task in Codex. |
| `task show ID --follow` | Follow conversation updates through the existing event stream. |

Support `--json`, `--help`, and file/stdin input for long prompts and messages.
Use task IDs for mutations, readable output by default, structured output on stdout, diagnostics on stderr, and documented nonzero exit codes.
Acquire the local request token internally and exclude it from all output, including JSON.
Use current layout revisions and active-turn IDs to reject stale operations.
Moving a card changes board placement; it does not start or stop execution.

Ensure message and stop commands acquire and load the live conversation without depending on a browser subscription.
Reuse the server's existing conversation machinery and release temporary subscriptions after each operation.

## 5. Verify and document

Test observable HTTP and CLI behavior with deterministic fixtures: valid inputs, invalid projects, duplicate requests, partial creation, offline Desktop, stale board revisions, changed active runs, JSON output, exit codes, and token omission.
Test live conversation loading with no browser connected.
Perform browser checks for the creation form and one agreed native end-to-end creation check covering the acceptance gate.
Run repository syntax checks and the affected tests, then the required suite.
Document CLI installation, commands, server requirements, supported workspace scope, and creation limitations.

Delivery order: native creation proof, shared creation module, New Task form and CLI, then end-to-end verification.
