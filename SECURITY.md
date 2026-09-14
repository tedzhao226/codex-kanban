## Security boundary

This project is a local macOS alpha. The server binds to loopback and can read local Codex task metadata and saved history, and can route supported actions through the signed-in Codex Desktop app. Anyone who can use the local machine and server session may be able to view or change that local task data. Do not expose the port through a tunnel, proxy, LAN bind, or public deployment.

The request token is a local request guard, not user authentication. The private Desktop IPC and database formats are implementation details observed against a particular app build and may change. This repository does not implement hosted accounts, device pairing, remote authorization, or multi-user isolation.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/tedzhao226/codex-kanban/security/advisories/new).
Do not disclose security details in public issues.

Safe reports include a short impact statement, affected version and environment, reproduction steps using fixtures, and redacted logs. Never attach `auth.json`, tokens, cookies, transcripts, local databases, or unredacted paths.
