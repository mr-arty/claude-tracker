/**
 * HTTP surface. Routing and wiring only; the real work lives in the modules.
 *
 *   GET    /                     index.html
 *   GET    /api/rows             tracked rows, joined with on-disk metadata
 *   GET    /api/untracked        sessions not tracked, ticket and name resolved
 *   GET    /api/search?q=        session id, ticket, name or mention, from the index
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
import { extractSession, extractAllTickets } from "./extract.ts";
import { read, upsert, remove, rollup, storePath, CorruptStoreError, type Annotation } from "./annotations.ts";
import { currentVersion } from "./version.ts";

/** Set this once. Everything else in the app works without it. */
const JIRA_BASE = "https://CHANGEME.atlassian.net/browse";
//                        ^^^^^^^^ your Jira host

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
}

/**
 * How a session matched the query. Ranked best-first: typing an id means you
 * want that session, and a session's own ticket beats one it merely discussed.
 *
 * The mention tier exists because any transcript that DISCUSSES a ticket gets it
 * indexed. A session about the tracker itself can end up carrying a dozen keys it
 * never worked on, so those must never outrank a real match.
 */
export type MatchKind = "id" | "ticket" | "name" | "mention";
const RANK: Record<MatchKind, number> = { id: 0, ticket: 1, name: 2, mention: 3 };

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
}

/**
 * Searchable state for every session, held in memory.
 *
 * A full rebuild costs about 195ms over a 130MB corpus and yields roughly 9KB, so
 * a query is a map walk rather than a 192ms rescan. Invalidation reuses the mtimes
 * the directory scan already collected: no extra stat calls, and only a transcript
 * that changed is re-read.
 */
class TicketIndex {
  private entries = new Map<string, Entry>();

  async refresh(sessions: SessionMeta[]): Promise<void> {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);

    for (const s of sessions) {
      if (this.entries.get(s.id)?.mtime === s.lastActive) continue;
      const { ticket, name, source } = await extractSession(s.path);
      this.entries.set(s.id, {
        mtime: s.lastActive,
        owned: ticket,
        source,
        name,
        mentions: await extractAllTickets(s.path),
      });
    }
  }

  /**
   * Matches session ids, owned tickets, names, and mentioned tickets, in that
   * order of confidence. Case-insensitive; ids and tickets match by prefix,
   * names by substring.
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
      }
      if (kind) hits.push({ id, kind });
    }
    return hits.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  }

  entry(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  ticketsFor(id: string): string[] {
    return [...(this.entries.get(id)?.mentions ?? [])].sort();
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const badRequest = (message: string) => json({ error: message }, 400);

export function createHandler(deps: Deps = {}) {
  const root = deps.root ?? projectsRoot();
  const annotationsPath = deps.annotationsPath ?? storePath();
  const spawn = deps.spawn ?? realSpawn;
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

      if (method === "GET" && pathname === "/api/config") {
        return json({
          version: await currentVersion(),
          jiraBase: JIRA_BASE,
          jiraConfigured: !JIRA_BASE.includes("CHANGEME"),
        });
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
              ticket: e?.owned ?? null,
              project: s.project,
              projectName: s.projectName,
              lastActive: s.lastActive,
              tracked: id in store,
              tickets: upper
                ? index.ticketsFor(id).filter((t) => t.toUpperCase().startsWith(upper))
                : [],
            };
          })
          .sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || (b.lastActive - a.lastActive));
        return json({ query: q, results });
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
  if (JIRA_BASE.includes("CHANGEME")) {
    console.log(`  note: set JIRA_BASE at the top of server.ts to make ticket links work`);
  }
}
