# TODOS

Deferred work for claude-tracker. Captured during `/plan-eng-review` on 2026-08-22.
Each item records why it was deferred, not just what it is.

---

## Resolved

**Track from a search result lost the title and ticket** — fixed 2026-10-03.
`put(id, {})` sent an empty patch, so `normalise()` filled in `name: ""` and
`tickets: []`. The picker had always seeded both; only this path did not.

**The rollup box was not clickable** — fixed 2026-10-03. It was a display-only
`div`. Clicking it now sets `done` and every ticket together, and a completed
row takes a translucent green tint.

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

