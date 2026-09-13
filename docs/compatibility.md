## Compatibility and support

The supported target for this alpha is macOS with Node.js 24 or newer and the Codex Desktop app installed with local tasks. The app was developed against the installed Codex Desktop `0.154.0-alpha.6.2`; the adapter targets private IPC state version 11 and observed follower request versions. These are observations, not compatibility promises. A Desktop update can require adapter changes.

The default test suite is fixture-only and does not prove native Desktop compatibility. A clean Mac smoke test, including a harmless native setup probe and the intended local workflows, is required before a release. Do not perform native task actions in CI.

For troubleshooting, confirm Node with `node --version`, install with `npm ci`, keep the server terminal open, and check that Codex Desktop is running and signed in when using native features. Use `PORT=4318 npm start` when the default port is unavailable. Do not paste private logs or task history into reports.
