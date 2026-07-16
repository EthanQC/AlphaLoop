// Task H4 (phase2.5 hardening): first direct test coverage official-paper-
// monitor.mjs has ever had. Covers three things from the task brief:
//   1. snapshot writes now carry owner_id (exactly 1 active member -> that
//      member; 0 or >1 -> the '__shared__' sentinel).
//   2. audit item (a): a per-symbol quote failure is marked with an explicit
//      priceSource ('cost'|'zero') on the position and a `degraded` flag on
//      the snapshot, instead of silently folding into a cost/0 valuation
//      that looks identical to a real quote everywhere downstream.
//   3. audit item (b): the manual `snapshot` path now asserts the paper-
//      account environment, same as poll/pnl, instead of skipping it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const officialPaperMonitor = await import("./official-paper-monitor.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-official-paper-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id: string, overrides: Partial<{ status: string }> = {}): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: (overrides.status as "active" | "revoked") ?? "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

describe("resolveSnapshotOwnerId", () => {
  it("resolves to the single active member's id", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    expect(officialPaperMonitor.resolveSnapshotOwnerId(db)).toBe("member_1");
  });

  it("falls back to the shared sentinel when there are 0 active members", () => {
    const { db } = makeDb();

    expect(officialPaperMonitor.resolveSnapshotOwnerId(db)).toBe(officialPaperMonitor.SHARED_OWNER_SENTINEL);
  });

  it("falls back to the shared sentinel when there is more than 1 active member", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");

    expect(officialPaperMonitor.resolveSnapshotOwnerId(db)).toBe(officialPaperMonitor.SHARED_OWNER_SENTINEL);
  });

  it("ignores a revoked member when counting active members", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_revoked", { status: "revoked" });

    expect(officialPaperMonitor.resolveSnapshotOwnerId(db)).toBe("member_1");
  });
});

function buildSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    fetchedAt: "2026-07-01T14:00:00.000Z",
    primaryAsset: { net_assets: "1000", total_cash: "500" },
    positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 100, priceSource: "live", price: 106 }],
    quotes: [{ symbol: "NVDA.US", last: 106 }],
    ...overrides
  };
}

describe("saveSnapshot: writes owner_id", () => {
  it("writes the single active member's id as owner_id", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    const id = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "manual");

    const row = db.prepare("SELECT owner_id FROM official_paper_snapshots WHERE id = ?").get(id) as { owner_id: string };
    expect(row.owner_id).toBe("member_1");
  });

  it("writes the shared sentinel when there is no single active member", () => {
    const { db } = makeDb();

    const id = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "manual");

    const row = db.prepare("SELECT owner_id FROM official_paper_snapshots WHERE id = ?").get(id) as { owner_id: string };
    expect(row.owner_id).toBe(officialPaperMonitor.SHARED_OWNER_SENTINEL);
  });
});

describe("attachPriceSource: audit item (a) - degraded price marking", () => {
  it("marks a position with a usable quote as priceSource 'live'", () => {
    const positions = [{ symbol: "NVDA.US", quantity: 10, costPrice: 100 }];
    const quotes = [{ symbol: "NVDA.US", last: 120 }];

    const { positions: priced, degradedSymbols } = officialPaperMonitor.attachPriceSource(positions, quotes);

    expect(priced[0]).toMatchObject({ priceSource: "live", price: 120 });
    expect(degradedSymbols).toEqual([]);
  });

  it("marks a position whose quote failed but has a cost basis as priceSource 'cost'", () => {
    const positions = [{ symbol: "NVDA.US", quantity: 10, costPrice: 100 }];
    const quotes = [{ symbol: "NVDA.US", error: "timeout" }];

    const { positions: priced, degradedSymbols } = officialPaperMonitor.attachPriceSource(positions, quotes);

    expect(priced[0]).toMatchObject({ priceSource: "cost", price: 100 });
    expect(degradedSymbols).toEqual(["NVDA.US(按成本估值)"]);
  });

  it("marks a position with no quote and no cost basis as priceSource 'zero'", () => {
    const positions = [{ symbol: "NVDA.US", quantity: 10, costPrice: undefined }];
    const quotes: unknown[] = [];

    const { positions: priced, degradedSymbols } = officialPaperMonitor.attachPriceSource(positions, quotes);

    expect(priced[0]).toMatchObject({ priceSource: "zero", price: 0 });
    expect(degradedSymbols).toEqual(["NVDA.US(按0估值)"]);
  });
});

describe("estimateMarketValue", () => {
  it("uses each position's resolved price (live/cost/zero)", () => {
    const snapshot = {
      positions: [
        { symbol: "NVDA.US", quantity: 10, priceSource: "live", price: 100 },
        { symbol: "TSLA.US", quantity: 5, priceSource: "cost", price: 50 },
        { symbol: "AMD.US", quantity: 2, priceSource: "zero", price: 0 }
      ]
    };

    expect(officialPaperMonitor.estimateMarketValue(snapshot)).toBe(10 * 100 + 5 * 50 + 2 * 0);
  });

  it("falls back to costPrice for legacy positions with no .price field (pre-H4 raw snapshots)", () => {
    const snapshot = { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 90 }] };

    expect(officialPaperMonitor.estimateMarketValue(snapshot)).toBe(900);
  });
});

describe("buildStrategyReflection: discloses degradation instead of trusting the value", () => {
  it("does not mention degradation when the snapshot is not degraded", () => {
    const snapshot = buildSnapshot({ degraded: false });
    const reflection = officialPaperMonitor.buildStrategyReflection(snapshot);

    expect(reflection.degraded).toBe(false);
    expect(reflection.summary).not.toMatch(/估计值|按成本|按0/);
  });

  it("discloses the number of degraded positions in the summary when the snapshot is degraded", () => {
    const snapshot = buildSnapshot({
      degraded: true,
      positions: [
        { symbol: "NVDA.US", quantity: 10, priceSource: "cost", price: 100 },
        { symbol: "TSLA.US", quantity: 5, priceSource: "zero", price: 0 },
        { symbol: "AMD.US", quantity: 2, priceSource: "live", price: 150 }
      ]
    });

    const reflection = officialPaperMonitor.buildStrategyReflection(snapshot);

    expect(reflection.degraded).toBe(true);
    expect(reflection.summary).toMatch(/2 笔持仓/);
    expect(reflection.summary).toMatch(/估计值/);
  });
});

describe("renderPnlReport: report reading discloses per-position degradation", () => {
  it("annotates a degraded position's line in the rendered markdown", () => {
    const snapshot = buildSnapshot({
      degraded: true,
      positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 100, priceSource: "cost", price: 100 }],
      quotes: [{ symbol: "NVDA.US", error: "timeout" }]
    });

    const markdown = officialPaperMonitor.renderPnlReport(snapshot, null, null);

    expect(markdown).toMatch(/NVDA\.US[^\n]*估值降级/);
  });

  it("does not annotate a live-priced position", () => {
    const snapshot = buildSnapshot();
    const markdown = officialPaperMonitor.renderPnlReport(snapshot, null, null);

    expect(markdown).not.toMatch(/估值降级/);
  });
});

describe("runManualSnapshot: audit item (b) - environment assertion is no longer skipped", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws before ever writing a snapshot row when the paper-account environment is not asserted", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    delete process.env.LONGBRIDGE_ACCOUNT_MODE;
    delete process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED;
    delete process.env.ALLOW_LIVE_EXECUTION;

    await expect(officialPaperMonitor.runManualSnapshot(db)).rejects.toThrow(/官方模拟盘/);

    const count = db.prepare("SELECT COUNT(*) AS c FROM official_paper_snapshots").get() as { c: number };
    expect(count.c).toBe(0);
  });
});

// Phase 6 Task 6 (2026-07-15 plan): per-member polling loop. `fetchImpl` is
// the injection seam named in the task brief ("长桥抓取本身保持可注入
// (fetchImpl/execFn)...真实多账户 = P10") - every test here supplies a fixture
// function, never touching a real longbridge CLI/subprocess.
describe("pollOfficialPaperPerMember", () => {
  const credentialsRoots: string[] = [];

  function makeCredentialsRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-official-paper-creds-"));
    credentialsRoots.push(dir);
    return dir;
  }

  function seedMemberCredentials(root: string, memberId: string): void {
    const memberDir = join(root, memberId);
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, "longbridge.env"), `LONGBRIDGE_ACCESS_TOKEN=token-${memberId}\n`, "utf8");
  }

  afterEach(() => {
    while (credentialsRoots.length > 0) {
      const dir = credentialsRoots.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("returns null (H4 single-account fallback signal) when zero active members have credentials", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const root = makeCredentialsRoot(); // empty - nobody has a longbridge.env file

    const result = await officialPaperMonitor.pollOfficialPaperPerMember(db, { credentialsRootDir: root });

    expect(result).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS c FROM official_paper_snapshots").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("returns null when there are zero active members at all", async () => {
    const { db } = makeDb();
    const root = makeCredentialsRoot();

    const result = await officialPaperMonitor.pollOfficialPaperPerMember(db, { credentialsRootDir: root });

    expect(result).toBeNull();
  });

  it("2 credentialed members -> 2 owner-tagged snapshot rows, each with THAT member's fetch result", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const root = makeCredentialsRoot();
    seedMemberCredentials(root, "member_1");
    seedMemberCredentials(root, "member_2");

    const fetchImpl = async (member: { id: string }) =>
      buildSnapshot({
        fetchedAt: `2026-07-15T14:00:00.000Z`,
        primaryAsset: { net_assets: member.id === "member_1" ? "1000" : "2000", total_cash: "0" }
      });

    const result = await officialPaperMonitor.pollOfficialPaperPerMember(db, { fetchImpl, credentialsRootDir: root });

    expect(result).toHaveLength(2);
    expect(result?.map((entry: { ownerId: string }) => entry.ownerId).sort()).toEqual(["member_1", "member_2"]);

    const rows = db
      .prepare("SELECT owner_id, net_assets FROM official_paper_snapshots ORDER BY owner_id ASC")
      .all() as Array<{ owner_id: string; net_assets: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ owner_id: "member_1", net_assets: 1000 });
    expect(rows[1]).toMatchObject({ owner_id: "member_2", net_assets: 2000 });
  });

  it("a member with no credentials file is skipped entirely (no snapshot row, not an error)", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_no_account");
    const root = makeCredentialsRoot();
    seedMemberCredentials(root, "member_1");
    // member_no_account intentionally gets no longbridge.env file.

    const fetchImpl = async () => buildSnapshot();
    const result = await officialPaperMonitor.pollOfficialPaperPerMember(db, { fetchImpl, credentialsRootDir: root });

    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ ownerId: "member_1" });
    const rows = db.prepare("SELECT owner_id FROM official_paper_snapshots").all() as Array<{ owner_id: string }>;
    expect(rows).toEqual([{ owner_id: "member_1" }]);
  });

  it("passes each member's own env/creds into fetchImpl (never leaks another member's credentials)", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const root = makeCredentialsRoot();
    seedMemberCredentials(root, "member_1");
    seedMemberCredentials(root, "member_2");

    const seenTokens: string[] = [];
    const fetchImpl = async (_member: { id: string }, creds: { env: Record<string, string> }) => {
      seenTokens.push(creds.env.LONGBRIDGE_ACCESS_TOKEN);
      return buildSnapshot();
    };

    await officialPaperMonitor.pollOfficialPaperPerMember(db, { fetchImpl, credentialsRootDir: root });

    expect(seenTokens.sort()).toEqual(["token-member_1", "token-member_2"]);
  });
});

// 2026-07 audit fix: main() had no try/catch and openTradingDatabase sat
// outside any try, so an unknown command produced a multi-line raw Node
// stack trace instead of the {ok:false,error} single-line JSON envelope
// every other CLI in this package uses (stock-analysis.mjs, market-alerts.
// mjs). Spawned as a real subprocess (not an in-process import) because the
// top-level `if (isMainModule)` block only runs under that condition, and an
// unknown command is validated BEFORE any db is opened - see main()'s
// KNOWN_COMMANDS check - so this never touches the real trading.sqlite.
const scriptPath = fileURLToPath(new URL("./official-paper-monitor.mjs", import.meta.url));

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stderr: "", stdout };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? 1, stderr: err.stderr ?? "", stdout: err.stdout ?? "" };
  }
}

describe("official-paper-monitor.mjs CLI entry: unknown command -> JSON envelope, not a raw stack trace", () => {
  it("exits non-zero with a single-line {ok:false,error} JSON on stderr for an unknown subcommand", () => {
    const result = runScript(["bogus-command"]);

    expect(result.status).not.toBe(0);
    const stderrLines = result.stderr.trim().split("\n");
    expect(stderrLines).toHaveLength(1);
    const parsed = JSON.parse(stderrLines[0]!);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toMatch(/poll\|pnl\|snapshot/);
  });
});
