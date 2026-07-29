// Task 20 (2026-07-28 spec-drift plan): the earnings half of requirements
// §3.1's 「宏观与财报日历」.
//
// FIXTURE PROVENANCE - these are not invented shapes. Every `earningsCalendar`
// row below was captured on 2026-07-30 from the real
// https://finnhub.io/api/v1/calendar/earnings using the deployed mini's own
// FINNHUB_API_KEY, verbatim apart from being pasted here:
//
//   curl "…/calendar/earnings?from=2026-07-30&to=2026-11-30&symbol=NVDA"
//     -> {"earningsCalendar":[{"symbol":"NVDA","date":"2026-11-17","hour":"amc",
//          "quarter":3,"year":2027,"epsEstimate":2.3985,"epsActual":null,
//          "revenueEstimate":105311630623,"revenueActual":null},
//         {"symbol":"NVDA","date":"2026-08-26","hour":"amc","quarter":2,
//          "year":2027,"epsEstimate":2.1274,…}]}
//   …&symbol=TSM
//     -> [{"symbol":"2330.TW","date":"2026-10-14","hour":"amc","quarter":3,
//          "year":2026,"epsEstimate":28.6598,…}]
//
// Two properties of the real producer that the code depends on and that a
// hand-authored fixture would have quietly gotten wrong: rows arrive UNSORTED
// (NVDA's 11-17 came before its 08-26), and Finnhub answers a US ticker with
// its primary listing's symbol where those differ (TSM -> 2330.TW).
import { describe, expect, it, vi } from "vitest";

import {
  UNKNOWN_EARNINGS_HOUR_LABEL,
  fetchEarningsCalendar,
  normalizeEarningsCalendarPayload,
  normalizeEarningsRow,
  renderEarningsCalendarLines,
  renderEarningsLine
} from "./report-earnings.mjs";

const NVDA_ROWS = [
  {
    symbol: "NVDA",
    date: "2026-11-17",
    hour: "amc",
    quarter: 3,
    year: 2027,
    epsEstimate: 2.3985,
    epsActual: null,
    revenueEstimate: 105311630623,
    revenueActual: null
  },
  {
    symbol: "NVDA",
    date: "2026-08-26",
    hour: "amc",
    quarter: 2,
    year: 2027,
    epsEstimate: 2.1274,
    epsActual: null,
    revenueEstimate: 93606383310,
    revenueActual: null
  }
];

const TSM_ROWS = [
  {
    symbol: "2330.TW",
    date: "2026-10-14",
    hour: "amc",
    quarter: 3,
    year: 2026,
    epsEstimate: 28.6598,
    epsActual: null,
    revenueEstimate: 1472221986525,
    revenueActual: null
  }
];

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => payload };
}

describe("normalizeEarningsCalendarPayload", () => {
  it("orders the real (unsorted) Finnhub payload by date ascending", () => {
    const entries = normalizeEarningsCalendarPayload(NVDA_ROWS, { queriedSymbol: "NVDA.US" });

    expect(entries.map((entry) => entry.date)).toEqual(["2026-08-26", "2026-11-17"]);
  });

  it("keeps BOTH the queried pool symbol and the symbol Finnhub answered with", () => {
    const [entry] = normalizeEarningsCalendarPayload(TSM_ROWS, { queriedSymbol: "TSM.US" });

    expect(entry?.queriedSymbol).toBe("TSM.US");
    expect(entry?.symbol).toBe("2330.TW");
  });

  it("drops a row with no usable date rather than defaulting one", () => {
    expect(normalizeEarningsRow({ symbol: "AAPL", date: "" })).toBeNull();
    expect(normalizeEarningsRow({ symbol: "AAPL", date: "soon" })).toBeNull();
    expect(normalizeEarningsRow(null)).toBeNull();
  });

  it("leaves an absent estimate null - never 0", () => {
    const [entry] = normalizeEarningsCalendarPayload(
      [{ symbol: "AMZN", date: "2026-08-06", hour: "", epsEstimate: null, revenueEstimate: undefined }],
      { queriedSymbol: "AMZN.US" }
    );

    expect(entry?.epsEstimate).toBeNull();
    expect(entry?.revenueEstimate).toBeNull();
  });
});

describe("renderEarningsLine", () => {
  it("renders date, session, symbol, fiscal period and the estimates in Chinese", () => {
    const [entry] = normalizeEarningsCalendarPayload([NVDA_ROWS[1]], { queriedSymbol: "NVDA.US" });
    const line = renderEarningsLine(entry);

    expect(line).toContain("2026-08-26");
    expect(line).toContain("盘后");
    expect(line).toContain("NVDA.US");
    expect(line).toContain("2027 财年 Q2 财报");
    expect(line).toContain("EPS 预期 2.1274");
    expect(line).toContain("营收预期 936.06 亿");
    // Nothing has been reported yet, so no "actual" of any kind may appear.
    expect(line).not.toContain("实际");
  });

  it("names the Finnhub-side symbol when it is a genuinely different listing", () => {
    const [entry] = normalizeEarningsCalendarPayload(TSM_ROWS, { queriedSymbol: "TSM.US" });

    expect(renderEarningsLine(entry)).toContain("TSM.US（Finnhub 代码 2330.TW）");
  });

  it("does not annotate the ordinary case where only the .US suffix differs", () => {
    // Observed against the live pool on 2026-07-30: AMZN and NVDA (the two
    // pool symbols with a row in the window) came back as the bare ticker, so a
    // raw string comparison would tag every normal row with a meaningless
    // "AMZN.US（Finnhub 代码 AMZN）".
    const [entry] = normalizeEarningsCalendarPayload(
      [{ symbol: "AMZN", date: "2026-07-30", hour: "amc", quarter: 2, year: 2026, epsEstimate: 1.8556, revenueEstimate: 200176733847 }],
      { queriedSymbol: "AMZN.US" }
    );
    const line = renderEarningsLine(entry);

    expect(line).toContain("AMZN.US");
    expect(line).not.toContain("Finnhub 代码");
  });

  it("says the session is unannounced rather than guessing 盘前/盘后", () => {
    const [entry] = normalizeEarningsCalendarPayload(
      [{ symbol: "GOOG", date: "2026-08-04", hour: "", quarter: 2, year: 2026 }],
      { queriedSymbol: "GOOG.US" }
    );

    expect(renderEarningsLine(entry)).toContain(UNKNOWN_EARNINGS_HOUR_LABEL);
  });

  it("says 未提供 for a missing estimate instead of printing a zero", () => {
    const [entry] = normalizeEarningsCalendarPayload(
      [{ symbol: "AMZN", date: "2026-08-06", hour: "amc", quarter: 2, year: 2026 }],
      { queriedSymbol: "AMZN.US" }
    );
    const line = renderEarningsLine(entry);

    expect(line).toContain("EPS 预期 未提供");
    expect(line).toContain("营收预期 未提供");
    expect(line).not.toMatch(/预期 0(?:\D|$)/u);
  });
});

describe("renderEarningsCalendarLines - honest disclosure, never an empty section", () => {
  it("states that nothing was queried, and why, when the key is missing", async () => {
    const result = await fetchEarningsCalendar({
      symbols: ["NVDA.US"],
      from: "2026-07-30",
      to: "2026-08-29",
      lookaheadDays: 30,
      env: {}
    });

    expect(result.skippedReason).toContain("FINNHUB_API_KEY");
    const lines = renderEarningsCalendarLines(result);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("财报日历本次未查询");
    expect(lines[0]).toContain("FINNHUB_API_KEY");
  });

  it("distinguishes 'no company reports in this window' from 'we did not look' by naming the queried symbols", () => {
    const lines = renderEarningsCalendarLines({
      entries: [],
      queriedSymbols: ["NVDA.US", "AMZN.US"],
      lookaheadDays: 30,
      warnings: []
    });

    expect(lines[0]).toContain("未来 30 天");
    expect(lines[0]).toContain("没有已确认的财报日期");
    expect(lines[0]).toContain("NVDA.US、AMZN.US");
  });

  it("keeps a failed symbol visible as a degradation line beside the symbols that answered", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      if (String(url).includes("symbol=AMZN")) {
        throw new Error("connect ETIMEDOUT");
      }
      return jsonResponse({ earningsCalendar: NVDA_ROWS });
    });

    const result = await fetchEarningsCalendar({
      symbols: ["NVDA.US", "AMZN.US"],
      from: "2026-07-30",
      to: "2026-08-29",
      lookaheadDays: 30,
      env: { FINNHUB_API_KEY: "test-key-abcdef" },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.entries).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);

    const lines = renderEarningsCalendarLines(result);
    expect(lines.some((line) => line.includes("2026-08-26"))).toBe(true);
    expect(lines.some((line) => line.includes("财报日历降级：AMZN.US 财报日期读取失败"))).toBe(true);
  });

  it("never lets the API key reach a warning line, even when the transport echoes it back", async () => {
    const apiKey = "sk-live-finnhub-0987654321";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`request failed for https://finnhub.io/api/v1/calendar/earnings?token=${apiKey}`);
    });

    const result = await fetchEarningsCalendar({
      symbols: ["NVDA.US"],
      from: "2026-07-30",
      to: "2026-08-29",
      lookaheadDays: 30,
      env: { FINNHUB_API_KEY: apiKey },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const rendered = renderEarningsCalendarLines(result).join("\n");
    expect(rendered).not.toContain(apiKey);
    expect(rendered).toContain("<redacted>");
  });

  it("merges every symbol's rows into one date-ordered list", async () => {
    const fetchImpl = vi.fn(async (url: URL) =>
      jsonResponse({ earningsCalendar: String(url).includes("symbol=TSM") ? TSM_ROWS : NVDA_ROWS })
    );

    const result = await fetchEarningsCalendar({
      symbols: ["TSM.US", "NVDA.US"],
      from: "2026-07-30",
      to: "2026-11-30",
      lookaheadDays: 123,
      env: { FINNHUB_API_KEY: "test-key-abcdef" },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.entries.map((entry) => entry.date)).toEqual(["2026-08-26", "2026-10-14", "2026-11-17"]);
  });

  it("sends the key as a header and the window as query params - the shape the live API answered 200 to", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ earningsCalendar: [] }));

    await fetchEarningsCalendar({
      symbols: ["NVDA.US"],
      from: "2026-07-30",
      to: "2026-08-29",
      lookaheadDays: 30,
      env: { FINNHUB_API_KEY: "test-key-abcdef" },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, { headers: Record<string, string> }];
    expect(url.pathname).toBe("/api/v1/calendar/earnings");
    expect(url.searchParams.get("symbol")).toBe("NVDA");
    expect(url.searchParams.get("from")).toBe("2026-07-30");
    expect(url.searchParams.get("to")).toBe("2026-08-29");
    expect(init.headers["X-Finnhub-Token"]).toBe("test-key-abcdef");
    expect(String(url)).not.toContain("test-key-abcdef");
  });
});
