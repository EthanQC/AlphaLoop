// Task H4 (phase2.5 hardening): stock-analysis.mjs's `targets` CLI + its
// setTargets() writer previously operated on a globally-shared watchlist
// (stock_analysis_targets.symbol was the sole PRIMARY KEY pre-v7) and wrote
// owner-less rows. Schema v7 (task H3) rebuilt the table with a composite
// PRIMARY KEY (symbol, owner_id), owner_id NOT NULL - so the old setTargets
// would now fail loudly against every real db (no owner_id to bind). This
// file is the first direct test coverage stock-analysis.mjs has ever had;
// see market-alerts-seam.test.ts for the writer (setTargets) <-> reader
// (isSymbolWatched) cross-module seam test, per this task's "writer-side
// and reader-side must be tested against each other" instruction.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const stockAnalysis = await import("./stock-analysis.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string; options: { dbPath: string } } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-stock-analysis-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath, options: { dbPath } };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id = "member_1", overrides: Partial<{ status: string }> = {}): void {
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

function activeTargets(db: DatabaseSync, ownerId: string): string[] {
  const rows = db
    .prepare(`SELECT symbol FROM stock_analysis_targets WHERE owner_id = ? AND active = 1 ORDER BY symbol ASC`)
    .all(ownerId) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

describe("runTargetsCommand: --owner is required", () => {
  it("throws (does not silently operate on a global pool) when --owner is missing", () => {
    const { options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["NVDA"], options)).toThrow(/owner/);
  });

  it("throws when --owner is present but empty", () => {
    const { options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "NVDA"], options)).toThrow(/owner/);
  });
});

describe("runTargetsCommand: owner validation", () => {
  it("rejects an owner id that does not exist in members", () => {
    const { options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "no_such_member", "NVDA"], options)).toThrow(/成员/);
  });

  it("rejects a revoked (non-active) member", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", { status: "revoked" });
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options)).toThrow(/成员/);
  });

  it("rejects the legacy shared-pool sentinel as an --owner value", () => {
    const { db, options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "__legacy_shared__", "NVDA"], options)).toThrow(/只读/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM stock_analysis_targets").get()).toMatchObject({ c: 0 });
  });
});

describe("runTargetsCommand: successful writes are owner-scoped", () => {
  it("adds symbols under the given owner", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA", "msft"], options);

    expect(result).toEqual({ ownerId: "member_1", saved: ["NVDA.US", "MSFT.US"] });
    expect(activeTargets(db, "member_1")).toEqual(["MSFT.US", "NVDA.US"]);
  });

  it("does not touch a different owner's rows", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "TSLA"], options);

    expect(activeTargets(db, "member_1")).toEqual(["NVDA.US"]);
    expect(activeTargets(db, "member_2")).toEqual(["TSLA.US"]);
  });

  it("soft-deletes (active=0) only THIS owner's previously-active rows on a subsequent call, scoped to that owner", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "AAPL"], options);

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "MSFT"], options);

    expect(activeTargets(db, "member_1")).toEqual(["MSFT.US"]);
    // member_2's row must survive untouched - the soft-delete in setTargets
    // must be scoped by owner_id, not global (the pre-H4 behavior).
    expect(activeTargets(db, "member_2")).toEqual(["AAPL.US"]);

    const nvdaRow = db.prepare("SELECT active FROM stock_analysis_targets WHERE symbol = ? AND owner_id = ?").get("NVDA.US", "member_1") as { active: number };
    expect(nvdaRow.active).toBe(0);
  });

  it("never writes to or soft-deletes the legacy shared-pool sentinel's rows", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    db.prepare(`
      INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
      VALUES ('AAPL.US', '__legacy_shared__', 1, ?, ?)
    `).run("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);

    const legacyRow = db.prepare("SELECT active FROM stock_analysis_targets WHERE symbol = ? AND owner_id = ?").get("AAPL.US", "__legacy_shared__") as { active: number };
    expect(legacyRow.active).toBe(1);
  });
});

describe("runTargetsCommand: per-owner cap of 20", () => {
  it("rejects a submission of more than 20 symbols", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const symbols = Array.from({ length: 21 }, (_, i) => `${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`);

    expect(() => stockAnalysis.runTargetsCommand(["--owner", "member_1", ...symbols], options)).toThrow(/20/);
    expect(activeTargets(db, "member_1")).toEqual([]);
  });

  it("accepts exactly 20 symbols", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const symbols = Array.from({ length: 20 }, (_, i) => `${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`);

    const result = stockAnalysis.runTargetsCommand(["--owner", "member_1", ...symbols], options);
    expect(result.saved).toHaveLength(20);
    expect(activeTargets(db, "member_1")).toHaveLength(20);
  });
});

describe("setTargets (direct writer call)", () => {
  it("requires at least one symbol", () => {
    const { db } = makeDb();
    expect(() => stockAnalysis.setTargets(db, "member_1", [])).toThrow();
  });

  it("rejects the legacy shared-pool sentinel as an ownerId regardless of caller", () => {
    const { db } = makeDb();
    expect(() => stockAnalysis.setTargets(db, "__legacy_shared__", ["NVDA"])).toThrow(/只读/);
  });
});

// Task H7 (2026-07-14 legacy audit): one bad target used to kill the whole
// analysis batch with no isolation - see fetchStockAnalysisRecords's own
// doc comment. These tests exercise the isolation directly via dependency
// injection (an in-memory fetchRecord) rather than real network/Longbridge
// calls.
describe("fetchStockAnalysisRecords: per-symbol isolation", () => {
  it("isolates one symbol's failure and still returns the others' records", async () => {
    const fetchRecord = async (symbol: string) => {
      if (symbol === "BAD.US") {
        throw new Error("BAD.US 行情格式异常。");
      }
      return { symbol, analysis: {} };
    };

    const { records, failedSymbols } = await stockAnalysis.fetchStockAnalysisRecords(
      ["AAPL.US", "BAD.US", "MSFT.US"],
      { fetchRecord }
    );

    expect(records.map((r: { symbol: string }) => r.symbol)).toEqual(["AAPL.US", "MSFT.US"]);
    expect(failedSymbols).toEqual([{ symbol: "BAD.US", error: "BAD.US 行情格式异常。" }]);
  });

  it("returns every record when nothing fails", async () => {
    const fetchRecord = async (symbol: string) => ({ symbol, analysis: {} });

    const { records, failedSymbols } = await stockAnalysis.fetchStockAnalysisRecords(["AAPL.US"], { fetchRecord });

    expect(records).toHaveLength(1);
    expect(failedSymbols).toEqual([]);
  });

  it("reports every failure when the whole batch fails", async () => {
    const fetchRecord = async () => {
      throw new Error("行情读取失败。");
    };

    const { records, failedSymbols } = await stockAnalysis.fetchStockAnalysisRecords(["AAPL.US", "MSFT.US"], { fetchRecord });

    expect(records).toEqual([]);
    expect(failedSymbols).toEqual([
      { symbol: "AAPL.US", error: "行情读取失败。" },
      { symbol: "MSFT.US", error: "行情读取失败。" }
    ]);
  });
});

describe("renderBatchStockAnalysis: discloses failed symbols instead of hiding the gap", () => {
  it("includes a data-gap disclosure line naming the failed symbol and reason", () => {
    const markdown = stockAnalysis.renderBatchStockAnalysis({
      label: "2026-07-14",
      generatedAt: "2026-07-14T05:00:00.000Z",
      records: [],
      failedSymbols: [{ symbol: "BAD.US", error: "BAD.US 行情格式异常。" }]
    });

    expect(markdown).toContain("数据缺口");
    expect(markdown).toContain("BAD.US");
    expect(markdown).toContain("BAD.US 行情格式异常。");
  });

  it("omits the disclosure line when nothing failed", () => {
    const markdown = stockAnalysis.renderBatchStockAnalysis({
      label: "2026-07-14",
      generatedAt: "2026-07-14T05:00:00.000Z",
      records: [],
      failedSymbols: []
    });

    expect(markdown).not.toContain("数据缺口");
  });
});

describe("listTargets: collapses per-owner duplicates into one global distinct set", () => {
  it("returns a symbol once even when two different owners both have it active", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "NVDA"], options);

    expect(stockAnalysis.listTargets(db)).toEqual(["NVDA.US"]);
  });

  it("runListTargetsCommand exposes the same global view via its own db handle", () => {
    const { options } = makeDb();
    const db2 = openTradingDatabase(options.dbPath);
    seedMember(db2, "member_1");
    db2.close();

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "AAPL", "NVDA"], options);

    expect(stockAnalysis.runListTargetsCommand(options)).toEqual(["AAPL.US", "NVDA.US"]);
  });
});
