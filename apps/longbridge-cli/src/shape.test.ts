import { describe, expect, it } from "vitest";

import {
  buildAssetsPayload,
  buildCalendarPayload,
  buildCheckPayload,
  buildExecutionsPayload,
  buildNewsPayload,
  buildOrderDetailPayload,
  buildOrderListPayload,
  buildPositionsPayload,
  buildQuoteRows,
  buildSubmitPayload,
  buildWatchlistPayload
} from "./shape.js";

describe("buildCheckPayload", () => {
  it("produces the exact shape healLongbridgeRegionCacheFromCheck and validateLongbridgeCheck read", () => {
    const payload = buildCheckPayload({
      resolution: { active: "global", cached: "global", source: "cache" },
      probes: {
        global: { ok: true, latencyMs: 812 },
        cn: { ok: false, error: "connect timed out" }
      }
    });
    expect(payload).toEqual({
      session: { token: "valid" },
      connectivity: {
        global: { ok: true, latency_ms: 812 },
        cn: { ok: false, error: "connect timed out" }
      },
      region: { active: "global", cached: "global" }
    });
  });

  it("flips region.active to the working region when the resolved one is down", () => {
    const payload = buildCheckPayload({
      resolution: { active: "cn", cached: "cn", source: "cache" },
      probes: {
        global: { ok: true, latencyMs: 10 },
        cn: { ok: false, error: "unreachable" }
      }
    }) as { region: { active: string; cached: string }; session: { token: string } };
    expect(payload.region.active).toBe("global");
    expect(payload.region.cached).toBe("cn");
    expect(payload.session.token).toBe("valid");
  });

  it("reports token invalid when no region is reachable", () => {
    const payload = buildCheckPayload({
      resolution: { active: "global", cached: undefined, source: "default" },
      probes: {
        global: { ok: false, error: "401 unauthorized" },
        cn: { ok: false, error: "connect timed out" }
      }
    }) as { session: { token: string }; connectivity: Record<string, { ok: boolean }>; region: { cached: string } };
    expect(payload.session.token).not.toBe("valid");
    expect(payload.connectivity.global?.ok).toBe(false);
    expect(payload.connectivity.cn?.ok).toBe(false);
    // cached must still be a valid region string for the snapshot consumers
    expect(payload.region.cached).toBe("global");
  });
});

describe("buildQuoteRows", () => {
  const fullQuote = {
    symbol: "QQQ.US",
    lastDone: "551.64",
    prevClose: "548.99",
    open: "549.20",
    high: "552.10",
    low: "547.30",
    volume: 41235678,
    turnover: "22754301234.55",
    timestamp: "2026-07-15T20:00:00.000Z",
    status: "normal",
    postMarket: { last: "551.90", timestamp: "2026-07-15T23:59:00.000Z" },
    preMarket: { last: "549.05", timestamp: "2026-07-15T12:00:00.000Z" }
  };

  it("emits the contract row fields (snake_case) with the requested symbol round-tripped", () => {
    const rows = buildQuoteRows(["qqq.us"], [fullQuote]);
    expect(rows).toEqual([{
      symbol: "QQQ.US",
      last_done: "551.64",
      prev_close: "548.99",
      open: "549.20",
      high: "552.10",
      low: "547.30",
      volume: 41235678,
      turnover: "22754301234.55",
      timestamp: "2026-07-15T20:00:00.000Z",
      status: "normal",
      post_market_quote: { last: "551.90", timestamp: "2026-07-15T23:59:00.000Z" },
      pre_market_quote: { last: "549.05", timestamp: "2026-07-15T12:00:00.000Z" }
    }]);
  });

  it("omits absent pre/post market sessions instead of emitting null", () => {
    const rows = buildQuoteRows(["QQQ.US"], [{ symbol: "QQQ.US", lastDone: "1.0" }]) as Array<Record<string, unknown>>;
    expect(rows[0]).not.toHaveProperty("post_market_quote");
    expect(rows[0]).not.toHaveProperty("pre_market_quote");
  });

  it("keeps request order and drops symbols the SDK did not return", () => {
    const rows = buildQuoteRows(
      ["AAPL.US", "MISSING.US", "QQQ.US"],
      [
        { symbol: "QQQ.US", lastDone: "551.64" },
        { symbol: "AAPL.US", lastDone: "212.10" }
      ]
    ) as Array<{ symbol: string }>;
    expect(rows.map((row) => row.symbol)).toEqual(["AAPL.US", "QQQ.US"]);
  });
});

describe("buildAssetsPayload", () => {
  it("emits net_assets/total_cash/currency plus buy_power and risk_level", () => {
    const payload = buildAssetsPayload([{
      netAssets: "100236.31",
      totalCash: "99755.61",
      currency: "USD",
      buyPower: "199511.22",
      riskLevel: 1,
      maxFinanceAmount: "0",
      cash: [{ currency: "USD", availableCash: "99755.61" }]
    }]);
    expect(payload).toEqual([{
      net_assets: "100236.31",
      total_cash: "99755.61",
      currency: "USD",
      buy_power: "199511.22",
      risk_level: 1,
      max_finance_amount: "0",
      cash_infos: [{ currency: "USD", available_cash: "99755.61" }]
    }]);
  });
});

describe("buildPositionsPayload", () => {
  it("emits the fields normalizeOfficialPosition reads", () => {
    const payload = buildPositionsPayload([{
      symbol: "TSLL.US",
      name: "Direxion Daily TSLA Bull 2X",
      quantity: "40",
      available: "40",
      currency: "USD",
      costPrice: "11.334",
      market: "US",
      accountChannel: "lb_papertrading"
    }]);
    expect(payload).toEqual([{
      symbol: "TSLL.US",
      name: "Direxion Daily TSLA Bull 2X",
      quantity: "40",
      available: "40",
      currency: "USD",
      cost_price: "11.334",
      market: "US",
      account_channel: "lb_papertrading"
    }]);
  });

  it("omits an empty name so consumers default it to the symbol", () => {
    const payload = buildPositionsPayload([{ symbol: "SGOV.US", quantity: "5" }]) as Array<Record<string, unknown>>;
    expect(payload[0]).not.toHaveProperty("name");
  });
});

describe("buildWatchlistPayload", () => {
  it("passes groups through as plain JSON", () => {
    const groups = [{ id: 1, name: "全部", securities: [{ symbol: "QQQ.US", market: "US", name: "Invesco QQQ" }] }];
    expect(buildWatchlistPayload(groups)).toEqual(groups);
  });
});

describe("buildNewsPayload", () => {
  const item = {
    id: "n-1",
    title: "QQQ hits record",
    description: "desc",
    url: "https://example.test/n-1",
    publishedAtMs: 1752570000000,
    likesCount: 3,
    commentsCount: 1,
    sharesCount: 0
  };

  it("emits the contract news fields with published_at in epoch ms", () => {
    expect(buildNewsPayload([item], 5)).toEqual([{
      id: "n-1",
      title: "QQQ hits record",
      description: "desc",
      url: "https://example.test/n-1",
      published_at: 1752570000000,
      likes_count: 3,
      comments_count: 1,
      shares_count: 0
    }]);
  });

  it("caps at count and omits unknown timestamps instead of fabricating them", () => {
    const rows = buildNewsPayload(
      [item, { ...item, id: "n-2", publishedAtMs: undefined }, { ...item, id: "n-3" }],
      2
    ) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).not.toHaveProperty("published_at");
  });
});

describe("buildCalendarPayload", () => {
  const groups = [{
    date: "2026-07-17",
    infos: [
      { id: "e1", content: "CPI YoY", market: "US", star: 3, datetime: "1752710400", timeLabel: "盘前", type: "macrodata", dataKv: [{ key: "前值", type: "previous", value: "3.2%" }] },
      { id: "e2", content: "Minor print", market: "US", star: 1, datetime: "1752710400" }
    ]
  }, {
    date: "2026-07-18",
    infos: [
      { id: "e3", content: "PPI", market: "US", star: 2, datetime: "1752796800" }
    ]
  }];

  it("filters by star, caps total entries, and emits the contract group/entry fields", () => {
    const payload = buildCalendarPayload(groups, { stars: [2, 3], count: 1 });
    expect(payload).toEqual([{
      date: "2026-07-17",
      infos: [{
        id: "e1",
        content: "CPI YoY",
        market: "US",
        star: 3,
        datetime: 1752710400,
        date: "盘前",
        type: "macrodata",
        data_kv: [{ key: "前值", type: "previous", value: "3.2%" }]
      }]
    }]);
  });

  it("keeps every star and entry when no filters are given, dropping empty groups", () => {
    const payload = buildCalendarPayload(groups, { stars: [], count: undefined }) as Array<{ infos: unknown[] }>;
    expect(payload).toHaveLength(2);
    expect(payload[0]?.infos).toHaveLength(2);
  });
});

describe("order payloads", () => {
  it("buildOrderListPayload emits order_id/side/quantity/price/status/created_at", () => {
    const payload = buildOrderListPayload([{
      orderId: "1043998",
      symbol: "QQQ.US",
      side: "buy",
      quantity: "1",
      executedQuantity: "1",
      price: "551.64",
      executedPrice: "551.60",
      status: "Filled",
      submittedAtIso: "2026-07-15T14:32:11.000Z",
      updatedAtIso: "2026-07-15T14:32:12.000Z",
      orderType: "LO",
      timeInForce: "Day",
      remark: "OpenClaw paper t-1",
      currency: "USD",
      stockName: "Invesco QQQ Trust"
    }]);
    expect(payload).toEqual([{
      order_id: "1043998",
      symbol: "QQQ.US",
      side: "buy",
      quantity: "1",
      executed_quantity: "1",
      price: "551.64",
      executed_price: "551.60",
      status: "Filled",
      created_at: "2026-07-15T14:32:11.000Z",
      updated_at: "2026-07-15T14:32:12.000Z",
      order_type: "LO",
      time_in_force: "Day",
      remark: "OpenClaw paper t-1",
      currency: "USD",
      stock_name: "Invesco QQQ Trust"
    }]);
  });

  it("buildExecutionsPayload emits order_id per fill", () => {
    expect(buildExecutionsPayload([{
      orderId: "1043998",
      tradeId: "t-77",
      symbol: "QQQ.US",
      tradeDoneAtIso: "2026-07-15T14:32:12.000Z",
      quantity: "1",
      price: "551.60"
    }])).toEqual([{
      order_id: "1043998",
      trade_id: "t-77",
      symbol: "QQQ.US",
      trade_done_at: "2026-07-15T14:32:12.000Z",
      quantity: "1",
      price: "551.60"
    }]);
  });

  it("buildSubmitPayload carries the new order id without a fake status", () => {
    const payload = buildSubmitPayload({ orderId: "1044001" }, {
      kind: "order-submit",
      side: "buy",
      symbol: "QQQ.US",
      quantity: "1",
      price: "551.64",
      orderType: "LO",
      timeInForce: "Day",
      remark: "OpenClaw paper t-9",
      yes: true
    });
    expect(payload).toMatchObject({
      order_id: "1044001",
      symbol: "QQQ.US",
      side: "buy",
      quantity: "1",
      price: "551.64",
      order_type: "LO",
      time_in_force: "Day"
    });
    expect(payload).not.toHaveProperty("status");
  });

  it("buildOrderDetailPayload emits status and executed_price for the executor's deep search", () => {
    const payload = buildOrderDetailPayload({
      orderId: "1044001",
      symbol: "QQQ.US",
      side: "buy",
      quantity: "1",
      executedQuantity: "1",
      price: "551.64",
      executedPrice: "551.60",
      status: "Filled",
      submittedAtIso: "2026-07-15T14:32:11.000Z",
      msg: "",
      remark: "OpenClaw paper t-9"
    });
    expect(payload).toMatchObject({
      order_id: "1044001",
      status: "Filled",
      executed_price: "551.60",
      symbol: "QQQ.US"
    });
  });

  it("omits null-ish prices instead of emitting '-' placeholders", () => {
    const payload = buildOrderDetailPayload({
      orderId: "1",
      symbol: "QQQ.US",
      side: "buy",
      status: "New"
    }) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("executed_price");
    expect(payload).not.toHaveProperty("price");
  });
});
