/**
 * Semver parsing and bumping. Kept separate from release.ts so the arithmetic is
 * unit-testable without touching git or the filesystem.
 *
 * What is being versioned here is not a library API. It is the
 * ~/.claude-tracker/annotations.json format and the HTTP surface:
 *
 *   major  a stored annotations file written by an older version stops loading
 *   minor  new capability, older files still load unchanged
 *   patch  fixes and internals, nothing a stored file or a caller can observe
 */

export type BumpPart = "major" | "minor" | "patch";
export const BUMP_PARTS: BumpPart[] = ["major", "minor", "patch"];

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parse(raw: string): SemVer {
  const m = SEMVER.exec(raw.trim());
  if (!m) throw new Error(`not a semver version: ${JSON.stringify(raw)}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function format(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Bumping a part resets everything to its right, which is the whole point of semver ordering. */
export function bump(v: SemVer, part: BumpPart): SemVer {
  switch (part) {
    case "major":
      return { major: v.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case "patch":
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

export function compare(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isBumpPart(value: string): value is BumpPart {
  return (BUMP_PARTS as string[]).includes(value);
}

const VERSION_FILE = new URL("./VERSION", import.meta.url).pathname;

/** Reads VERSION. Falls back to 0.0.0 rather than crashing the server over a missing file. */
export async function currentVersion(path = VERSION_FILE): Promise<string> {
  try {
    return format(parse(await Bun.file(path).text()));
  } catch {
    return "0.0.0";
  }
}

export { VERSION_FILE };
