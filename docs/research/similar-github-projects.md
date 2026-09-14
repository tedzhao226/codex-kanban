# Similar GitHub projects

Research date: 2026-09-13.

Yes: **Better Codex** is the closest product comparison found, and **Codex Web** is the closest implementation reference for controlling existing native Desktop conversations.
These rankings are an assessment of the documented behavior, not a runtime evaluation.

## Comparison baseline

This repository presents existing Codex Desktop tasks as a local board and sends replies, steering, and stop requests to their original native owners.
It reads Codex's SQLite state and uses the Desktop IPC socket without starting a separate Codex app-server.
Board lanes and ordering are stored separately, while automatic placement follows published Desktop state.
See [native integration](../usage.md#native-integration).

## Relevant repositories

| Project | Verified overlap | Main difference from this repository |
| --- | --- | --- |
| [Ericwong5021/better-codex](https://github.com/Ericwong5021/better-codex) | A task board inside Codex Desktop; converts conversations into tasks, preserves linked conversations, and lets users read and reply from a task. | Adds Agent profiles, assignment, automatic dispatch, its own SQLite database and local Runtime. The board enters the sidebar through a local MCP app and CDP page integration; its README also describes an independent Session Host and Codex App Server. |
| [i-am-BT/codex-web](https://github.com/i-am-BT/codex-web#会话说明) | Browser access to native conversations; reads `session_index.jsonl`, `state_5.sqlite`, and session files. Open Desktop threads receive replies, steering, and cancellation through Desktop IPC. | A chat interface with broader media/provider features. When a thread is not open or IPC is unavailable, it falls back to a persistent `codex app-server --stdio`; creation, renaming, archiving, and approvals use app-server. |
| [b-nnett/codex-plusplus-project-home](https://github.com/b-nnett/codex-plusplus-project-home) | A per-project Kanban view in Codex, with Backlog, Todo, In Progress, In Review, and Done; drag and edit controls; MCP tools for agents. | A Codex++ tweak whose cards are issue records in a separate JSON database keyed by project path. Its documented object model is issues rather than a board of native Codex conversations. |
| [duo121/codex-kanban](https://github.com/duo121/codex-kanban) | Boards organize multiple Codex sessions, with running, attention, approval, seen, and error states. Switching sessions retains the official chat experience and `/resume` behavior. | A fork of the official Codex CLI, with board/session pickers in the terminal UI. It changes the CLI itself rather than attaching a browser board to Desktop. |
| [rschwabco/deck-threads](https://github.com/rschwabco/deck-threads#how-it-works) | Reads live Desktop task state, prioritizes tasks needing attention, and opens the exact existing task. It runs locally on macOS without an OpenAI API key. | Displays tasks on Stream Deck hardware, also supports Claude, and documents deep-link switching rather than in-board conversation controls. It queries a local Codex app-server for sidebar titles. |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | Kanban planning, Codex and other agent support, execution monitoring, follow-up feedback, and diff review. | Its [execution documentation](https://github.com/BloopAI/vibe-kanban/blob/main/docs/core-features/monitoring-task-execution.mdx) creates a Git worktree before starting the agent. This is an agent workspace workflow, rather than discovery of existing Desktop tasks. Bloop's [shutdown announcement](https://www.vibekanban.com/blog/shutdown) says the company is closing while Vibe Kanban continues as community-maintained open source; local workspaces keep working. |

Each project link above is a first-party README supporting its row.

## Popularity and development activity

Snapshot checked through the live GitHub REST API on 2026-09-13.
The activity window covers 30 complete UTC days: 2026-08-14 00:00 through 2026-09-13 00:00.
Counts include all paginated commits on each repository's default branch, `main`, including merge and bot commits.
They measure recorded activity, not code quality or the number of improvements.

| Project | Stars | Forks | Commits in 30 days | Latest main commit, UTC | Latest published GitHub release |
| --- | ---: | ---: | ---: | --- | --- |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 28,065 | 3,004 | [0](https://github.com/BloopAI/vibe-kanban/commits/main/) | [2026-04-24](https://github.com/BloopAI/vibe-kanban/commit/4deb7eca8f381f7cbc1f9d15515a9ab8f8009053) | [v0.1.44, Apr 24](https://github.com/BloopAI/vibe-kanban/releases/tag/v0.1.44-20260424091429) |
| [Better Codex](https://github.com/Ericwong5021/better-codex) | 43 | 0 | [434](https://github.com/Ericwong5021/better-codex/commits/main/) | [2026-09-12](https://github.com/Ericwong5021/better-codex/commit/2e69d3c6c0c28d227e1f1bec59eb66c4e0476eb2) | [v0.4.13-beta.3, Sep 12](https://github.com/Ericwong5021/better-codex/releases/tag/v0.4.13-beta.3); stable [v0.4.12, Sep 11](https://github.com/Ericwong5021/better-codex/releases/tag/v0.4.12) |
| [duo121/codex-kanban](https://github.com/duo121/codex-kanban) | 6 | 0 | [0](https://github.com/duo121/codex-kanban/commits/main/) | [2026-03-20](https://github.com/duo121/codex-kanban/commit/79d93c64b3e36d6188909c88e5bbf2abfae09b24) | [0.116.0-kanban.2, Mar 20](https://github.com/duo121/codex-kanban/releases/tag/rust-v0.116.0-kanban.2) |
| [Project Home](https://github.com/b-nnett/codex-plusplus-project-home) | 5 | 2 | [0](https://github.com/b-nnett/codex-plusplus-project-home/commits/main/) | [2026-04-30](https://github.com/b-nnett/codex-plusplus-project-home/commit/1d97062f707caafdac5ed2af8bd9a986341dc912) | [v1.0.0, Apr 30](https://github.com/b-nnett/codex-plusplus-project-home/releases/tag/v1.0.0) |
| [MK10 Bridge](https://github.com/Rladmsrl/codex-mk10-bridge) | 5 | 0 | [10](https://github.com/Rladmsrl/codex-mk10-bridge/commits/main/) | [2026-09-01](https://github.com/Rladmsrl/codex-mk10-bridge/commit/4805a17a1df088240d8a2305a7477e29d15a3144) | [None published](https://github.com/Rladmsrl/codex-mk10-bridge/releases) |
| [Codex Web](https://github.com/i-am-BT/codex-web) | 4 | 4 | [66](https://github.com/i-am-BT/codex-web/commits/main/) | [2026-09-12](https://github.com/i-am-BT/codex-web/commit/92fd8b5fc59834043029db252c897c530709257c) | [None published](https://github.com/i-am-BT/codex-web/releases) |
| [Deck Threads](https://github.com/rschwabco/deck-threads) | 1 | 0 | [0](https://github.com/rschwabco/deck-threads/commits/main/) | [2026-07-29](https://github.com/rschwabco/deck-threads/commit/7beee9519da142e1c367244c651328024ad543a9) | [v1.0.3, Jul 29](https://github.com/rschwabco/deck-threads/releases/tag/v1.0.3) |

Better Codex recorded commits on 20 of the 30 days, with 428 attributed to `Ericwong` and six to `github-actions[bot]`.
Its repository was created on August 4, 2026, so this is a young project with frequent recent development and releases, but limited public adoption by stars and forks.
Codex Web recorded commits on 18 days: 13 bot commits and 53 under two other author names, which are not necessarily two separate people.
Its repository was created on July 7, 2026.
These figures come from their [repository metadata](https://api.github.com/repos/Ericwong5021/better-codex), [Codex Web metadata](https://api.github.com/repos/i-am-BT/codex-web), and the linked commit histories.

Vibe Kanban has by far the largest star and fork counts in this set, but its original repository has no recent main-branch commits or releases.
Its [April 10 announcement](https://www.vibekanban.com/blog/shutdown) describes Bloop's shutdown and intended continuation through community maintenance.
Project Home, duo121's fork, and Deck Threads likewise show no default-branch commits in this window; this alone does not prove abandonment.
MK10 Bridge has recent activity but serves a hardware interface rather than a Kanban board.

All seven repositories were unarchived at the time of the API check.
Vibe Kanban and Deck Threads report September `pushed_at` timestamps despite older main-branch heads; those timestamps were not treated as evidence of recent main-branch development.
The latest public event pages did not expose PushEvents explaining the difference, so activity on other branches remains unassessed.
The duo121 repository is an OpenAI Codex fork: inherited upstream history would distort an all-time commit comparison.
Stars indicate public attention, not verified usage, reliability, or maintainer capacity.

To reproduce the checks, query GitHub REST endpoints `repos/{owner}/{repo}`, `repos/{owner}/{repo}/releases`, and all pages of `repos/{owner}/{repo}/commits?sha=main&since=2026-08-14T00:00:00Z&until=2026-09-13T00:00:00Z&per_page=100`.
The latest commit dates were read separately with `commits?sha=main&per_page=1`.

## Strongest technical overlap

Codex Web goes beyond a general claim of Codex support.
Its [Desktop IPC client source](https://github.com/i-am-BT/codex-web/blob/main/desktop-ipc-client.mjs) contains owner discovery and follower requests for starting turns, loading history, steering, interruption, and approvals, and connects to `$CODEX_HOME/ipc/ipc.sock` on macOS.
That makes it a concrete reference for this adapter's approach, although its method versions must be checked against the installed Desktop release.

[Rladmsrl/codex-mk10-bridge](https://github.com/Rladmsrl/codex-mk10-bridge/blob/main/docs/codex-micro.md) is another useful implementation reference.
Its hardware control panel uses native follower requests for settings, compaction, and interruption, and documents the four-byte little-endian length-prefixed JSON transport.
It explicitly identifies this as a private, version-sensitive App interface.
It is not a Kanban application.

## Assessment and limits

The most useful comparisons are Better Codex for board interactions and Codex Web for native conversation transport.
This repository's narrower combination remains distinct among the examined projects: an external board for existing Desktop conversations, native status placement, and reply/steer/stop through the existing owner, without a separate Codex app-server.
This is a bounded search result, not a claim that no identical project exists.

Repositories, READMEs, and selected integration source were inspected; no competing application was installed or exercised.
The popularity and activity section reports a dated API snapshot; its assessments describe observed development signals rather than a runtime quality evaluation.
The live Markdown rule was unavailable during this dated research pass; authoring used a local backup. No private path is required to reproduce the findings.
