## Local source release checklist

- [ ] Choose a license before calling the repository open-source licensed. This source publication does not grant a license.
- [x] Owner selected public publication at `tedzhao226/codex-kanban` on 2026-09-14.
- [x] Use GitHub private vulnerability reporting, linked from `SECURITY.md`.
- [ ] Complete a clean Mac/native compatibility smoke test against the intended Codex Desktop build.
- [x] Review history: no matching credential patterns, database files, environment files, or transcripts found; older commits retain developer paths.
- [x] Complete source review and resolve malformed-URL handling, terminal control output, missing CLI tool results, and a sent-draft race.

The 2026-09-14 source pass verified a fresh dependency install, 103 fixture tests, syntax checks, all five browser checks, package contents, and a dependency audit with zero reported vulnerabilities.
The isolated native setup probe passed without a model turn, and the running local server reported a connected Desktop.
This pass did not repeat signed-in send/steer/stop actions or verify a separate clean Mac; earlier native observations are recorded in the compatibility and research documents.

Hosted login, remote execution, cloud persistence, and multi-user authorization are future requirements, not release criteria for this local application.
