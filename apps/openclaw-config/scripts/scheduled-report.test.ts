// Task H7 (2026-07-14 legacy audit): scheduled-report.mjs previously ran its
// entire CLI dispatch unconditionally at module load time (parsing real
// process.argv), which made the module impossible to `import` for testing
// at all - see the isMainModule guard this task added. This is the first
// direct test coverage the module has ever had.
import { describe, expect, it } from "vitest";

import {
  buildDegradedQuoteSnapshot,
  buildTrackedSymbols,
  normalizeMacroCalendarPayload,
  normalizeOfficialPaperSnapshot,
  normalizeQuotePayload
} from "./report-data.mjs";

const scheduledReport = await import("./scheduled-report.mjs");

function buildFixtureData() {
  const fetchedAt = "2026-07-14T05:00:00.000Z";
  const officialPaperSnapshot = normalizeOfficialPaperSnapshot({
    check: {
      session: { token: "valid" },
      region: { active: "global", cached: "global" },
      connectivity: { global: { ok: true } }
    },
    assets: [
      { net_assets: "100000", total_cash: "20000", buy_power: "50000", currency: "USD", risk_level: "low" }
    ],
    positions: [
      { symbol: "QQQ.US", name: "Invesco QQQ", market: "US", currency: "USD", quantity: "20", available: "20", cost_price: "600" },
      { symbol: "NVDA.US", name: "NVIDIA", market: "US", currency: "USD", quantity: "10", available: "10", cost_price: "100" }
    ],
    fetchedAt
  });

  const qqqQuote = normalizeQuotePayload(
    { symbol: "QQQ.US", last: "721.34", prev_close: "717.12", open: "718", high: "725", low: "716", volume: "1000000" },
    "QQQ.US"
  );

  const marketNews = [
    {
      id: "news-1",
      symbol: "QQQ.US",
      title: "Stocks Rally on Hopes for a Truce",
      titleZh: "美股在停火预期和科技股支撑下反弹",
      url: "https://finance.yahoo.com/example",
      publishedAt: "2026-07-13T21:55:00.000Z",
      publishedAtMs: Date.parse("2026-07-13T21:55:00.000Z"),
      source: "yahoo-finance-rss",
      sourceName: "Yahoo Finance",
      publisher: "Barchart"
    }
  ];

  const macroEvents = normalizeMacroCalendarPayload({
    list: [
      {
        date: "2026-07-18",
        infos: [
          {
            id: "evt-1",
            content: "美国费城联储制造业指数",
            date: "20:30",
            market: "US",
            star: 2,
            type: "macrodata",
            datetime: "1752863400",
            data_kv: [{ key: "前值", value: "--" }, { key: "预测", value: "12" }]
          }
        ]
      }
    ]
  });

  const trackedSymbols = buildTrackedSymbols(officialPaperSnapshot.positions);

  return {
    executionRows: [],
    officialPaperSnapshot,
    qqqQuote,
    trackedSymbols,
    marketNews,
    newsWarnings: [],
    longbridgeWarnings: [],
    macroEvents,
    macroWarnings: [],
    sourceEvidence: {
      fetchedAt,
      accountMode: officialPaperSnapshot.accountMode,
      longbridgeSessionStatus: officialPaperSnapshot.check.sessionStatus,
      longbridgeOkRegions: officialPaperSnapshot.check.okRegions,
      assetRows: officialPaperSnapshot.assets.length,
      officialPositions: officialPaperSnapshot.positions.length,
      trackedSymbols,
      newsCount: marketNews.length,
      newsSourceBreakdown: "Barchart 1 条",
      newsWarnings: [],
      longbridgeWarnings: [],
      macroEventsCount: macroEvents.length,
      macroWarnings: [],
      quoteSymbol: "QQQ.US",
      quoteTimestamp: null
    }
  };
}

describe("seam test: a genuinely-generated report always satisfies its own completeness check (task H7)", () => {
  it("renderDailyReport's output passes isPreparedReportMarkdownComplete", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, buildFixtureData());

    expect(scheduledReport.isPreparedReportMarkdownComplete(markdown)).toBe(true);
    // Pin the specific marker text so a future accidental rewrite of the
    // data-source line regresses loudly instead of silently drifting again.
    expect(markdown).toContain("长桥行情（QQQ 行情）");
  });

  it("renderWeeklyReport's output passes isPreparedReportMarkdownComplete", () => {
    const info = scheduledReport.resolveReportWindow("weekly", "2026-07-14");
    const markdown = scheduledReport.renderWeeklyReport(info, buildFixtureData());

    expect(scheduledReport.isPreparedReportMarkdownComplete(markdown)).toBe(true);
  });

  it("a report missing even one of the 5 markers is correctly flagged incomplete (the check side still works)", () => {
    expect(scheduledReport.isPreparedReportMarkdownComplete("# OpenClaw 日报 2026-07-14\n\n长桥官方模拟盘 多源新闻 宏观日历 QQQ 行情")).toBe(false);
  });
});

describe("fetchMacroCalendar degrades instead of crashing the whole report (task H7)", () => {
  const originalCliPath = process.env.LONGBRIDGE_CLI_PATH;
  const originalAttempts = process.env.LONGBRIDGE_READ_RETRY_ATTEMPTS;

  it("returns a degraded {entries: [], warnings} shape when the Longbridge CLI fails instead of throwing", async () => {
    const { mkdtempSync, chmodSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "openclaw-macro-stub-"));
    const stubPath = join(dir, "longbridge-stub.mjs");
    writeFileSync(stubPath, `#!/usr/bin/env node
process.stderr.write("token expired\\n");
process.exit(1);
`, "utf8");
    chmodSync(stubPath, 0o755);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    process.env.LONGBRIDGE_READ_RETRY_ATTEMPTS = "1";

    try {
      const result = await scheduledReport.fetchMacroCalendar({ label: "2026-07-14" });
      expect(result.entries).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("宏观日历读取失败");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (originalCliPath === undefined) {
        delete process.env.LONGBRIDGE_CLI_PATH;
      } else {
        process.env.LONGBRIDGE_CLI_PATH = originalCliPath;
      }
      if (originalAttempts === undefined) {
        delete process.env.LONGBRIDGE_READ_RETRY_ATTEMPTS;
      } else {
        process.env.LONGBRIDGE_READ_RETRY_ATTEMPTS = originalAttempts;
      }
    }
  });
});

describe("summarizePaperBudget uses positions' real market-value fields (task H7)", () => {
  it("reports no exposure when net assets are unavailable", () => {
    const snapshot = { primaryAsset: { net_assets: "0" }, positions: [] };
    expect(scheduledReport.summarizePaperBudget(snapshot, buildDegradedQuoteSnapshot("QQQ.US"))).toBe("无法计算模拟盘暴露比例");
  });

  it("prices the QQQ position from the live quote and discloses non-QQQ positions priced by cost fallback (no snapshot.quotes field exists to read)", () => {
    const snapshot = {
      primaryAsset: { net_assets: "100000" },
      positions: [
        { symbol: "QQQ.US", quantity: 10, costPrice: 600 },
        { symbol: "NVDA.US", quantity: 5, costPrice: 100 }
      ]
    };
    const qqqQuote = normalizeQuotePayload({ symbol: "QQQ.US", last: "700" }, "QQQ.US");

    const summary = scheduledReport.summarizePaperBudget(snapshot, qqqQuote);

    // marketValue = 10 * 700 (live QQQ) + 5 * 100 (NVDA cost fallback) = 7500
    expect(summary).toContain("模拟盘暴露 7.50%");
    expect(summary).toContain("NVDA.US");
    expect(summary).toContain("非真实市价");
  });

  it("discloses a zero-valued position when cost basis is also missing", () => {
    const snapshot = {
      primaryAsset: { net_assets: "100000" },
      positions: [{ symbol: "TSLA.US", quantity: 5 }]
    };

    const summary = scheduledReport.summarizePaperBudget(snapshot, buildDegradedQuoteSnapshot("QQQ.US"));

    expect(summary).toContain("模拟盘暴露 0.00%");
    expect(summary).toContain("TSLA.US");
  });

  it("does not disclose anything when every position has a live quote", () => {
    const snapshot = {
      primaryAsset: { net_assets: "100000" },
      positions: [{ symbol: "QQQ.US", quantity: 10, costPrice: 600 }]
    };
    const qqqQuote = normalizeQuotePayload({ symbol: "QQQ.US", last: "700" }, "QQQ.US");

    const summary = scheduledReport.summarizePaperBudget(snapshot, qqqQuote);

    expect(summary).not.toContain("非真实市价");
  });
});
