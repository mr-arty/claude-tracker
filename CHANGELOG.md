# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning is [semver](https://semver.org/spec/v2.0.0.html), with the caveat that
this is a single-user local tool: the public surface being versioned is the
`~/.claude-tracker/annotations.json` format and the HTTP API, not a library.

Add entries under `## [Unreleased]` as you work. `bun run release.ts <part>`
moves them into a numbered section and tags the commit.

## [Unreleased]

### Added
- Full-text search over transcript bodies. Search previously matched only session
  ids, titles and ticket keys, which left every session carrying no ticket
  invisible — 21 of 37 locally, being every git chore and every incident debug.
  Body-text hits rank below ticket mentions and show the matching phrase in
  context. Only what was said is indexed, not tool output or file dumps: those
  are 98% of the corpus and matching them finds the file, not the session.

### Changed
- Tags render highlighted at rest instead of only on hover, so a row's tags are
  visible without pointing at them. Hover now turns a tag red-orange, matching
  the delete affordance already used by the `×` on a ticket chip.
- `GET /api/search` results carry a `snippet` object on body-text hits, and
  `kind` can now be `text`. Additive; existing fields are unchanged.

### Notes
- `claude --resume` was confirmed to append to the existing transcript rather
  than forking a new one, so a tracked session id stays valid after a resume.
  This had been assumed but never proven; the measurement is recorded in
  MANUAL-CHECKLIST.md.

## [0.2.1] - 2026-08-22

### Fixed
- `release.ts` committed the version bump and then tagged it, with no rollback
  if tagging failed. A failed `git tag` left a Release commit that nothing
  pointed at, so VERSION and CHANGELOG claimed a release that did not exist.
  The commit and the tag are now applied as one unit: a tag failure resets back
  to the pre-release commit. A signing failure additionally names `tag.gpgSign`,
  which is a separate setting from `commit.gpgsign`, so a repo configured for
  unsigned commits will still try to sign its tags.

## [0.2.0] - 2026-08-22

### Added
- Search matches session ids and session titles, not only ticket keys. Results
  are ranked id, then owned ticket, then title, then mention, and each row says
  which kind it was. A session that merely discussed a ticket can no longer
  outrank the one that worked on it.
- Copy ID button on every row, copying the full session id. Stays enabled on a
  dead row, where Resume is disabled.
- Priority label above the priority selector.
- Version footer on the page, served from VERSION via /api/config.
- VERSION, CHANGELOG.md, and release.ts, which refuses to run on a dirty tree,
  failing tests, an empty Unreleased section, or an existing tag.

### Changed
- The Jira base URL comes from CT_JIRA_BASE rather than a constant in the
  source, so no real hostname enters git. It is also injectable, so tests do not
  depend on whether the variable happens to be set in the shell running them.
- The untracked listing reads its ticket and name from the search index instead
  of re-extracting the same transcripts.

### Fixed
- The Add session button was white on light green in dark mode, at 2.26:1.
  Filled buttons now take their text colour from a theme-aware token; every
  filled button measures 4.69:1 or better in both themes.

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
