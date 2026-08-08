import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const doctor = await import("./openclaw-runtime-doctor-core.mjs");

/**
 * Doctor findings that could fire on the deploy machine and that no test in the
 * tree named, found by test/claim-guard.test.ts once its own list stopped
 * vouching for itself (2026-07-29). Each `it` below removes one entry from
 * FINDING_CODES_WITHOUT_TESTS; what is left there is listed with its reason.
 *
 * A separate file rather than more cases in openclaw-runtime-doctor-core.test.ts
 * on purpose: that file and the doctor itself are being edited by another agent
 * this round, and these cases are about branches nobody is touching.
 *
 * The snapshot handed to `analyzeOpenClawRuntimeSnapshot` here is deliberately
 * NOT an otherwise-healthy machine - every other check is free to complain. The
 * claim under test is "this specific finding fires with this specific code and
 * severity", so the assertions are on the finding, never on `report.ok`.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type Finding = { code: string; severity: string; message: string };

function findingFor(report: { findings: Finding[] }, code: string): Finding {
  const found = report.findings.find((entry) => entry.code === code);
  if (!found) {
    throw new Error(`no ${code} finding; got: ${report.findings.map((entry) => entry.code).join(", ")}`);
  }
  return found;
}

describe("doctor: two processes on one port", () => {
  // A legacy/manual `openclaw gateway install` can still create the user-level
  // ai.openclaw.gateway next to the system daemon. The standard deploy no
  // longer does so, but the doctor must still notice this unsafe state.
  it("reports gateway.duplicate_listener when 18789 has more than one listening pid", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [
        { pid: 100, command: "node", endpoint: "127.0.0.1:18789" },
        { pid: 101, command: "node", endpoint: "[::1]:18789" }
      ],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }]
    });

    const finding = findingFor(report, "gateway.duplicate_listener");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("100");
    expect(finding.message).toContain("101");
    expect(report.ok).toBe(false);
  });

  it("counts pids, not rows - one process bound to both loopback families is not a duplicate", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [
        { pid: 100, command: "node", endpoint: "127.0.0.1:18789" },
        { pid: 100, command: "node", endpoint: "[::1]:18789" }
      ],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }]
    });

    expect(report.findings.some((entry) => entry.code === "gateway.duplicate_listener")).toBe(false);
  });

  it("reports runner.duplicate_listener when 18792 has more than one listening pid", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      cronRunnerListeners: [
        { pid: 200, command: "node", endpoint: "127.0.0.1:18792" },
        { pid: 201, command: "node", endpoint: "127.0.0.1:18792" }
      ]
    });

    const finding = findingFor(report, "runner.duplicate_listener");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("200");
    expect(finding.message).toContain("201");
  });
});

describe("doctor: the persona file exists but cannot be read", () => {
  // The missing and empty branches are covered next door. This is the third:
  // the path resolves to something readFileSync refuses. A directory named
  // AGENTS.md is the reproducible version (EISDIR on macOS and Linux both) of
  // what a root-owned mode-600 file left by a sudo run does on the mini.
  it("reports control-persona.unreadable rather than treating an unreadable persona as present", async () => {
    const dir = makeTempDir("alphaloop-doctor-persona-unreadable-");
    const personaPath = join(dir, "AGENTS.md");
    mkdirSync(personaPath);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
      controlWorkspaceAgentsPath: personaPath
    });

    const finding = findingFor(report, "control-persona.unreadable");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain(personaPath);
    // Not the missing/empty branches - an unreadable file is a different fact
    // from an absent one, and the remedy differs (permissions, not re-render).
    expect(report.findings.some((entry) => entry.code === "control-persona.missing")).toBe(false);
    expect(report.findings.some((entry) => entry.code === "control-persona.empty")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stock-analysis-health (2026-07-30). The finding an operator did NOT get: on
// 2026-07-30 the mini's /stock/TSM.US served the 2026-07-27 batch's support
// level and no probe anywhere said the batch was three days old, because the
// job was skipping (exit 0), not failing. This check reads the delivered
// archive instead of exit codes.
// ---------------------------------------------------------------------------
const { MemberRepository, openTradingDatabase } = await import("../../../packages/shared-types/dist/index.js");
const stockAnalysis = await import("./stock-analysis.mjs");
const resolveReportPaths = stockAnalysis.resolveReportPaths as (
  dir: string,
  label: string,
  deliver: boolean
) => { markdownPath: string };

describe("doctor: 个股分析 stopped producing without ever failing", () => {
  /** Seeds an active member + a watchlist through the REAL writer
   * (`runTargetsCommand`, the only supported way a symbol enters
   * stock_analysis_targets), so the check's "is anyone watching anything" gate
   * is exercised against real rows rather than hand-inserted ones. */
  function seedWatchedPool(dbPath: string): void {
    const db = openTradingDatabase(dbPath);
    new MemberRepository(db).upsert({
      id: "member_1",
      email: "member_1@example.com",
      displayName: "member_1",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z"
    });
    db.close();
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "TSM"], { dbPath });
  }

  /** Archives a delivered batch exactly as runAnalysis does: created_at is the
   * batch's generatedAt, markdown_path is resolveReportPaths' own output. */
  function archiveBatch(dbPath: string, generatedAt: string): void {
    const label = generatedAt.slice(0, 10);
    const paths = resolveReportPaths(join(dbPath, "..", "reports"), label, true);
    const db = openTradingDatabase(dbPath);
    db.prepare(`
      INSERT INTO stock_analysis_runs (id, created_at, symbols, markdown_path, delivery)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `stock_analysis_run_${label}`,
      generatedAt,
      JSON.stringify(["TSM.US"]),
      paths.markdownPath,
      JSON.stringify({ sent: true })
    );
    db.close();
  }

  function snapshotWith(dbPath: string, nowIso: string) {
    return {
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
      nowMs: Date.parse(nowIso),
      dbPath
    };
  }

  it("reports stock-analysis-health.stale, naming the batch on display and its age", async () => {
    const dir = makeTempDir("alphaloop-doctor-stock-analysis-");
    const dbPath = join(dir, "trading.sqlite");
    seedWatchedPool(dbPath);
    // The live values: the mini's newest delivered batch was 2026-07-27,
    // archived at markdown_path .../2026-07-27.md.
    archiveBatch(dbPath, "2026-07-27T16:35:02.483Z");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, "2026-07-31T13:00:00.000Z"));

    const finding = findingFor(report, "stock-analysis-health.stale");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("2026-07-27");
    expect(finding.message).toContain("已过去 4 天");
    expect(finding.message).toContain("不可当作当前价位使用");
  });

  it("stays quiet while the batch is only as old as the cadence allows", async () => {
    const dir = makeTempDir("alphaloop-doctor-stock-analysis-");
    const dbPath = join(dir, "trading.sqlite");
    seedWatchedPool(dbPath);
    archiveBatch(dbPath, "2026-07-27T16:35:02.483Z");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, "2026-07-30T13:00:00.000Z"));

    expect(report.findings.some((entry) => entry.code.startsWith("stock-analysis-health."))).toBe(false);
  });

  it("accepts five minutes of clock skew but rejects a farther-future delivered batch timestamp", async () => {
    const nowIso = "2026-07-30T13:00:00.000Z";
    const nowMs = Date.parse(nowIso);
    const withinDbPath = join(makeTempDir("alphaloop-doctor-stock-analysis-"), "trading.sqlite");
    seedWatchedPool(withinDbPath);
    archiveBatch(withinDbPath, new Date(nowMs + 4 * 60_000).toISOString());

    const withinReport = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(withinDbPath, nowIso));
    expect(withinReport.findings.some((entry) => entry.code.startsWith("stock-analysis-health."))).toBe(false);

    const futureDbPath = join(makeTempDir("alphaloop-doctor-stock-analysis-"), "trading.sqlite");
    seedWatchedPool(futureDbPath);
    archiveBatch(futureDbPath, new Date(nowMs + 6 * 60_000).toISOString());

    const futureReport = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(futureDbPath, nowIso));
    const finding = findingFor(futureReport, "stock-analysis-health.stale");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("5 分钟时钟偏差");
  });

  it("reports stock-analysis-health.never_ran when a watched pool has produced nothing at all", async () => {
    const dir = makeTempDir("alphaloop-doctor-stock-analysis-");
    const dbPath = join(dir, "trading.sqlite");
    seedWatchedPool(dbPath);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, "2026-07-30T13:00:00.000Z"));

    const finding = findingFor(report, "stock-analysis-health.never_ran");
    expect(finding.severity).toBe("warn");
    expect(finding.message).toContain("从未产出过个股分析批次");
    expect(finding.message).toContain("1 只在用标的");
  });

  it("says nothing about an empty watchlist - no batch is the correct state there", async () => {
    const dir = makeTempDir("alphaloop-doctor-stock-analysis-");
    const dbPath = join(dir, "trading.sqlite");
    openTradingDatabase(dbPath).close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, "2026-07-30T13:00:00.000Z"));

    expect(report.findings.some((entry) => entry.code.startsWith("stock-analysis-health."))).toBe(false);
  });
});
