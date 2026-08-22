# TODOS

Deferred work for claude-tracker. Captured during `/plan-eng-review` on 2026-08-22.
Each item records why it was deferred, not just what it is.

---

## Full-text transcript search

**What:** Search the body text of transcripts, not just ticket keys. Ask "which
session did the Trivy exemption work?" and get an answer even when no ticket was
mentioned in that session.

**Why:** The v1 search index (D8) maps sessions to `NR-####` keys only. Measured:
**21 of 37 sessions carry no ticket at all** — every git chore, every incident
debug, every exploratory session. Those are invisible to ticket-only search, and
incident debugging is exactly the category you would most want to find again six
months later.

**Pros:** Search covers the whole corpus rather than the 16 ticketed sessions.
Makes the tool useful for "how did I fix that" questions, not just "what did I do
for PROJ-558".

**Cons:** A real inverted index over 130 MB is a different animal from the 9 KB
ticket map. The naive alternative, grep-per-query, measured at 192 ms and grows
linearly with the corpus. Either way it is the largest single piece of work in
the project.

**Context:** The D8 ticket index establishes the mtime-invalidation pattern that
full-text search would reuse. Build order matters — doing full-text first means
inventing that pattern twice. Deferred because guessing at what you want to
search for, before living with ticket search, is how you build the wrong index.

**Depends on / blocked by:** D8 ticket index must land first.

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

## One-time validation, not a build task

**Does `claude --resume` fork the transcript?** Investigation found 37 files with
exactly one `sessionId` each and filename always equal to that id, which is
consistent with resume appending in place — but it was not proven. If resume
creates a NEW file, every tracked UUID goes stale after one use and the core loop
breaks.

Cheap check: note a session's mtime, resume it, exit, confirm the mtime changed
and no new `.jsonl` appeared in that directory. This is on the manual checklist
rather than here because it takes thirty seconds and blocks nothing until it
fails.
