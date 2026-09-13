/**
 * The one network call in this tool. Everything else reads the local disk.
 *
 * Turns a bare key into "Trivy scan gate, In Progress, assigned to you". The five
 * priority levels in annotations.ts were chosen Jira-shaped for exactly this, so
 * nothing about the stored format changes here.
 *
 * Two rules hold the blast radius down:
 *
 *   1. Nothing here can fail a request. Jira being slow, down, or unauthorised
 *      returns an error string alongside whatever did resolve; the page then
 *      renders exactly as it did before this existed.
 *   2. The credential never reaches the repo. It comes from the environment, or
 *      from a file in $HOME that this tool only ever reads.
 */

import { storeDir } from "./annotations.ts";

export interface JiraAuth {
  email: string;
  token: string;
}

export interface TicketInfo {
  summary: string;
  status: string;
  /** Jira's own three-bucket grouping: "new", "indeterminate" or "done". */
  statusCategory: string;
  assignee: string | null;
}

/** Where the fallback credentials live, beside annotations.json and outside any repo. */
export function credentialsPath(home = Bun.env.HOME ?? ""): string {
  return `${storeDir(home)}/credentials.json`;
}

/**
 * Environment first, file second.
 *
 * The env pair matches CT_JIRA_BASE and keeps the secret out of every filesystem.
 * The file exists because a desktop launcher does not inherit a shell.
 */
export async function loadAuth(home = Bun.env.HOME ?? ""): Promise<JiraAuth | null> {
  const email = Bun.env.CT_JIRA_EMAIL?.trim();
  const token = Bun.env.CT_JIRA_TOKEN?.trim();
  if (email && token) return { email, token };

  const path = credentialsPath(home);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  try {
    const raw = JSON.parse(await file.text()) as Record<string, unknown>;
    const fileEmail = typeof raw.jiraEmail === "string" ? raw.jiraEmail.trim() : "";
    const fileToken = typeof raw.jiraToken === "string" ? raw.jiraToken.trim() : "";
    if (!fileEmail || !fileToken) return null;

    const { mode } = await file.stat();
    // A warning, not a refusal: it is the user's machine and their call. Silence
    // would be worse, since a world-readable token looks identical to a safe one.
    if (mode & 0o077) console.warn(`  warning: ${path} is readable by others (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);

    return { email: fileEmail, token: fileToken };
  } catch {
    return null;
  }
}

/**
 * The Jira site root, derived from the browse URL already configured.
 *
 * CT_JIRA_BASE is ".../browse" because that is what a ticket link needs. The REST
 * API hangs off the host, so strip the last segment rather than asking for a
 * second URL that could disagree with the first.
 */
export function siteRoot(jiraBase: string): string {
  return jiraBase.replace(/\/+$/, "").replace(/\/browse$/i, "");
}

const CONCURRENCY = 6;
const TIMEOUT_MS = 8000;

function parseIssue(body: unknown): TicketInfo | null {
  const fields = (body as { fields?: Record<string, unknown> })?.fields;
  if (!fields) return null;
  const status = fields.status as { name?: unknown; statusCategory?: { key?: unknown } } | undefined;
  const assignee = fields.assignee as { displayName?: unknown } | null | undefined;
  return {
    summary: typeof fields.summary === "string" ? fields.summary : "",
    status: typeof status?.name === "string" ? status.name : "",
    statusCategory: typeof status?.statusCategory?.key === "string" ? status.statusCategory.key : "",
    assignee: typeof assignee?.displayName === "string" ? assignee.displayName : null,
  };
}

/**
 * Jira Cloud answers 404, not 401, for an issue request carrying a bad token: it
 * declines to say whether the issue exists. Measured against a real host, both
 * anonymous and wrong-credential requests. So a wrong token is indistinguishable
 * from a missing ticket at this endpoint, and would otherwise present as silence.
 *
 * /myself does answer 401, so it is the one call that can tell the two apart. It
 * runs only when EVERY key came back 404, which is the only ambiguous case.
 */
async function credentialsRejected(site: string, header: string, doFetch: typeof fetch): Promise<boolean> {
  try {
    const res = await doFetch(`${site}/rest/api/3/myself`, {
      headers: { authorization: header, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

export interface FetchResult {
  tickets: Record<string, TicketInfo | null>;
  /** Human-readable, and shown as-is. Null when every key resolved or was simply absent. */
  error: string | null;
}

/**
 * One request per key, six at a time.
 *
 * Not a JQL batch: /rest/api/3/issue/{key} is the endpoint that has not moved,
 * needs no query escaping, and lets one missing ticket resolve to null instead of
 * failing the whole page. Key counts here are in the tens.
 */
export async function fetchTickets(
  keys: string[],
  site: string,
  auth: JiraAuth,
  doFetch: typeof fetch = fetch,
): Promise<FetchResult> {
  const tickets: Record<string, TicketInfo | null> = {};
  const errors: string[] = [];
  let missing = 0;
  const header = `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString("base64")}`;
  const queue = [...keys];

  const worker = async () => {
    for (let k = queue.shift(); k !== undefined; k = queue.shift()) {
      const url = `${site}/rest/api/3/issue/${k}?fields=summary,status,assignee`;
      try {
        const res = await doFetch(url, {
          headers: { authorization: header, accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 404) {
          // Either the ticket is gone or the token is bad; Jira will not say
          // which. Resolved once below, only if every key came back this way.
          tickets[k] = null;
          missing++;
          continue;
        }
        if (!res.ok) {
          tickets[k] = null;
          errors.push(res.status === 401 || res.status === 403 ? "Jira rejected the credentials" : `Jira returned ${res.status}`);
          continue;
        }
        tickets[k] = parseIssue(await res.json());
      } catch (error) {
        tickets[k] = null;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker));

  if (!errors.length && missing === keys.length && keys.length > 0) {
    if (await credentialsRejected(site, header, doFetch)) errors.push("Jira rejected the credentials");
  }

  return { tickets, error: errors.length ? [...new Set(errors)][0]! : null };
}
