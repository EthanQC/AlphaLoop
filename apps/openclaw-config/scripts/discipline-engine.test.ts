import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, createId, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const disciplineEngine = await import("./discipline-engine.mjs");
const stockFactsStore = await import("./stock-facts-store.mjs");

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-discipline-engine-"));
  tempDirs.push(dir);
  const db = openTradingDatabase(join(dir, "trading.sqlite"));
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
  return db;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedRule(
  db: DatabaseSync,
  opts: { ruleText: string; enforcement: "hard" | "proposal_check" | "self"; enabled?: boolean; ownerId?: string }
): string {
  const id = createId("rule");
  db.prepare(`
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, linked_strategy, enabled, created_at, disabled_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
  `).run(id, opts.ownerId ?? "member_1", opts.ruleText, opts.enforcement, opts.enabled === false ? 0 : 1, "2026-07-01T00:00:00.000Z");
  return id;
}

function draft(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    symbol: "AAPL.US",
    side: "buy" as const,
    quantity: 10,
    limitPrice: 200,
    budgetImpactPct: 3,
    currentExposurePct: 5,
    ...overrides
  };
}

// Wednesday 2026-07-15 (EDT) - same reference instant as circuit-breaker
// .test.ts, whose current US/Eastern trading day is 2026-07-15 and whose
// trading week is Monday 2026-07-13 .. Friday 2026-07-17 (pinned against
// trading-schedule.test.ts's own assertion for this instant).
const NOW = new Date("2026-07-15T18:00:00.000Z");
const TRADING_DAY = "2026-07-15";

describe("evaluateDiscipline - 仓位上限 rule (①)", () => {
  it("passes when projected exposure is at or under the cap", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "仓位≤10%", enforcement: "hard" });

    const result = disciplineEngine.evaluateDiscipline(
      db,
      "member_1",
      draft({ currentExposurePct: 5, budgetImpactPct: 3 }),
      NOW
    );

    expect(result.report).toEqual([
      { ruleId, ruleText: "仓位≤10%", enforcement: "hard", pass: true, detail: expect.stringContaining("8.00%") }
    ]);
    expect(result.hardViolations).toEqual([]);
  });

  it("fails when projected exposure exceeds the cap, and a HARD rule lands in hardViolations", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "仓位 ≤ 10%", enforcement: "hard" });

    const result = disciplineEngine.evaluateDiscipline(
      db,
      "member_1",
      draft({ currentExposurePct: 8, budgetImpactPct: 5 }),
      NOW
    );

    expect(result.report).toEqual([
      { ruleId, ruleText: "仓位 ≤ 10%", enforcement: "hard", pass: false, detail: expect.stringContaining("13.00%") }
    ]);
    expect(result.hardViolations).toEqual([{ ruleId, ruleText: "仓位 ≤ 10%", detail: expect.stringContaining("13.00%") }]);
  });

  it("a violated proposal_check rule appears in report but does NOT land in hardViolations", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "仓位≤10%", enforcement: "proposal_check" });

    const result = disciplineEngine.evaluateDiscipline(
      db,
      "member_1",
      draft({ currentExposurePct: 8, budgetImpactPct: 5 }),
      NOW
    );

    expect(result.report).toEqual([
      { ruleId, ruleText: "仓位≤10%", enforcement: "proposal_check", pass: false, detail: expect.any(String) }
    ]);
    expect(result.hardViolations).toEqual([]);
  });

  it("returns pass:null (never a silent pass) when the draft is missing exposure/budget data", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "仓位≤10%", enforcement: "hard" });

    const result = disciplineEngine.evaluateDiscipline(
      db,
      "member_1",
      draft({ currentExposurePct: undefined, budgetImpactPct: undefined }),
      NOW
    );

    expect(result.report).toEqual([
      { ruleId, ruleText: "仓位≤10%", enforcement: "hard", pass: null, detail: expect.stringContaining("无法判定") }
    ]);
    expect(result.hardViolations).toEqual([]);
  });
});

describe("evaluateDiscipline - 财报周 rule (②)", () => {
  it("passes trivially for a sell order, regardless of earnings data", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "财报周不买入", enforcement: "hard" });

    const result = disciplineEngine.evaluateDiscipline(db, "member_1", draft({ side: "sell" }), NOW);

    expect(result.report).toEqual([
      { ruleId, ruleText: "财报周不买入", enforcement: "hard", pass: true, detail: expect.any(String) }
    ]);
  });

  it("returns pass:null with the exact '无法判定：缺少财报日数据' detail when no earnings fact exists - NEVER a silent pass", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "财报周不买入", enforcement: "hard" });

    const result = disciplineEngine.evaluateDiscipline(db, "member_1", draft({ side: "buy" }), NOW);

    expect(result.report).toEqual([
      { ruleId, ruleText: "财报周不买入", enforcement: "hard", pass: null, detail: "无法判定：缺少财报日数据" }
    ]);
    expect(result.hardViolations).toEqual([]);
  });

  it("fails (hard violation) when the earnings date falls inside the current trading week and the order is a buy", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "财报周不加仓", enforcement: "hard" });
    stockFactsStore.replaceStockFacts(db, TRADING_DAY, "AAPL.US", [
      { factKey: "earnings.nextDate", valueNum: null, valueText: "2026-07-16", unit: null, source: "test", dataTime: TRADING_DAY }
    ]);

    const result = disciplineEngine.evaluateDiscipline(db, "member_1", draft({ side: "buy" }), NOW);

    expect(result.report[0]).toMatchObject({ ruleId, pass: false });
    expect(result.hardViolations).toEqual([{ ruleId, ruleText: "财报周不加仓", detail: expect.stringContaining("2026-07-16") }]);
  });

  it("passes when an earnings date exists but falls OUTSIDE the current trading week", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "财报周不买入", enforcement: "hard" });
    stockFactsStore.replaceStockFacts(db, TRADING_DAY, "AAPL.US", [
      { factKey: "earnings.nextDate", valueNum: null, valueText: "2026-08-01", unit: null, source: "test", dataTime: TRADING_DAY }
    ]);

    const result = disciplineEngine.evaluateDiscipline(db, "member_1", draft({ side: "buy" }), NOW);

    expect(result.report[0]).toMatchObject({ ruleId, pass: true });
    expect(result.hardViolations).toEqual([]);
  });
});

describe("evaluateDiscipline - unrecognized rule text (③)", () => {
  it("is forced to enforcement 'self' with pass:null, even when stored as 'hard' - never silently passes, never hard-blocks", () => {
    const db = makeDb();
    const ruleId = seedRule(db, { ruleText: "不要冲动追高", enforcement: "hard" });

    const result = disciplineEngine.evaluateDiscipline(db, "member_1", draft(), NOW);

    expect(result.report).toEqual([
      { ruleId, ruleText: "不要冲动追高", enforcement: "self", pass: null, detail: "规则格式未识别，仅提示" }
    ]);
    expect(result.hardViolations).toEqual([]);
  });
});

describe("evaluateDiscipline - aggregate behavior", () => {
  it("report includes every ENABLED rule (mixed pass/fail/null), and only excludes disabled rules", () => {
    const db = makeDb();
    const capRuleId = seedRule(db, { ruleText: "仓位≤10%", enforcement: "hard" });
    const earningsRuleId = seedRule(db, { ruleText: "财报周不买入", enforcement: "proposal_check" });
    const freeTextRuleId = seedRule(db, { ruleText: "保持耐心", enforcement: "self" });
    seedRule(db, { ruleText: "仓位≤5%", enforcement: "hard", enabled: false });

    const result = disciplineEngine.evaluateDiscipline(
      db,
      "member_1",
      draft({ currentExposurePct: 5, budgetImpactPct: 3, side: "buy" }),
      NOW
    );

    const ruleIds = result.report.map((r: { ruleId: string }) => r.ruleId);
    expect(ruleIds).toEqual([capRuleId, earningsRuleId, freeTextRuleId]);
    expect(result.report.map((r: { pass: boolean | null }) => r.pass)).toEqual([true, null, null]);
  });

  it("evaluateDiscipline only reads rules belonging to the given ownerId", () => {
    const db = makeDb();
    new MemberRepository(db).upsert({
      id: "member_2",
      email: "member_2@example.com",
      displayName: "member_2",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z"
    });
    seedRule(db, { ruleText: "仓位≤10%", enforcement: "hard", ownerId: "member_2" });

    const result = disciplineEngine.evaluateDiscipline(db, "member_1", draft(), NOW);

    expect(result.report).toEqual([]);
    expect(result.hardViolations).toEqual([]);
  });
});
