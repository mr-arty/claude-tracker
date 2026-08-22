/**
 * Discovers Claude Code sessions on disk. Read-only, never mutates anything.
 *
 *   ~/.claude/projects/
 *     -home-dev-work-example-service/     <- dir name, LOSSY
 *       cafe000f-7900-4bb9-a5af-57df355fc927.jsonl   <- filename IS the session id
 *              |                                        (this part is reliable)
 *              v
 *       {"cwd":"/home/dev/work/example-service", ...}
 *              ^
 *              +-- authoritative project path, read from inside the transcript
 *
 * The directory name replaces "/" with "-", so it cannot be decoded back: a real
 * folder called example-service is indistinguishable from terraform/modules.
 * Measured 10 of 11 local directories decode wrong. So we read cwd from the
 * transcript instead, once per DIRECTORY (not per session) and cache it.
 */

import { stat } from "node:fs/promises";

/** How much of a transcript to read when hunting for the cwd field. */
const CWD_PROBE_BYTES = 64 * 1024;

export interface SessionMeta {
  /** UUID, taken from the filename. */
  id: string;
  /** Absolute working directory, from the transcript's cwd field. */
  project: string;
  /** Last path segment of `project`, for display. */
  projectName: string;
  /** Raw on-disk directory name, kept for debugging the lossy encoding. */
  dir: string;
  /** Absolute path to the .jsonl. */
  path: string;
  /** File mtime in ms. Used for sorting and index invalidation. */
  lastActive: number;
  size: number;
}

export function projectsRoot(home = Bun.env.HOME ?? ""): string {
  return `${home}/.claude/projects`;
}

/**
 * Best-effort decode of a project directory name. Only used when NO session in
 * that directory records a cwd, which does not occur in practice. Wrong for any
 * path containing a hyphen, which is why it is the fallback and not the rule.
 */
export function fallbackProjectPath(dir: string): string {
  return "/" + dir.replace(/^-/, "").replace(/-/g, "/");
}

/** Pull the first `cwd` value out of raw JSONL text. Null if absent or unparseable. */
export function cwdFromTranscript(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // truncated tail of a sliced read, or a partial write
    }
    const cwd = (rec as { cwd?: unknown })?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return null;
}

/**
 * Resolve dir name -> real project path, reading transcripts until one yields a
 * cwd. Sequential and short-circuiting: the first hit in a directory settles it.
 */
async function resolveDirCwd(paths: string[], dir: string): Promise<string> {
  for (const p of paths) {
    let text: string;
    try {
      text = await Bun.file(p).slice(0, CWD_PROBE_BYTES).text();
    } catch {
      continue; // unreadable file, try the next one in this directory
    }
    const cwd = cwdFromTranscript(text);
    if (cwd) return cwd;
  }
  return fallbackProjectPath(dir);
}

/**
 * Every session on disk, newest first.
 *
 * Sequential by design. Promise.all measured 54ms faster but peaked at 92MB heap
 * versus 59MB, and that gap scales linearly with corpus size.
 */
export async function scanSessions(root = projectsRoot()): Promise<SessionMeta[]> {
  const byDir = new Map<string, string[]>();

  try {
    // Exactly two levels deep, on purpose. Sub-agent runs live one level lower,
    // at <project>/<session-uuid>/subagents/agent-*.jsonl. There are 18 of them
    // locally. They are not resumable sessions and must never appear as rows, so
    // this must not become "**/*.jsonl".
    const glob = new Bun.Glob("*/*.jsonl");
    for await (const path of glob.scan({ cwd: root, absolute: true })) {
      const dir = path.slice(root.length + 1).split("/")[0]!;
      const list = byDir.get(dir);
      if (list) list.push(path);
      else byDir.set(dir, [path]);
    }
  } catch {
    return []; // projects dir missing entirely: an empty list, not a crash
  }

  const sessions: SessionMeta[] = [];
  for (const [dir, paths] of byDir) {
    const project = await resolveDirCwd(paths, dir);
    const projectName = project.split("/").filter(Boolean).pop() ?? project;
    for (const path of paths) {
      let info: { mtimeMs: number; size: number };
      try {
        info = await stat(path);
      } catch {
        continue; // vanished between glob and stat
      }
      sessions.push({
        id: path.slice(path.lastIndexOf("/") + 1, -".jsonl".length),
        project,
        projectName,
        dir,
        path,
        lastActive: info.mtimeMs,
        size: info.size,
      });
    }
  }

  return sessions.sort((a, b) => b.lastActive - a.lastActive);
}
