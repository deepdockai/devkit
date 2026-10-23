# Changelog

## 1.0.1

- The agent skill: page with `nextCursor` until it is `null` (a short page can carry a cursor), and cover the codes `access_outdated`, `access_missing`, `record_locked`, `record_not_editable`, `unknown_provider`, `payload_too_large` and the system status `unknown`, in the skill and the CLI's exit-code table.
- The agent skill: one statement on how to fetch the OpenAPI document, and a MEDICAL OFFICE recipe with its action names.
- The agent skill states the id rule in full: reads and creates answer ids as integers, a create's new id included; every id you send is a string of digits without a leading zero, at most 10 characters, in a query string and a write body alike.

## 1.0.0

First release of `@deepdockai/cli`, the `deepdock` command.
- Sign in from the terminal with approval in the browser: `deepdock auth login`, `auth status`, `auth logout`.
- Organisations: `org list`, `org select`, and `--org` or `DEEPDOCK_ORG` on every command that acts in one.
- Devices, systems, actions and incidents: `devices list|pair|rename|release|systems`, `systems list|openapi`, `actions list`, `incidents list`.
- API keys that never pass through the terminal: `keys create` (approved in the browser, written straight to your env file), `keys list`, `keys revoke`.
- The agent skill for Claude Code, Codex and Cursor: `deepdock skill`.
- Output built for scripts and coding agents: JSON when stdout is not a terminal, stable exit codes 0 to 5.
- Runs on Linux, macOS and Windows with Node 22.13 or newer.
