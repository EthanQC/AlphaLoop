/**
 * H1's end-to-end evidence, driven by test/runtime-write-guard.test.ts.
 *
 * NOT named `*.test.ts` on purpose: the real suite must never collect it, since
 * one of its two cases is required to fail. The parent test runs it in a child
 * vitest against test/fixtures/runtime-guard-probe.config.ts, with
 * ALPHALOOP_RUNTIME_GUARD_ROOT pointing at a temp directory - so the proof that
 * "a test writing into the guarded runtime root fails" never has to write into
 * the real runtime/ to demonstrate itself.
 *
 * The two cases together are the claim: the guard fires on the guarded root,
 * and stays silent for a test that writes anywhere else.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

const GUARDED_ROOT = process.env.ALPHALOOP_RUNTIME_GUARD_ROOT;

it("VIOLATION: writes a state file into the guarded runtime root", () => {
  expect(GUARDED_ROOT, "the probe must run against a temp guarded root").toBeTruthy();
  writeFileSync(join(GUARDED_ROOT as string, "ledger.json"), JSON.stringify({ calls: [1] }), "utf8");
  // This assertion passes. The failure must come from the guard's afterEach,
  // which is the whole point - the test body itself has no idea it did anything
  // wrong, exactly like the five _longbridge call sites did not.
  expect(true).toBe(true);
});

it("INNOCENT: writes the same file into a temp dir of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-guard-innocent-"));
  writeFileSync(join(dir, "ledger.json"), JSON.stringify({ calls: [1] }), "utf8");
  expect(true).toBe(true);
});
