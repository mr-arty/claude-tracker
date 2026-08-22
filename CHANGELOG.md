# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning is [semver](https://semver.org/spec/v2.0.0.html), with the caveat that
this is a single-user local tool: the public surface being versioned is the
`~/.claude-tracker/annotations.json` format and the HTTP API, not a library.

Add entries under `## [Unreleased]` as you work. `bun run release.ts <part>`
moves them into a numbered section and tags the commit.

## [Unreleased]

## [0.1.0] - 2026-08-22

First working version. Replaces a text file of `claude --resume <uuid>` lines.

### Added
- Session discovery from `~/.claude/projects`. Project paths come from the `cwd`
  recorded inside each transcript, because the directory name is a lossy
  encoding and decodes wrong for any path containing a hyphen.
- Ticket extraction from the `aiTitle` Claude Code writes, falling back to an
  anchored regex on the first genuine user message. Never matches raw JSONL
  bytes, since a stale `slug` field can name a ticket the session never touched.
- Tracked rows with per-ticket done state rolled up to a row indicator,
  five-level priority, a name, and tags.
- Resume: spawns the system terminal via `x-terminal-emulator`, falling back to
  the clipboard when no terminal is found.
- Search across every session on disk, tracked or not, matching session ids,
  titles, and ticket keys. A session that owns a ticket ranks above one that
  merely mentioned it.
- 94 tests, no dependencies. Real-corpus parity tests run from a gitignored
  `fixtures.local.json` and report as skipped when it is absent.

### Security
- Binds `127.0.0.1` only. `POST /api/resume` spawns a process, so exposing it on
  a routable interface would be remote code execution.
- Session ids are matched against a strict UUID pattern and resolved against the
  scanned session list before use. Spawn takes an argv array with no shell.

### Notes
- `JIRA_BASE` in `server.ts` and `CT_TICKET_PREFIXES` in the environment are the
  two things to configure. Neither contains a real value in this repo.
