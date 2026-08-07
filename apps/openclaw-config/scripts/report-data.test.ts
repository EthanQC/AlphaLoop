import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const helpers = await import("./report-data.mjs");
// Task 10 (2026-07-28 spec-drift plan): the watchlist rows this suite reads
// back are written by the REAL writer (stock-analysis.mjs's `targets` command,
// the same one the Feishu bot and the CLI call), never by a hand-typed INSERT
// in this file - a test that authors its own row shape can agree with itself
// while disagreeing with production.
const stockAnalysis = await import("./stock-analysis.mjs");

// Temp databases only - runtime/trading.sqlite is never touched by a test.
const tempDirs: string[] = [];

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeDb(): { db: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-report-data-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  return { db: openTradingDatabase(dbPath), dbPath };
}

function seedMember(db: DatabaseSync, id: string): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

describe("report data normalization", () => {
  it("normalizes official Longbridge paper positions without local rows", () => {
    const snapshot = helpers.normalizeOfficialPaperSnapshot({
      fetchedAt: "2026-05-30T08:00:00.000Z",
      check: {
        session: { token: "valid" },
        connectivity: { cn: { ok: true }, global: { ok: false } },
        region: { active: "CN", cached: "cn" }
      },
      assets: [{ net_assets: "122957.73", total_cash: "122220.08", currency: "USD" }],
      positions: [
        {
          symbol: "QQQ.US",
          name: "Invesco QQQ Trust",
          quantity: "1",
          available: "1",
          cost_price: "663.880",
          currency: "USD",
          market: "US"
        },
        { symbol: "TSLA.US", quantity: "-2", available: "0", cost_price: "250", currency: "USD", market: "US" },
        { symbol: "AAPL.US", quantity: "0" }
      ]
    });

    expect(snapshot.source).toBe("longbridge-official-paper");
    expect(snapshot.check).toEqual({
      sessionStatus: "valid",
      activeRegion: "cn",
      cachedRegion: "cn",
      okRegions: ["cn"]
    });
    expect(snapshot.positions).toHaveLength(2);
    expect(snapshot.positions[0]).toMatchObject({
      symbol: "QQQ.US",
      quantity: 1,
      costPrice: 663.88,
      assetClass: "etf"
    });
    expect(snapshot.positions[1]).toMatchObject({ symbol: "TSLA.US", quantity: -2, costPrice: 250 });
  });

  it("fails closed when any official position row has an invalid symbol or quantity", () => {
    const base = {
      fetchedAt: "2026-05-30T08:00:00.000Z",
      check: {
        session: { token: "valid" },
        connectivity: { global: { ok: true } },
        region: { active: "global", cached: "global" }
      },
      assets: [{ net_assets: "100000", total_cash: "50000", currency: "USD" }]
    };

    expect(() => helpers.normalizeOfficialPaperSnapshot({
      ...base,
      positions: [{ symbol: "", quantity: "1", cost_price: "100" }]
    })).toThrow(/持仓.*标的|symbol/u);

    expect(() => helpers.normalizeOfficialPaperSnapshot({
      ...base,
      positions: [{ symbol: "AAPL.US", quantity: "not-a-number", cost_price: "100" }]
    })).toThrow(/持仓.*数量|quantity/u);
  });

  it("rejects official paper reports unless the safety environment is exact", () => {
    expect(() => helpers.assertOfficialPaperReportEnvironment({
      LONGBRIDGE_ACCOUNT_MODE: "paper",
      LONGBRIDGE_OFFICIAL_PAPER_ENABLED: "true",
      ALLOW_LIVE_EXECUTION: "false"
    })).not.toThrow();

    expect(() => helpers.assertOfficialPaperReportEnvironment({
      LONGBRIDGE_ACCOUNT_MODE: "live",
      LONGBRIDGE_OFFICIAL_PAPER_ENABLED: "true",
      ALLOW_LIVE_EXECUTION: "false"
    })).toThrow(/官方模拟盘/u);
  });

  it("rejects official paper snapshots with invalid check or assets", () => {
    expect(() => helpers.normalizeOfficialPaperSnapshot({
      fetchedAt: "2026-05-30T08:00:00.000Z",
      check: { session: { token: "expired" }, connectivity: { cn: { ok: true } } },
      assets: [{ net_assets: "122957.73", total_cash: "122220.08", currency: "USD" }],
      positions: []
    })).toThrow(/令牌检查/u);

    expect(() => helpers.normalizeOfficialPaperSnapshot({
      fetchedAt: "2026-05-30T08:00:00.000Z",
      check: { session: { token: "valid" }, connectivity: { cn: { ok: true } } },
      assets: [{}],
      positions: []
    })).toThrow(/资产缺少/u);
  });

  it("builds a safe degraded official paper snapshot when Longbridge is temporarily unavailable", () => {
    const snapshot = helpers.buildDegradedOfficialPaperSnapshot({
      fetchedAt: "2026-06-19T12:00:00.000Z",
      reason: "Longbridge connect failed"
    });

    expect(snapshot).toMatchObject({
      source: "longbridge-official-paper",
      degraded: true,
      accountMode: "paper",
      primaryAsset: {
        net_assets: "0",
        total_cash: "0",
        currency: "USD",
        risk_level: "unknown"
      },
      check: {
        sessionStatus: "unknown",
        okRegions: []
      },
      positions: []
    });
    expect(snapshot.degradedReason).toContain("Longbridge connect failed");
  });

  it("builds a degraded quote snapshot that keeps QQQ reporting auditable", () => {
    const quote = helpers.buildDegradedQuoteSnapshot("QQQ.US", {
      fetchedAt: "2026-06-19T12:00:00.000Z",
      reason: "quote unavailable"
    });

    expect(quote).toMatchObject({
      symbol: "QQQ.US",
      status: "degraded",
      degraded: true,
      degradedReason: "quote unavailable",
      timestamp: "2026-06-19T12:00:00.000Z"
    });
  });

  it("builds a de-duplicated Longbridge watch/news symbol set", () => {
    const { db } = makeDb();
    const symbols = helpers.buildTrackedSymbols({
      db,
      positions: [{ symbol: "QQQ.US" }, { symbol: "AAPL.US" }],
      extraSymbols: ["qqq.us", "MSFT"]
    });

    expect(symbols).toEqual(["QQQ.US", "AAPL.US", "MSFT.US"]);
  });

  it("normalizes Longbridge news timestamps and titles", () => {
    const articles = helpers.normalizeNewsPayload("QQQ.US", [
      {
        id: "288104799",
        title: " What to Watch   in the Week Ahead ",
        published_at: 1780079501,
        url: "https://longbridge.com/news/288104799"
      }
    ]);

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      id: "288104799",
      symbol: "QQQ.US",
      title: "What to Watch in the Week Ahead",
      publishedAt: "2026-05-29T18:31:41.000Z"
    });
  });

  it("rejects malformed Longbridge news payloads", () => {
    expect(() => helpers.normalizeNewsPayload("QQQ.US", { unexpected: [] })).toThrow(/新闻 QQQ.US返回格式异常/u);
  });

  // #31 audit fix regression: normalizeEpochMs (shared by news and macro
  // calendar normalization) used to fabricate Date.now() for a
  // missing/unparseable published_at, making undated stale news look
  // "just published" and rank first.
  it("leaves publishedAt/publishedAtMs unknown (undefined) instead of fabricating Date.now() for undated Longbridge news", () => {
    const articles = helpers.normalizeNewsPayload("QQQ.US", [
      {
        id: "undated-1",
        title: "Undated Longbridge wire item",
        url: "https://longbridge.com/news/undated-1"
      }
    ]);

    expect(articles).toHaveLength(1);
    expect(articles[0].publishedAtMs).toBeUndefined();
    expect(articles[0].publishedAt).toBeUndefined();
  });

  it("sorts undated Longbridge news last (not first) instead of crashing on an undefined subtraction", () => {
    const articles = helpers.normalizeNewsPayload("QQQ.US", [
      { id: "undated", title: "Undated wire item", url: "https://longbridge.com/news/undated" },
      { id: "dated", title: "Dated wire item", url: "https://longbridge.com/news/dated", published_at: 1780079501 }
    ]);

    expect(articles.map((article) => article.id)).toEqual(["dated", "undated"]);
  });

  // #29 audit fix regression: this normalizer builds its own article shape
  // independently of report-news.mjs's decorateNewsArticle, so it must
  // defuse markdown-link titles itself.
  it("defuses a malicious markdown-link title in Longbridge news normalization", () => {
    const articles = helpers.normalizeNewsPayload("QQQ.US", [
      {
        id: "phish-1",
        title: "[紧急：点击核对持仓](https://evil.example/phish)",
        url: "https://longbridge.com/news/phish-1",
        published_at: 1780079501
      }
    ]);

    expect(articles).toHaveLength(1);
    expect(articles[0].title).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);
    expect(articles[0].title).toBe("［紧急：点击核对持仓］(https://evil.example/phish)");
  });

  it("flattens Longbridge macro calendar groups", () => {
    const entries = helpers.normalizeMacroCalendarPayload({
      list: [
        {
          date: "2026-06-18",
          infos: [
            {
              id: "403032383",
              content: "美国费城联储制造业指数",
              datetime: "1781785840",
              market: "US",
              star: 2,
              data_kv: [{ key: "预测", type: "estimate", value: "12" }]
            }
          ]
        }
      ]
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "403032383",
      title: "美国费城联储制造业指数",
      market: "US",
      star: 2,
      values: [{ key: "预测", type: "estimate", value: "12" }]
    });
  });

  it("rejects malformed Longbridge macro calendar payloads", () => {
    expect(() => helpers.normalizeMacroCalendarPayload({ rows: [] })).toThrow(/宏观日历返回格式异常/u);
  });

});

// Task 10 (2026-07-28 spec-drift plan) - 2026-07-12 requirements §0.4:
// 「平台的新闻抓取与个股分析按全体成员标的池的并集 + 全体持仓生产」. buildTrackedSymbols
// used to hardcode QQQ + positions + whatever REPORT_NEWS_SYMBOLS happened to
// carry, so on the live mini (one member, five active targets, no env var) the
// 2026-07-30 daily report literally reads 「跟踪标的 QQQ.US」 and NONE of that
// member's watchlist got any news coverage at all.
describe("buildTrackedSymbols: the pool is the union of every member's watchlist + held positions (§0.4)", () => {
  it("returns QQQ + held positions + BOTH members' watchlists, with no env var involved", () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA", "TSM"], { dbPath });
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "AMZN", "GOOG"], { dbPath });

    // Positions come from the real normalizer, not a hand-built row shape.
    const positions = helpers.normalizeOfficialPaperSnapshot({
      fetchedAt: "2026-07-30T12:00:00.000Z",
      check: { session: { token: "valid" }, region: { active: "global", cached: "global" }, connectivity: { global: { ok: true } } },
      assets: [{ net_assets: "100000", total_cash: "20000", currency: "USD" }],
      positions: [{ symbol: "MSFT.US", name: "Microsoft", quantity: "3", available: "3", cost_price: "400", currency: "USD", market: "US" }]
    }).positions;

    const symbols = helpers.buildTrackedSymbols({ db, positions });

    // Benchmark first, then money actually at risk, then the watchlist union
    // (sorted, so the order cannot depend on which member wrote last).
    expect(symbols).toEqual(["QQQ.US", "MSFT.US", "AMZN.US", "GOOG.US", "NVDA.US", "TSM.US"]);
  });

  it("keeps a second member's watchlist even when the first member holds nothing", () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], { dbPath });
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "TSM"], { dbPath });

    expect(helpers.buildTrackedSymbols({ db, positions: [] })).toEqual(["QQQ.US", "NVDA.US", "TSM.US"]);
  });

  it("ignores watchlist rows a member has deactivated", () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA", "TSM"], { dbPath });
    // The real writer deactivates everything not named in the new set.
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], { dbPath });

    expect(helpers.buildTrackedSymbols({ db, positions: [] })).toEqual(["QQQ.US", "NVDA.US"]);
  });

  it("treats REPORT_NEWS_SYMBOLS as an addition on top of the union, never as the source of it", () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], { dbPath });

    const symbols = helpers.buildTrackedSymbols({ db, positions: [], extraSymbols: ["amd"] });

    // The env-supplied symbol is present AND the member's watchlist survives:
    // an operator override must never be able to silence a member's pool.
    expect(symbols).toEqual(["QQQ.US", "NVDA.US", "AMD.US"]);
  });

  it("refuses to build a pool without the database instead of silently returning the old hardcoded list", () => {
    expect(() => helpers.buildTrackedSymbols({ positions: [{ symbol: "NVDA.US" }] })).toThrow(/标的池/u);
  });

  it("selectWatchlistUnion reads every owner's active rows exactly once", () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    // Both members watch TSM - the union must carry it once, not twice.
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "TSM"], { dbPath });
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "TSM", "NVDA"], { dbPath });

    expect(helpers.selectWatchlistUnion(db)).toEqual(["NVDA.US", "TSM.US"]);
  });
});
