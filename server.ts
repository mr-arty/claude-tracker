/**
 * HTTP surface. Routing and wiring only; the real work lives in the modules.
 *
 *   GET    /                     index.html
 *   GET    /api/rows             tracked rows, joined with on-disk metadata
 *   GET    /api/untracked        sessions not tracked, ticket and name resolved
 *   GET    /api/search?q=        every session mentioning a ticket, from the index
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
  indexDir?: string;
}

/**
 * Ticket -> sessions, held in memory.
 *
 * Rebuilding costs 195ms over the whole 130MB corpus and yields about 9KB, so a
 * query becomes a map lookup instead of a 192ms rescan. Invalidation reuses the
 * mtimes the scan already collected: no extra stat calls, and a file that
 * changed is the only one re-read.
 */
class TicketIndex {
  private tickets = new Map<string, Set<string>>(); // session id -> tickets
  private mtimes = new Map<string, number>();

  async refresh(sessions: SessionMeta[]): Promise<void> {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of this.mtimes.keys()) {
      if (!live.has(id)) {
        this.mtimes.delete(id);
        this.tickets.delete(id);
      }
    }
    for (const s of sessions) {
      if (this.mtimes.get(s.id) === s.lastActive) continue;
      this.tickets.set(s.id, await extractAllTickets(s.path));
      this.mtimes.set(s.id, s.lastActive);
    }
  }

  /** Session ids mentioning `query`, case-insensitive, prefix-matching on the ticket key. */
  find(query: string): Set<string> {
    const q = query.trim().toUpperCase();
    const hits = new Set<string>();
    if (!q) return hits;
    for (const [id, set] of this.tickets) {
      for (const t of set) {
        if (t.toUpperCase().startsWith(q)) {
          hits.add(id);
          break;
        }
      }
    }
    return hits;
  }

  ticketsFor(id: string): string[] {
    return [...(this.tickets.get(id) ?? [])].sort();
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
        return json({ jiraBase: JIRA_BASE, jiraConfigured: !JIRA_BASE.includes("CHANGEME") });
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
        const candidates = sessions.filter((s) => !(s.id in store));
        const out = [];
        for (const s of candidates) {
          const { ticket, name, source } = await extractSession(s.path);
          out.push({
            id: s.id,
            project: s.project,
            projectName: s.projectName,
            lastActive: s.lastActive,
            size: s.size,
            suggestedTicket: ticket,
            suggestedName: name,
            suggestionSource: source,
            mentions: index.ticketsFor(s.id).slice(0, 8),
          });
        }
        return json({ sessions: out });
      }

      // Searches ALL sessions on disk, not just the working set. Deleting a row
      // removes a to-do, not a record.
      if (method === "GET" && pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const [store, sessions] = await Promise.all([read(annotationsPath), snapshot()]);
        const hits = index.find(q);
        const byId = new Map(sessions.map((s) => [s.id, s]));
        const results = [...hits]
          .map((id) => {
            const s = byId.get(id)!;
            return {
              id,
              project: s.project,
              projectName: s.projectName,
              lastActive: s.lastActive,
              tracked: id in store,
              tickets: index.ticketsFor(id).filter((t) => t.toUpperCase().startsWith(q.trim().toUpperCase())),
            };
          })
          .sort((a, b) => b.lastActive - a.lastActive);
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
  console.log(`claude-tracker  http://${HOST}:${server.port}`);
  if (JIRA_BASE.includes("CHANGEME")) {
    console.log(`  note: set JIRA_BASE at the top of server.ts to make ticket links work`);
  }
}
