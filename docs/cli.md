## CLI reference

`bin/codex-kanban.mjs` is the entry point and `lib/cli.mjs` contains the implementation. `npm link` installs the `codex-kanban` command pointing back to these files; without linking, use `npm run cli -- <command>` from the repository. The local Kanban server must be running; native operations also require Codex Desktop.

## Commands

```sh
codex-kanban project list
codex-kanban project create PATH
codex-kanban task list [--project ID] [--column COLUMN] [--search TEXT]
codex-kanban task show ID [--limit N] [--follow]
codex-kanban task create --project ID --prompt TEXT
codex-kanban task send ID --text TEXT
codex-kanban task steer ID --text TEXT
codex-kanban task stop ID
codex-kanban task move ID COLUMN [--before ID]
codex-kanban task reset ID
codex-kanban task open ID
```

Use complete IDs from the list commands; task names are not mutation targets. Options follow the command.

## Options

| Option | Applies to | Effect |
| --- | --- | --- |
| `--json` | all | Machine-readable output on stdout. |
| `--port PORT` | all | Loopback port of the Kanban server (default `4317`). |
| `--file PATH` / `--file -` | `task create`, `task send`, `task steer` | Read the prompt or text from a file or stdin instead of `--prompt` / `--text`. |
| `--request-id UUID` | `task create`, `task send`, `task steer` | Identify a repeat of the exact same submission. |
| `--project ID`, `--column COLUMN`, `--search TEXT` | `task list` | Filter the listing. |
| `--limit N` | `task show` | History items to fetch, `1..10000` (default 50). |
| `--follow` | `task show` | Keep streaming. With `--json`, emits one conversation snapshot per line until Ctrl+C. |
| `--before ID` | `task move` | Place the card above another card in the target lane. |

Moving or resetting a card changes the board only; stopping execution requires `task stop`. `task reset` restores automatic placement.

## Behavior

- The CLI acquires the local request token internally and excludes it from output.
- It loads native conversations for send, steer, and stop without needing a browser tab. If an older task has no native owner, use `task open` to load it in Codex before sending.
- Errors go to stderr. Mutations are never retried automatically.
- Creation and message errors include their request ID. After uncertain task creation, reuse its request ID and original input to check the saved result, or inspect the returned task ID before starting another task.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Other failure |
| `2` | Invalid input |
| `3` | Kanban server or Codex unavailable |
| `4` | Conflict (for example a stale board revision or a changed active run) |
| `5` | Uncertain delivery: check the task before retrying |
