import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config.js";
import { failRunFromTeardown } from "./global-setup.js";
import {
  RUNTIME_GUARD_ROOT,
  describeRuntimeChanges,
  diffRuntimeEntries,
  hasRuntimeChanges,
  snapshotRuntimeEntries
} from "./runtime-root-snapshot.js";

/**
 * H1's own guard.
 *
 * test/runtime-root-snapshot.ts explains WHY the repo's real `runtime/` must be
 * untouchable from a test (running _longbridge.test.ts alone rewrote the live
 * Longbridge rate-limit ledger). This file keeps that mechanism from decaying in
 * the ways it can:
 *
 *  1. the guard being pointed somewhere harmless, so it watches a directory
 *     nothing writes to and passes forever;
 *  2. the `setupFiles` wiring being dropped from one of the two vitest projects
 *     - they are per-project in Vitest 4, so a missing line is a whole lane with
 *     no guard;
 *  3. the whole-run backstop in test/global-setup.ts losing its teardown;
 *  4. the detection logic quietly going blind.
 *
 * (4) is checked twice: directly, against real writes into a temp directory,
 * and end-to-end, by running a child vitest over a fixture whose test writes
 * into the guarded root and asserting the run FAILS with the guard's message.
 * The end-to-end case is the one that would notice if vitest ever stopped
 * applying these hooks at all.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const VITEST_BIN = join(dirname(createRequire(join(ROOT, "package.json")).resolve("vitest/package.json")), "vitest.mjs");

const scratch: string[] = [];

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/gu, "");
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("H1: the guard watches the real runtime directory", () => {
  it("resolves to <repo>/runtime in a normal run, not a temp stand-in", () => {
    // Without this the whole mechanism could be satisfied by watching an empty
    // directory nobody writes to. ALPHALOOP_RUNTIME_GUARD_ROOT is set only by
    // this file's own child-process probe.
    expect(RUNTIME_GUARD_ROOT).toBe(join(ROOT, "runtime"));
    expect(process.env.ALPHALOOP_RUNTIME_GUARD_ROOT).toBeUndefined();
  });

  it("is wired as a setup file on EVERY vitest project", () => {
    interface ProjectEntry {
      test?: { name?: string; setupFiles?: string[] };
    }
    const projects = (vitestConfig.test?.projects ?? []) as ProjectEntry[];
    expect(projects.length).toBeGreaterThanOrEqual(2);
    for (const project of projects) {
      expect(
        project.test?.setupFiles ?? [],
        `vitest project "${project.test?.name ?? "?"}" does not load the runtime-write guard, so every ` +
          `test in it may write into the real runtime/ unnoticed`
      ).toContain("./test/runtime-write-guard.ts");
    }
  });

  it("keeps the whole-run backstop: global setup returns a teardown", async () => {
    // The per-test hooks cannot see a write that happens while a test file is
    // being imported, nor one landing after the last test. That is what the
    // teardown returned by global-setup covers.
    const { default: setup, BUILD_STAMP_ENV } = await import("./global-setup.js");
    // Running the setup a second time re-stamps BUILD_STAMP_ENV in this worker,
    // and vitest reuses a worker process across test files - leaving that stamp
    // behind would let test/build-freshness.test.ts pass in a run where the
    // globalSetup wiring had been deleted. Put it back exactly as found.
    const stamp = process.env[BUILD_STAMP_ENV];
    try {
      const teardown = await setup();
      expect(typeof teardown, "test/global-setup.ts no longer returns a teardown").toBe("function");
      // It must be silent when nothing moved - a backstop that always throws
      // would be removed within a day.
      expect(() => teardown()).not.toThrow();
    } finally {
      if (stamp === undefined) {
        delete process.env[BUILD_STAMP_ENV];
      } else {
        process.env[BUILD_STAMP_ENV] = stamp;
      }
    }
  });
});

describe("H1: the detector notices every kind of change", () => {
  it("reports a created file, a modified file, a deleted file and a new subdirectory", () => {
    const root = tempDir("runtime-guard-unit-");
    writeFileSync(join(root, "kept.json"), "kept", "utf8");
    writeFileSync(join(root, "doomed.json"), "doomed", "utf8");
    const before = snapshotRuntimeEntries(root);

    writeFileSync(join(root, "created.json"), "new", "utf8");
    writeFileSync(join(root, "kept.json"), "rewritten to a different length", "utf8");
    rmSync(join(root, "doomed.json"));
    mkdirSync(join(root, "nested", "deeper"), { recursive: true });
    writeFileSync(join(root, "nested", "deeper", "leaf.json"), "leaf", "utf8");

    const changes = diffRuntimeEntries(before, snapshotRuntimeEntries(root));
    expect(hasRuntimeChanges(changes)).toBe(true);
    expect(changes.created).toEqual(["created.json", "nested", "nested/deeper", "nested/deeper/leaf.json"]);
    expect(changes.modified).toEqual(["kept.json"]);
    expect(changes.deleted).toEqual(["doomed.json"]);
  });

  it("notices a rewrite that keeps the byte length identical", () => {
    // The real case: longbridge-rate-limit-quote.json is `{"calls":[<13-digit
    // epoch ms>]}` before and after, same length every time.
    const root = tempDir("runtime-guard-samelen-");
    const ledger = join(root, "longbridge-rate-limit-quote.json");
    writeFileSync(ledger, JSON.stringify({ calls: [1785249613271] }), "utf8");
    const before = snapshotRuntimeEntries(root);
    writeFileSync(ledger, JSON.stringify({ calls: [1785253650611] }), "utf8");

    const changes = diffRuntimeEntries(before, snapshotRuntimeEntries(root));
    expect(changes.modified).toEqual(["longbridge-rate-limit-quote.json"]);
  });

  it("stays silent when nothing under the root moved", () => {
    const root = tempDir("runtime-guard-quiet-");
    writeFileSync(join(root, "state.json"), "state", "utf8");
    const before = snapshotRuntimeEntries(root);
    // A write anywhere else must not register.
    writeFileSync(join(tempDir("runtime-guard-elsewhere-"), "state.json"), "state", "utf8");
    expect(hasRuntimeChanges(diffRuntimeEntries(before, snapshotRuntimeEntries(root)))).toBe(false);
  });

  it("treats an absent root as empty, so a fresh clone is not a violation", () => {
    const missing = join(tempDir("runtime-guard-absent-"), "runtime");
    const before = snapshotRuntimeEntries(missing);
    expect(before.size).toBe(0);
    // What the five production .mjs modules do at import time.
    mkdirSync(missing, { recursive: true });
    expect(hasRuntimeChanges(diffRuntimeEntries(before, snapshotRuntimeEntries(missing)))).toBe(false);
  });

  it("names the ledger and the way out in its failure message", () => {
    const message = describeRuntimeChanges(
      { created: [], modified: ["longbridge-rate-limit-quote.json"], deleted: [] },
      "the test \"x\""
    );
    expect(message).toContain("longbridge-rate-limit-quote.json");
    expect(message).toContain("rateLimitDir");
  });
});

describe("J1: a detected violation fails the RUN, not just the log", () => {
  /**
   * The round-6 finding: the whole-run backstop DETECTED an import-time write,
   * threw, and the process still exited 0. Measured on this exact fixture,
   * 2026-07-29, by swapping `failRunFromTeardown(...)` back to `throw new
   * Error(...)` in test/global-setup.ts:
   *
   *   Test Files  1 passed (1)
   *   error during close Error: this test run wrote into the repository's ...
   *   $? = 0
   *
   * With the fix in place the same fixture exits 1. That difference is the only
   * thing standing between a stray test and the deploy machine's live
   * Longbridge rate-limit ledger, so it gets a test rather than a comment.
   */
  it("goes red when the write happens at IMPORT time, which only the backstop can see", { timeout: 120_000 }, () => {
    const guardedRoot = tempDir("runtime-guard-import-");
    const result = spawnSync(
      process.execPath,
      [VITEST_BIN, "run", "--config", "test/fixtures/runtime-guard-import-time.config.ts"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, ALPHALOOP_RUNTIME_GUARD_ROOT: guardedRoot, CI: "true" }
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const plainOutput = stripAnsi(output);
    expect(
      result.status,
      `the run must FAIL. Vitest 4.1.7 logs a globalSetup teardown throw as "error during close" and ` +
        `exits 0, so test/global-setup.ts forces the code itself; if that stopped working the guard is ` +
        `decorative again. Output:\n${output}`
    ).not.toBe(0);
    expect(output).toContain("RUN FAILED: RUNTIME WRITE GUARD");
    expect(output).toContain("wrote into the repository's real runtime directory");
    expect(output).toContain("created: import-time.json");
    // The test itself passes: that is what makes this window invisible to the
    // per-test guard, and why a green summary must not mean a green run.
    expect(plainOutput).toMatch(/Tests\s+1 passed/u);
  });

  it("still goes red when the refusal comes from the SETUP phase", { timeout: 120_000 }, () => {
    // The four build-freshness refusals in test/global-setup.ts are plain
    // throws, on the measured basis that vitest honors a setup-phase throw.
    // This pins that assumption instead of trusting it, which is the mistake
    // the teardown half made.
    const result = spawnSync(
      process.execPath,
      [VITEST_BIN, "run", "--config", "test/fixtures/global-setup-throw.config.ts"],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "true" } }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(
      result.status,
      `a globalSetup that throws during SETUP must fail the run - test/global-setup.ts leaves its four ` +
        `stale-build refusals as bare throws on exactly this basis. Output:\n${output}`
    ).not.toBe(0);
    expect(output).toContain("SETUP PHASE REFUSED THE RUN");
  });

  it("forces a non-zero exit code even if nothing re-reads the throw", () => {
    // Unit-level, in-process: the exported helper must set process.exitCode
    // BEFORE it throws, since the throw is the half vitest discards.
    const previous = process.exitCode;
    // Only the listeners THIS call adds get removed again - blowing away every
    // "exit" listener would take vitest's own worker teardown with it.
    const listenersBefore = new Set(process.listeners("exit"));
    // Captured rather than let through: a RUN FAILED banner printed during a
    // green run is how a banner stops being read.
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.exitCode = 0;
      expect(() => failRunFromTeardown("injected violation")).toThrow(/injected violation/u);
      expect(process.exitCode).toBe(1);
      // The banner is the half vitest cannot discard, so it carries the message.
      const banner = written.join("");
      expect(banner).toContain("RUN FAILED: RUNTIME WRITE GUARD");
      expect(banner).toContain("injected violation");
    } finally {
      process.stderr.write = realWrite;
      process.exitCode = previous;
      for (const listener of process.listeners("exit")) {
        if (!listenersBefore.has(listener)) {
          process.removeListener("exit", listener);
        }
      }
    }
  });
});

describe("H1: a test that writes into the guarded root actually fails", () => {
  it("fails the offending test, and only that one, in a real child vitest run", { timeout: 60_000 }, () => {
    const guardedRoot = tempDir("runtime-guard-probe-");
    const result = spawnSync(
      process.execPath,
      [VITEST_BIN, "run", "--config", "test/fixtures/runtime-guard-probe.config.ts"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, ALPHALOOP_RUNTIME_GUARD_ROOT: guardedRoot, CI: "true" }
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const plainOutput = stripAnsi(output);

    expect(result.status, `child vitest should have failed. Output:\n${output}`).not.toBe(0);
    expect(output).toContain("wrote into the repository's real runtime directory");
    expect(output).toContain("created: ledger.json");
    expect(output).toContain("VIOLATION: writes a state file into the guarded runtime root");
    // The innocent case in the same file still passes: the guard is not just
    // failing everything it sees.
    expect(plainOutput).toMatch(/1 failed \| 1 passed/u);
  });
});
