import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, createId, migrate, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member_1",
    email: "member1@example.com",
    displayName: "Member One",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function seedSnapshot(
  db: DatabaseSync,
  opts: {
    ownerId: string | null;
    fetchedAt: string;
    netAssets?: number | null;
    marketValue?: number;
    positions?: unknown[];
    degraded?: boolean;
    degradedReason?: string;
    /** `raw.primaryAsset.currency`. Defaults to USD so these tests read
     * naturally; official-paper-monitor.mjs always writes a primaryAsset (all
     * 64 live snapshots carry one, reporting HKD - measured 2026-07-30), so a
     * blob without it is a shape the producer never emits. */
    reportingCurrency?: string | null;
    /**
     * `raw.primaryAsset.cash_infos` - the per-currency cash buckets Longbridge
     * returns. Defaults to a single bucket in the reporting currency holding
     * `netAssets`, i.e. "the whole account is cash, in the currency it is
     * reported in": the simplest REAL account shape, and the one that makes
     * data/snapshots.ts's FX-free basis equal `netAssets` so these tests'
     * percentage expectations stay readable.
     *
     * Tests that need the LIVE deployment's shape (HKD reporting over a USD
     * cash bucket, i.e. a converted aggregate) pass it explicitly - see the
     * F1 block at the bottom of this file.
     */
    cashInfos?: Array<{ currency: string; available_cash: string }>;
    /** `raw.primaryAsset.total_cash`, in the reporting currency. Defaults to
     * `netAssets` to match the default single-bucket shape above. */
    totalCash?: string;
  }
): void {
  const currency = opts.reportingCurrency === undefined ? "USD" : opts.reportingCurrency;
  const cashInfos =
    opts.cashInfos ??
    (currency === null
      ? []
      : [{ currency, available_cash: String(opts.netAssets ?? 0) }]);
  const raw: Record<string, unknown> = {
    degraded: opts.degraded ?? false,
    degradedReason: opts.degradedReason ?? null,
    primaryAsset: {
      net_assets: String(opts.netAssets ?? 0),
      total_cash: opts.totalCash ?? String(opts.netAssets ?? 0),
      cash_infos: cashInfos,
      ...(currency === null ? {} : { currency })
    }
  };
  db.prepare(`
    INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'manual', ?, NULL, ?, ?, ?, ?)
  `).run(
    createId("snapshot"),
    opts.fetchedAt,
    opts.netAssets === undefined ? null : opts.netAssets,
    opts.marketValue ?? 0,
    JSON.stringify(opts.positions ?? []),
    JSON.stringify(raw),
    opts.ownerId
  );
}

/** Wraps `db.prepare` so every bound parameter of every `.all()`/`.get()`
 * call executed through it is recorded - lets tests assert at the SQL layer
 * (not just "not in the rendered HTML") that a given id was NEVER used as a
 * query parameter, proving the hidden-performance gate runs before any
 * query, not just before rendering. */
function spyOnBoundParams(db: DatabaseSync): { params: unknown[]; restore: () => void } {
  const originalPrepare = db.prepare.bind(db);
  const params: unknown[] = [];
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const stmt = originalPrepare(sql);
    const originalAll = stmt.all.bind(stmt);
    const originalGet = stmt.get.bind(stmt);
    (stmt as unknown as { all: typeof stmt.all }).all = ((...args: unknown[]) => {
      params.push(...args);
      return originalAll(...(args as []));
    }) as typeof stmt.all;
    (stmt as unknown as { get: typeof stmt.get }).get = ((...args: unknown[]) => {
      params.push(...args);
      return originalGet(...(args as []));
    }) as typeof stmt.get;
    return stmt;
  }) as typeof db.prepare;
  return {
    params,
    restore: () => {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
  };
}

describe("paper route (GET /paper)", () => {
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  const NOW = () => new Date("2026-07-14T12:00:00.000Z"); // 2026-07-14 20:00 Beijing

  beforeEach(async () => {
    db = memoryDb();
    server = createPlatformServer({ db, repoRoot: "/tmp/does-not-matter", now: NOW });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function seedMemberWithToken(overrides: Partial<Member> = {}): { member: Member; token: string } {
    const member = makeMember(overrides);
    new MemberRepository(db).upsert(member);
    const token = new ApiTokenRepository(db).issue(member.id, "test").token;
    return { member, token };
  }

  function authed(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it("returns 401 without any identity", async () => {
    const response = await fetch(`${baseUrl}/paper`);
    expect(response.status).toBe(401);
  });

  it("returns 405 for non-GET requests", async () => {
    const { token } = seedMemberWithToken();
    const response = await fetch(`${baseUrl}/paper`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(405);
  });

  it("renders the viewer's own full account by default (KPI/curve/holdings all present)", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 1100 });

    const response = await authed("/paper", token);
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain("1,100.00 美元");
    expect(body).toContain("净值曲线");
    expect(body).toContain("持仓");
    expect(body).not.toContain("对方未公开战绩");
  });

  it("renders 数据不足 KPIs and an empty-state curve card when the viewer has no snapshots at all", async () => {
    const { token } = seedMemberWithToken();

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toContain("数据不足");
    expect(body).toContain("还没有任何模拟盘快照，画不出净值曲线。");
  });

  it("renders an inline SVG net-worth curve when 2+ points exist", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 });

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toMatch(/<svg[^>]*aria-label="净值曲线"[\s\S]*?<polyline/u);
  });

  it("renders degraded position badges (.pill.warn) for cost/zero priceSource rows", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:00:00.000Z",
      netAssets: 1000,
      degraded: true,
      degradedReason: "行情读取失败：NVDA.US(按成本估值)",
      positions: [
        { symbol: "NVDA.US", currency: "USD", quantity: 2, costPrice: 800, price: 810, priceSource: "cost" },
        { symbol: "AAPL.US", currency: "USD", quantity: 1, costPrice: 200, price: 205, priceSource: "live" }
      ]
    });

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toContain("按成本估值");
    expect(body).toMatch(/<tr class="degraded">[\s\S]*?<span class="pill warn">按成本估值<\/span>/u);
    expect(body).toContain("数据降级提示"); // top-level banner (render/layout.ts), same rule as home
  });

  it("member switcher lists active members and EXCLUDES __legacy_system__ even if forced active", async () => {
    const { token } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "成员甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "成员乙" });
    new MemberRepository(db).upsert(memberB);
    // Force the legacy placeholder to 'active' - defense-in-depth pin, mirrors
    // identity.test.ts's technique for the same guard.
    new MemberRepository(db).upsert(
      makeMember({
        id: "__legacy_system__",
        email: "__legacy_system__@alphaloop.invalid",
        displayName: "Legacy System (migration placeholder)",
        status: "active"
      })
    );

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toContain("成员甲");
    expect(body).toContain("成员乙");
    expect(body).not.toContain("Legacy System (migration placeholder)");
    expect(body).not.toContain("__legacy_system__@alphaloop.invalid");
  });

  it("viewing another member with show_performance=1 shows their real KPI data", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: true });
    new MemberRepository(db).upsert(memberB);
    seedSnapshot(db, { ownerId: "member_b", fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 5000 });

    const response = await authed("/paper?member=member_b", tokenA);
    const body = await response.text();

    expect(body).toContain("5,000.00 美元");
    expect(body).not.toContain("对方未公开战绩");
  });

  it("viewing another member with show_performance=0 hides KPI/curve/holdings AND never queries their snapshot rows", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: false });
    new MemberRepository(db).upsert(memberB);
    seedSnapshot(db, {
      ownerId: "member_b",
      fetchedAt: "2026-07-14T11:00:00.000Z",
      netAssets: 999999,
      positions: [{ symbol: "SECRET.US", currency: "USD", quantity: 1, price: 10, priceSource: "live" }]
    });

    const spy = spyOnBoundParams(db);
    const response = await authed("/paper?member=member_b", tokenA);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("对方未公开战绩");
    expect(body).not.toContain("999999");
    expect(body).not.toContain("SECRET.US");
    // The privacy gate must run BEFORE any query, not just before rendering:
    // member_b's id must never appear as a bound SQL parameter anywhere.
    expect(spy.params).not.toContain("member_b");
    spy.restore();
  });

  it("viewing self always shows full data even when the viewer's OWN show_performance is 0", async () => {
    const { member, token } = seedMemberWithToken({ showPerformance: false });
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1234 });

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toContain("1,234.00 美元");
    expect(body).not.toContain("对方未公开战绩");
  });

  it("two-member isolation: viewing an unknown/invalid ?member value falls back to the viewer's own account, never someone else's", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 4242 });

    const response = await authed("/paper?member=does-not-exist", token);
    const body = await response.text();

    expect(body).toContain("4,242.00 美元");
  });

  it("compare mode (?compare=1) overlays both curves when the other member allows show_performance", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: true });
    new MemberRepository(db).upsert(memberB);
    seedSnapshot(db, { ownerId: "member_a", fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: "member_a", fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 });
    seedSnapshot(db, { ownerId: "member_b", fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 5000 });
    seedSnapshot(db, { ownerId: "member_b", fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 5500 });

    const response = await authed("/paper?member=member_b&compare=1", tokenA);
    const body = await response.text();

    expect(body).toContain("净值曲线对比");
    expect(body).toContain("乙");
    expect(body).toMatch(/<polyline[\s\S]*<polyline/u); // two polylines = two curves
  });

  it("compare mode shows only self + 对方未公开战绩 when the other member hides performance, and never queries their rows", async () => {
    const { member: memberA, token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", showPerformance: false });
    new MemberRepository(db).upsert(memberB);
    seedSnapshot(db, { ownerId: memberA.id, fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: memberA.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 });
    seedSnapshot(db, { ownerId: "member_b", fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 424242 });

    const spy = spyOnBoundParams(db);
    const response = await authed("/paper?member=member_b&compare=1", tokenA);
    const body = await response.text();

    expect(body).toContain("对方未公开战绩");
    expect(body).not.toContain("424242");
    expect(spy.params).not.toContain("member_b");
    spy.restore();
  });

  it("compare mode with no resolvable comparison target shows a hint instead of a silent solo chart", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 });

    const response = await authed("/paper?compare=1", token);
    const body = await response.text();

    expect(body).toContain("选择上方成员以对比净值曲线");
  });

  it("carries the response's CSP nonce onto the page and makes no third-party requests", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/paper", token);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    expect(body).not.toMatch(/https?:\/\//iu);
  });

  // -------------------------------------------------------------------------
  // 提案与成交历史 (req §1.6) - shipped 2026-07-30, replacing a hard-coded
  // "提案与成交历史 P6 上线" placeholder that outlived P6 by weeks.
  // -------------------------------------------------------------------------

  function seedProposal(
    ownerId: string,
    opts: { symbol?: string; status?: string; createdAt?: string; decidedAt?: string | null } = {}
  ): string {
    const id = createId("proposal");
    db.prepare(`
      INSERT INTO proposals (id, owner_id, symbol, side, quantity, order_type, limit_price, reason, evidence,
                             discipline_report, status, decided_at, decided_by, created_at, expires_at)
      VALUES (?, ?, ?, 'buy', 2, 'limit', 390.5, '回踩 MA20', '[]', '[]', ?, ?, NULL, ?, '2026-07-28T12:30:00.000Z')
    `).run(
      id,
      ownerId,
      opts.symbol ?? "TSM.US",
      opts.status ?? "approved",
      opts.decidedAt === undefined ? "2026-07-27T13:00:00.000Z" : opts.decidedAt,
      opts.createdAt ?? "2026-07-27T12:30:00.000Z"
    );
    return id;
  }

  it("renders the viewer's real proposals with a state badge and a link to the detail page", async () => {
    const { member, token } = seedMemberWithToken();
    const id = seedProposal(member.id, { status: "approved_half" });

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("提案与成交历史");
    expect(body).toContain("减半批准");
    expect(body).toContain(`/proposal/${id}`);
    expect(body).toContain("TSM.US 买入 2.00 股");
    // U1: the decision instant reads as Beijing wall-clock, not a raw ISO.
    expect(body).toContain("07-27 21:00");
    expect(body).not.toContain(">2026-07-27T13:00:00.000Z<");
    // The placeholder this replaced.
    expect(body).not.toContain("P6 上线");
  });

  it("shows an honest empty state - naming the real mechanism - when the viewer has no proposals", async () => {
    const { token } = seedMemberWithToken();
    const body = await (await authed("/paper", token)).text();
    expect(body).toContain("你还没有任何提案记录。");
    expect(body).toContain("24 小时无操作自动作废");
    expect(body).not.toContain(">暂无提案</p>");
  });

  // req §1.6 / plan Task 11: 「看他人盘时该区块隐藏」. The block is about the
  // account currently on screen, so on someone else's page it has nothing
  // truthful to show - not B's (private) and not A's (which would read as B's
  // beside B's KPI row).
  it("hides the proposal block entirely on another member's page - neither member's proposals appear", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: true });
    new MemberRepository(db).upsert(memberB);
    seedProposal("member_b", { symbol: "NVDA.US" });
    const ownId = seedProposal("member_a", { symbol: "TSM.US" });

    const body = await (await authed(`/paper?member=member_b`, tokenA)).text();

    expect(body).not.toContain("提案与成交历史");
    expect(body).not.toContain(`/proposal/${ownId}`);
    expect(body).not.toContain("NVDA.US 买入");
    expect(body).not.toContain("TSM.US 买入");
  });

  it("keeps the proposal block on the viewer's OWN page, including a hidden-performance member's", async () => {
    const { member, token } = seedMemberWithToken({ showPerformance: false });
    const ownId = seedProposal(member.id, { symbol: "TSM.US" });

    const body = await (await authed(`/paper?member=${member.id}`, token)).text();

    expect(body).toContain("提案与成交历史");
    expect(body).toContain(`/proposal/${ownId}`);
  });

  it("keeps the proposal block in compare mode - the dashboard there is still the viewer's own", async () => {
    const { member, token } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙" });
    new MemberRepository(db).upsert(memberB);
    const ownId = seedProposal(member.id, { symbol: "TSM.US" });
    seedProposal("member_b", { symbol: "NVDA.US" });

    const body = await (await authed("/paper?member=member_b&compare=1", token)).text();

    expect(body).toContain("提案与成交历史");
    expect(body).toContain(`/proposal/${ownId}`);
    expect(body).not.toContain("NVDA.US 买入");
  });

  // -------------------------------------------------------------------------
  // 对比入口 (req §1.6: 「对比视图」; plan Task 18 §1.6) - 2026-07-30.
  // -------------------------------------------------------------------------

  it("renders a 对比 entry beside every OTHER member's chip, pointing at compare mode", async () => {
    const { token } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    new MemberRepository(db).upsert(
      makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: true })
    );

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain('href="/paper?member=member_b&amp;compare=1"');
    expect(body).toContain("对比");
    // Never a link to compare yourself with yourself.
    expect(body).not.toContain('href="/paper?member=member_a&amp;compare=1"');
  });

  it("greys the 对比 entry out - not a link - for a member who hides their performance", async () => {
    const { token } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    new MemberRepository(db).upsert(
      makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: false })
    );

    const body = await (await authed("/paper", token)).text();

    expect(body).not.toContain('href="/paper?member=member_b&amp;compare=1"');
    expect(body).toContain('aria-disabled="true"');
    expect(body).toContain("对方未公开战绩");
  });

  // -------------------------------------------------------------------------
  // 持仓当日涨跌条形图 (req §1.6) - 2026-07-30. This card used to print a fixed
  // 「数据不足——当日涨跌需行情接入（P6）」 no matter what was in the database.
  // Facts are written by the PRODUCER (report-facts.mjs's buildStockFacts +
  // persistStockFacts, the pair stock-analysis.mjs calls) from a real
  // Longbridge quote payload - see data/position-daily-move.test.ts's header
  // for why a hand-written INSERT would not prove anything here.
  // -------------------------------------------------------------------------

  async function produceQuoteFacts(symbol: string, quote: Record<string, unknown>, tradingDay: string): Promise<void> {
    // eslint-disable-next-line import/no-unresolved -- plain .mjs, no dist
    const reportFacts = await import("../../../openclaw-config/scripts/report-facts.mjs");
    const facts = reportFacts.buildStockFacts({
      symbol,
      quote,
      history: {},
      fundamentals: {},
      optionChain: {},
      news: [],
      tradingDay
    });
    reportFacts.persistStockFacts(db, tradingDay, symbol, facts);
  }

  it("draws a bar per holding, 绿涨红跌, with the number the producer computed", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:30:00.000Z",
      netAssets: 1100,
      positions: [
        { symbol: "TSM.US", currency: "USD", quantity: 10, price: 394.525, priceSource: "live" },
        { symbol: "NVDA.US", currency: "USD", quantity: 5, price: 180, priceSource: "live" }
      ]
    });
    await produceQuoteFacts("TSM.US", { last: 394.525, prev_close: 403.41, volume: 8570295 }, "2026-07-14");
    await produceQuoteFacts("NVDA.US", { last: 180, prev_close: 175, volume: 1000 }, "2026-07-14");

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("持仓当日涨跌");
    // The falling holding is red and signed negative; the rising one is green.
    expect(body).toContain("-2.20%");
    expect(body).toContain("+2.86%");
    expect(body).toContain("background:var(--down)");
    expect(body).toContain("background:var(--up)");
    // TSM is the larger position, so it comes first (same ordering as the donut).
    expect(body.indexOf("TSM.US")).toBeLessThan(body.indexOf("NVDA.US"));
    // The stale phase-name placeholder is gone for good.
    expect(body).not.toContain("当日涨跌需行情接入");
  });

  it("says WHY a holding has no 当日涨跌 instead of drawing it at 0%", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:30:00.000Z",
      netAssets: 1100,
      positions: [
        { symbol: "TSM.US", currency: "USD", quantity: 10, price: 394.525, priceSource: "live" },
        { symbol: "GOOG.US", currency: "USD", quantity: 1, price: 200, priceSource: "live" }
      ]
    });
    await produceQuoteFacts("TSM.US", { last: 394.525, prev_close: 403.41, volume: 8570295 }, "2026-07-14");
    // GOOG has no facts at all - a symbol the analysis batch never reached.

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("没有任何行情事实行");
    // A missing quote must not be rendered as a flat 0.00% bar.
    expect(body).not.toContain("+0.00%");
  });

  it("never queries another member's quote facts when they hide their performance", async () => {
    const { token } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    new MemberRepository(db).upsert(
      makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: false })
    );
    seedSnapshot(db, {
      ownerId: "member_b",
      fetchedAt: "2026-07-14T11:30:00.000Z",
      netAssets: 5000,
      positions: [{ symbol: "TSM.US", currency: "USD", quantity: 99, price: 394.525, priceSource: "live" }]
    });
    await produceQuoteFacts("TSM.US", { last: 394.525, prev_close: 403.41, volume: 8570295 }, "2026-07-14");

    const body = await (await authed("/paper?member=member_b", token)).text();

    expect(body).toContain("对方未公开战绩");
    expect(body).not.toContain("持仓当日涨跌");
    expect(body).not.toContain("-2.20%");
  });
});

// ---------------------------------------------------------------------------
// F1 / F2 (2026-07-30), at the RENDERED-PAGE level.
//
// Fixtures are the deployed mini's real blob shape and real numbers (see
// data/snapshots.test.ts's F1/F2 blocks for the measurement), and the QQQ
// `daily_facts` rows go in through report-facts.mjs's OWN buildDailyFacts /
// persistDailyFacts - the producer - rather than hand-written INSERTs, so the
// alignment is proved against the shape that producer actually writes.
// ---------------------------------------------------------------------------
describe("paper route: currency-artifact-free performance (F1) and the QQQ benchmark (F2)", () => {
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  // After the live series' last poll (2026-07-29T19:30Z), so the page reads as
  // it does in production rather than as if the data were from the future.
  const NOW = () => new Date("2026-07-30T04:00:00.000Z");
  const USD_CASH = 122079.05;
  const RATE_BEFORE = 7.801553911174768;
  const RATE_AFTER = 7.008233189888027;

  beforeEach(async () => {
    db = memoryDb();
    server = createPlatformServer({ db, repoRoot: "/tmp/does-not-matter", now: NOW });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function seedLiveShapeSnapshot(ownerId: string, fetchedAt: string, qqqPrice: number, impliedRate: number): void {
    const totalCash = USD_CASH * impliedRate;
    seedSnapshot(db, {
      ownerId,
      fetchedAt,
      netAssets: totalCash + qqqPrice * impliedRate,
      marketValue: qqqPrice,
      reportingCurrency: "HKD",
      totalCash: totalCash.toFixed(2),
      cashInfos: [
        { currency: "USD", available_cash: USD_CASH.toFixed(2) },
        { currency: "HKD", available_cash: "0.00" }
      ],
      positions: [
        { symbol: "QQQ.US", currency: "USD", quantity: 1, costPrice: 663.88, price: qqqPrice, priceSource: "live" }
      ]
    });
  }

  /** One poll per live US session, at the session's last poll instant. */
  function seedLiveSessions(ownerId: string): void {
    const sessions: Array<[string, number, number]> = [
      ["2026-07-20T19:30:04.887Z", 697.5, RATE_BEFORE],
      ["2026-07-21T19:30:05.017Z", 708.43, RATE_BEFORE],
      ["2026-07-22T19:30:01.414Z", 707.36, RATE_BEFORE],
      ["2026-07-23T19:30:00.788Z", 691.43, RATE_AFTER],
      ["2026-07-24T19:30:03.123Z", 683.714, RATE_AFTER],
      ["2026-07-27T19:30:01.253Z", 683.3, RATE_AFTER],
      ["2026-07-28T19:30:03.115Z", 677.955, RATE_AFTER],
      ["2026-07-29T19:30:04.594Z", 670.9, RATE_AFTER]
    ];
    for (const [fetchedAt, qqqPrice, rate] of sessions) {
      seedLiveShapeSnapshot(ownerId, fetchedAt, qqqPrice, rate);
    }
  }

  /** Writes a `qqq.price` row through report-facts.mjs's own producer. */
  async function produceQqqDailyFact(tradingDay: string, last: number, timestamp: string): Promise<void> {
    // eslint-disable-next-line import/no-unresolved -- plain .mjs, no dist
    const reportFacts = await import("../../../openclaw-config/scripts/report-facts.mjs");
    const facts = reportFacts.buildDailyFacts({
      snapshot: null,
      qqqQuote: { last, prev_close: last, timestamp },
      macroEntries: [],
      tradingDay
    });
    reportFacts.persistDailyFacts(db, tradingDay, facts);
  }

  /** The six live rows, verbatim - three real closes, three intraday quotes
   * from late/manual runs, and one (2026-07-26) whose label sits two sessions
   * away from the Friday close it holds. */
  async function produceLiveQqqFacts(): Promise<void> {
    await produceQqqDailyFact("2026-07-21", 696.06, "2026-07-20T20:00:00.000Z");
    await produceQqqDailyFact("2026-07-26", 684.23, "2026-07-24T20:00:00.000Z");
    await produceQqqDailyFact("2026-07-27", 677.96, "2026-07-27T15:52:37.000Z");
    await produceQqqDailyFact("2026-07-28", 682.12, "2026-07-27T20:00:00.000Z");
    await produceQqqDailyFact("2026-07-29", 668.47, "2026-07-29T14:34:12.000Z");
    await produceQqqDailyFact("2026-07-30", 665.08, "2026-07-29T16:22:29.000Z");
  }

  function seedMemberWithToken(overrides: Partial<Member> = {}): { member: Member; token: string } {
    const member = makeMember(overrides);
    new MemberRepository(db).upsert(member);
    return { member, token: new ApiTokenRepository(db).issue(member.id, "test").token };
  }

  function authed(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it("does not print a double-digit 累计/最大回撤 for an account whose only move was the broker's HKD/USD rate", async () => {
    const { member, token } = seedMemberWithToken();
    seedLiveSessions(member.id);

    const body = await (await authed("/paper", token)).text();

    // The old, netAssets-derived numbers. Never again, in any rounding.
    expect(body).not.toContain("-10.19%");
    expect(body).not.toContain("-10.20%");
    // 净值 stays the broker's own HKD statement, correctly labelled.
    expect(body).toContain("港元");
    // 累计/最大回撤 are the real USD moves of one QQQ share against six figures
    // of cash: (122079.05+670.90)/(122079.05+697.50)-1 = -0.0217%, and the
    // deepest peak-to-trough over these eight closes is -0.0281%.
    expect(body).toContain("-0.02%");
    expect(body).toContain("-0.03%");
    expect(body).not.toContain("数据不足");
  });

  it("discloses that 净值 is converted, when the rate moved, and what the percentages are measured in", async () => {
    const { member, token } = seedMemberWithToken();
    seedLiveSessions(member.id);

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("净值是券商按自己的汇率表折出的 港元 口径");
    expect(body).toContain("账户里的钱实际是\n    美元");
    expect(body).toContain("7.0082");
    expect(body).toContain("7.8016");
    expect(body).toContain("净值在那一刻的跳动来自折算率，不是盈亏");
    expect(body).toContain("不经过任何汇率");
  });

  it("says WHICH percentages could not be computed and WHY, instead of falling back to the converted aggregate", async () => {
    const { member, token } = seedMemberWithToken();
    // Two polls whose cash spans USD and HKD: no FX-free total exists.
    for (const fetchedAt of ["2026-07-28T19:30:00.000Z", "2026-07-29T19:30:00.000Z"]) {
      seedSnapshot(db, {
        ownerId: member.id,
        fetchedAt,
        netAssets: 1000,
        reportingCurrency: "HKD",
        totalCash: "1000",
        cashInfos: [
          { currency: "USD", available_cash: "100" },
          { currency: "HKD", available_cash: "220" }
        ]
      });
    }

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("今日 / 累计 / 最大回撤 都算不出来");
    expect(body).toContain("现金与持仓跨多个币种，没有不经汇率折算就能得到的总额");
    // And the curve refuses for the same stated reason rather than plotting the
    // broker's converted aggregate.
    expect(body).toContain("画不出净值曲线：没有两个可比的净值点。");
    expect(body).toContain("不会拿券商折出的汇总口径充数");
  });

  it("draws the QQQ benchmark from the sessions that align, and names the ones that do not", async () => {
    const { member, token } = seedMemberWithToken();
    seedLiveSessions(member.id);
    await produceLiveQqqFacts();

    const body = await (await authed("/paper", token)).text();

    // The dead claim is gone.
    expect(body).not.toContain("基准曲线尚未接入本页");
    expect(body).not.toContain("QQQ 每日收盘数据已入库");
    // A real benchmark group is drawn, with QQQ's own same-window return next
    // to this account's: 682.12/696.06-1 = -2.00%.
    expect(body).toContain('data-role="benchmark-qqq"');
    expect(body).toContain("QQQ（每日收盘）");
    expect(body).toContain("同期（2026-07-20 → 2026-07-27 两个美股收盘）");
    expect(body).toContain("-2.00%");
    // The five sessions with no accepted close are named, not interpolated.
    expect(body).toContain("2026-07-21、2026-07-22、2026-07-23、2026-07-28、2026-07-29");
    expect(body).toContain("不做插值");
    // And each rejected daily_facts row carries its reason.
    expect(body).toContain("盘中报价");
  });

  it("draws a benchmark line only across consecutive sessions - a gap breaks it into separate runs", async () => {
    const { member, token } = seedMemberWithToken();
    seedLiveSessions(member.id);
    await produceLiveQqqFacts();

    const body = await (await authed("/paper", token)).text();
    const group = body.slice(body.indexOf('data-role="benchmark-qqq"'));
    const groupEnd = group.slice(0, group.indexOf("</g>"));

    // 07-20 is isolated (07-21..07-23 have no close), 07-24 -> 07-27 spans only
    // a weekend and so is one drawable run: exactly ONE polyline, three markers.
    expect(groupEnd.match(/<polyline/gu)).toHaveLength(1);
    expect(groupEnd.match(/<circle/gu)).toHaveLength(3);
  });

  it("says the benchmark could not be drawn, with reasons, when no session aligns", async () => {
    const { member, token } = seedMemberWithToken();
    seedLiveSessions(member.id);
    // Only intraday rows: nothing is a close, so nothing aligns.
    await produceQqqDailyFact("2026-07-29", 668.47, "2026-07-29T14:34:12.000Z");

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("对不上足够的交易日，这条线不画");
    expect(body).not.toContain('data-role="benchmark-qqq"');
    expect(body).toContain("2026-07-29 的盘中报价（抓取于收盘前），不是收盘价");
  });

  it("never reads daily_facts into a benchmark for a member who hides their performance", async () => {
    const { token } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    new MemberRepository(db).upsert(
      makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: false })
    );
    seedLiveSessions("member_b");
    await produceLiveQqqFacts();

    const spy = spyOnBoundParams(db);
    const body = await (await authed("/paper?member=member_b", token)).text();
    spy.restore();

    expect(body).toContain("对方未公开战绩");
    expect(body).not.toContain('data-role="benchmark-qqq"');
    expect(spy.params).not.toContain("qqq.price");
  });
});

// ---------------------------------------------------------------------------
// F1's class, one level down: per-position figures (2026-07-30)
// ---------------------------------------------------------------------------
describe("paper route: per-position figures never mix currencies either", () => {
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  beforeEach(async () => {
    db = memoryDb();
    server = createPlatformServer({
      db,
      repoRoot: "/tmp/does-not-matter",
      now: () => new Date("2026-07-14T12:00:00.000Z")
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function seedMemberWithToken(): { member: Member; token: string } {
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    return { member, token: new ApiTokenRepository(db).issue(member.id, "test").token };
  }

  function authed(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it("labels each holding's price with the currency the broker quoted it in", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:30:00.000Z",
      netAssets: 1000,
      positions: [
        { symbol: "QQQ.US", currency: "USD", quantity: 1, costPrice: 663.88, price: 670.9, priceSource: "live" },
        { symbol: "0700.HK", currency: "HKD", quantity: 100, costPrice: 400, price: 420, priceSource: "live" }
      ]
    });

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("<th>币种</th>");
    expect(body).toContain("美元");
    expect(body).toContain("港元");
  });

  it("says 币种未知 rather than leaving a bare price when a position row states no currency", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:30:00.000Z",
      netAssets: 1000,
      positions: [{ symbol: "MYSTERY.US", quantity: 1, price: 100, priceSource: "live" }]
    });

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("币种未知");
  });

  it("refuses the 仓位分布 donut - naming the currencies - instead of adding HKD to USD to get weights", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:30:00.000Z",
      netAssets: 1000,
      positions: [
        { symbol: "QQQ.US", currency: "USD", quantity: 1, price: 670.9, priceSource: "live" },
        { symbol: "0700.HK", currency: "HKD", quantity: 100, price: 420, priceSource: "live" }
      ]
    });

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain("持仓跨 USD / HKD 多个币种，画不出仓位占比。");
    expect(body).not.toContain('aria-label="仓位分布环图"');
  });

  it("still draws the donut when every holding is in ONE currency", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:30:00.000Z",
      netAssets: 1000,
      positions: [
        { symbol: "QQQ.US", currency: "USD", quantity: 1, price: 600, priceSource: "live" },
        { symbol: "NVDA.US", currency: "USD", quantity: 1, price: 400, priceSource: "live" }
      ]
    });

    const body = await (await authed("/paper", token)).text();

    expect(body).toContain('aria-label="仓位分布环图"');
    expect(body).toContain("60.0%");
    expect(body).toContain("40.0%");
  });
});
