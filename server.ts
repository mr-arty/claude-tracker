/**
 * HTTP surface. Routing and wiring only; the real work lives in the modules.
 *
 *   GET    /                     index.html
 *   GET    /prs/:id              prs.html, the pull requests opened in one session
 *   GET    /tokens.css           the colour tokens both pages share
 *   GET    /api/rows             tracked rows, joined with on-disk metadata
 *   GET    /api/untracked        sessions not tracked, ticket and name resolved
 *   GET    /api/search?q=        session id, ticket, name, mention or body text, from the index
 *   GET    /api/prs/:id          pull requests opened in one session
 *   GET    /api/tickets?keys=    Jira summary and status for the given keys
 *   PUT    /api/rows/:id         merge one row
 *   DELETE /api/rows/:id         hard delete the row, never the transcript
 *   POST   /api/resume/:id       spawn a terminal, or fall back to the clipboard
 *
 * SECURITY. POST /api/resume spawns a process, so this server must never be
 * reachable from anywhere but this machine:
 *
 *   1. bind 127.0.0.1 explicitly, never 0.0.0.0
 *   2. every :id is matched against a strict UUID regex before use, and then
 *      resolved against the scanned session list, so it can never become a path
 *      fragment or a shell fragment
 *   3. spawn takes an argv array with no shell, so even a hostile id would only
 *      ever be one inert argument
 */

import { scanSessions, projectsRoot, type SessionMeta } from "./scan.ts";
import { extractSession, scanFull, isTicketKey, type PrRef } from "./extract.ts";
import { loadAuth, siteRoot, fetchTickets, credentialsPath, type JiraAuth, type TicketInfo } from "./jira.ts";
import { read, upsert, remove, rollup, storePath, CorruptStoreError, type Annotation } from "./annotations.ts";
import { currentVersion } from "./version.ts";

/**
 * CONFIG. Your Jira browse URL, no trailing slash. Pairs with CT_TICKET_PREFIXES
 * in extract.ts.
 *
 * Supplied by the environment rather than hardcoded so a real hostname never
 * enters git. Everything except clickable ticket links works without it.
 *
 *   CT_JIRA_BASE=https://your-host.atlassian.net/browse bun run server.ts
 */
const JIRA_PLACEHOLDER = "https://CHANGEME.atlassian.net/browse";
const JIRA_BASE = Bun.env.CT_JIRA_BASE ?? JIRA_PLACEHOLDER;

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4000;

/** The system's configured terminal. Debian alternatives points this at whatever you actually use. */
const TERMINAL = ["x-terminal-emulator", "-e"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SpawnFn = (argv: string[]) => void;

const realSpawn: SpawnFn = (argv) => {
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
};

export interface Deps {
  root?: string;
  annotationsPath?: string;
  spawn?: SpawnFn;
  /**
   * Jira browse URL. Injectable so tests never inherit CT_JIRA_BASE from the
   * developer's shell: a test that asserts on ambient environment state passes
   * or fails depending on who runs it, which is worse than no test.
   */
  jiraBase?: string;
  /**
   * Jira credentials and the fetch used to spend them. Both injectable: this is
   * the only network call in the tool, and no test should ever make it.
   * Undefined means "load from the environment"; null means "explicitly none".
   */
  jiraAuth?: JiraAuth | null;
  jiraFetch?: typeof fetch;
}

/**
 * How a session matched the query. Ranked best-first: typing an id means you
 * want that session, and a session's own ticket beats one it merely discussed.
 *
 * The mention tier exists because any transcript that DISCUSSES a ticket gets it
 * indexed. A session about the tracker itself can end up carrying a dozen keys it
 * never worked on, so those must never outrank a real match. Body text ranks below
 * even that: saying a word is the weakest claim a session can make on a query.
 */
export type MatchKind = "id" | "ticket" | "name" | "mention" | "text";
const RANK: Record<MatchKind, number> = { id: 0, ticket: 1, name: 2, mention: 3, text: 4 };

/**
 * Below this, a query is a prefix someone is still typing. One or two characters
 * appear in every transcript, and letting them match body text buries the id and
 * ticket hits that were actually being aimed for. Only the text tier is gated.
 */
const MIN_TEXT_QUERY = 3;

/** Characters of context each side of a body-text hit. */
const SNIPPET_PAD = 60;

/** Most body-text results returned. The stronger tiers are never capped. */
const TEXT_LIMIT = 25;

/** How long a Jira summary and status stay fresh. Long enough that a reload is free. */
const TICKET_TTL_MS = 5 * 60 * 1000;

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface Hit {
  id: string;
  kind: MatchKind;
}

interface Entry {
  mtime: number;
  /** The ticket this session is actually about, or null. */
  owned: string | null;
  /** Which rule produced `owned`. Kept for debugging a surprising suggestion. */
  source: "aiTitle" | "opener" | null;
  /** aiTitle, or a trimmed first message. */
  name: string | null;
  /** Every ticket appearing anywhere in the transcript, including ones only discussed. */
  mentions: Set<string>;
  /** What was said in the session, for full-text search. */
  prose: string;
  /** Held alongside `prose` so a query does not lowercase the whole corpus per keystroke. */
  proseLower: string;
  /** The name Claude Code carries for the session, without the display @. */
  agentName: string | null;
  /** Pull requests opened during the session, deduped, newest first. */
  prs: PrRef[];
}

/**
 * Searchable state for every session, held in memory.
 *
 * A full rebuild costs about 950ms over a 196MB corpus, so a query is a map walk
 * rather than a rescan. Invalidation reuses the mtimes the directory scan already
 * collected: no extra stat calls, and only a transcript that changed is re-read.
 *
 * Body text is what gives it size: prose is 2.0% of the raw bytes (4.0MB), held
 * twice so a query does not lowercase the corpus per keystroke. It stays a plain
 * scan rather than an inverted index on purpose — a substring sweep of 4MB answers
 * in 1-4ms, and an inverted index would be faster asymptotically while losing
 * phrase search and snippets, both of which fall out of the scan for free.
 *
 * The session name and PR list ride along on the same read for nothing: 25 names
 * and 87 pull requests across the whole corpus.
 */
class TicketIndex {
  private entries = new Map<string, Entry>();

  async refresh(sessions: SessionMeta[]): Promise<void> {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);

    for (const s of sessions) {
      if (this.entries.get(s.id)?.mtime === s.lastActive) continue;
      const { ticket, name, source } = await extractSession(s.path);
      // scanFull is the only full read. extractSession keeps its 512KB probe, so
      // which ticket a session resolves to does not change with this.
      const { mentions, prose, agentName, prs } = await scanFull(s.path);
      this.entries.set(s.id, {
        mtime: s.lastActive,
        owned: ticket,
        source,
        name,
        mentions,
        prose,
        proseLower: prose.toLowerCase(),
        agentName,
        prs,
      });
    }
  }

  /**
   * Matches session ids, owned tickets, names, mentioned tickets, and finally
   * body text, in that order of confidence. Case-insensitive; ids and tickets
   * match by prefix, names and body text by substring, so a typed phrase works.
   */
  find(query: string): Hit[] {
    const q = query.trim();
    if (!q) return [];
    const upper = q.toUpperCase();
    const lower = q.toLowerCase();
    const hits: Hit[] = [];

    for (const [id, e] of this.entries) {
      let kind: MatchKind | null = null;
      if (id.toLowerCase().startsWith(lower) || id.toLowerCase().replace(/-/g, "").startsWith(lower.replace(/-/g, ""))) {
        kind = "id";
      } else if (e.owned?.toUpperCase().startsWith(upper)) {
        kind = "ticket";
      } else if (e.name?.toLowerCase().includes(lower)) {
        kind = "name";
      } else {
        for (const t of e.mentions) {
          if (t.toUpperCase().startsWith(upper)) {
            kind = "mention";
            break;
          }
        }
        if (!kind && lower.length >= MIN_TEXT_QUERY && e.proseLower.includes(lower)) {
          kind = "text";
        }
      }
      if (kind) hits.push({ id, kind });
    }
    return hits.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  }

  /**
   * The matched phrase with its surrounding context, for a body-text hit. Sliced
   * from prose already in memory, so this costs no read.
   */
  snippet(id: string, query: string): Snippet | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const needle = query.trim().toLowerCase();
    const at = needle ? e.proseLower.indexOf(needle) : -1;
    if (at < 0) return null;

    // toLowerCase is not length-preserving in every script, and only then does the
    // offset stop pointing at the same character in the original.
    const src = e.prose.length === e.proseLower.length ? e.prose : e.proseLower;
    const start = Math.max(0, at - SNIPPET_PAD);
    const end = Math.min(src.length, at + needle.length + SNIPPET_PAD);

    return {
      before: (start > 0 ? "…" : "") + src.slice(start, at),
      match: src.slice(at, at + needle.length),
      after: src.slice(at + needle.length, end) + (end < src.length ? "…" : ""),
    };
  }

  entry(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  ticketsFor(id: string): string[] {
    return [...(this.entries.get(id)?.mentions ?? [])].sort();
  }

  agentNameFor(id: string): string | null {
    return this.entries.get(id)?.agentName ?? null;
  }

  prsFor(id: string): PrRef[] {
    return this.entries.get(id)?.prs ?? [];
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const badRequest = (message: string) => json({ error: message }, 400);

export function createHandler(deps: Deps = {}) {
  const root = deps.root ?? projectsRoot();
  const annotationsPath = deps.annotationsPath ?? storePath();
  const spawn = deps.spawn ?? realSpawn;
  const jiraBase = deps.jiraBase ?? JIRA_BASE;
  const jiraFetch = deps.jiraFetch ?? fetch;
  // Resolved once. A promise rather than a value so construction stays sync.
  const jiraAuth: Promise<JiraAuth | null> =
    deps.jiraAuth === undefined ? loadAuth() : Promise.resolve(deps.jiraAuth);
  const ticketCache = new Map<string, { at: number; value: TicketInfo | null }>();
  const index = new TicketIndex();

  /** Scan disk and refresh the index. Every request that needs session data starts here. */
  async function snapshot(): Promise<SessionMeta[]> {
    const sessions = await scanSessions(root);
    await index.refresh(sessions);
    return sessions;
  }

  const shape = (id: string, a: Annotation, s: SessionMeta | undefined) => ({
    id,
    ...a,
    rollup: rollup(a),
    alive: Boolean(s),
    project: s?.project ?? null,
    projectName: s?.projectName ?? null,
    lastActive: s?.lastActive ?? null,
    resumeCommand: `claude --resume ${id}`,
    // Derived, never stored. After the spread so a hand-edited annotations.json
    // carrying either key cannot shadow what the transcript actually says.
    agentName: index.agentNameFor(id),
    prCount: index.prsFor(id).length,
  });

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const file = Bun.file(new URL("./index.html", import.meta.url).pathname);
        if (!(await file.exists())) return new Response("index.html missing", { status: 500 });
        return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // Both pages share one token sheet so the AA-checked colour pairs are
      // maintained in one place rather than drifting between two files.
      if (method === "GET" && pathname === "/tokens.css") {
        const file = Bun.file(new URL("./tokens.css", import.meta.url).pathname);
        if (!(await file.exists())) return new Response("tokens.css missing", { status: 500 });
        return new Response(file, { headers: { "content-type": "text/css; charset=utf-8" } });
      }

      // The page reads its own session id back out of the path. Validated here
      // first so a bad id never reaches a tab at all.
      const prsPage = pathname.match(/^\/prs\/(.+)$/);
      if (prsPage && method === "GET") {
        if (!UUID.test(decodeURIComponent(prsPage[1]!))) return json({ error: "not found" }, 404);
        const file = Bun.file(new URL("./prs.html", import.meta.url).pathname);
        if (!(await file.exists())) return new Response("prs.html missing", { status: 500 });
        return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (method === "GET" && pathname === "/api/config") {
        return json({
          version: await currentVersion(),
          jiraBase,
          jiraConfigured: jiraBase !== JIRA_PLACEHOLDER,
          jiraApiConfigured: jiraBase !== JIRA_PLACEHOLDER && (await jiraAuth) !== null,
        });
      }

      /**
       * Jira summary and status for the keys already on the page.
       *
       * Never 5xx. Jira slow, down or unauthorised comes back as `error` with
       * whatever did resolve, and the page keeps rendering bare keys as before.
       */
      if (method === "GET" && pathname === "/api/tickets") {
        const auth = await jiraAuth;
        const configured = jiraBase !== JIRA_PLACEHOLDER && auth !== null;
        // Validated before anything is spent on them: a key is the only thing
        // that may become a path segment in a request we authenticate.
        const keys = [...new Set((url.searchParams.get("keys") ?? "").split(",").map((k) => k.trim().toUpperCase()))]
          .filter((k) => k && isTicketKey(k));
        if (!configured || keys.length === 0) return json({ configured, error: null, tickets: {} });

        const now = Date.now();
        const tickets: Record<string, TicketInfo | null> = {};
        const stale: string[] = [];
        for (const k of keys) {
          const hit = ticketCache.get(k);
          if (hit && now - hit.at < TICKET_TTL_MS) tickets[k] = hit.value;
          else stale.push(k);
        }

        let error: string | null = null;
        if (stale.length) {
          const fetched = await fetchTickets(stale, siteRoot(jiraBase), auth!, jiraFetch);
          error = fetched.error;
          for (const [k, value] of Object.entries(fetched.tickets)) {
            tickets[k] = value;
            // A failure is not cached: the next reload should retry, not inherit it.
            if (!error) ticketCache.set(k, { at: now, value });
          }
        }

        return json({ configured, error, tickets });
      }

      // Tracked rows, joined with what is currently on disk. A row whose session
      // has vanished still renders, flagged dead, rather than disappearing.
      if (method === "GET" && pathname === "/api/rows") {
        const [store, sessions] = await Promise.all([read(annotationsPath), snapshot()]);
        const byId = new Map(sessions.map((s) => [s.id, s]));
        const rows = Object.entries(store)
          .map(([id, a]) => shape(id, a, byId.get(id)))
          .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
        return json({ rows });
      }

      // Everything on disk that is not tracked yet, with the ticket and name
      // already resolved. One request, no per-row follow-ups.
      if (method === "GET" && pathname === "/api/untracked") {
        const [store, sessions] = await Promise.all([read(annotationsPath), snapshot()]);
        // Ticket and name come from the index, which the snapshot above just
        // refreshed. No second read of the same transcripts.
        const out = sessions
          .filter((s) => !(s.id in store))
          .map((s) => ({
            id: s.id,
            project: s.project,
            projectName: s.projectName,
            lastActive: s.lastActive,
            size: s.size,
            suggestedTicket: index.entry(s.id)?.owned ?? null,
            suggestedName: index.entry(s.id)?.name ?? null,
            suggestionSource: index.entry(s.id)?.source ?? null,
            mentions: index.ticketsFor(s.id).slice(0, 8),
            agentName: index.agentNameFor(s.id),
            prCount: index.prsFor(s.id).length,
          }));
        return json({ sessions: out });
      }

      // Searches ALL sessions on disk, not just the working set. Deleting a row
      // removes a to-do, not a record.
      if (method === "GET" && pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const [store, sessions] = await Promise.all([read(annotationsPath), snapshot()]);
        const byId = new Map(sessions.map((s) => [s.id, s]));
        const upper = q.trim().toUpperCase();
        // Ranked by match kind first, then newest within each kind, so an id or
        // an owned ticket never sits below a passing mention.
        const results = index
          .find(q)
          .map(({ id, kind }) => {
            const s = byId.get(id)!;
            const e = index.entry(id);
            return {
              id,
              kind,
              name: e?.name ?? null,
              agentName: e?.agentName ?? null,
              prCount: e?.prs.length ?? 0,
              ticket: e?.owned ?? null,
              project: s.project,
              projectName: s.projectName,
              lastActive: s.lastActive,
              tracked: id in store,
              tickets: upper
                ? index.ticketsFor(id).filter((t) => t.toUpperCase().startsWith(upper))
                : [],
              // Structured, never markup: this is transcript content on its way
              // into innerHTML, and the page escapes each part separately.
              snippet: kind === "text" ? index.snippet(id, q) : null,
            };
          })
          .sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || (b.lastActive - a.lastActive));
        // Body text is the broad tier; a common word should not return the corpus.
        let texts = 0;
        const capped = results.filter((r) => r.kind !== "text" || ++texts <= TEXT_LIMIT);
        return json({ query: q, results: capped });
      }

      // Everything a PR tab needs in one request: its own title comes from the
      // index, so the page never follows up for the session it is already about.
      const prsApi = pathname.match(/^\/api\/prs\/(.+)$/);
      if (prsApi && method === "GET") {
        const id = decodeURIComponent(prsApi[1]!);
        if (!UUID.test(id)) return badRequest("not a session id");

        const sessions = await snapshot();
        const session = sessions.find((s) => s.id === id);
        if (!session) return json({ error: "session not on disk", id }, 404);

        return json({
          id,
          name: index.entry(id)?.name ?? null,
          agentName: index.agentNameFor(id),
          project: session.project,
          projectName: session.projectName,
          lastActive: session.lastActive,
          prs: index.prsFor(id),
        });
      }

      const rowMatch = pathname.match(/^\/api\/rows\/(.+)$/);
      if (rowMatch) {
        const id = decodeURIComponent(rowMatch[1]!);
        if (!UUID.test(id)) return badRequest("not a session id");

        if (method === "PUT") {
          let patch: unknown;
          try {
            patch = await request.json();
          } catch {
            return badRequest("body must be JSON");
          }
          if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
            return badRequest("body must be a JSON object");
          }
          const saved = await upsert(id, patch as Partial<Annotation>, annotationsPath);
          const sessions = await snapshot();
          return json(shape(id, saved, sessions.find((s) => s.id === id)));
        }

        if (method === "DELETE") {
          const existed = await remove(id, annotationsPath);
          return json({ deleted: existed, id });
        }
      }

      const resumeMatch = pathname.match(/^\/api\/resume\/(.+)$/);
      if (resumeMatch && method === "POST") {
        const id = decodeURIComponent(resumeMatch[1]!);
        if (!UUID.test(id)) return badRequest("not a session id");

        const sessions = await snapshot();
        const command = `claude --resume ${id}`;
        if (!sessions.some((s) => s.id === id)) {
          return json({ launched: false, reason: "gone", command }, 404);
        }
        try {
          spawn([...TERMINAL, "claude", "--resume", id]);
          return json({ launched: true, command });
        } catch (error) {
          // Missing terminal binary throws synchronously. The button must still
          // do something useful, so hand the command to the clipboard instead.
          return json({
            launched: false,
            reason: "spawn-failed",
            fallback: "clipboard",
            command,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof CorruptStoreError) {
        return json({ error: error.message, hint: "fix or delete the file; nothing was overwritten" }, 500);
      }
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
}

export function start(port = DEFAULT_PORT, deps: Deps = {}) {
  const server = Bun.serve({ hostname: HOST, port, fetch: createHandler(deps) });
  return server;
}

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? DEFAULT_PORT);
  const server = start(port);
  console.log(`claude-tracker ${await currentVersion()}  http://${HOST}:${server.port}`);
  if (JIRA_BASE === JIRA_PLACEHOLDER) {
    console.log(`  note: set CT_JIRA_BASE=https://your-host.atlassian.net/browse to make ticket links work`);
  } else if (!(await loadAuth())) {
    console.log(`  note: set CT_JIRA_EMAIL and CT_JIRA_TOKEN, or write ${credentialsPath()}, to show ticket titles`);
  }
}
