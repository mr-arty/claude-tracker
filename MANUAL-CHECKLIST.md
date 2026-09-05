# Manual UI checklist

The server has 124 automated tests. The UI does not — that was a deliberate
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
- [ ] **Tags are highlighted at rest.** A row's tags are visible as filled chips
      without hovering over them. If they only light up under the pointer, the
      resting style has regressed to the old muted one.
- [ ] **Tag hover reads as delete.** Hover a tag. It turns red-orange, the same
      colour the `×` on a ticket chip turns, and the tooltip says *Remove tag*.
      It must not turn green — that is the colour for done, and clicking here
      deletes rather than completes.

## Resume

- [ ] **Copy ID.** Click *Copy ID* on any row. Toast confirms, and pasting gives
      the full 36-character session id, not the truncated one shown in the row.
- [ ] **Buttons read as distinct.** Resume is green and clearly lighter than the
      *Add session* button; Copy ID is a soft orange. Both legible in light and
      dark mode, and Copy ID stays enabled on a dead row where Resume does not.
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
- [ ] **Finds a session with no ticket at all.** Pick a git chore or an incident
      debug session — one that never mentioned a ticket — and search a distinctive
      phrase you remember saying in it. It comes back, labelled `TRANSCRIPT`.
      This is the case ticket-only search could never reach.
- [ ] **The snippet shows why it matched.** A `TRANSCRIPT` hit renders a line of
      surrounding context with the phrase highlighted, elided with `…` when the
      match sits mid-transcript. Readable in both light and dark mode.
- [ ] **Body text ranks last.** Search a ticket key that one session owns, another
      mentions, and a third merely discusses in prose. Order is `TICKET`, then
      `MENTIONED`, then `TRANSCRIPT`.
- [ ] **Two characters do not flood.** Type two characters of a common word.
      No `TRANSCRIPT` hits appear. Type the third and they do.
- [ ] **Tool output is not searchable.** Search a string that only ever appeared
      in a command's output — a file path from a `grep` result, say. It must not
      match. Only what was said is indexed.

## Empty and edge states

- [ ] **No tracked rows.** Delete everything. A bordered empty state explains
      where to start, naming `~/.claude/projects`.
- [ ] **No search results.** Search `PROJ-00000`. The empty state says search
      covers every transcript, tracked or not.
- [ ] **Everything already tracked.** Track every session, then open the picker.
      It says so rather than showing a blank dialog.
- [ ] **Jira banner.** Start without `CT_JIRA_BASE`; a banner names the variable
      and ticket keys render as plain text rather than dead links. Restart with
      it set, reload, banner disappears and keys become links that resolve.
- [ ] **Priority label.** Every row shows `PRIORITY` above its dropdown, and the
      star, dropdown, and buttons sit on one baseline rather than stair-stepping.
- [ ] **Version footer.** The bottom of the page reads `Version: <x.y.z>` and
      matches `cat VERSION`.
- [ ] **Dark mode.** Switch your OS theme. Text stays readable, the dead-row and
      partial-rollup colours remain distinguishable.

## One-time validations

These block nothing until they fail, but each invalidates an assumption.

- [x] **`claude --resume` appends, it does not fork.** Note a session's mtime and
      its directory's file count. Resume it, send one message, exit. The mtime
      changed and no new `.jsonl` appeared in that directory. **If a new file
      appears, every tracked UUID goes stale after one resume** and the core loop
      is broken — stop and redesign around the fork.

      Verified 2026-09-05 against a directory holding exactly one transcript.
      Resuming it moved the mtime from `18:03:34` to `10:17:39` and grew the file
      235862 -> 254712 bytes, while the directory stayed at 1 file, the corpus
      stayed at 37, and the transcript still held one `sessionId` equal to its
      filename. Resume appends in place; tracked UUIDs survive.
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
