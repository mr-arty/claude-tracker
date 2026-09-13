/**
 * Credential loading and URL derivation. The fetch itself is covered in
 * server.test.ts, where it is injected; nothing in this suite touches a network.
 */

import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuth, siteRoot, credentialsPath, fetchTickets } from "./jira.ts";

let home: string;
const made: string[] = [];

// loadAuth reads the environment by design, so the suite owns it for the
// duration rather than inheriting whatever the developer has exported.
const SAVED = { email: Bun.env.CT_JIRA_EMAIL, token: Bun.env.CT_JIRA_TOKEN };
const clearEnv = () => {
  delete Bun.env.CT_JIRA_EMAIL;
  delete Bun.env.CT_JIRA_TOKEN;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ct-jira-"));
  made.push(home);
  await mkdir(join(home, ".claude-tracker"), { recursive: true });
  clearEnv();
});

afterEach(clearEnv);

afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  if (SAVED.email !== undefined) Bun.env.CT_JIRA_EMAIL = SAVED.email;
  if (SAVED.token !== undefined) Bun.env.CT_JIRA_TOKEN = SAVED.token;
});

const writeCreds = (body: unknown, mode = 0o600) =>
  writeFile(credentialsPath(home), JSON.stringify(body)).then(() => chmod(credentialsPath(home), mode));

describe("siteRoot", () => {
  test("strips the browse segment the ticket links need", () => {
    expect(siteRoot("https://example.atlassian.net/browse")).toBe("https://example.atlassian.net");
  });

  test("tolerates a trailing slash", () => {
    expect(siteRoot("https://example.atlassian.net/browse/")).toBe("https://example.atlassian.net");
  });

  test("leaves a url that is already a site root alone", () => {
    expect(siteRoot("https://example.atlassian.net")).toBe("https://example.atlassian.net");
  });

  test("does not eat a path segment that merely contains the word", () => {
    expect(siteRoot("https://example.com/jira/browsers")).toBe("https://example.com/jira/browsers");
  });
});

describe("loadAuth", () => {
  test("no environment and no file means no credentials, not a throw", async () => {
    expect(await loadAuth(home)).toBeNull();
  });

  test("the environment pair is used when both halves are present", async () => {
    Bun.env.CT_JIRA_EMAIL = "dev@example.com";
    Bun.env.CT_JIRA_TOKEN = "from-env";
    expect(await loadAuth(home)).toEqual({ email: "dev@example.com", token: "from-env" });
  });

  test("half an environment pair is not credentials", async () => {
    Bun.env.CT_JIRA_EMAIL = "dev@example.com";
    expect(await loadAuth(home)).toBeNull();
  });

  test("the file is the fallback when the environment is empty", async () => {
    await writeCreds({ jiraEmail: "dev@example.com", jiraToken: "from-file" });
    expect(await loadAuth(home)).toEqual({ email: "dev@example.com", token: "from-file" });
  });

  test("the environment wins over the file", async () => {
    await writeCreds({ jiraEmail: "file@example.com", jiraToken: "from-file" });
    Bun.env.CT_JIRA_EMAIL = "env@example.com";
    Bun.env.CT_JIRA_TOKEN = "from-env";
    expect(await loadAuth(home)).toEqual({ email: "env@example.com", token: "from-env" });
  });

  test("a half-filled or malformed file is no credentials, not a crash", async () => {
    await writeCreds({ jiraEmail: "dev@example.com" });
    expect(await loadAuth(home)).toBeNull();

    await writeFile(credentialsPath(home), "{ not json");
    expect(await loadAuth(home)).toBeNull();
  });

  test("a world-readable file still loads, but says so", async () => {
    // The user's machine and the user's call. Refusing would just move the
    // secret somewhere less visible; silence would hide a real exposure.
    await writeCreds({ jiraEmail: "dev@example.com", jiraToken: "loose" }, 0o644);
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      expect(await loadAuth(home)).toEqual({ email: "dev@example.com", token: "loose" });
    } finally {
      console.warn = original;
    }
    expect(warnings.join(" ")).toContain("readable by others");
    expect(warnings.join(" ")).not.toContain("loose");
  });

  test("the credentials file lives in $HOME, never in the repo", async () => {
    expect(credentialsPath(home)).toBe(`${home}/.claude-tracker/credentials.json`);
  });
});

describe("fetchTickets", () => {
  const AUTH = { email: "dev@example.com", token: "t" };

  test("one slow key does not hold up the others", async () => {
    // Six run at a time; the point is that a partial failure is still a partial
    // success rather than an empty page.
    const doFetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("SLOW-2")) throw new Error("timed out");
      return new Response(JSON.stringify({ fields: { summary: "ok", status: { name: "Done", statusCategory: { key: "done" } }, assignee: null } }));
    }) as typeof fetch;

    const { tickets, error } = await fetchTickets(["SLOW-1", "SLOW-2", "SLOW-3"], "https://x", AUTH, doFetch);
    expect(error).toBe("timed out");
    expect(tickets["SLOW-1"]?.summary).toBe("ok");
    expect(tickets["SLOW-2"]).toBeNull();
    expect(tickets["SLOW-3"]?.summary).toBe("ok");
  });

  test("an unexpected body shape yields null rather than a half-built ticket", async () => {
    const doFetch = (async () => new Response(JSON.stringify({ nope: true }))) as typeof fetch;
    const { tickets, error } = await fetchTickets(["X-1"], "https://x", AUTH, doFetch);
    expect(tickets["X-1"]).toBeNull();
    expect(error).toBeNull();
  });

  test("an all-404 result is diagnosed, because Jira will not say 401 on an issue", async () => {
    // Measured against a real Jira Cloud host: a wrong token gets 404 from
    // /issue and 401 from /myself. Without the second call, a bad credential
    // looks exactly like a ticket that was deleted.
    const seen: string[] = [];
    const doFetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("", { status: String(input).endsWith("/myself") ? 401 : 404 });
    }) as typeof fetch;

    const { tickets, error } = await fetchTickets(["X-1", "X-2"], "https://x", AUTH, doFetch);
    expect(error).toBe("Jira rejected the credentials");
    expect(tickets).toEqual({ "X-1": null, "X-2": null });
    expect(seen.filter((u) => u.endsWith("/myself"))).toHaveLength(1);
  });

  test("a genuinely deleted ticket is still just null, with the credentials good", async () => {
    const doFetch = (async (input: RequestInfo | URL) =>
      new Response(String(input).endsWith("/myself") ? "{}" : "", {
        status: String(input).endsWith("/myself") ? 200 : 404,
      })) as typeof fetch;

    const { tickets, error } = await fetchTickets(["X-1"], "https://x", AUTH, doFetch);
    expect(error).toBeNull();
    expect(tickets["X-1"]).toBeNull();
  });

  test("one key resolving means no credential probe at all", async () => {
    const seen: string[] = [];
    const doFetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      seen.push(u);
      if (u.includes("X-1")) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ fields: { summary: "here", status: { name: "Done", statusCategory: { key: "done" } }, assignee: null } }));
    }) as typeof fetch;

    const { error } = await fetchTickets(["X-1", "X-2"], "https://x", AUTH, doFetch);
    expect(error).toBeNull();
    expect(seen.some((u) => u.endsWith("/myself"))).toBe(false);
  });

  test("no keys means no requests", async () => {
    let called = 0;
    const doFetch = (async () => {
      called++;
      return new Response("{}");
    }) as typeof fetch;
    expect(await fetchTickets([], "https://x", AUTH, doFetch)).toEqual({ tickets: {}, error: null });
    expect(called).toBe(0);
  });
});
