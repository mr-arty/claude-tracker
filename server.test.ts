import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { createHandler, start, type SpawnFn } from "./server.ts";
import { TICKET_PREFIXES } from "./extract.ts";

const P = TICKET_PREFIXES[0]!;
const key = (n: number) => `${P}-${n}`;

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const GONE = "99999999-9999-4999-8999-999999999999";

let root: string;
let annotationsPath: string;
let spawned: string[][];
let spawnFails = false;
const made: string[] = [];

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

const spy: SpawnFn = (argv) => {
  if (spawnFails) throw new Error('Executable not found in $PATH: "x-terminal-emulator"');
  spawned.push(argv);
};

function handler() {
  return createHandler({ root, annotationsPath, spawn: spy });
}
const GET = (p: string) => new Request(`http://localhost${p}`);
const PUT = (p: string, body: unknown) =>
  new Request(`http://localhost${p}`, { method: "PUT", body: JSON.stringify(body) });
const DEL = (p: string) => new Request(`http://localhost${p}`, { method: "DELETE" });
const POST = (p: string) => new Request(`http://localhost${p}`, { method: "POST" });

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-server-"));
  made.push(dir);
  root = join(dir, "projects");
  annotationsPath = join(dir, "annotations.json");
  spawned = [];
  spawnFails = false;

  const proj = join(root, "-home-dev-work-example-service");
  await mkdir(proj, { recursive: true });
  await writeFile(
    join(proj, `${A}.jsonl`),
    jsonl(
      { type: "user", cwd: "/home/dev/work/example-service", message: { content: "hello" } },
      { aiTitle: `Implement ${key(405)} Jira ticket` },
      { type: "assistant", message: { content: `also mentions ${key(406)} and ${key(549)}` } },
    ),
  );
  await writeFile(
    join(proj, `${B}.jsonl`),
    jsonl(
      { type: "user", cwd: "/home/dev/work/example-service", message: { content: "git fetch and pull main up to date" } },
      { aiTitle: "Fetch and pull main branch updates" },
      { slug: `check-${P.toLowerCase()}-403-in-jira-recursive-quasar` },
    ),
  );
});

afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

describe("security", () => {
  test("start() binds 127.0.0.1, not every interface", async () => {
    const server = start(0, { root, annotationsPath, spawn: spy });
    try {
      expect(server.hostname).toBe("127.0.0.1");
      // Loopback answers.
      expect((await fetch(`http://127.0.0.1:${server.port}/api/rows`)).status).toBe(200);
      // A LAN address must not.
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((n) => n && n.family === "IPv4" && !n.internal)?.address;
      if (lan) {
        await expect(
          fetch(`http://${lan}:${server.port}/api/rows`, { signal: AbortSignal.timeout(1500) }),
        ).rejects.toThrow();
      }
    } finally {
      server.stop(true);
    }
  });

  // A bare ".." is normalised away by the URL parser before routing sees it, so
  // it 404s rather than 400s. Either way the request is refused and nothing is
  // spawned, which is the property worth asserting.
  test.each([
    ["../../etc/passwd", "path traversal"],
    ["..", "bare dotdot"],
    ["x; rm -rf ~", "shell metacharacters"],
    ["$(whoami)", "command substitution"],
    ["not-a-uuid", "plain garbage"],
    ["aaaaaaaa-1111-4111-8111-11111111111", "one char short"],
    ["aaaaaaaa-1111-4111-8111-111111111111x", "one char long"],
  ])("resume refuses %s (%s) and never spawns", async (id) => {
    const res = await handler()(POST(`/api/resume/${encodeURIComponent(id)}`));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(spawned).toEqual([]);
  });

  test("a valid-looking but unknown UUID never reaches spawn either", async () => {
    await handler()(POST(`/api/resume/${GONE}`));
    expect(spawned).toEqual([]);
  });

  test.each([
    ["../../etc/passwd", "PUT"],
    ["x; rm -rf ~", "DELETE"],
  ])("row routes reject %s on %s", async (id, method) => {
    const req = method === "PUT" ? PUT(`/api/rows/${encodeURIComponent(id)}`, {}) : DEL(`/api/rows/${encodeURIComponent(id)}`);
    expect((await handler()(req)).status).toBe(400);
  });

  test("spawn receives an argv array with the id as one inert element", async () => {
    await handler()(POST(`/api/resume/${A}`));
    expect(spawned).toEqual([["x-terminal-emulator", "-e", "claude", "--resume", A]]);
  });
});

describe("GET /api/untracked", () => {
  test("resolves ticket and name inline, no follow-up request needed", async () => {
    const res = await handler()(GET("/api/untracked"));
    const { sessions } = await res.json();
    const a = sessions.find((s: { id: string }) => s.id === A);
    expect(a.suggestedTicket).toBe(`${key(405)}`);
    expect(a.suggestedName).toBe(`Implement ${key(405)} Jira ticket`);
    expect(a.suggestionSource).toBe("aiTitle");
  });

  test("a chore session gets no pre-filled ticket even though its bytes mention one", async () => {
    const { sessions } = await (await handler()(GET("/api/untracked"))).json();
    const b = sessions.find((s: { id: string }) => s.id === B);
    expect(b.suggestedTicket).toBeNull();
    expect(b.suggestedName).toBe("Fetch and pull main branch updates");
  });

  test("project name comes from cwd, not the hyphenated directory", async () => {
    const { sessions } = await (await handler()(GET("/api/untracked"))).json();
    expect(sessions[0].projectName).toBe("example-service");
  });

  test("tracked sessions drop out of the list", async () => {
    const h = handler();
    await h(PUT(`/api/rows/${A}`, { name: "tracked" }));
    const { sessions } = await (await h(GET("/api/untracked"))).json();
    expect(sessions.map((s: { id: string }) => s.id)).toEqual([B]);
  });
});

describe("GET /api/rows", () => {
  test("empty before anything is tracked", async () => {
    expect((await (await handler()(GET("/api/rows"))).json()).rows).toEqual([]);
  });

  test("joins on-disk metadata and computes the rollup", async () => {
    const h = handler();
    await h(PUT(`/api/rows/${A}`, {
      name: `${key(405)}`,
      tickets: [{ key: `${key(405)}`, done: true }, { key: `${key(406)}`, done: false }],
    }));
    const { rows } = await (await h(GET("/api/rows"))).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: A,
      alive: true,
      projectName: "example-service",
      rollup: "partial",
      resumeCommand: `claude --resume ${A}`,
    });
  });

  test("a row whose session vanished still renders, flagged dead", async () => {
    const h = handler();
    await h(PUT(`/api/rows/${GONE}`, { name: "aged off disk" }));
    const { rows } = await (await h(GET("/api/rows"))).json();
    expect(rows[0]).toMatchObject({ id: GONE, alive: false, project: null });
  });
});

describe("PUT and DELETE /api/rows/:id", () => {
  test("merges rather than replacing", async () => {
    const h = handler();
    await h(PUT(`/api/rows/${A}`, { name: "keep me", tags: ["opa"] }));
    await h(PUT(`/api/rows/${A}`, { priority: "Highest" }));
    const { rows } = await (await h(GET("/api/rows"))).json();
    expect(rows[0]).toMatchObject({ name: "keep me", tags: ["opa"], priority: "Highest" });
  });

  test("rejects a non-object body", async () => {
    expect((await handler()(PUT(`/api/rows/${A}`, ["nope"]))).status).toBe(400);
  });

  test("rejects a non-JSON body", async () => {
    const req = new Request(`http://localhost/api/rows/${A}`, { method: "PUT", body: "not json" });
    expect((await handler()(req)).status).toBe(400);
  });

  test("delete removes the row and leaves the transcript untouched", async () => {
    const h = handler();
    await h(PUT(`/api/rows/${A}`, { name: "x" }));
    const res = await h(DEL(`/api/rows/${A}`));
    expect(await res.json()).toEqual({ deleted: true, id: A });
    expect((await (await h(GET("/api/rows"))).json()).rows).toEqual([]);
    // The .jsonl must still be on disk and readable.
    const { sessions } = await (await h(GET("/api/untracked"))).json();
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual([A, B].sort());
  });

  test("deleting an untracked id reports false rather than erroring", async () => {
    expect(await (await handler()(DEL(`/api/rows/${A}`))).json()).toEqual({ deleted: false, id: A });
  });
});

describe("POST /api/resume/:id", () => {
  test("launches for a live session", async () => {
    const res = await handler()(POST(`/api/resume/${A}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ launched: true, command: `claude --resume ${A}` });
  });

  test("404s for a UUID that is not on disk", async () => {
    const res = await handler()(POST(`/api/resume/${GONE}`));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ launched: false, reason: "gone" });
    expect(spawned).toEqual([]);
  });

  test("falls back to the clipboard when the terminal binary is missing", async () => {
    spawnFails = true;
    const res = await handler()(POST(`/api/resume/${A}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      launched: false,
      fallback: "clipboard",
      command: `claude --resume ${A}`,
    });
  });
});

describe("GET /api/search", () => {
  test("finds sessions by any mentioned ticket, not just the primary one", async () => {
    const { results } = await (await handler()(GET(`/api/search?q=${key(549)}`))).json();
    expect(results.map((r: { id: string }) => r.id)).toEqual([A]);
  });

  test("searches all sessions on disk, including untracked and deleted ones", async () => {
    const h = handler();
    await h(PUT(`/api/rows/${A}`, { name: "x" }));
    await h(DEL(`/api/rows/${A}`)); // the working set is now empty
    const { results } = await (await h(GET(`/api/search?q=${key(406)}`))).json();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: A, tracked: false });
  });

  test("prefix matching, case-insensitive", async () => {
    const { results } = await (await handler()(GET(`/api/search?q=${P.toLowerCase()}-40`))).json();
    expect(results.map((r: { id: string }) => r.id)).toEqual([A]);
  });

  test("finds a session by its id prefix", async () => {
    const { results } = await (await handler()(GET(`/api/search?q=${A.slice(0, 8)}`))).json();
    expect(results.map((r: { id: string }) => r.id)).toEqual([A]);
    expect(results[0].kind).toBe("id");
  });

  test("finds a session by its full id, hyphens and all", async () => {
    const { results } = await (await handler()(GET(`/api/search?q=${A}`))).json();
    expect(results.map((r: { id: string }) => r.id)).toEqual([A]);
  });

  test("finds a session by words in its name", async () => {
    const { results } = await (await handler()(GET("/api/search?q=fetch and pull"))).json();
    expect(results.map((r: { id: string }) => r.id)).toEqual([B]);
    expect(results[0].kind).toBe("name");
  });

  test("name matching is case-insensitive and substring-based", async () => {
    const { results } = await (await handler()(GET("/api/search?q=BRANCH"))).json();
    expect(results.map((r: { id: string }) => r.id)).toEqual([B]);
  });

  test("an owned ticket outranks a session that merely mentions it", async () => {
    // A owns PROJ-405 via aiTitle. Give B a passing mention of the same key.
    const proj = join(root, "-home-dev-work-example-service");
    await Bun.sleep(10);
    await writeFile(join(proj, `${B}.jsonl`), jsonl(
      { type: "user", cwd: "/home/dev/work/example-service", message: { content: "git fetch and pull main up to date" } },
      { aiTitle: "Fetch and pull main branch updates" },
      { type: "assistant", message: { content: `while here I also glanced at ${key(405)}` } },
    ));
    const { results } = await (await handler()(GET(`/api/search?q=${key(405)}`))).json();
    expect(results.map((r: { id: string; kind: string }) => [r.id, r.kind])).toEqual([
      [A, "ticket"],
      [B, "mention"],
    ]);
  });

  test("results carry the name and owned ticket so the UI need not refetch", async () => {
    const { results } = await (await handler()(GET(`/api/search?q=${A.slice(0, 8)}`))).json();
    expect(results[0]).toMatchObject({
      name: `Implement ${key(405)} Jira ticket`,
      ticket: key(405),
      projectName: "example-service",
    });
  });

  test("an empty query returns nothing rather than everything", async () => {
    expect((await (await handler()(GET("/api/search?q="))).json()).results).toEqual([]);
  });

  test("the index picks up a transcript that changed on disk", async () => {
    const h = handler();
    expect((await (await h(GET(`/api/search?q=${key(777)}`))).json()).results).toEqual([]);
    const proj = join(root, "-home-dev-work-example-service");
    await Bun.sleep(10);
    await writeFile(join(proj, `${A}.jsonl`), jsonl(
      { type: "user", cwd: "/home/dev/work/example-service", message: { content: "hello" } },
      { aiTitle: `Now about ${key(777)}` },
    ));
    const { results } = await (await h(GET(`/api/search?q=${key(777)}`))).json();
    expect(results.map((r: { id: string }) => r.id)).toEqual([A]);
  });
});

describe("errors and edges", () => {
  test("a corrupt annotations file returns 500 and does not overwrite it", async () => {
    await writeFile(annotationsPath, "{ half an edit");
    const res = await handler()(GET("/api/rows"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("not valid JSON");
    expect(await Bun.file(annotationsPath).text()).toBe("{ half an edit");
  });

  test("a missing projects directory yields empty lists, not a crash", async () => {
    const h = createHandler({ root: join(root, "nope"), annotationsPath, spawn: spy });
    expect((await (await h(GET("/api/untracked"))).json()).sessions).toEqual([]);
    expect((await (await h(GET("/api/rows"))).json()).rows).toEqual([]);
  });

  test("unknown routes 404", async () => {
    expect((await handler()(GET("/api/nope"))).status).toBe(404);
  });

  // These inject jiraBase rather than reading CT_JIRA_BASE, so the result does
  // not depend on whether the developer running them has it set in their shell.
  test("config reports unconfigured while the placeholder is in place", async () => {
    const h = createHandler({ root, annotationsPath, spawn: spy, jiraBase: "https://CHANGEME.atlassian.net/browse" });
    const cfg = await (await h(GET("/api/config"))).json();
    expect(cfg.jiraConfigured).toBe(false);
    expect(cfg.jiraBase).toContain("CHANGEME");
  });

  test("config reports configured once a real host is supplied", async () => {
    const h = createHandler({ root, annotationsPath, spawn: spy, jiraBase: "https://example.atlassian.net/browse" });
    const cfg = await (await h(GET("/api/config"))).json();
    expect(cfg.jiraConfigured).toBe(true);
    expect(cfg.jiraBase).toBe("https://example.atlassian.net/browse");
  });

  test("config always reports a version", async () => {
    const cfg = await (await handler()(GET("/api/config"))).json();
    expect(cfg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
