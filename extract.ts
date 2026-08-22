/**
 * Pulls a Jira ticket and a human-readable name out of a Claude Code transcript.
 *
 * Two rules, tried in order. They were compared across every local session and
 * NEVER disagreed, so no tie-breaking is needed:
 *
 *   1. aiTitle    Claude Code writes its own one-line summary into the
 *                 transcript. Present in most transcripts; carries a ticket in many.
 *                 "Plan PROJ-346 Jira ticket with trivy scan" -> PROJ-346
 *
 *   2. opener     The first genuine user message, anchored.
 *                 "Check PROJ-402 in Jira. We need to finish it." -> PROJ-402
 *                 Catches cafe000d, which aiTitle misses.
 *
 *   union: strictly better coverage than either rule alone, with no measured conflicts.
 *
 * DO NOT regex the raw JSONL. A `slug` field preserves a STALE opener while
 * aiTitle reflects what the session actually did:
 *
 *   cafe0003  slug    = "check-proj-403-in-jira-recursive-qua..."   <- stale
 *             aiTitle = "Fetch and pull main branch updates"      <- truth
 *
 * Matching raw bytes picks up the slug and pre-fills PROJ-403 on a git chore.
 * That over-match is exactly what extract.test.ts guards against.
 */

/**
 * CONFIG. Your Jira project prefixes, alongside JIRA_BASE in server.ts.
 *
 * Deliberately not a generic [A-Z]+-\d+ pattern: that matches UTF-8, HTTP-2 and
 * every other hyphenated token, and a false ticket is worse than none.
 *
 * Override without editing this file:  CT_TICKET_PREFIXES=ABC,XYZ bun run server.ts
 */
export const TICKET_PREFIXES = (Bun.env.CT_TICKET_PREFIXES ?? "NR")
  .split(",")
  .map((p) => p.trim().toUpperCase())
  .filter(Boolean);

const TICKET = new RegExp(`\\b((?:${TICKET_PREFIXES.join("|")})-\\d{2,5})\\b`);
const TICKET_ALL = new RegExp(TICKET.source, "g");

/** The opener must START the message. "check PROJ-1 later" mid-paragraph is not intent. */
const OPENER = new RegExp(`^\\s*(?:check|read|look at|see)\\s+(?:out\\s+)?${TICKET.source}`, "i");

/**
 * aiTitle was observed at byte offsets up to ~220KB. 512KB gives roughly 2.3x
 * headroom over the worst case and costs about 10ms across a 37-session corpus.
 */
const PROBE_BYTES = 512 * 1024;

/** Openers that are harness machinery rather than the user stating intent. */
const NOISE = [
  "caveat:",
  "base directory for this skill",
  "[request interrupted",
  "this session is being continued",
  "<command-",
  "<local-command",
  "<system-reminder",
  "<user-prompt-submit-hook",
] as const;

export interface Extracted {
  /** Jira key, or null when neither rule fires. Null means "leave the field empty". */
  ticket: string | null;
  /** Display name for the row. aiTitle when available, else a trimmed first message. */
  name: string | null;
  /** Which rule produced the ticket. Useful in tests and for debugging. */
  source: "aiTitle" | "opener" | null;
}

function textOfMessage(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

/** Strip the xml-ish wrapper blocks the harness injects, then collapse whitespace. */
function clean(raw: string): string {
  return raw
    .replace(/<([a-z-]+)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?[a-z-]+>/gi, " ")
    .split(/\s+/)
    .join(" ")
    .trim();
}

function isNoise(text: string): boolean {
  const head = text.slice(0, 80).toLowerCase();
  return NOISE.some((n) => head.includes(n));
}

/**
 * Walk JSONL text once, collecting the first aiTitle and the first genuine user
 * message. Unparseable lines are skipped rather than fatal: a sliced read always
 * ends mid-line, and a live session may be mid-write.
 */
export function extractFromText(text: string): Extracted {
  let aiTitle: string | null = null;
  let firstUser: string | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (aiTitle === null && typeof rec.aiTitle === "string" && rec.aiTitle.trim()) {
      aiTitle = rec.aiTitle.trim();
    }

    if (firstUser === null && rec.type === "user") {
      const candidate = clean(textOfMessage(rec.message));
      if (candidate.length >= 15 && !isNoise(candidate)) firstUser = candidate;
    }

    if (aiTitle !== null && firstUser !== null) break;
  }

  const name = aiTitle ?? (firstUser ? firstUser.slice(0, 120) : null);

  // Rule 1: the title Claude Code wrote for itself.
  const fromTitle = aiTitle?.match(TICKET);
  if (fromTitle) return { ticket: fromTitle[1]!, name, source: "aiTitle" };

  // Rule 2: the user's own opening line, anchored.
  const fromOpener = firstUser?.match(OPENER);
  if (fromOpener) return { ticket: fromOpener[1]!, name, source: "opener" };

  return { ticket: null, name, source: null };
}

/** Read enough of a transcript to resolve its ticket and name. ~10ms for a 37-session corpus. */
export async function extractSession(path: string): Promise<Extracted> {
  let text: string;
  try {
    text = await Bun.file(path).slice(0, PROBE_BYTES).text();
  } catch {
    return { ticket: null, name: null, source: null };
  }
  return extractFromText(text);
}

/**
 * Every ticket mentioned anywhere in a transcript, for the search index.
 *
 * Reads the whole file, unlike extractSession. Measured 192ms over a 130MB corpus, which is
 * why this feeds a cached index rather than running per query.
 */
export async function extractAllTickets(path: string): Promise<Set<string>> {
  try {
    const text = await Bun.file(path).text();
    return new Set(text.match(TICKET_ALL) ?? []);
  } catch {
    return new Set();
  }
}

/** Exposed so the UI and tests agree on what a valid ticket key looks like. */
export function isTicketKey(value: string): boolean {
  return new RegExp(`^(?:${TICKET_PREFIXES.join("|")})-\\d{2,5}$`).test(value);
}
