# TODOS

Deferred work for claude-tracker. Captured during `/plan-eng-review` on 2026-08-22.
Each item records why it was deferred, not just what it is.

---

## Resolved

**Some tracked sessions showed no PRs** — fixed 2026-11-14, both causes.

*A PR opened through the GitHub MCP server recorded nothing.* `mcpPrsFromText`
pairs a `create_pull_request` tool_use with its own tool_result and reads the
`html_url` out of it. Deliberately NOT a scan for PR urls in the text: a session
that reviewed a PR and one that opened it read identically in prose, and the
tool call is the act of opening. Over the local corpus this added exactly one
PR, in exactly the session that was missing one — no session gained a PR it had
only discussed. Every `PrRef` now carries `source: "pr-link" | "mcp"`.

*The record could land on a different session than the one that ran the command.*
`TicketIndex.regroup()` unions the PRs of every session sharing one `agentName`,
**scoped to one project** — a name like `fix-ci` is reusable, and pooling across
unrelated work would invent PRs rather than find them. No name is shared across
projects today, so the scoping costs nothing now and bounds the damage later.
The union is rebuilt from scratch each refresh and `Entry.prs` stays exactly what
its own transcript said, so it cannot compound. `prsFor()` returns `sessionId`
per PR and the page marks an inherited one `via <id>`, so it never silently
claims a sibling's work.

Still unhandled, deliberately: a PR opened by `gh pr create` whose `pr-link`
landed elsewhere AND whose session has no `agentName` has nothing to group on.
Harvesting the url from the Bash output would cover it, at the cost of a third
source to keep straight. No local session is in that state.

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

