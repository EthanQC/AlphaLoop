// Task 5 (2026-07-28 spec-drift remediation plan): the 个人页 generator.
// Requirements §3.2 "个人页（每人一份，随日报生成）" was never built - Task 4
// stripped the owner's holdings/strategy content out of the PUBLIC daily and
// weekly body, and this is the per-owner page that content moved INTO.
//
// The isolation assertions below are the load-bearing ones: §3.2 says
// "个人页只有本人可见——「系统可用」档策略绝不泄露给其他成员", so two members
// seeded with disjoint data must produce two markdown documents that share no
// owner-private token.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemberRepository,
  ProposalRepository,
  SCHEMA_VERSION,
  getSchemaVersion,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";
import type { ExecutionResultStatus } from "../../../packages/shared-types/dist/index.js";

import { normalizeOfficialPaperSnapshot } from "./report-data.mjs";

const personalPage = await import("./personal-page.mjs");
const scheduledReport = await import("./scheduled-report.mjs");
// R5 (2026-07-28 verifier): the REAL producer of execution_reports rows. The
// previous version of this file hand-wrote 「Side: buy」 bodies - a format
// nothing in this repo emits - so §3.3 passed every assertion here while
// rendering 「无对照」 for every production record. Seeding now goes through the
// same two functions the broker-executor success path calls, so a change to
// what that writer records breaks these tests instead of hiding behind them.
const brokerExecutor = await import("../../broker-executor/src/server.ts");
// The same status->{stage, localStatus} mapper that success path runs, so a
// seeded row's lifecycle stage is derived from a raw broker status rather than
// typed in here (M15).
const brokerStatusMap = await import("../../broker-executor/src/broker-status-map.ts");
const reconcileModule = await import("./reconcile-official-paper-orders.mjs");

// The three renderers Task 4 exported as the seam for this page (see their doc
// comments in scheduled-report.mjs). Injected rather than imported by
// personal-page.mjs itself so the dependency stays one-directional
// (scheduled-report.mjs -> personal-page.mjs), the same helpers-injection
// pattern review-engine.mjs already uses for its cross-app helpers.
const helpers = {
  renderOfficialPaperSnapshot: scheduledReport.renderOfficialPaperSnapshot,
  summarizeOfficialAccount: scheduledReport.summarizeOfficialAccount,
  summarizeOfficialPositions: scheduledReport.summarizeOfficialPositions,
  // C1/C2: the owner-scoped execution read and the fill formatter that used to
  // feed the PUBLIC digest. Injected through the same seam for the same reason.
  selectExecutionReports: scheduledReport.selectExecutionReports,
  countUnattributedExecutionReports: scheduledReport.countUnattributedExecutionReports,
  extractExecutionFacts: scheduledReport.extractExecutionFacts,
  summarizeExecutionRow: scheduledReport.summarizeExecutionRow
};

interface FillInput {
  id: string;
  ownerId: string | null;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price?: number;
  createdAt: string;
  category?: string;
  proposalId?: string;
  /** Omit the structured facts, leaving only the prose body - the shape of a row written before R5. */
  legacyMetadataOnly?: boolean;
  /**
   * The RAW broker status the row came back with. The lifecycle stage and local
   * status are then derived from it by the real mapper, exactly as
   * broker-executor does - never typed in here - so a seeded row can only ever
   * carry a {status, stage} pair the mapper actually produces.
   */
  brokerStatus?: string;
}

/**
 * One fill written the way apps/broker-executor/src/server.ts writes a real
 * one: the body is produced by the exported buildExecutionReportBody and the
 * metadata by the exported buildExecutionReportMetadata - the two functions the
 * success path itself calls, not a local imitation of them.
 */
function seedExecutionReport(db: DatabaseSync, input: FillInput): void {
  const ticketId = `ticket_prop_${input.proposalId ?? input.id}`;
  const ticket = {
    id: ticketId,
    source: "proposals-cli",
    submittedAt: input.createdAt,
    environment: "paper" as const,
    assetClass: "stock" as const,
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
    conviction: "normal" as const,
    notionalUsd: input.quantity * (input.price ?? 0),
    // OrderTicket declares `ownerId?: string`; under exactOptionalPropertyTypes
    // neither an explicit `undefined` nor a `null` is the same as absent, and
    // an ownerless ticket is the shape the pre-C1 rows actually have.
    ...(input.ownerId === null ? {} : { ownerId: input.ownerId }),
    proposalId: input.proposalId ?? input.id
  };
  // The stage/localStatus pair is DERIVED from the raw broker status by the
  // same mapper the broker-executor success path uses, so these rows can only
  // carry combinations production can produce. "unknown" is a legitimate
  // mapper output (any status the table does not recognize) that the shared
  // ExecutionResultStatus type has no member for - see the same cast and the
  // same explanation in packages/shared-types/src/database.test.ts.
  const brokerStatus = input.brokerStatus ?? "Filled";
  const mapping = brokerStatusMap.mapBrokerStatusToStage(brokerStatus);
  const result = {
    ticketId,
    environment: "paper" as const,
    status: mapping.localStatus as ExecutionResultStatus,
    provider: "longbridge-paper" as const,
    externalOrderId: `ext_${input.id}`,
    brokerStatus,
    brokerOrderStage: mapping.stage,
    ...(input.price === undefined ? {} : { limitPrice: input.price, fillPrice: input.price }),
    reasons: ["长桥官方模拟盘已接受该订单。"]
  };

  const body = brokerExecutor.buildExecutionReportBody(ticket, result);
  const metadata = input.legacyMetadataOnly
    // What the rows already in production look like: the ticket/proposal
    // linkage and the broker result, but no symbol/side/quantity of their own.
    ? { ticketId, proposalId: input.proposalId ?? input.id, environment: "paper", assetClass: "stock", result }
    : brokerExecutor.buildExecutionReportMetadata(ticket, input.proposalId ?? input.id, result);
  // A legacy row's body predates R5 too - it named the workorder and nothing
  // about the trade. Reproduced by stripping exactly the lines R5 added.
  const storedBody = input.legacyMetadataOnly
    ? body.split("\n").filter((line) => !/^(标的|方向|数量|成交价)[：:]/u.test(line)).join("\n")
    : body;

  db.prepare(`
    INSERT INTO execution_reports (id, category, title, body, metadata, created_at, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.category ?? "trade",
    `${input.symbol} 执行报告`,
    storedBody,
    JSON.stringify(metadata),
    input.createdAt,
    input.ownerId
  );
}

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-personal-page-"));
  tempDirs.push(dir);
  return openTradingDatabase(join(dir, "trading.sqlite"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id: string, displayName: string, status = "active"): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: status as "active" | "revoked",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function seedSnapshot(
  db: DatabaseSync,
  input: {
    id: string;
    ownerId: string | null;
    fetchedAt: string;
    netAssets: number;
    totalCash: number;
    positions: Array<{ symbol: string; name: string; quantity: number; costPrice: number }>;
  }
): void {
  const snapshot = normalizeOfficialPaperSnapshot({
    check: {
      session: { token: "valid" },
      region: { active: "global", cached: "global" },
      connectivity: { global: { ok: true } }
    },
    assets: [
      {
        net_assets: String(input.netAssets),
        total_cash: String(input.totalCash),
        buy_power: String(input.totalCash),
        currency: "USD",
        risk_level: "low"
      }
    ],
    positions: input.positions.map((position) => ({
      symbol: position.symbol,
      name: position.name,
      market: "US",
      currency: "USD",
      quantity: String(position.quantity),
      available: String(position.quantity),
      cost_price: String(position.costPrice)
    })),
    fetchedAt: input.fetchedAt
  });

  db.prepare(`
    INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.fetchedAt,
    input.netAssets,
    input.totalCash,
    input.netAssets - input.totalCash,
    JSON.stringify(snapshot.positions),
    JSON.stringify(snapshot),
    input.ownerId
  );
}

function seedThesis(
  db: DatabaseSync,
  input: {
    id: string;
    ownerId: string;
    symbol: string;
    direction: string;
    targetHigh?: number | null;
    targetLow?: number | null;
    invalidationPrice?: number | null;
    status?: string;
  }
): void {
  db.prepare(`
    INSERT INTO theses
      (id, owner_id, symbol, direction, target_low, target_high, invalidation_price, visibility, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')
  `).run(
    input.id,
    input.ownerId,
    input.symbol,
    input.direction,
    input.targetLow ?? null,
    input.targetHigh ?? null,
    input.invalidationPrice ?? null,
    input.status ?? "active"
  );
}

function seedQuoteFact(db: DatabaseSync, symbol: string, tradingDay: string, last: number): void {
  db.prepare(`
    INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES (?, ?, ?, 'quote.last', ?, NULL, 'USD', 'longbridge', ?, ?)
  `).run(
    `fact_${symbol}_${tradingDay}`,
    tradingDay,
    symbol,
    last,
    `${tradingDay}T20:00:00.000Z`,
    `${tradingDay}T20:00:00.000Z`
  );
}

function seedAlert(
  db: DatabaseSync,
  input: { ruleId: string; eventId: string; ownerId: string; symbol: string; triggeredAt: string; value: number }
): void {
  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
    VALUES (?, ?, ?, 'daily_move', 0.04, 'both', 'once_daily', 0, 1, '2026-07-20T00:00:00.000Z')
  `).run(input.ruleId, input.ownerId, input.symbol);
  db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value, message_id, feedback)
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
  `).run(input.eventId, input.ruleId, input.ownerId, input.triggeredAt, input.value);
}

function seedProposal(
  db: DatabaseSync,
  input: { id: string; ownerId: string; symbol: string; status?: string; createdAt?: string }
): void {
  db.prepare(`
    INSERT INTO proposals
      (id, owner_id, symbol, side, quantity, order_type, limit_price, reason, evidence, strategy_ref,
       discipline_report, invalidation, stop_loss, budget_impact, confidence, status, approval_token,
       consumed_at, decided_at, decided_by, ticket_id, outcome, card_message_id, created_at, expires_at)
    VALUES (?, ?, ?, 'buy', 10, 'limit', 100.5, '测试提案理由', '[]', NULL, '[]', NULL, NULL, NULL, 'medium',
            ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, '2026-07-29T12:00:00.000Z')
  `).run(
    input.id,
    input.ownerId,
    input.symbol,
    input.status ?? "pending",
    input.createdAt ?? "2026-07-28T02:00:00.000Z"
  );
}

// A member with one of everything, inside the daily window of 2026-07-28
// (2026-07-27 20:00 -> 2026-07-28 20:00 Beijing time).
function seedFullOwner(db: DatabaseSync, ownerId: string, symbol: string, displayName: string): void {
  seedMember(db, ownerId, displayName);
  seedSnapshot(db, {
    id: `snap_${ownerId}`,
    ownerId,
    fetchedAt: "2026-07-28T09:00:00.000Z",
    netAssets: 100000,
    totalCash: 20000,
    positions: [{ symbol, name: symbol, quantity: 20, costPrice: 500 }]
  });
  seedThesis(db, {
    id: `thesis_${ownerId}`,
    ownerId,
    symbol,
    direction: "bull",
    targetHigh: 800,
    invalidationPrice: 500
  });
  seedQuoteFact(db, symbol, "2026-07-28", 600);
  seedAlert(db, {
    ruleId: `rule_${ownerId}`,
    eventId: `event_${ownerId}`,
    ownerId,
    symbol,
    triggeredAt: "2026-07-28T09:30:00.000Z",
    value: 0.052
  });
  seedProposal(db, { id: `prop_${ownerId}`, ownerId, symbol });
}

describe("renderPersonalPage", () => {
  it("renders all four spec sections for a member who has data in every one of them", () => {
    const db = makeDb();
    seedFullOwner(db, "member_a", "AAPL.US", "小明");

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_a",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(page.sections.map((section: { key: string }) => section.key)).toEqual([
      "holdings",
      "strategy",
      "alerts",
      "todos"
    ]);
    expect(page.sections.map((section: { title: string }) => section.title)).toEqual([
      "我的持仓速览",
      "我的策略对照",
      "我的提醒回顾",
      "我的待办"
    ]);

    // Header identifies the owner and declares the owner-only visibility rule.
    expect(page.markdown).toContain("# 我的个人页 · 日报 2026-07-28");
    expect(page.markdown).toContain("小明");
    expect(page.markdown).toContain("仅本人可见");

    // 1. holdings - the account numbers Task 4 removed from the public body.
    expect(page.markdown).toContain("## 1. 我的持仓速览");
    expect(page.markdown).toContain("净资产");
    expect(page.markdown).toContain("AAPL.US");

    // 2. strategy - the thesis and its distance to the invalidation line.
    expect(page.markdown).toContain("## 2. 我的策略对照");
    expect(page.markdown).toContain("失效线 500.00");
    // latest price 600 vs invalidation 500 -> +20.00%
    expect(page.markdown).toContain("距失效线 +20.00%");

    // 3. alerts fired inside this report's window.
    expect(page.markdown).toContain("## 3. 我的提醒回顾");
    expect(page.markdown).toContain("日内涨跌");

    // 4. pending proposals.
    expect(page.markdown).toContain("## 4. 我的待办");
    expect(page.markdown).toContain("待审批");
  });

  it("keeps each member's page to their own data - one member's page never contains the other's", () => {
    const db = makeDb();
    seedFullOwner(db, "member_a", "AAPL.US", "小明");
    seedFullOwner(db, "member_b", "TSLA.US", "小红");
    // Distinct account sizes so a leaked number is detectable, not just a
    // leaked symbol.
    db.prepare(`UPDATE official_paper_snapshots SET net_assets = 777777, raw = replace(raw, '"100000"', '"777777"') WHERE owner_id = 'member_b'`).run();

    const pageA = personalPage.renderPersonalPage({
      db,
      ownerId: "member_a",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const pageB = personalPage.renderPersonalPage({
      db,
      ownerId: "member_b",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(pageA.markdown).toContain("AAPL.US");
    expect(pageA.markdown).not.toContain("TSLA.US");
    expect(pageA.markdown).not.toContain("777,777");
    expect(pageA.markdown).not.toContain("小红");

    expect(pageB.markdown).toContain("TSLA.US");
    expect(pageB.markdown).not.toContain("AAPL.US");
    expect(pageB.markdown).not.toContain("小明");
  });

  it("states the reason for every empty section instead of leaving it blank", () => {
    const db = makeDb();
    seedMember(db, "member_empty", "小空");

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_empty",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(page.markdown).toContain("暂无持仓");
    expect(page.markdown).toContain("暂无论点");
    expect(page.markdown).toContain("暂无提醒");
    expect(page.markdown).toContain("暂无待办");
    for (const section of page.sections as Array<{ body: string }>) {
      expect(section.body.trim()).not.toBe("");
    }
  });

  it("discloses a missing price instead of guessing a distance to the invalidation line", () => {
    const db = makeDb();
    seedMember(db, "member_np", "小无价");
    seedThesis(db, {
      id: "thesis_np",
      ownerId: "member_np",
      symbol: "NVDA.US",
      direction: "bull",
      targetHigh: 200,
      invalidationPrice: 120
    });

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_np",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(page.markdown).toContain("NVDA.US");
    expect(page.markdown).toContain("最新价不可用");
    expect(page.markdown).toContain("距失效线：不可计算");
    expect(page.markdown).not.toContain("距失效线 +");
  });

  it("labels a shared (owner_id IS NULL) snapshot as not owner-attributed instead of claiming it as the member's own", () => {
    const db = makeDb();
    seedMember(db, "member_legacy", "小旧");
    seedSnapshot(db, {
      id: "snap_legacy",
      ownerId: null,
      fetchedAt: "2026-07-28T09:00:00.000Z",
      netAssets: 50000,
      totalCash: 10000,
      positions: [{ symbol: "QQQ.US", name: "Invesco QQQ", quantity: 5, costPrice: 400 }]
    });

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_legacy",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(page.markdown).toContain("QQQ.US");
    expect(page.markdown).toContain("未按成员归属");
  });

  it("reports a tiny net-asset move as <0.01% rather than as a signed zero", () => {
    const db = makeDb();
    seedMember(db, "member_tiny", "小微");
    seedSnapshot(db, {
      id: "snap_base",
      ownerId: "member_tiny",
      fetchedAt: "2026-07-27T00:00:00.000Z",
      netAssets: 860343.02,
      totalCash: 855558.45,
      positions: [{ symbol: "QQQ.US", name: "Invesco QQQ", quantity: 1, costPrice: 663.88 }]
    });
    seedSnapshot(db, {
      id: "snap_latest",
      ownerId: "member_tiny",
      fetchedAt: "2026-07-28T09:00:00.000Z",
      netAssets: 860341.2,
      totalCash: 855558.45,
      positions: [{ symbol: "QQQ.US", name: "Invesco QQQ", quantity: 1, costPrice: 663.88 }]
    });

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_tiny",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(page.markdown).toContain("-1.82（-<0.01%）");
    expect(page.markdown).not.toContain("-0.00%");
  });

  it("uses the same report window rule as scheduled-report.mjs (anti-drift seam)", () => {
    for (const kind of ["daily", "weekly"] as const) {
      const mine = personalPage.resolvePersonalPageWindow(kind, "2026-07-28");
      const theirs = scheduledReport.resolveReportWindow(kind, "2026-07-28");
      expect(mine.startLabel).toBe(theirs.startLabel);
      expect(mine.endLabel).toBe(theirs.endLabel);
      expect(mine.start.toISOString()).toBe(theirs.start.toISOString());
      expect(mine.end.toISOString()).toBe(theirs.end.toISOString());
    }
  });

  it("scopes the weekly page's alert review to the seven-day window", () => {
    const db = makeDb();
    seedMember(db, "member_w", "小周");
    seedAlert(db, {
      ruleId: "rule_w",
      eventId: "event_w_in",
      ownerId: "member_w",
      symbol: "AAPL.US",
      triggeredAt: "2026-07-24T09:30:00.000Z",
      value: 0.06
    });
    db.prepare(`
      INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value, message_id, feedback)
      VALUES ('event_w_out', 'rule_w', 'member_w', '2026-07-01T09:30:00.000Z', 0.09, NULL, NULL)
    `).run();

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_w",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const daily = personalPage.renderPersonalPage({
      db,
      ownerId: "member_w",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(weekly.markdown).toContain("# 我的个人页 · 周报 2026-07-28");
    expect(weekly.markdown).toContain("6.00%");
    expect(weekly.markdown).not.toContain("9.00%");
    expect(daily.markdown).toContain("暂无提醒");
  });
});

describe("generatePersonalPages", () => {
  it("writes one page per ACTIVE member and skips revoked members", () => {
    const db = makeDb();
    seedFullOwner(db, "member_a", "AAPL.US", "小明");
    seedFullOwner(db, "member_b", "TSLA.US", "小红");
    seedMember(db, "member_gone", "小离", "revoked");

    const result = personalPage.generatePersonalPages({
      db,
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(result.failures).toEqual([]);
    expect(result.generated.map((entry: { ownerId: string }) => entry.ownerId).sort()).toEqual([
      "member_a",
      "member_b"
    ]);

    const rows = db
      .prepare(`SELECT owner_id, kind, date, markdown FROM personal_pages ORDER BY owner_id`)
      .all() as Array<{ owner_id: string; kind: string; date: string; markdown: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.owner_id)).toEqual(["member_a", "member_b"]);
    expect(rows.every((row) => row.kind === "daily" && row.date === "2026-07-28")).toBe(true);

    // Per-owner isolation, proven on what actually landed in the table.
    const rowA = rows.find((row) => row.owner_id === "member_a");
    const rowB = rows.find((row) => row.owner_id === "member_b");
    expect(rowA?.markdown).toContain("AAPL.US");
    expect(rowA?.markdown).not.toContain("TSLA.US");
    expect(rowB?.markdown).toContain("TSLA.US");
    expect(rowB?.markdown).not.toContain("AAPL.US");
  });

  it("re-running the same (owner, kind, date) overwrites in place instead of duplicating", () => {
    const db = makeDb();
    seedFullOwner(db, "member_a", "AAPL.US", "小明");

    personalPage.generatePersonalPages({
      db,
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    seedProposal(db, { id: "prop_second", ownerId: "member_a", symbol: "MSFT.US" });
    personalPage.generatePersonalPages({
      db,
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:30:00.000Z",
      helpers
    });

    const rows = db
      .prepare(`SELECT id, markdown, created_at FROM personal_pages WHERE owner_id = 'member_a' AND kind = 'daily' AND date = '2026-07-28'`)
      .all() as Array<{ id: string; markdown: string; created_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.markdown).toContain("MSFT.US");
    expect(rows[0]?.created_at).toBe("2026-07-28T12:30:00.000Z");
  });

  it("keeps the daily and the weekly page of one member as separate rows", () => {
    const db = makeDb();
    seedFullOwner(db, "member_a", "AAPL.US", "小明");

    personalPage.generatePersonalPages({ db, kind: "daily", date: "2026-07-28", now: "2026-07-28T12:05:00.000Z", helpers });
    personalPage.generatePersonalPages({ db, kind: "weekly", date: "2026-07-28", now: "2026-07-28T12:06:00.000Z", helpers });

    const rows = db.prepare(`SELECT kind FROM personal_pages ORDER BY kind`).all() as Array<{ kind: string }>;
    expect(rows.map((row) => row.kind)).toEqual(["daily", "weekly"]);
  });

  it("records a per-member failure without losing the other members' pages", () => {
    const db = makeDb();
    seedFullOwner(db, "member_a", "AAPL.US", "小明");
    seedFullOwner(db, "member_b", "TSLA.US", "小红");

    const brokenHelpers = {
      ...helpers,
      renderOfficialPaperSnapshot: (snapshot: { positions: Array<{ symbol: string }> }) => {
        if (snapshot.positions.some((position) => position.symbol === "TSLA.US")) {
          throw new Error("renderer blew up");
        }
        return helpers.renderOfficialPaperSnapshot(snapshot);
      }
    };

    const result = personalPage.generatePersonalPages({
      db,
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers: brokenHelpers
    });

    expect(result.generated.map((entry: { ownerId: string }) => entry.ownerId)).toEqual(["member_a"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.ownerId).toBe("member_b");
    expect(result.failures[0]?.reason).toContain("renderer blew up");
  });
});

// prepareReport is not exported (and drives Longbridge + the news agents), so
// the wiring is pinned at the source level instead: §3.2 says the page is
// generated "随日报生成", and a generator nothing calls would leave every
// member with no page at all while every unit test above still passed.
describe("scheduled-report wiring", () => {
  it("generates the personal pages as part of preparing a report", () => {
    const source = readFileSync(new URL("./scheduled-report.mjs", import.meta.url), "utf8");
    expect(source).toContain('from "./personal-page.mjs"');
    expect(source).toMatch(/generatePersonalPages\(\{\s*\n\s*db,\s*\n\s*kind: reportKind,\s*\n\s*date: info\.label,/u);
    // Injected, not imported back - see personal-page.mjs's header on why the
    // dependency has to stay one-directional.
    expect(source).toContain("renderOfficialPaperSnapshot,\n      summarizeOfficialAccount,\n      summarizeOfficialPositions");
  });
});

// The v16 migration itself (fresh-db shape, v15 upgrade-in-place, UNIQUE/FK/
// CHECK enforcement, idempotency) is pinned where every other version's
// migration is - packages/shared-types/src/database.test.ts's "v16
// personal_pages migration" block. What this file pins is that the schema the
// generator writes into is genuinely on the migration chain, so a page can
// never be written into an ad-hoc table.
describe("schema v16 personal_pages", () => {
  it("is on the migration chain a plain openTradingDatabase() produces", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    const db = makeDb();
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const columns = (db.prepare(`PRAGMA table_info(personal_pages)`).all() as Array<{ name: string }>).map(
      (column) => column.name
    );
    expect(columns).toEqual(["id", "owner_id", "kind", "date", "markdown", "created_at"]);
  });
});

// ---------------------------------------------------------------------------
// C2 (2026-07-28 adversarial review): the weekly personal page was
// byte-identical in STRUCTURE to the daily one - renderPersonalPage used `kind`
// only for the window length and the title. Spec §3.3 asks the weekly page for
// 「本周我的交易 vs 策略一致性回顾」, and C1 just took the fill detail out of the
// public body, so this is where it belongs.
// ---------------------------------------------------------------------------
describe("C2: the weekly personal page reviews this week's trades against the owner's strategy", () => {
  function seedOwnerWithFills(db: DatabaseSync): void {
    seedMember(db, "member_c2", "小周报");
    // bull thesis on AAPL: a buy is 一致, a sell is 冲突.
    seedThesis(db, {
      id: "thesis_c2_aapl",
      ownerId: "member_c2",
      symbol: "AAPL.US",
      direction: "bull",
      targetHigh: 300,
      invalidationPrice: 150
    });
    // No thesis at all on MSFT: the verdict must be 无对照 with a reason, not a
    // guess in either direction.
    seedExecutionReport(db, {
      id: "er_c2_buy",
      ownerId: "member_c2",
      symbol: "AAPL.US",
      side: "buy",
      quantity: 40,
      price: 210.5,
      createdAt: "2026-07-24T14:00:00.000Z"
    });
    seedExecutionReport(db, {
      id: "er_c2_sell",
      ownerId: "member_c2",
      symbol: "AAPL.US",
      side: "sell",
      quantity: 15,
      price: 205.25,
      createdAt: "2026-07-25T14:00:00.000Z"
    });
    seedExecutionReport(db, {
      id: "er_c2_nothesis",
      ownerId: "member_c2",
      symbol: "MSFT.US",
      side: "buy",
      quantity: 5,
      price: 480,
      createdAt: "2026-07-26T14:00:00.000Z"
    });
  }

  it("adds the §3.3 section to the WEEKLY page only - the daily page keeps the four §3.2 sections", () => {
    const db = makeDb();
    seedOwnerWithFills(db);

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const daily = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(weekly.sections.map((section: { key: string }) => section.key)).toEqual([
      "holdings",
      "strategy",
      "alerts",
      "todos",
      "consistency"
    ]);
    expect(weekly.markdown).toContain("## 5. 本周我的交易 vs 策略一致性回顾");

    expect(daily.sections.map((section: { key: string }) => section.key)).toEqual([
      "holdings",
      "strategy",
      "alerts",
      "todos"
    ]);
    expect(daily.markdown).not.toContain("本周我的交易 vs 策略一致性回顾");
    // The two pages are no longer structurally identical, which is the defect.
    expect(weekly.sections).not.toHaveLength(daily.sections.length);
  });

  it("carries the fill detail C1 removed from the public body: symbol, side, quantity, reference price", () => {
    const db = makeDb();
    seedOwnerWithFills(db);

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const section = weekly.sections.find((entry: { key: string }) => entry.key === "consistency");

    expect(section?.body).toContain("AAPL.US");
    expect(section?.body).toContain("买入");
    expect(section?.body).toContain("卖出");
    expect(section?.body).toContain("40");
    expect(section?.body).toContain("210.5");
  });

  it("states a real verdict per fill: 一致 / 冲突 / 无对照, each with its reason", () => {
    const db = makeDb();
    seedOwnerWithFills(db);

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const body = weekly.sections.find((entry: { key: string }) => entry.key === "consistency")?.body ?? "";
    // One block per fill: the entry line plus its indented 一致性/状态/纪律对照
    // sub-lines. The section's own header/说明/判定口径 bullets do not start
    // with a date, so they are excluded.
    const lines = body.split(/\n(?=- )/u).filter((block) => /^- \d{4}-/u.test(block));

    expect(lines).toHaveLength(3);
    // buy under a bull thesis
    expect(lines[0]).toContain("买入");
    expect(lines[0]).toContain("一致性：一致（");
    expect(lines[0]).toContain("看多");
    // sell under the same bull thesis
    expect(lines[1]).toContain("卖出");
    expect(lines[1]).toContain("一致性：冲突（");
    // no thesis for MSFT at all - disclosed, not guessed
    expect(lines[2]).toContain("MSFT.US");
    expect(lines[2]).toContain("一致性：无对照（");
    expect(lines[2]).toMatch(/原因[：:]/u);
  });

  // ==========================================================================
  // M15 (2026-07-28 round-4 verifier): F4 gave the execution verdict five
  // tests, and all five call summarizeExecutionRow(row).status directly. The
  // place a MEMBER reads that verdict is personal-page.mjs's renderConsistency
  // Line - 「  - 状态：${summary.status}」 - and nothing asserted on that line,
  // so the whole wiring (row -> selectExecutionReports -> summarizeExecution
  // Row -> the rendered markdown) was unverified end to end. These assert the
  // rendered TEXT of a real page, for rows whose lifecycle stage came out of
  // the real broker-status mapper.
  // ==========================================================================
  describe("the 状态 line a member actually reads (M15)", () => {
    function weeklyBodyFor(db: DatabaseSync, ownerId: string): string {
      const weekly = personalPage.renderPersonalPage({
        db,
        ownerId,
        kind: "weekly",
        date: "2026-07-28",
        now: "2026-07-28T12:05:00.000Z",
        helpers
      });
      return weekly.sections.find((entry: { key: string }) => entry.key === "consistency")?.body ?? "";
    }

    it("prints 券商已确认成交 for a filled row - the only verdict allowed to claim a fill", () => {
      const db = makeDb();
      seedOwnerWithFills(db);

      const body = weeklyBodyFor(db, "member_c2");

      // The rendered line, indentation and all - not a helper's return value.
      expect(body).toContain("  - 状态：券商已确认成交。");
      // Three fills, three 状态 lines: the section renders one per row rather
      // than one for the section.
      expect(body.match(/^ {2}- 状态：/gmu) ?? []).toHaveLength(3);
    });

    it("never claims a fill for a live-but-unfilled order: 'New' renders 尚未观察到成交", () => {
      const db = makeDb();
      seedMember(db, "member_m15", "小状态");
      seedExecutionReport(db, {
        id: "er_m15_new",
        ownerId: "member_m15",
        symbol: "AAPL.US",
        side: "buy",
        quantity: 10,
        price: 200,
        createdAt: "2026-07-24T14:00:00.000Z",
        // mapBrokerStatusToStage("New") -> {stage:"submitted", localStatus:"submitted"}
        brokerStatus: "New"
      });

      const body = weeklyBodyFor(db, "member_m15");

      expect(body).toContain("  - 状态：订单已提交至券商并存活，尚未观察到成交。");
      expect(body).not.toContain("券商已确认成交");
    });

    it("says the status is unrecognized - naming it - instead of guessing, for a status the mapper does not know", () => {
      const db = makeDb();
      seedMember(db, "member_m15u", "小未知");
      seedExecutionReport(db, {
        id: "er_m15_unknown",
        ownerId: "member_m15u",
        symbol: "AAPL.US",
        side: "buy",
        quantity: 10,
        price: 200,
        createdAt: "2026-07-24T14:00:00.000Z",
        // Anything outside broker-status-map's table maps to
        // {stage:"unknown_broker_status", localStatus:"unknown"} - the real
        // shape a new Longbridge status would arrive in.
        brokerStatus: "SomeNewLongbridgeStatus"
      });

      const body = weeklyBodyFor(db, "member_m15u");

      expect(body).toContain("  - 状态：券商状态「SomeNewLongbridgeStatus」不在本系统的状态映射表内，无法判定是否成交。");
      expect(body).not.toContain("券商已确认成交");
    });

    // M14: the verdict tables are plain object literals and their keys come
    // from row metadata, i.e. from DATA. Before the fix,
    // EXECUTION_STAGE_VERDICTS["toString"] resolved through the prototype to
    // Function.prototype.toString - truthy - and this line rendered
    // 「  - 状态：function toString() { [native code] }」 on a member's page.
    //
    // This row's metadata is deliberately NOT a producer shape: no writer in
    // this repo emits lifecycleStage "toString". That is the point - it is the
    // garbage-input case, and the assertion is that the page degrades to the
    // documented "unrecognized status" sentence like any other unknown value.
    it("does not resolve a prototype key into a verdict (M14): lifecycleStage 'toString' degrades, it does not print a function", () => {
      const db = makeDb();
      seedMember(db, "member_m14", "小原型");
      db.prepare(`
        INSERT INTO execution_reports (id, category, title, body, metadata, created_at, owner_id)
        VALUES (?, 'trade', ?, ?, ?, ?, ?)
      `).run(
        "er_m14_proto",
        "AAPL.US 执行报告",
        "标的：AAPL.US\n方向：买入\n数量：10",
        JSON.stringify({
          ticketId: "ticket_prop_er_m14_proto",
          proposalId: "er_m14_proto",
          environment: "paper",
          assetClass: "stock",
          symbol: "AAPL.US",
          side: "buy",
          quantity: 10,
          lifecycleStage: "toString",
          localStatus: "hasOwnProperty",
          brokerStatus: "constructor"
        }),
        "2026-07-24T14:00:00.000Z",
        "member_m14"
      );

      const body = weeklyBodyFor(db, "member_m14");

      expect(body).not.toContain("native code");
      expect(body).not.toContain("function toString");
      expect(body).not.toContain("[object Object]");
      expect(body).toContain("  - 状态：券商状态「constructor」不在本系统的状态映射表内，无法判定是否成交。");
    });
  });

  it("judges a neutral thesis as 无对照 rather than forcing it into 一致 or 冲突", () => {
    const db = makeDb();
    seedMember(db, "member_c2n", "小中性");
    seedThesis(db, {
      id: "thesis_c2n",
      ownerId: "member_c2n",
      symbol: "AAPL.US",
      direction: "neutral",
      targetHigh: 300,
      invalidationPrice: 150
    });
    seedExecutionReport(db, {
      id: "er_c2n",
      ownerId: "member_c2n",
      symbol: "AAPL.US",
      side: "buy",
      quantity: 10,
      price: 200,
      createdAt: "2026-07-24T14:00:00.000Z"
    });

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2n",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const body = weekly.sections.find((entry: { key: string }) => entry.key === "consistency")?.body ?? "";
    expect(body).toContain("一致性：无对照（");
    expect(body).toContain("中性");
    expect(body).not.toContain("一致性：一致（");
    expect(body).not.toContain("一致性：冲突（");
  });

  it("lists the owner's discipline rules that name the traded symbol, and says when a rule is not machine-judgeable", () => {
    const db = makeDb();
    seedOwnerWithFills(db);
    db.prepare(`
      INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, linked_strategy, enabled, created_at, disabled_at)
      VALUES ('rule_c2', 'member_c2', 'AAPL.US 单一标的不超过总仓 15%', 'hard', NULL, 1, '2026-07-01T00:00:00.000Z', NULL)
    `).run();
    db.prepare(`
      INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, linked_strategy, enabled, created_at, disabled_at)
      VALUES ('rule_c2_off', 'member_c2', 'MSFT.US 禁止追高', 'self', NULL, 0, '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')
    `).run();

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const body = weekly.sections.find((entry: { key: string }) => entry.key === "consistency")?.body ?? "";

    expect(body).toContain("AAPL.US 单一标的不超过总仓 15%");
    expect(body).toContain("硬约束");
    // A free-text rule is NOT machine-evaluated, and the page says so instead
    // of implying the fill was checked against it.
    expect(body).toContain("不做机器判定");
    // A disabled rule is not presented as if it were in force.
    expect(body).not.toContain("MSFT.US 禁止追高");
  });

  it("never shows another member's fill, and excludes the window's rows from the owner's list", () => {
    const db = makeDb();
    seedOwnerWithFills(db);
    seedMember(db, "member_other", "别人");
    seedExecutionReport(db, {
      id: "er_other",
      ownerId: "member_other",
      symbol: "TSLA.US",
      side: "buy",
      quantity: 999,
      price: 250,
      createdAt: "2026-07-24T15:00:00.000Z"
    });
    seedExecutionReport(db, {
      id: "er_stale",
      ownerId: "member_c2",
      symbol: "GOOG.US",
      side: "buy",
      quantity: 7,
      price: 190,
      createdAt: "2026-06-01T15:00:00.000Z"
    });

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(weekly.markdown).not.toContain("TSLA.US");
    expect(weekly.markdown).not.toContain("999");
    // Outside the seven-day window.
    expect(weekly.markdown).not.toContain("GOOG.US");
  });

  it("discloses the unattributed legacy rows it excluded instead of letting them look like nothing happened", () => {
    const db = makeDb();
    seedMember(db, "member_c2u", "小无主");
    seedExecutionReport(db, {
      id: "er_legacy_1",
      ownerId: null,
      symbol: "QQQ.US",
      side: "buy",
      quantity: 3,
      price: 700,
      createdAt: "2026-07-24T15:00:00.000Z"
    });

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2u",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const body = weekly.sections.find((entry: { key: string }) => entry.key === "consistency")?.body ?? "";

    expect(body).toContain("本周没有属于本人的执行记录");
    expect(body).toContain("1 条");
    expect(body).toContain("未按成员归属");
    // The disclosure names the count, never the excluded row's content.
    expect(body).not.toContain("QQQ.US");
  });

  it("says the section is empty and WHY when the week has no execution rows at all", () => {
    const db = makeDb();
    seedMember(db, "member_c2e", "小空周");

    const weekly = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c2e",
      kind: "weekly",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });
    const body = weekly.sections.find((entry: { key: string }) => entry.key === "consistency")?.body ?? "";

    expect(body.trim()).not.toBe("");
    expect(body).toContain("本周没有属于本人的执行记录");
    // Never "flat"/"no trades were made" as a conclusion about the ACCOUNT.
    expect(body).toMatch(/原因|说明/u);
  });
});

// ---------------------------------------------------------------------------
// R5 (2026-07-28 verifier): §3.3 could not read production data, and its test
// concealed that. The seeder above wrote 「Side: buy」 - a format no writer in
// this repo produces - so every assertion passed while the live rendering was:
//
//   - 2026-07-15 18:00 NVDA.US 记录：标的 NVDA.US；详细内容保存在本地数据库，
//     中文报告不直接展开旧英文正文。
//     - 一致性：无对照（原因：这条执行记录的正文里读不出买卖方向…）
//
// ...for EVERY record, forever. These cases drive the real writers end to end:
// no body or metadata below is written by this file.
// ---------------------------------------------------------------------------
describe("R5: the consistency verdict is computed from what the real writers actually record", () => {
  function seedBullOwner(db: DatabaseSync, ownerId: string): void {
    seedMember(db, ownerId, "小实盘");
    seedThesis(db, { id: `thesis_${ownerId}`, ownerId, symbol: "NVDA.US", direction: "bull", targetHigh: 300, invalidationPrice: 150 });
  }

  function consistencyBody(db: DatabaseSync, ownerId: string): string {
    const weekly = personalPage.renderPersonalPage({
      db, ownerId, kind: "weekly", date: "2026-07-28", now: "2026-07-28T12:05:00.000Z", helpers
    });
    return weekly.sections.find((entry: { key: string }) => entry.key === "consistency")?.body ?? "";
  }

  it("reaches a verdict on a row whose body came from broker-executor's own buildExecutionReportBody", () => {
    const db = makeDb();
    seedBullOwner(db, "member_r5");
    seedExecutionReport(db, {
      id: "er_r5_real", ownerId: "member_r5", symbol: "NVDA.US", side: "sell",
      quantity: 6, price: 170.5, createdAt: "2026-07-24T14:00:00.000Z"
    });

    // The stored body is the writer's, and it is genuinely Chinese prose with
    // none of the English markers the old extraction depended on.
    const stored = db.prepare(`SELECT body FROM execution_reports WHERE id = 'er_r5_real'`).get() as { body: string };
    expect(stored.body).toContain("工单：");
    expect(stored.body).not.toMatch(/Side:/u);

    const body = consistencyBody(db, "member_r5");
    expect(body).toContain("一致性：冲突（");
    expect(body).toContain("方向 卖出");
    expect(body).toContain("数量 6");
    expect(body).toContain("成交价 170.5");
    expect(body).not.toContain("读不出买卖方向");
  });

  it("recovers the direction of a pre-R5 row from its own linked proposal, and says that it did", () => {
    const db = makeDb();
    seedBullOwner(db, "member_r5_legacy");
    const proposal = new ProposalRepository(db).create({
      ownerId: "member_r5_legacy", symbol: "NVDA.US", side: "sell", quantity: 6,
      orderType: "limit", limitPrice: 170.5, reason: "减仓", expiresAt: "2026-08-01T00:00:00.000Z"
    });
    seedExecutionReport(db, {
      id: "er_r5_legacy", ownerId: "member_r5_legacy", symbol: "NVDA.US", side: "sell",
      quantity: 6, price: 170.5, createdAt: "2026-07-24T14:00:00.000Z",
      proposalId: proposal.id, legacyMetadataOnly: true
    });

    const body = consistencyBody(db, "member_r5_legacy");
    expect(body).toContain("一致性：冲突（");
    expect(body).toContain(`已按它关联的提案 ${proposal.id}`);
    // The proposal's quantity is an INTENTION (approved_half executes fewer
    // shares than it asked for), so it is never presented as the fill's size.
    expect(body).not.toContain("数量 6");
    expect(body).toContain("数量与价格不据此推断");
  });

  it("refuses to borrow a direction from a proposal that belongs to somebody else", () => {
    const db = makeDb();
    seedBullOwner(db, "member_r5_mine");
    seedMember(db, "member_r5_theirs", "别人");
    const foreign = new ProposalRepository(db).create({
      ownerId: "member_r5_theirs", symbol: "NVDA.US", side: "sell", quantity: 6,
      orderType: "limit", limitPrice: 170.5, reason: "别人的提案", expiresAt: "2026-08-01T00:00:00.000Z"
    });
    seedExecutionReport(db, {
      id: "er_r5_foreign", ownerId: "member_r5_mine", symbol: "NVDA.US", side: "sell",
      quantity: 6, price: 170.5, createdAt: "2026-07-24T14:00:00.000Z",
      proposalId: foreign.id, legacyMetadataOnly: true
    });

    const body = consistencyBody(db, "member_r5_mine");
    expect(body).toContain("一致性：无对照（");
    expect(body).toContain("读不出买卖方向");
    expect(body).not.toContain(foreign.id);
    // Never invents the other side either.
    expect(body).not.toContain("一致性：冲突（");
  });

  it("renders a row written end to end by the REAL reconcile writer on its owner's own page", async () => {
    const db = makeDb();
    seedBullOwner(db, "member_r5_rec");
    const proposal = new ProposalRepository(db).create({
      ownerId: "member_r5_rec", symbol: "NVDA.US", side: "buy", quantity: 4,
      orderType: "limit", limitPrice: 160, reason: "加仓", expiresAt: "2026-08-01T00:00:00.000Z"
    });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）。");
    db.prepare(`
      INSERT INTO official_paper_order_lifecycle
      (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
       side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
       last_observed_at, raw, notes, owner_id)
      VALUES ('row_r5', ?, NULL, 'longbridge-paper', 'paper', 'paper', 'NVDA.US', 'stock',
       'buy', 4, 160, 'unconfirmed', 'pending', 'submit_unconfirmed', '2026-07-24T14:00:00.000Z',
       '2026-07-24T14:00:00.000Z', 'null', '[]', NULL)
    `).run(ticketId);

    const reconcileResult = await reconcileModule.reconcileOfficialPaperOrders(db, {
      fetchOrders: () => [{
        order_id: "EXT_R5", symbol: "NVDA.US", side: "Buy", quantity: 4, price: 160,
        status: "Filled", created_at: "2026-07-24T14:02:00.000Z"
      }],
      fetchExecutions: () => [],
      now: () => new Date("2026-07-24T14:05:00.000Z")
    });

    expect(reconcileResult.adopted).toHaveLength(1);
    expect(db.prepare(`SELECT owner_id FROM official_paper_order_lifecycle WHERE id = 'row_r5'`).get())
      .toEqual({ owner_id: "member_r5_rec" });
    expect(db.prepare(`SELECT owner_id FROM execution_reports`).all())
      .toEqual([{ owner_id: "member_r5_rec" }]);

    const body = consistencyBody(db, "member_r5_rec");
    expect(body).toContain("一致性：一致（");
    expect(body).toContain("方向 买入");
    expect(body).toContain("数量 4");
    expect(body).not.toContain("未按成员归属");
  });
});

// ---------------------------------------------------------------------------
// C3 (2026-07-28 adversarial review, fabrication): loadSnapshotScope queried
// `latest` with fetched_at <= window.end and `baseline` with fetched_at <=
// window.start. When NO snapshot falls inside the window - every Monday, every
// holiday, every day the collector did not run - both queries return the SAME
// ROW, and describeNetAssetsChange never compared ids, so the page rendered
// 「区间净值变动：±0.00（±0.00%）；起点 X → 最新 X」: a claim that the account was
// FLAT, made from no data at all. Every other branch in this module writes
// 「不可计算（原因：…）」 instead.
// ---------------------------------------------------------------------------
describe("C3: no snapshot inside the window is disclosed, never rendered as ±0.00", () => {
  it("refuses to call the account flat when the only snapshot predates the window (the Monday/holiday case)", () => {
    const db = makeDb();
    seedMember(db, "member_c3", "小周一");
    // One snapshot, taken BEFORE the daily window starts (2026-07-27 20:00 CST
    // = 2026-07-27T12:00Z). Nothing inside the window at all.
    seedSnapshot(db, {
      id: "snap_c3_stale",
      ownerId: "member_c3",
      fetchedAt: "2026-07-24T09:00:00.000Z",
      netAssets: 123456.78,
      totalCash: 20000,
      positions: [{ symbol: "QQQ.US", name: "Invesco QQQ", quantity: 5, costPrice: 600 }]
    });

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c3",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(page.markdown).toContain("区间净值变动：不可计算");
    expect(page.markdown).toMatch(/区间净值变动：不可计算（原因：/u);
    // The exact fabrication the review found.
    expect(page.markdown).not.toContain("±0.00");
    expect(page.markdown).not.toMatch(/起点\s*123,456\.78\s*→\s*最新\s*123,456\.78/u);
    // The stale snapshot is still USED for the holdings view - it is the newest
    // account state we have - so the reason has to say what is missing.
    expect(page.markdown).toContain("123,456.78");
  });

  it("does the same on the shared (owner_id IS NULL) scope", () => {
    const db = makeDb();
    seedMember(db, "member_c3s", "小共享");
    seedSnapshot(db, {
      id: "snap_c3_shared",
      ownerId: null,
      fetchedAt: "2026-07-20T09:00:00.000Z",
      netAssets: 50000,
      totalCash: 10000,
      positions: [{ symbol: "QQQ.US", name: "Invesco QQQ", quantity: 5, costPrice: 400 }]
    });

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c3s",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(page.markdown).toContain("区间净值变动：不可计算");
    expect(page.markdown).not.toContain("±0.00");
  });

  it("STILL reports a genuinely flat window as ±0.00 - the fix compares row ids, not values", () => {
    const db = makeDb();
    seedMember(db, "member_c3f", "小持平");
    // Two DISTINCT snapshots: one at/just before the window start, one inside
    // it, with identical net assets. That account really was flat, and saying
    // so is honest - suppressing it would be the opposite error.
    seedSnapshot(db, {
      id: "snap_c3f_base",
      ownerId: "member_c3f",
      fetchedAt: "2026-07-27T09:00:00.000Z",
      netAssets: 90000,
      totalCash: 10000,
      positions: [{ symbol: "QQQ.US", name: "Invesco QQQ", quantity: 5, costPrice: 600 }]
    });
    seedSnapshot(db, {
      id: "snap_c3f_latest",
      ownerId: "member_c3f",
      fetchedAt: "2026-07-28T09:00:00.000Z",
      netAssets: 90000,
      totalCash: 10000,
      positions: [{ symbol: "QQQ.US", name: "Invesco QQQ", quantity: 5, costPrice: 600 }]
    });

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c3f",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    expect(page.markdown).toContain("区间净值变动：±0.00（±0.00%）");
    expect(page.markdown).not.toContain("区间净值变动：不可计算");
  });

  it("names the stale snapshot's own timestamp in the reason, so the gap is auditable", () => {
    const db = makeDb();
    seedMember(db, "member_c3t", "小时间");
    seedSnapshot(db, {
      id: "snap_c3t",
      ownerId: "member_c3t",
      fetchedAt: "2026-07-24T09:00:00.000Z",
      netAssets: 100000,
      totalCash: 20000,
      positions: [{ symbol: "QQQ.US", name: "Invesco QQQ", quantity: 5, costPrice: 600 }]
    });

    const page = personalPage.renderPersonalPage({
      db,
      ownerId: "member_c3t",
      kind: "daily",
      date: "2026-07-28",
      now: "2026-07-28T12:05:00.000Z",
      helpers
    });

    // 2026-07-24T09:00Z = 2026-07-24 17:00 Beijing time.
    expect(page.markdown).toMatch(/区间净值变动：不可计算（原因：[^）]*2026-07-24 17:00/u);
    expect(page.markdown).toMatch(/区间净值变动：不可计算（原因：[^）]*2026-07-27/u);
  });
});
