import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error - .mjs sibling with no declaration file, like every other
// script in this directory (see the module's own header for why this directory
// is not compiled).
import { checkRepositoryWrites, defaultRoots } from "./check-repository-writes.mjs";

/**
 * G3 (2026-07-28): apps/openclaw-config had no package.json and no tsconfig, so
 * `pnpm typecheck` had never looked at any of its ~74 .mjs scripts - including
 * the one that shipped `reports.save(...)` with no ownerId. This drives the
 * static guard that now covers that boundary, and - the part that matters -
 * proves the guard is not vacuous by REPRODUCING THAT EXACT DEFECT against the
 * current type and watching the guard catch it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RECONCILE = join(HERE, "reconcile-official-paper-orders.mjs");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Copies a script out of this directory with `edit` applied, rewriting every
 * relative specifier (both `from "./x.mjs"` and JSDoc `import("../…")`) to an
 * absolute path so the copy resolves exactly what the original resolved.
 */
function mutantOf(original: string, edit: (source: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-write-check-"));
  tempDirs.push(dir);
  const rewritten = edit(readFileSync(original, "utf8")).replace(
    /(from\s+"|import\(")(\.[^"]*)"/gu,
    (_match, prefix: string, specifier: string) => `${prefix}${resolve(dirname(original), specifier)}"`
  );
  const target = join(dir, "mutant.mjs");
  writeFileSync(target, rewritten, "utf8");
  return target;
}

describe("G3: every repository write in apps/openclaw-config carries the fields its type requires", () => {
  const real = checkRepositoryWrites();

  it("finds no write site omitting a required field, and no write it cannot see", () => {
    expect(real.violations).toEqual([]);
  });

  it("actually looked at something - the floor that stops this going vacuous", () => {
    // 75 .mjs files, 231 calls across the typed boundary, 6 object literals with
    // a required-property list to check, on 2026-07-28. The floors are below
    // today's numbers only far enough to absorb ordinary churn; a guard that
    // silently stopped resolving the boundary would land far under them.
    expect(real.stats.files).toBeGreaterThan(60);
    expect(real.stats.boundaryCalls).toBeGreaterThan(150);
    expect(real.stats.checkedLiterals).toBeGreaterThanOrEqual(6);
    expect(defaultRoots().length).toBeGreaterThan(60);
  });

  it("names every site it cannot decide, so the blind spot is counted rather than hidden", () => {
    // Object literals containing a spread: what the spread contributes is not
    // known here. Listed exactly, so a NEW undecidable site is a visible change
    // to this file rather than a quiet reduction in coverage.
    expect(real.unverifiable.map((entry: string) => entry.split(":").slice(0, 2).join(":"))).toEqual([
      "apps/openclaw-config/scripts/members.mjs:198",
      "apps/openclaw-config/scripts/proposals.mjs:326"
    ]);
  });

  it("catches the historic defect: reconcile's execution report written with no ownerId", () => {
    // 73177f0's own words - "a forgotten stamp is a compile error rather than a
    // silent orphan" - were true for broker-executor and false for this file,
    // which no compiler ever read. Delete the stamp again and see.
    const mutant = mutantOf(RECONCILE, (source) => {
      const stripped = source.replace(/^\s*ownerId: proposal\.ownerId,\n/mu, "");
      expect(stripped, "the ownerId stamp this test removes is no longer where it was").not.toBe(source);
      return stripped;
    });

    const { violations } = checkRepositoryWrites([mutant]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/reports\.save/u);
    expect(violations[0]).toMatch(/missing required `ownerId`/u);
  });

  it("catches a repository write the checker cannot type at all instead of skipping it", () => {
    // Drop the JSDoc @param that makes `reports` a repository inside
    // reconcileStuckFailedProposal - the state this file was in until G3. The
    // write becomes invisible to the type system, and that is itself the defect.
    const mutant = mutantOf(RECONCILE, (source) => {
      const stripped = source.replace(/^\s*\* @param \{import\([^)]*\)\.ExecutionReportRepository\} reports\n/mu, "");
      expect(stripped, "the @param annotation this test removes is no longer there").not.toBe(source);
      return stripped;
    });

    const { violations } = checkRepositoryWrites([mutant]);
    expect(violations.join("\n")).toMatch(/`reports\.save` is a repository call whose receiver types as `any`/u);
  });
});
