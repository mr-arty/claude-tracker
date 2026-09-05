# TODOS

Deferred work for claude-tracker. Captured during `/plan-eng-review` on 2026-08-22.
Each item records why it was deferred, not just what it is.

---

## Real Jira API integration

**What:** Pull ticket titles, live status, and assignee from Jira instead of
showing a bare key and a hyperlink.

**Why:** Premise 5 of the design doc defers this deliberately. More importantly,
the D12 decision to use five-level Jira-style priority was made **specifically so
the values map 1:1 if this lands**. That intent is invisible in the code and will
look like an arbitrary over-specified enum in three months without this note.

**Pros:** `PROJ-346` stops being an opaque string and becomes "Trivy scan gate,
In Progress, assigned to you". Closes the Jira cross-reference properly rather
than partially — the stated primary pain of the whole project.

**Cons:** Introduces the first network call, the first secret (API token), and
the first set of network failure states into a tool that currently has none of
those. Token storage on a local single-user tool is a small problem but a real
one, and Jira being slow or down becomes a UI state to handle.

**Context:** v1 uses `JIRA_BASE` as a named placeholder constant at the top of
`server.ts` (D11). Whoever picks this up starts there. The five priority levels
in `annotations.json` are already Jira-shaped, so no data migration is needed.

**Depends on / blocked by:** Nothing technical. Needs a Jira API token and a
decision on where to store it.

---

## Resolved

**Full-text transcript search** — landed 2026-09-05. Prose only, not tool output:
that is 2% of the bytes and the reason a plain scan beat an inverted index. The
"130 MB is a different animal" concern priced the raw corpus; the indexed slice
is 3.2 MB. See the `TicketIndex` comment in `server.ts`.

**Does `claude --resume` fork the transcript?** — no, answered 2026-09-05. It
appends in place, so a tracked session id stays valid. Measured in
`MANUAL-CHECKLIST.md` under One-time validations.
