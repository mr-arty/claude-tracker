# Manual UI checklist

The server has 94 automated tests. The UI does not — that was a deliberate
call: it is ~500 lines you exercise daily, and a browser harness would be more
machinery than the thing it tests. This is the repeatable pass instead.

Walk it once after any change to `index.html`. Takes about five minutes.

```bash
bun test          # must be green before starting
bun run server.ts # http://127.0.0.1:4000
```

---

## Add flow

- [ ] **Picker opens and groups sensibly.** Click *Add session*. Sessions appear
      newest first, each showing its short id, project name, and age.
- [ ] **Project names are real.** Look for `example-service` and
      `platform-catalog`. If you see `terraform/modules` or
      `infrastructure/catalog`, the lossy directory decode has regressed.
      Nothing else in the app will look wrong, so check this specifically.
- [ ] **Tickets are pre-filled where they should be.** `cafe0007` shows a green
      `PROJ-346` pill, `cafe0008` shows `PROJ-689`.
- [ ] **Chore sessions show `no ticket`, greyed.** Find `cafe0003`
      ("Fetch and pull main branch updates"), `cafe0004`, `cafe0005`. All three
      must show the muted *no ticket* pill, never a pre-filled key. A pre-filled
      ticket here is the exact regression the extractor fixture guards against.
- [ ] **Track works.** Click *Track* on one. It leaves the picker immediately and
      appears as a row behind the dialog with its name and ticket already set.
- [ ] **Manual add.** Paste `cafe0019-0000-4000-8000-000000000000` into the UUID
      box and click *Track*. It is added and renders as dead (see below).
- [ ] **Manual add rejects junk.** Paste `not-a-uuid`. A toast says it is not a
      session id; nothing is added.

## Annotate

- [ ] **Partial rollup.** On a row with two tickets, tick one. The left indicator
      changes to `◑` in amber.
- [ ] **Complete rollup.** Tick the second. It becomes `✓` in green.
- [ ] **Zero-ticket row.** Remove every ticket with the `×` on each chip. The row
      falls back to a plain indicator rather than showing a broken partial state.
- [ ] **Add a ticket.** Click *+ ticket*, enter `PROJ-999`. It appears as a chip,
      lowercase input is upper-cased.
- [ ] **Rename persists.** Click the name, edit it, press Enter. Reload the page.
      The new name is still there.
- [ ] **Rename does not fire per keystroke.** Type several characters and watch
      the server log. One request on blur, not one per key.
- [ ] **Priority.** Set a row to `Highest`. The star fills and turns amber.
      Set it to `Low`. The star empties. Reload — both survive.
- [ ] **Tags.** Add a tag, reload, it survives. Click it to remove it.

## Resume

- [ ] **Live row opens a terminal.** Click *Resume* on any row that is not dead.
      A terminal window opens running that session. Toast says "Terminal opened".
- [ ] **Dead row cannot be resumed.** The *Resume* button on the `cafe0019` row
      is disabled with a tooltip explaining why.
- [ ] **Clipboard fallback.** Temporarily break the terminal lookup:
      ```bash
      PATH=/nonexistent bun run server.ts
      ```
      Click *Resume*. Toast says the command was copied. Paste it somewhere and
      confirm it reads `claude --resume <full-uuid>`.

## Delete

- [ ] **Confirm dialog explains the consequence.** Click `×` on a row. The prompt
      makes clear the transcript is untouched and search still finds it.
- [ ] **Row disappears, returns to the picker.** Confirm. The row is gone. Open
      *Add session* — that session is available to track again.
- [ ] **Transcripts survive.** After deleting several rows:
      ```bash
      find ~/.claude/projects -maxdepth 2 -name '*.jsonl' | wc -l
      ```
      The count must be unchanged. Delete must never reach the filesystem.

## Search

- [ ] **Finds a session by its id.** Paste the first 8 characters of any session
      id. That session comes back, labelled `SESSION ID`.
- [ ] **Finds a session by its title.** Type a word from a session's name. It
      matches, labelled `TITLE`.
- [ ] **Owned tickets outrank mentions.** Search a ticket that one session worked
      on and others merely discussed. The owner is first, labelled `TICKET`; the
      rest follow, labelled `MENTIONED` and greyed.
- [ ] **Finds untracked sessions.** With an empty working set, search `PROJ-558`.
      Results appear. This is the whole point: search reads disk, not the table.
- [ ] **Finds deleted ones.** Track a session, note its ticket, delete the row,
      search that ticket. It still comes back, marked *not tracked*.
- [ ] **Live, no lag.** Type your own ticket prefix one character at a time. Results update
      without a visible pause. If it stutters, the in-memory index is not being
      used.
- [ ] **Track from search results.** Click *Track* on a search hit. It joins the
      working set and the search clears.
- [ ] **Escape clears.** Press Escape while focused in the search box. The table
      returns.

## Empty and edge states

- [ ] **No tracked rows.** Delete everything. A bordered empty state explains
      where to start, naming `~/.claude/projects`.
- [ ] **No search results.** Search `PROJ-00000`. The empty state says search
      covers every transcript, tracked or not.
- [ ] **Everything already tracked.** Track every session, then open the picker.
      It says so rather than showing a blank dialog.
- [ ] **Jira banner.** With `JIRA_BASE` still set to `CHANGEME`, a banner names
      the constant and the file. Ticket keys render as plain text, not dead
      links. Set a real host, reload, banner disappears and keys become links.
- [ ] **Dark mode.** Switch your OS theme. Text stays readable, the dead-row and
      partial-rollup colours remain distinguishable.

## One-time validations

These block nothing until they fail, but each invalidates an assumption.

- [ ] **`claude --resume` appends, it does not fork.** Note a session's mtime and
      its directory's file count. Resume it, send one message, exit. The mtime
      changed and no new `.jsonl` appeared in that directory. **If a new file
      appears, every tracked UUID goes stale after one resume** and the core loop
      is broken — stop and redesign around the fork.
- [ ] **Sub-agent transcripts stay hidden.** There are 18 of them at
      `<project>/<session-uuid>/subagents/agent-*.jsonl`. None may ever appear
      as a row; they are not resumable.
- [ ] **Two tabs cannot clobber each other.** Open two tabs. In tab B, delete a
      row. In tab A, without reloading, tick a checkbox on a different row.
      Reload both. The deleted row stays deleted and the tick was saved.
- [ ] **Kill mid-write.** Start the server, tick boxes rapidly, and `kill -9` it
      mid-burst. Then:
      ```bash
      python3 -m json.tool ~/.claude-tracker/annotations.json > /dev/null && echo VALID
      ```
      Must print `VALID`. A truncated file means the atomic rename regressed.
