# claude-tracker

A local table of the Claude Code sessions you care about, cross-referenced to
Jira tickets. Replaces a notepad full of `claude --resume <uuid>` lines.

```bash
bun run server.ts     # http://127.0.0.1:4000
```

Set `JIRA_BASE` at the top of `server.ts` once to make ticket links work.

## What it does

- Reads `~/.claude/projects` and never writes to it. You never type a UUID.
- Resolves each session's Jira ticket and title from the transcript itself,
  preferring the `aiTitle` Claude Code already writes.
- Tracks the sessions you pick: tickets with per-ticket done state, Jira-style
  priority, a name, and tags.
- Resume opens a terminal running that session, falling back to the clipboard.
- Search covers every session on disk, not just the tracked ones, so deleting a
  row loses no history. It matches session ids, titles, and ticket keys; a
  session that owns a ticket ranks above one that merely mentioned it.

## Layout

| File | Job |
|---|---|
| `scan.ts` | Find sessions, resolve real project paths from `cwd` |
| `extract.ts` | Transcript to ticket and name |
| `annotations.ts` | The working set, atomic writes, serialised mutations |
| `server.ts` | Routes, ticket index, guarded resume |
| `index.html` | The UI |
| `MANUAL-CHECKLIST.md` | The UI test pass |
| `TODOS.md` | Deferred work, with reasons |
| `VERSION` / `version.ts` | Current version, semver parsing and bumping |
| `release.ts` | Cut a release: bump, changelog, commit, tag |

State lives in `~/.claude-tracker/annotations.json` and is safe to hand-edit.

## Releasing

Write what changed under `## [Unreleased]` in `CHANGELOG.md` as you go, then:

```bash
bun run release.ts minor --dry   # show what would happen
bun run release.ts minor         # bump, changelog, commit, tag
```

It refuses to run on a dirty tree, on failing tests, with an empty Unreleased
section, or when the tag already exists. Each of those would record something
untrue. Semver here versions the `annotations.json` format and the HTTP surface:
major means a stored file stops loading, minor means new capability with old
files still working, patch means nothing observable changed.

```bash
bun test    # 124 tests, no dependencies
```
