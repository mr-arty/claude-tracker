import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessions, cwdFromTranscript, fallbackProjectPath, projectsRoot } from "./scan.ts";

const UUID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const UUID_B = "bbbbbbbb-2222-4222-8222-222222222222";
const UUID_C = "cccccccc-3333-4333-8333-333333333333";

let root: string;
const made: string[] = [];

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-scan-"));
  made.push(root);

  // A directory whose real path contains hyphens. The whole point of D6: the
  // directory name cannot be decoded back, so cwd must come from the transcript.
  const hyphenated = join(root, "-home-dev-work-example-service");
  await mkdir(hyphenated, { recursive: true });
  // First file has no cwd; the resolver must fall through to the second.
  await writeFile(join(hyphenated, `${UUID_A}.jsonl`), jsonl({ type: "mode", mode: "default" }));
  await writeFile(
    join(hyphenated, `${UUID_B}.jsonl`),
    jsonl({ type: "mode" }, { type: "user", cwd: "/home/dev/work/example-service", message: { content: "hi" } }),
  );

  // A directory where no session records cwd at all: fallback territory.
  const noCwd = join(root, "-tmp-scratch");
  await mkdir(noCwd, { recursive: true });
  await writeFile(join(noCwd, `${UUID_C}.jsonl`), jsonl({ type: "mode" }));

  // A zero-byte transcript. Aborted sessions exist and must not break the scan.
  const empty = join(root, "-tmp-empty");
  await mkdir(empty, { recursive: true });
  await writeFile(join(empty, `${UUID_A}.jsonl`), "");

  // Sub-agent runs nest one level deeper than sessions. They are not resumable
  // and must never be listed as rows.
  const subagents = join(hyphenated, UUID_B, "subagents");
  await mkdir(subagents, { recursive: true });
  await writeFile(join(subagents, "agent-a000000000000001.jsonl"), jsonl({ type: "user", message: { content: "sub" } }));
});

afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

describe("cwdFromTranscript", () => {
  test("finds the first cwd", () => {
    expect(cwdFromTranscript(jsonl({ type: "mode" }, { cwd: "/a/b-c" }))).toBe("/a/b-c");
  });

  test("returns null when absent", () => {
    expect(cwdFromTranscript(jsonl({ type: "mode" }))).toBeNull();
  });

  test("skips unparseable lines, including a truncated tail", () => {
    const text = `{ not json\n${JSON.stringify({ cwd: "/x/y" })}\n{"half":`;
    expect(cwdFromTranscript(text)).toBe("/x/y");
  });

  test("ignores a non-string or empty cwd", () => {
    expect(cwdFromTranscript(jsonl({ cwd: 42 }, { cwd: "" }, { cwd: "/real" }))).toBe("/real");
  });
});

describe("fallbackProjectPath — documents the lossy decode we avoid", () => {
  test("is correct only when the real path has no hyphens", () => {
    expect(fallbackProjectPath("-home-dev-work")).toBe("/home/dev/work");
  });

  test("is WRONG for a hyphenated directory, which is why it is the fallback", () => {
    expect(fallbackProjectPath("-home-dev-work-claude-tracker"))
      .toBe("/home/dev/work/claude/tracker"); // real path is .../claude-tracker
  });
});

describe("scanSessions", () => {
  test("a missing projects directory yields an empty list, not a throw", async () => {
    expect(await scanSessions(join(root, "does-not-exist"))).toEqual([]);
  });

  test("project path comes from cwd, not from the directory name", async () => {
    const sessions = await scanSessions(root);
    const s = sessions.find((x) => x.id === UUID_B)!;
    expect(s.project).toBe("/home/dev/work/example-service");
    expect(s.projectName).toBe("example-service");
  });

  test("every session in a directory inherits that directory's resolved cwd", async () => {
    const sessions = await scanSessions(root);
    const a = sessions.find((x) => x.id === UUID_A && x.dir.includes("example-service"))!;
    // UUID_A's own transcript has no cwd; it inherits from UUID_B in the same dir.
    expect(a.project).toBe("/home/dev/work/example-service");
  });

  test("falls back to the decoded directory name when nothing records cwd", async () => {
    const sessions = await scanSessions(root);
    const s = sessions.find((x) => x.id === UUID_C)!;
    expect(s.project).toBe("/tmp/scratch");
  });

  test("a zero-byte transcript is still a session", async () => {
    const sessions = await scanSessions(root);
    const s = sessions.find((x) => x.dir === "-tmp-empty")!;
    expect(s.size).toBe(0);
    expect(s.id).toBe(UUID_A);
  });

  test("the session id is the filename, minus the extension", async () => {
    for (const s of await scanSessions(root)) {
      expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(s.path.endsWith(`${s.id}.jsonl`)).toBe(true);
    }
  });

  test("sorted newest first", async () => {
    const sessions = await scanSessions(root);
    const times = sessions.map((s) => s.lastActive);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test("sub-agent transcripts are NOT sessions", async () => {
    // 18 of these exist locally at <project>/<session>/subagents/agent-*.jsonl.
    // Widening the glob to **/*.jsonl would list them as rows you cannot resume.
    const sessions = await scanSessions(root);
    expect(sessions.some((s) => s.id.startsWith("agent-"))).toBe(false);
    expect(sessions.some((s) => s.path.includes("/subagents/"))).toBe(false);
  });
});

describe("scanSessions against the real corpus", () => {
  test("resolves every project path from the recorded cwd, not the lossy decode", async () => {
    const sessions = await scanSessions(projectsRoot());
    if (sessions.length === 0) return; // no local sessions on this machine

    const byDir = new Map<string, typeof sessions>();
    for (const s of sessions) byDir.set(s.dir, [...(byDir.get(s.dir) ?? []), s]);

    // Regression guard for D6. Counting directories that merely EQUAL the naive
    // decode is not the same question: a path with no hyphen in any segment
    // decodes to itself, so a correct resolution looks like a regression.
    const wrong: string[] = [];
    let checked = 0;
    for (const [dir, list] of byDir) {
      let cwd: string | null = null;
      for (const s of list) {
        cwd = cwdFromTranscript(await Bun.file(s.path).slice(0, 64 * 1024).text());
        if (cwd) break;
      }
      if (!cwd) continue; // nothing recorded a cwd, so the fallback is correct here
      checked++;
      for (const s of list) {
        if (s.project !== cwd) wrong.push(`${dir}: resolved ${s.project}, transcript says ${cwd}`);
      }
    }

    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(0); // otherwise the loop above asserted nothing
  });

  test("the lossy decode really is lossy, so the guard above is not vacuous", async () => {
    const sessions = await scanSessions(projectsRoot());
    if (sessions.length === 0) return;

    // If every local path happened to survive the hyphen decode, the test above
    // would pass under a regression too. At least one must disagree.
    const dirs = new Set(sessions.map((s) => s.dir));
    const byDir = new Map(sessions.map((s) => [s.dir, s.project]));
    const disagree = [...dirs].filter((d) => byDir.get(d) !== fallbackProjectPath(d));
    expect(disagree.length).toBeGreaterThan(0);
  });

  test("no project name contains a slash", async () => {
    for (const s of await scanSessions(projectsRoot())) {
      expect(s.projectName).not.toContain("/");
    }
  });
});
