import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  read, upsert, remove, rollup, normalise,
  CorruptStoreError, DEFAULT_PRIORITY, type Annotation,
} from "./annotations.ts";

let dir: string;
let path: string;
const made: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct-annotations-"));
  made.push(dir);
  path = join(dir, "annotations.json");
});

afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

const ticket = (key: string, done = false) => ({ key, done });

describe("read", () => {
  test("missing file is an empty set, not an error", async () => {
    expect(await read(path)).toEqual({});
  });

  test("empty file is an empty set", async () => {
    await writeFile(path, "   \n");
    expect(await read(path)).toEqual({});
  });

  test("invalid JSON throws and does NOT clobber the file", async () => {
    await writeFile(path, "{ half an edit");
    await expect(read(path)).rejects.toThrow(CorruptStoreError);
    expect(await Bun.file(path).text()).toBe("{ half an edit");
  });

  test("a top-level array is rejected", async () => {
    await writeFile(path, "[]");
    await expect(read(path)).rejects.toThrow(CorruptStoreError);
  });

  test("partial rows are filled in with defaults", async () => {
    await writeFile(path, JSON.stringify({ abc: { name: "only a name" } }));
    const store = await read(path);
    expect(store.abc).toMatchObject({
      name: "only a name",
      tickets: [],
      tags: [],
      priority: DEFAULT_PRIORITY,
      done: false,
    });
  });

  test("an unknown priority falls back to the default", () => {
    expect(normalise({ priority: "Urgent" as never }).priority).toBe(DEFAULT_PRIORITY);
  });
});

describe("upsert", () => {
  test("creates a row", async () => {
    const row = await upsert("s1", { name: "first ticket plan", tickets: [ticket("TICKET-346")] }, path);
    expect(row.name).toBe("first ticket plan");
    expect((await read(path)).s1!.tickets).toEqual([ticket("TICKET-346")]);
  });

  test("merges one row and leaves the others alone", async () => {
    await upsert("s1", { name: "first" }, path);
    await upsert("s2", { name: "second" }, path);
    await upsert("s1", { priority: "Highest" }, path);
    const store = await read(path);
    expect(store.s1!.name).toBe("first");
    expect(store.s1!.priority).toBe("Highest");
    expect(store.s2!.name).toBe("second");
  });

  test("addedAt survives later edits", async () => {
    const first = await upsert("s1", { name: "a" }, path);
    await Bun.sleep(2);
    const second = await upsert("s1", { name: "b" }, path);
    expect(second.addedAt).toBe(first.addedAt);
  });

  test("a stale writer cannot resurrect a row deleted by someone else", async () => {
    // Tab A and tab B both load two rows.
    await upsert("s1", { name: "one" }, path);
    await upsert("s2", { name: "two" }, path);
    // Tab B deletes s1.
    await remove("s1", path);
    // Tab A, still holding a stale view, ticks a box on s2.
    await upsert("s2", { priority: "High" }, path);
    const store = await read(path);
    expect(Object.keys(store)).toEqual(["s2"]);
    expect(store.s2!.priority).toBe("High");
  });

  test("concurrent writes to different rows do not lose each other", async () => {
    // The race the serialisation queue exists for: without it these interleave
    // across the await between read and write and one update disappears.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => upsert(`s${i}`, { name: `row ${i}` }, path)),
    );
    const store = await read(path);
    expect(Object.keys(store)).toHaveLength(25);
    expect(store.s7!.name).toBe("row 7");
    expect(store.s24!.name).toBe("row 24");
  });

  test("concurrent writes to the SAME row all land", async () => {
    await Promise.all([
      upsert("s1", { name: "n" }, path),
      upsert("s1", { priority: "Low" }, path),
      upsert("s1", { tags: ["opa"] }, path),
    ]);
    const row = (await read(path)).s1!;
    expect(row.name).toBe("n");
    expect(row.priority).toBe("Low");
    expect(row.tags).toEqual(["opa"]);
  });
});

describe("atomic write", () => {
  test("leaves no temp files behind", async () => {
    await upsert("s1", { name: "a" }, path);
    await upsert("s2", { name: "b" }, path);
    const left = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(left).toEqual([]);
  });

  test("the file on disk is always valid JSON after a burst of writes", async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => upsert(`s${i}`, { name: `${i}` }, path)));
    const text = await Bun.file(path).text();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(Object.keys(JSON.parse(text))).toHaveLength(40);
  });

  test("creates the store directory on first write", async () => {
    const nested = join(dir, "deep", "annotations.json");
    await upsert("s1", { name: "a" }, nested);
    expect(await Bun.file(nested).exists()).toBe(true);
  });
});

describe("remove", () => {
  test("hard-deletes the row and reports it", async () => {
    await upsert("s1", { name: "a" }, path);
    expect(await remove("s1", path)).toBe(true);
    expect(await read(path)).toEqual({});
  });

  test("removing an unknown id is a no-op, not an error", async () => {
    await upsert("s1", { name: "a" }, path);
    expect(await remove("nope", path)).toBe(false);
    expect(Object.keys(await read(path))).toEqual(["s1"]);
  });
});

describe("rollup", () => {
  const base: Annotation = normalise({});
  const withTickets = (...t: { key: string; done: boolean }[]): Annotation => ({ ...base, tickets: t });

  test("no tickets falls back to the session-level flag", () => {
    expect(rollup({ ...base, tickets: [], done: false })).toBe("none");
    expect(rollup({ ...base, tickets: [], done: true })).toBe("all");
  });

  test("none, partial, all", () => {
    expect(rollup(withTickets(ticket("TICKET-1"), ticket("TICKET-2")))).toBe("none");
    expect(rollup(withTickets(ticket("TICKET-1", true), ticket("TICKET-2")))).toBe("partial");
    expect(rollup(withTickets(ticket("TICKET-1", true), ticket("TICKET-2", true)))).toBe("all");
  });

  test("a single done ticket is all, not partial", () => {
    expect(rollup(withTickets(ticket("TICKET-1", true)))).toBe("all");
  });
});
