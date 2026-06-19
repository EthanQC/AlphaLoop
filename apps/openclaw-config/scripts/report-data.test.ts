import { describe, expect, it } from "vitest";

const helpers = await import("./report-data.mjs");

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
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]).toMatchObject({
      symbol: "QQQ.US",
      quantity: 1,
      costPrice: 663.88,
      assetClass: "etf"
    });
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
    const symbols = helpers.buildTrackedSymbols(
      [{ symbol: "QQQ.US" }, { symbol: "AAPL.US" }],
      ["qqq.us", "MSFT"]
    );

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
