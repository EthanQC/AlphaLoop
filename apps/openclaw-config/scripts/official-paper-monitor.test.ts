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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
