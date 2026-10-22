# Changelog

## 1.0.0

First release of `@deepdockai/cli`, the `deepdock` command.
- Sign in from the terminal with approval in the browser: `deepdock auth login`, `auth status`, `auth logout`.
- Organisations: `org list`, `org select`, and `--org` or `DEEPDOCK_ORG` on every command that acts in one.
- Devices, systems, actions and incidents: `devices list|pair|rename|release|systems`, `systems list|openapi`, `actions list`, `incidents list`.
- API keys that never pass through the terminal: `keys create` (approved in the browser, written straight to your env file), `keys list`, `keys revoke`.
- The agent skill for Claude Code, Codex and Cursor: `deepdock skill`.
- Output built for scripts and coding agents: JSON when stdout is not a terminal, stable exit codes 0 to 5.
- Runs on Linux, macOS and Windows with Node 22.13 or newer.
