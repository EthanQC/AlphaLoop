import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUILD_STAMP_ENV, missingArtifacts, staleProjects } from "./global-setup.js";

/**
 * G1's own guard. `test/global-setup.ts` explains WHY the suite must never run
 * against a previous build's `dist`; this file makes the mechanism un-removable
 * and proves it is not vacuous:
 *
 *  1. the setup actually ran in THIS run (a stamp it sets, read from a worker),
 *     so deleting the `globalSetup` line from vitest.config.ts fails here
 *     instead of silently restoring stale-dist testing;
 *  2. tsc still considers every project up to date AT ASSERTION TIME, not just
 *     when the setup finished;
 *  3. an independent, content-level check that does not trust tsc's
 *     .tsbuildinfo bookkeeping at all: every value the shared-types SOURCE
 *     exports is actually present on the dist module the tests import.
 *
 * (3) is the one that would have caught round 2's stale artifact: it compares
 * what src says today against what is loadable from dist right now.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_TYPES_SRC = join(HERE, "..", "packages", "shared-types", "src");

const distModule = (await import("../packages/shared-types/dist/index.js")) as Record<string, unknown>;

/** Runtime (value) exports declared at the top level of one shared-types source file. */
function sourceValueExports(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gmu)) {
    names.add(match[1] as string);
  }
  for (const match of source.matchAll(/^export\s+(?:const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gmu)) {
    names.add(match[1] as string);
  }
  // `export { a, b as c };` - but never `export type { ... }`, which emits nothing.
  for (const match of source.matchAll(/^export\s+\{([^}]*)\}\s*;/gmu)) {
    for (const raw of (match[1] as string).split(",")) {
      const trimmed = raw.trim();
      if (trimmed.length === 0 || trimmed.startsWith("type ")) {
        continue;
      }
      const exposed = trimmed.split(/\s+as\s+/u).pop()?.trim();
      if (exposed) {
        names.add(exposed);
      }
    }
  }
  return [...names];
}

describe("G1: the suite cannot run against a stale dist", () => {
  it("ran the workspace build before loading any test file", () => {
    const stamp = process.env[BUILD_STAMP_ENV];
    expect(
      stamp,
      `${BUILD_STAMP_ENV} is unset, which means test/global-setup.ts did not run. ` +
        `Every test that imports packages/shared-types/dist is now measuring whatever was built last.`
    ).toBeDefined();
    const parsed = JSON.parse(stamp ?? "{}") as { projects?: string[]; builtAt?: string };
    expect(parsed.projects).toContain("packages/shared-types/tsconfig.json");
    expect(parsed.projects).toContain("apps/platform-app/tsconfig.json");
    expect(Number.isFinite(Date.parse(parsed.builtAt ?? ""))).toBe(true);
  });

  it("still has every artifact the .mjs scripts and their tests load by path", () => {
    expect(missingArtifacts()).toEqual([]);
  });

  it("still compiles clean: no project's output lags its sources", () => {
    expect(staleProjects()).toEqual([]);
  });

  it("exposes every value shared-types' CURRENT source exports on the dist module under test", () => {
    const expected = new Set<string>();
    for (const entry of readdirSync(SHARED_TYPES_SRC)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry === "index.ts") {
        continue;
      }
      for (const name of sourceValueExports(readFileSync(join(SHARED_TYPES_SRC, entry), "utf8"))) {
        expected.add(name);
      }
    }
    // If the parser above ever stops understanding the source, it must fail
    // here rather than quietly compare an empty set against everything.
    // 50 value exports today (2026-07-28); the floor only has to be far enough
    // from zero to catch a parser that stopped matching.
    expect(expected.size, "no value exports parsed out of shared-types/src - this check went vacuous").toBeGreaterThan(40);

    const missing = [...expected].filter((name) => !(name in distModule));
    expect(
      missing,
      "these are exported by packages/shared-types/src today but absent from the dist the tests import - dist is stale"
    ).toEqual([]);
  });
});
