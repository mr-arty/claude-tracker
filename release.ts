/**
 * Cuts a release: bump VERSION, move the Unreleased changelog entries into a
 * numbered section, commit, tag.
 *
 *   bun run release.ts patch          0.1.0 -> 0.1.1
 *   bun run release.ts minor          0.1.0 -> 0.2.0
 *   bun run release.ts major          0.1.0 -> 1.0.0
 *   bun run release.ts minor --dry    print what would happen, change nothing
 *
 * Refuses to run on a dirty working tree, on failing tests, with an empty
 * Unreleased section, or when the tag already exists. Every one of those means
 * the release would record something untrue.
 */

import { parse, format, bump, isBumpPart, BUMP_PARTS, VERSION_FILE, type BumpPart } from "./version.ts";

const CHANGELOG = new URL("./CHANGELOG.md", import.meta.url).pathname;
const DRY = Bun.argv.includes("--dry");

function die(message: string, hint?: string): never {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) die(`command failed: ${cmd.join(" ")}`, err.trim());
  return out.trim();
}

const part = Bun.argv[2];
if (!part || !isBumpPart(part)) {
  die(`usage: bun run release.ts <${BUMP_PARTS.join("|")}> [--dry]`);
}

// 1. Clean tree. A release commit must contain the bump and nothing else, or the
//    tag points at a state that was never tested.
const status = await run(["git", "status", "--porcelain"]);
if (status && !DRY) {
  die("working tree is dirty — commit or stash first", status.split("\n").slice(0, 5).join("\n  "));
}

// 2. Tests. Tagging a failing build is worse than not tagging at all.
process.stdout.write("  running tests... ");
const test = Bun.spawn(["bun", "test"], { stdout: "pipe", stderr: "pipe" });
const testOut = (await new Response(test.stderr).text()) + (await new Response(test.stdout).text());
if ((await test.exited) !== 0) {
  console.error("FAILED\n");
  die("tests must pass before a release", testOut.split("\n").slice(-12).join("\n  "));
}
console.log((testOut.match(/(\d+ pass)/)?.[1] ?? "ok"));

// 3. Versions.
const current = parse(await Bun.file(VERSION_FILE).text());
const next = bump(current, part as BumpPart);
const tag = `v${format(next)}`;

const existingTags = (await run(["git", "tag", "--list"])).split("\n").filter(Boolean);
if (existingTags.includes(tag)) die(`tag ${tag} already exists`);

// 4. Changelog. An empty Unreleased section means nobody wrote down what changed.
const changelog = await Bun.file(CHANGELOG).text();
const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/.exec(changelog);
if (!unreleased) die("CHANGELOG.md has no ## [Unreleased] section");
const notes = unreleased[1]!.trim();
if (!notes) {
  die(
    "nothing under ## [Unreleased] — write down what changed first",
    "a release with no notes is a version number nobody can interpret later",
  );
}

const today = new Date().toISOString().slice(0, 10);
const rewritten = changelog.replace(
  /## \[Unreleased\]\n[\s\S]*?(?=\n## \[|$)/,
  `## [Unreleased]\n\n## [${format(next)}] - ${today}\n\n${notes}\n`,
);

console.log(`  ${format(current)} -> ${format(next)}  (${part})`);
console.log(`  notes:\n${notes.split("\n").map((l) => `    ${l}`).join("\n")}`);

if (DRY) {
  console.log(`\n  --dry: nothing written. Would commit and tag ${tag}.`);
  process.exit(0);
}

await Bun.write(VERSION_FILE, `${format(next)}\n`);
await Bun.write(CHANGELOG, rewritten);

await run(["git", "add", "VERSION", "CHANGELOG.md"]);
await run(["git", "commit", "-m", `Release ${format(next)}\n\n${notes}`]);
await run(["git", "tag", "-a", tag, "-m", `Release ${format(next)}\n\n${notes}`]);

console.log(`\n  committed and tagged ${tag}`);
console.log(`  undo:  git tag -d ${tag} && git reset --hard HEAD~1`);
