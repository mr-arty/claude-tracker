/**
 * The only mutable state in the app: ~/.claude-tracker/annotations.json.
 *
 * Holds the working set, roughly seven rows. Sessions themselves are read-only
 * and live on disk under ~/.claude/projects; nothing here ever touches a .jsonl.
 *
 * WRITE PATH  (every mutation goes through this, no exceptions)
 *
 *   request ──> queue ──> read disk ──> merge ONE row ──> write .tmp ──> rename
 *                 │                                                        │
 *                 │  serialised: the next write waits for this rename      │
 *                 └────────────────────────────────────────────────────────┘
 *
 * Two separate races, two separate fixes:
 *
 *   torn write    kill the process mid-write and a plain overwrite leaves a
 *                 truncated file. Writing a temp file and renaming is atomic on
 *                 POSIX, so readers see either the old or the new content.
 *
 *   lost update   two writers both read the same base, both merge, and the
 *                 second rename discards the first change. Fixed twice over:
 *                 merging a single row instead of replacing the document (so a
 *                 stale browser tab cannot resurrect a deleted row), and
 *                 serialising through `queue` (so two in-flight requests cannot
 *                 interleave across the await between read and write).
 */

import { rename, mkdir } from "node:fs/promises";

/** Jira-style, chosen so the values map 1:1 if the Jira API ever lands. */
export const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = "Medium";

export interface TicketRef {
  key: string;
  done: boolean;
}

export interface Annotation {
  /** Many per session. Each carries its own done state; the row rolls them up. */
  tickets: TicketRef[];
  priority: Priority;
  /** Free text for reading. Seeded from the transcript's aiTitle. */
  name: string;
  /** Chips for filtering. */
  tags: string[];
  /** Only meaningful when `tickets` is empty; nothing to roll up otherwise. */
  done: boolean;
  addedAt: string;
}

export type Store = Record<string, Annotation>;

export function storeDir(home = Bun.env.HOME ?? ""): string {
  return `${home}/.claude-tracker`;
}
export function storePath(home = Bun.env.HOME ?? ""): string {
  return `${storeDir(home)}/annotations.json`;
}

/** Thrown when the file exists but is not valid JSON. Never swallowed: refusing to write beats silently overwriting hand-edited data. */
export class CorruptStoreError extends Error {
  constructor(public readonly path: string, cause: unknown) {
    super(`annotations file is not valid JSON: ${path}`, { cause });
    this.name = "CorruptStoreError";
  }
}

export function normalise(raw: unknown, now = new Date().toISOString()): Annotation {
  const r = (raw ?? {}) as Partial<Annotation>;
  const tickets = Array.isArray(r.tickets)
    ? r.tickets
        .filter((t): t is TicketRef => typeof t?.key === "string" && t.key.length > 0)
        .map((t) => ({ key: t.key, done: t.done === true }))
    : [];
  return {
    tickets,
    priority: PRIORITIES.includes(r.priority as Priority) ? (r.priority as Priority) : DEFAULT_PRIORITY,
    name: typeof r.name === "string" ? r.name : "",
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    done: r.done === true,
    addedAt: typeof r.addedAt === "string" ? r.addedAt : now,
  };
}

/**
 * Read the working set. A missing file is an empty set, not an error: first run
 * is the normal case. Invalid JSON throws, because overwriting it would destroy
 * whatever the user was hand-editing.
 */
export async function read(path = storePath()): Promise<Store> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const text = await file.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CorruptStoreError(path, cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CorruptStoreError(path, new Error("expected a JSON object at the top level"));
  }
  const out: Store = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) out[id] = normalise(value);
  return out;
}

/** Replace the file atomically. The temp file must share a directory with the target, since rename is only atomic within one filesystem. */
async function writeAtomic(store: Store, path: string): Promise<void> {
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(tmp, JSON.stringify(store, null, 2) + "\n");
  await rename(tmp, path);
}

/**
 * Serialises mutations. Bun runs one JS thread, but `await` yields, so two
 * concurrent requests can both read before either writes. Chaining every
 * mutation onto one promise closes that window.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {}); // a failed write must not poison later ones
  return run;
}

/** Merge one row into whatever is currently on disk. Other rows are untouched. */
export function upsert(id: string, patch: Partial<Annotation>, path = storePath()): Promise<Annotation> {
  return serialise(async () => {
    const store = await read(path);
    const merged = normalise({ ...(store[id] ?? {}), ...patch }, store[id]?.addedAt);
    store[id] = merged;
    await writeAtomic(store, path);
    return merged;
  });
}

/**
 * Hard delete. The tracked list is a working set, not an archive: finished rows
 * get removed on purpose. Historical queries run against the transcripts on
 * disk, so deleting a row costs no queryability. The .jsonl is never touched.
 */
export function remove(id: string, path = storePath()): Promise<boolean> {
  return serialise(async () => {
    const store = await read(path);
    if (!(id in store)) return false;
    delete store[id];
    await writeAtomic(store, path);
    return true;
  });
}

/** none | partial | all. Falls back to the session-level flag when there are no tickets to roll up. */
export function rollup(a: Annotation): "none" | "partial" | "all" {
  if (a.tickets.length === 0) return a.done ? "all" : "none";
  const done = a.tickets.filter((t) => t.done).length;
  if (done === 0) return "none";
  return done === a.tickets.length ? "all" : "partial";
}
