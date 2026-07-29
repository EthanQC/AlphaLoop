// The deploy ledger is what carries "a step of this deploy failed" forward in
// time to the acceptance gate. Round 7 found the ledger could fail to record
// anything at all and nobody - not the writer, not the gate - would say so, so
// these cases are about the ledger's OWN failure modes as much as about the
// receipts it holds.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  deployLedgerPath,
  judgeDeployLedger,
  lastSuccessfulInstallAt,
  probeDeployLedgerWritable,
  readDeployLedger,
  readDeployLedgerResult,
  recordDeployStep
} from "./deploy-ledger.mjs";

const ledgerScript = fileURLToPath(new URL("./deploy-ledger.mjs", import.meta.url));
const tempDirs: string[] = [];

function makeRuntimeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-ledger-"));
  tempDirs.push(dir);
  return join(dir, "runtime");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    const ledger = deployLedgerPath(join(dir, "runtime"));
    if (existsSync(ledger)) {
      chmodSync(ledger, 0o644);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function recordViaCli(runtimeRoot: string, step: number, exitCode: number): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [
      ledgerScript, "record",
      "--runtime-root", runtimeRoot,
      "--attempt", "cli-test",
      "--step", String(step),
      "--exit", String(exitCode)
    ], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    if (typeof failure.status !== "number") {
      throw error;
    }
    return { status: failure.status, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("K1: an unwritable ledger is a fact about this machine, not a blank", () => {
  it("reports the write failure instead of throwing, and the CLI exits 3", () => {
    const runtimeRoot = makeRuntimeRoot();
    expect(recordViaCli(runtimeRoot, 3, 0).status).toBe(0);

    const path = deployLedgerPath(runtimeRoot);
    chmodSync(path, 0o444);

    const result = recordDeployStep({ runtimeRoot, attempt: "a2", step: 3, exitCode: 1 });
    expect(result.written).toBe(false);
    expect(result.error).toMatch(/EACCES|permission denied/iu);

    const cli = recordViaCli(runtimeRoot, 3, 1);
    // 3, not 1 and not 0: "the ledger is broken" is neither "the step failed"
    // nor "recorded fine". A shell caller has to be able to tell them apart
    // without parsing prose.
    expect(cli.status).toBe(3);
    expect(cli.output).toMatch(/could not write/u);

    // And the previous, successful receipt is still all that is on disk -
    // which is exactly why exiting 0 here used to be indistinguishable from
    // recording a failure.
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readDeployLedger(runtimeRoot)).toHaveLength(1);
  });

  it("answers whether an append could land, without writing anything to find out", () => {
    const runtimeRoot = makeRuntimeRoot();

    // Nothing under the runtime root exists yet, but its parent does and is
    // writable - so an append COULD land here, and that is the honest answer.
    expect(probeDeployLedgerWritable(runtimeRoot).writable).toBe(true);
    // Nothing in the chain exists at all: unknown, and the doctor says nothing
    // rather than inventing a verdict about a path that is not there.
    expect(probeDeployLedgerWritable(join(runtimeRoot, "no", "such", "tree")).writable).toBeNull();

    recordDeployStep({ runtimeRoot, attempt: "a1", step: 0, exitCode: 0 });
    const before = readFileSync(deployLedgerPath(runtimeRoot), "utf8");
    expect(probeDeployLedgerWritable(runtimeRoot)).toMatchObject({ writable: true });
    // The probe is a read: the file is byte-for-byte what it was.
    expect(readFileSync(deployLedgerPath(runtimeRoot), "utf8")).toBe(before);

    chmodSync(deployLedgerPath(runtimeRoot), 0o444);
    const verdict = probeDeployLedgerWritable(runtimeRoot);
    expect(verdict.writable).toBe(false);
    expect(verdict.checked).toBe(deployLedgerPath(runtimeRoot));

    // A directory nobody can write to is caught the same way, before any file
    // exists in it.
    const otherRoot = makeRuntimeRoot();
    mkdirSync(join(otherRoot, "deploy"), { recursive: true });
    chmodSync(join(otherRoot, "deploy"), 0o555);
    try {
      expect(probeDeployLedgerWritable(otherRoot).writable).toBe(false);
    } finally {
      chmodSync(join(otherRoot, "deploy"), 0o755);
    }
  });
});

describe("judging receipts per step", () => {
  const receipt = (step: number, extra: Record<string, unknown> = {}) => ({
    attempt: "a1",
    step,
    key: `step-${step}`,
    exitCode: 0,
    head: "cafe123",
    finishedAt: "2026-07-29T01:00:00.000Z",
    ...extra
  });
  const allEight = [0, 1, 2, 3, 4, 5, 6, 7].map((step) => receipt(step));

  it("calls a non-zero receipt a failure and a newer success a repair", () => {
    const failed = judgeDeployLedger([...allEight, receipt(3, { exitCode: 1, attempt: "a2" })], { head: "cafe123" });
    expect(failed.failedSteps.map((step) => step.step)).toEqual([3]);

    const repaired = judgeDeployLedger(
      [...allEight, receipt(3, { exitCode: 1, attempt: "a2" }), receipt(3, { attempt: "a3" })],
      { head: "cafe123" }
    );
    expect(repaired.failedSteps).toEqual([]);
  });

  // K2. A receipt from another commit is the machine saying "the last time this
  // step ran, it ran on different code" - dist and every daemon are still that
  // code. The doctor turns this into an error; see its own suite.
  it("separates a receipt recorded on another commit from one that is simply absent", () => {
    const verdict = judgeDeployLedger([...allEight.slice(0, 7), receipt(7, { head: "beef456" })], { head: "cafe123" });
    expect(verdict.staleSteps.map((step) => step.step)).toEqual([7]);
    expect(verdict.missingSteps).toEqual([]);

    const missing = judgeDeployLedger(allEight.slice(0, 7), { head: "cafe123" });
    expect(missing.missingSteps.map((step) => step.step)).toEqual([7]);
    expect(missing.staleSteps).toEqual([]);
  });

  it("treats a machine with no receipts at all as not-deployed rather than failed", () => {
    expect(judgeDeployLedger([], { head: "cafe123" })).toMatchObject({ deployed: false, failedSteps: [] });
  });
});

describe("K6: when the resident daemons' restart counters were last reset", () => {
  it("uses the newest SUCCESSFUL step-3 receipt, and nothing else", () => {
    expect(lastSuccessfulInstallAt([])).toBeNull();
    // Step 3 is the only step that boots every system label out and back in.
    expect(lastSuccessfulInstallAt([
      { step: 1, exitCode: 0, finishedAt: "2026-07-29T01:00:00.000Z" }
    ])).toBeNull();
    // A FAILED install did not reset anything.
    expect(lastSuccessfulInstallAt([
      { step: 3, exitCode: 1, finishedAt: "2026-07-29T01:00:00.000Z" }
    ])).toBeNull();
    expect(lastSuccessfulInstallAt([
      { step: 3, exitCode: 0, finishedAt: "2026-07-28T01:00:00.000Z" },
      { step: 3, exitCode: 0, finishedAt: "2026-07-29T01:00:00.000Z" }
    ])).toBe("2026-07-29T01:00:00.000Z");
  });
});

describe("reading a ledger nobody can be sure is well-formed", () => {
  it("drops malformed lines instead of throwing inside a health check", () => {
    const runtimeRoot = makeRuntimeRoot();
    mkdirSync(join(runtimeRoot, "deploy"), { recursive: true });
    writeFileSync(
      deployLedgerPath(runtimeRoot),
      `${JSON.stringify({ attempt: "a", step: 0, exitCode: 0 })}\nnot json at all\n\n[1,2,3]\n`
    );

    expect(readDeployLedger(runtimeRoot)).toEqual([
      expect.objectContaining({ step: 0, exitCode: 0 }),
      [1, 2, 3]
    ]);
  });

  // Round-8 finding L3: `[]` used to be the answer for "no ledger here", "the
  // ledger was deleted" and "the ledger cannot be read", and only the first of
  // those is a machine that never deployed. The doctor's severity split needs
  // them apart, so the reader has to hand back which one it is.
  it("tells 'never had one' apart from 'deleted' and from 'cannot read it'", () => {
    const untouched = makeRuntimeRoot();
    expect(readDeployLedgerResult(untouched)).toMatchObject({
      entries: [], fileExists: false, dirExists: false, readable: null
    });

    const deleted = makeRuntimeRoot();
    recordDeployStep({ runtimeRoot: deleted, attempt: "a", step: 0, exitCode: 0 });
    rmSync(deployLedgerPath(deleted));
    expect(readDeployLedgerResult(deleted)).toMatchObject({
      entries: [], fileExists: false, dirExists: true, readable: null
    });

    const unreadable = makeRuntimeRoot();
    recordDeployStep({ runtimeRoot: unreadable, attempt: "a", step: 3, exitCode: 1 });
    chmodSync(deployLedgerPath(unreadable), 0o222);
    const result = readDeployLedgerResult(unreadable);
    expect(result).toMatchObject({ entries: [], fileExists: true, readable: false });
    expect(result.error).toMatch(/EACCES/u);
  });
});
