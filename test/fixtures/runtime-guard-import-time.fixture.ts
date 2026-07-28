/**
 * J1's end-to-end evidence, driven by test/runtime-write-guard.test.ts.
 *
 * NOT named `*.test.ts` on purpose: the real suite must never collect it, since
 * its whole job is to commit a violation. The parent test runs it in a child
 * vitest against test/fixtures/runtime-guard-import-time.config.ts with
 * ALPHALOOP_RUNTIME_GUARD_ROOT pointing at a temp directory, so proving that
 * "writing into the guarded runtime root fails the run" never has to write into
 * the real runtime/.
 *
 * The write is at module scope, i.e. during COLLECTION, which is the window
 * that separates this fixture from runtime-guard-violation.fixture.ts:
 *   - the per-test guard (test/runtime-write-guard.ts) takes its baseline in a
 *     `beforeEach`, which first runs AFTER this file has been imported, so it
 *     sees nothing and the test below passes;
 *   - only the whole-run backstop in test/global-setup.ts can catch it.
 * That is exactly the shape of the five production .mjs modules that
 * `mkdirSync(runtimeRoot)` at import time.
 *
 * Before J1 this fixture produced `Test Files 1 passed / Tests 1 passed`, the
 * teardown's message, `error during close`, and exit status 0.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

const GUARDED_ROOT = process.env.ALPHALOOP_RUNTIME_GUARD_ROOT;

if (!GUARDED_ROOT) {
  throw new Error("the import-time probe must run against a temp guarded root");
}

// IMPORT TIME. No test has started; no beforeEach has run.
writeFileSync(join(GUARDED_ROOT, "import-time.json"), JSON.stringify({ calls: [1] }), "utf8");

it("PASSES: the per-test guard is blind to an import-time write", () => {
  // This genuinely passes, and must. The run has to go red anyway.
  expect(true).toBe(true);
});
