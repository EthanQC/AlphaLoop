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
  SCHEMA_VERSION,
  getSchemaVersion,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";

import { normalizeOfficialPaperSnapshot } from "./report-data.mjs";

const personalPage = await import("./personal-page.mjs");
const scheduledReport = await import("./scheduled-report.mjs");

// The three renderers Task 4 exported as the seam for this page (see their doc
// comments in scheduled-report.mjs). Injected rather than imported by
// personal-page.mjs itself so the dependency stays one-directional
// (scheduled-report.mjs -> personal-page.mjs), the same helpers-injection
// pattern review-engine.mjs already uses for its cross-app helpers.
const helpers = {
  renderOfficialPaperSnapshot: scheduledReport.renderOfficialPaperSnapshot,
  summarizeOfficialAccount: scheduledReport.summarizeOfficialAccount,
  summarizeOfficialPositions: scheduledReport.summarizeOfficialPositions
};

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
    expect(SCHEMA_VERSION).toBe(16);
    const db = makeDb();
    expect(getSchemaVersion(db)).toBe(16);
    const columns = (db.prepare(`PRAGMA table_info(personal_pages)`).all() as Array<{ name: string }>).map(
      (column) => column.name
    );
    expect(columns).toEqual(["id", "owner_id", "kind", "date", "markdown", "created_at"]);
  });
});
