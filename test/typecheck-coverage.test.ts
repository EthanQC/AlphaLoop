import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * I10's own guard.
 *
 * `tsconfig.tests.json` explains WHY the test files needed static coverage
 * (125 of 126 were checked by nothing, and the checker found real drift the
 * moment it was pointed at them). This file keeps that mechanism from decaying
 * in the ways it can:
 *
 *  1. the tests project losing its include globs, or quietly relaxing
 *     strictness so that "green" stops meaning what it means for src;
 *  2. the pre-existing-backlog exclusion list GROWING, or keeping entries for
 *     files that no longer exist - a rename would turn an honest "37
 *     known-dirty files" into a smaller check that still claims 37;
 *  3. a test file appearing somewhere no tsconfig include glob reaches.
 *
 * It deliberately does NOT run tsc: `pnpm typecheck` does that, and repeating
 * it here would add ~7s to every suite run for the same answer.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TESTS_TSCONFIG = join(ROOT, "tsconfig.tests.json");

/**
 * The exclusion list may only shrink. Raising this means accepting more
 * unchecked test files - the exact thing I10 set out to end - so it should be a
 * deliberate, argued edit rather than a side effect of adding one more file.
 */
const MAX_EXCLUDED_TEST_FILES = 37;

/** tsconfig.json is JSONC, so TypeScript's own parser is the one that reads it. */
const ts = createRequire(join(ROOT, "package.json"))("typescript") as typeof import("typescript");

interface TestsTsconfig {
  include?: string[];
  exclude?: string[];
  compilerOptions?: Record<string, unknown>;
}

function readTestsTsconfig(): TestsTsconfig {
  const parsed = ts.parseConfigFileTextToJson(TESTS_TSCONFIG, readFileSync(TESTS_TSCONFIG, "utf8"));
  expect(parsed.error, "tsconfig.tests.json is not parseable").toBeUndefined();
  return parsed.config as TestsTsconfig;
}

/** Every *.test.ts in the working tree, repo-relative with forward slashes. */
function testFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.test.ts"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("node_modules/"));
}

const config = readTestsTsconfig();
const excluded = (config.exclude ?? []).filter((entry) => entry.endsWith(".test.ts"));
const excludedSet = new Set(excluded);

/** Covered by tsconfig.tools.json instead - the vitest setup and these guards. */
function coveredByToolsProject(relativePath: string): boolean {
  return relativePath.startsWith("test/");
}

function coveredByTestsProject(relativePath: string): boolean {
  return (
    (relativePath.startsWith("packages/") || relativePath.startsWith("apps/")) && !excludedSet.has(relativePath)
  );
}

describe("I10: every test file is typechecked by something", () => {
  it("still covers packages/** and apps/**, at production strictness", () => {
    expect(config.include).toEqual(["packages/**/*.test.ts", "apps/**/*.test.ts"]);
    // `allowJs` is a module-graph switch and is expected. A local `strict:
    // false` or a dropped noUncheckedIndexedAccess would silently narrow what
    // "green" means for the layer that asserts this repo's contracts.
    expect(config.compilerOptions?.strict, "tsconfig.tests.json must not relax strictness locally").toBeUndefined();
    expect(config.compilerOptions?.noUncheckedIndexedAccess).toBeUndefined();
    expect(config.compilerOptions?.exactOptionalPropertyTypes).toBeUndefined();
    expect(config.compilerOptions?.checkJs).toBe(false);
    expect(config.compilerOptions?.noEmit).toBe(true);
  });

  it("is wired into the gate: `pnpm typecheck` runs the tests project", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.typecheck ?? "").toContain("tsc -p tsconfig.tests.json");
  });

  it("excludes only files that still exist (a rename must not shrink the check silently)", () => {
    const gone = excluded.filter((relativePath) => !existsSync(join(ROOT, relativePath)));
    expect(gone, "these paths are excluded from typechecking but no longer exist").toEqual([]);
  });

  it("keeps the pre-existing backlog a ratchet: the exclusion list may only shrink", () => {
    expect(
      excluded.length,
      `the typecheck exclusion list grew to ${excluded.length}; every file added to it is a test asserting ` +
        `contracts that nothing verifies. Fix the file instead, or raise the ceiling deliberately.`
    ).toBeLessThanOrEqual(MAX_EXCLUDED_TEST_FILES);
  });

  it("leaves no test file outside both the covered set and the declared backlog", () => {
    const all = testFiles();
    // Sanity floor: if `git ls-files` ever stops returning the suite, every
    // assertion here goes vacuous.
    expect(all.length, "no test files found - this guard went vacuous").toBeGreaterThan(100);

    const orphans = all.filter(
      (relativePath) =>
        !coveredByTestsProject(relativePath) &&
        !coveredByToolsProject(relativePath) &&
        !excludedSet.has(relativePath)
    );
    expect(orphans, "these test files match no tsconfig include glob, so nothing typechecks them").toEqual([]);
  });

  it("reports the split honestly: covered + backlog accounts for every test file", () => {
    const all = testFiles();
    const covered = all.filter((path) => coveredByTestsProject(path) || coveredByToolsProject(path));
    const backlog = all.filter((path) => excludedSet.has(path));
    expect(covered.length + backlog.length).toBe(all.length);
    // The claim this file's header makes, kept measurable rather than prose.
    expect(backlog.length).toBe(excluded.length);
    expect(covered.length).toBeGreaterThanOrEqual(all.length - MAX_EXCLUDED_TEST_FILES);
  });
});
