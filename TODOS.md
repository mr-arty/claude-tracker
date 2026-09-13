# TODOS

Deferred work for claude-tracker. Captured during `/plan-eng-review` on 2026-08-22.
Each item records why it was deferred, not just what it is.

**Nothing is open.** Everything below has landed. New items go above the Resolved
heading, with the reason for deferring, not just the description.

---

## Resolved

**Real Jira API integration** — landed 2026-09-13. Ticket chips carry the Jira
summary, status and assignee. Credentials come from `CT_JIRA_EMAIL` /
`CT_JIRA_TOKEN` or `~/.claude-tracker/credentials.json`, never from the repo; the
REST root is derived from `CT_JIRA_BASE` rather than configured twice. The D12
five-level priority mapped 1:1 as intended, so no migration was needed. The
network-failure worry in the original note was answered by never letting it reach
the page: enrichment runs after render, `/api/tickets` never 5xxs, and Jira down
leaves the page byte-for-byte what it was. One trap found the hard way — Jira
Cloud answers **404, not 401**, for an issue request with a bad token, so a wrong
credential looked exactly like a deleted ticket. `/rest/api/3/myself` does answer
401 and is called once when every key comes back missing.

**Second tab for PRs** — landed 2026-09-13. No GitHub call was needed: Claude Code
already writes `{"type":"pr-link",prNumber,prRepository,prUrl,timestamp}` into the
transcript. 3170 records locally for 87 real PRs, so they are deduped by url with
the earliest timestamp kept as when the PR opened.

**Session name on each block** — landed 2026-09-13. Also already on disk, as
`{"type":"agent-name","agentName":"…"}`. The `@` is Claude Code's display prefix
and is not stored. **Last record wins**, unlike the first-wins `aiTitle` rule:
three local sessions were renamed mid-run.

Both of those records routinely sit past the 512KB `PROBE_BYTES` that
`extractSession` uses — 22 of 23 sessions with PRs, 15 of 24 named ones, one at
7.7MB — so neither can be read from a probe. Both are harvested in `scanFull`,
which already reads every byte for the search index; the two extra passes cost
222ms across a 196MB corpus. Each guards the parse with a cheap substring test,
which is what keeps that number small.

**Full-text transcript search** — landed 2026-09-05. Prose only, not tool output:
that is 2% of the bytes and the reason a plain scan beat an inverted index. The
"130 MB is a different animal" concern priced the raw corpus; the indexed slice
is 3.2 MB. See the `TicketIndex` comment in `server.ts`.

**Does `claude --resume` fork the transcript?** — no, answered 2026-09-05. It
appends in place, so a tracked session id stays valid. Measured in
`MANUAL-CHECKLIST.md` under One-time validations.
