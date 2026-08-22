import { describe, expect, test } from "bun:test";
import { parse, format, bump, compare, isBumpPart, currentVersion, VERSION_FILE } from "./version.ts";

describe("parse", () => {
  test("reads a plain version", () => {
    expect(parse("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("tolerates surrounding whitespace, since VERSION ends with a newline", () => {
    expect(parse("  0.1.0\n")).toEqual({ major: 0, minor: 1, patch: 0 });
  });

  test("multi-digit parts", () => {
    expect(parse("10.20.30")).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  test.each(["1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc1", "", "x.y.z", "01.2.3-"])(
    "rejects %p",
    (bad) => {
      expect(() => parse(bad)).toThrow(/not a semver/);
    },
  );
});

describe("bump", () => {
  const v = parse("1.2.3");

  test("patch touches only the patch", () => {
    expect(format(bump(v, "patch"))).toBe("1.2.4");
  });

  test("minor resets patch", () => {
    expect(format(bump(v, "minor"))).toBe("1.3.0");
  });

  test("major resets minor and patch", () => {
    expect(format(bump(v, "major"))).toBe("2.0.0");
  });

  test("0.x stays in 0.x on a minor bump", () => {
    expect(format(bump(parse("0.1.0"), "minor"))).toBe("0.2.0");
  });

  test("leaving 0.x is an explicit major bump, never accidental", () => {
    expect(format(bump(parse("0.9.9"), "minor"))).toBe("0.10.0");
    expect(format(bump(parse("0.9.9"), "major"))).toBe("1.0.0");
  });

  test("every bump produces a strictly greater version", () => {
    for (const part of ["major", "minor", "patch"] as const) {
      expect(compare(bump(v, part), v)).toBeGreaterThan(0);
    }
  });
});

describe("compare", () => {
  test("orders by major, then minor, then patch", () => {
    const sorted = ["0.1.0", "0.2.0", "0.10.0", "1.0.0", "1.0.1"]
      .map(parse)
      .sort(compare)
      .map(format);
    expect(sorted).toEqual(["0.1.0", "0.2.0", "0.10.0", "1.0.0", "1.0.1"]);
  });

  test("0.10.0 is newer than 0.9.0, not older", () => {
    expect(compare(parse("0.10.0"), parse("0.9.0"))).toBeGreaterThan(0);
  });

  test("equal versions compare equal", () => {
    expect(compare(parse("1.2.3"), parse("1.2.3"))).toBe(0);
  });
});

describe("isBumpPart", () => {
  test.each(["major", "minor", "patch"])("accepts %s", (p) => {
    expect(isBumpPart(p)).toBe(true);
  });

  test.each(["Major", "bump", "", "1.0.0", "prerelease"])("rejects %p", (p) => {
    expect(isBumpPart(p)).toBe(false);
  });
});

describe("currentVersion", () => {
  test("reads the real VERSION file", async () => {
    expect(await currentVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("VERSION is parseable — a malformed file would ship a broken footer", async () => {
    const raw = await Bun.file(VERSION_FILE).text();
    expect(() => parse(raw)).not.toThrow();
  });

  test("falls back to 0.0.0 rather than throwing when the file is missing", async () => {
    expect(await currentVersion("/nonexistent/VERSION")).toBe("0.0.0");
  });
});
