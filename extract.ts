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
 * Per-session prose budget, guarding the heap against one runaway transcript.
 *
 * Sized from the corpus, not guessed: prose is 2.1% of raw bytes (152MB -> 3.2MB
 * across 37 sessions) and the largest single session is 596KB. At 256KB this
 * silently truncated the six longest sessions, which are the deep debugging ones
 * search exists to find. 1MB clears the real maximum and still bounds the damage.
 */
const PROSE_CAP = 1024 * 1024;

export interface PrRef {
  number: number;
  /** "OWNER/REPO", exactly as the transcript records it. */
  repository: string;
  url: string;
  /** ISO. The earliest timestamp seen for this url, i.e. when the PR was opened. */
  firstSeen: string;
}

export interface FullScan {
  /** Every ticket appearing anywhere in the transcript, including ones only discussed. */
  mentions: Set<string>;
  /** User and assistant prose, cleaned and concatenated. Tool output excluded. */
  prose: string;
  /** The name Claude Code carries for this session, without the display @. */
  agentName: string | null;
  /** Pull requests opened during the session, deduped. */
  prs: PrRef[];
}

/**
 * The searchable prose of a transcript: what was said, not what was run.
 *
 * textOfMessage already keeps only `text` blocks, so tool_use and tool_result
 * fall away on their own — which is the point. Tool output and file dumps are
 * the bulk of the corpus, and matching them finds the file rather than the
 * session. isNoise drops the harness boilerplate that would otherwise appear in
 * every transcript and match every query.
 */
export function proseFromText(text: string): string {
  const parts: string[] = [];
  let length = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;

    const said = clean(textOfMessage(rec.message));
    if (!said || isNoise(said)) continue;

    parts.push(said);
    length += said.length + 1;
    if (length >= PROSE_CAP) break;
  }

  return parts.join("\n").slice(0, PROSE_CAP);
}

/**
 * The session name Claude Code carries, e.g. "oke-traefik-gitops-e2e-test".
 *
 * LAST record wins, the opposite of the aiTitle rule above. Sessions get renamed
 * mid-run and the record is rewritten each time; three local transcripts carry
 * two or three distinct names. The @ in the displayed "@name" is Claude Code's
 * addressing prefix and is never part of the stored value.
 */
export function agentNameFromText(text: string): string | null {
  let name: string | null = null;

  for (const line of text.split("\n")) {
    // Cheap reject before the parse. These records are a handful of lines in a
    // file that is mostly tool output, so parsing every line would dominate.
    if (!line.includes('"agent-name"')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== "agent-name") continue;
    const value = typeof rec.agentName === "string" ? rec.agentName.trim() : "";
    if (value) name = value;
  }

  return name;
}

/**
 * Pull requests opened during the session, from the transcript's own pr-link
 * records. No network call and no gh: the data is already on disk.
 *
 * The records repeat every turn — 3170 of them locally for 87 distinct PRs — so
 * dedupe by url and keep the EARLIEST timestamp, which is when the PR appeared.
 */
export function prsFromText(text: string): PrRef[] {
  const byUrl = new Map<string, PrRef>();

  for (const line of text.split("\n")) {
    if (!line.includes('"pr-link"')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== "pr-link") continue;

    const url = typeof rec.prUrl === "string" ? rec.prUrl.trim() : "";
    const repository = typeof rec.prRepository === "string" ? rec.prRepository.trim() : "";
    const number = typeof rec.prNumber === "number" ? rec.prNumber : NaN;
    if (!url || !repository || !Number.isFinite(number)) continue;

    const firstSeen = typeof rec.timestamp === "string" ? rec.timestamp : "";
    const seen = byUrl.get(url);
    if (!seen) {
      byUrl.set(url, { number, repository, url, firstSeen });
    } else if (firstSeen && (!seen.firstSeen || firstSeen < seen.firstSeen)) {
      seen.firstSeen = firstSeen;
    }
  }

  return [...byUrl.values()].sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
}

/**
 * One full read, feeding the mention set, the full-text index, the session name
 * and the PR list.
 *
 * Reads the whole file, unlike extractSession. Mentions come from the raw bytes,
 * since a ticket key means something wherever it appears; prose does not.
 *
 * The name and PR passes are separate loops rather than folded into
 * proseFromText, because that one stops at PROSE_CAP and both records routinely
 * sit past it: 15 of 24 named sessions record their name beyond 512KB, one at
 * 7.7MB. The substring guard before each parse keeps the two extra passes at
 * ~220ms across a 195MB corpus, which is why this feeds a cached index rather
 * than running per query.
 */
export async function scanFull(path: string): Promise<FullScan> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return { mentions: new Set(), prose: "", agentName: null, prs: [] };
  }
  return {
    mentions: new Set(text.match(TICKET_ALL) ?? []),
    prose: proseFromText(text),
    agentName: agentNameFromText(text),
    prs: prsFromText(text),
  };
}

/** Exposed so the UI and tests agree on what a valid ticket key looks like. */
export function isTicketKey(value: string): boolean {
  return new RegExp(`^(?:${TICKET_PREFIXES.join("|")})-\\d{2,5}$`).test(value);
}
