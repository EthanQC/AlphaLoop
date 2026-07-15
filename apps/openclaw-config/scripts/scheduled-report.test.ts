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
import { validateNarrativeNumbers, validateReportMarkdown } from "./report-quality.mjs";

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

  // Phase 4 Task 7: three DISTINCT, non-overlapping stories (rather than the
  // single article this fixture used to carry) from three different
  // sources/languages - clusterArticles (news-engine.mjs) groups by raw
  // title-token similarity, so three unrelated headlines cluster into three
  // separate events, which in turn is what lets the render tests below
  // exercise the "### 多源新闻（事件聚类）" section's per-event compat-detail
  // line (report-quality.mjs's news.detail_depth needs >=3 such lines) and
  // its source-diversity/chinese-ratio tail stats against realistic data
  // instead of a single-event edge case.
  const marketNews = [
    {
      id: "news-1",
      symbol: "QQQ.US",
      title: "美联储维持利率不变",
      titleZh: "美联储维持利率不变",
      url: "https://cls.cn/telegraph/1",
      publishedAt: "2026-07-13T21:55:00.000Z",
      publishedAtMs: Date.parse("2026-07-13T21:55:00.000Z"),
      source: "rsshub-cls",
      sourceName: "财联社",
      publisher: "财联社"
    },
    {
      id: "news-2",
      symbol: "QQQ.US",
      title: "Wall Street Extends Rally on Tech Strength",
      titleZh: "美股在科技板块带动下延续上涨",
      url: "https://finance.yahoo.com/example-2",
      publishedAt: "2026-07-13T20:30:00.000Z",
      publishedAtMs: Date.parse("2026-07-13T20:30:00.000Z"),
      source: "yahoo-finance-rss",
      sourceName: "Yahoo Finance",
      publisher: "Barchart"
    },
    {
      id: "news-3",
      symbol: "NVDA.US",
      title: "Fed Officials Signal Cautious Approach on Rate Decisions",
      titleZh: "美联储官员释放谨慎加息信号",
      url: "https://reuters.com/example-3",
      publishedAt: "2026-07-13T19:50:00.000Z",
      publishedAtMs: Date.parse("2026-07-13T19:50:00.000Z"),
      source: "google-news-rss",
      sourceName: "Google News",
      publisher: "Reuters"
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
      newsSourceBreakdown: "财联社 1 条；Barchart 1 条；Reuters 1 条",
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

describe("Phase 4 Task 7: clustered news section (### 多源新闻（事件聚类）)", () => {
  it("clusters the 3 fixture articles into 3 events and passes the full quality gate (sync + facts.numeric_match)", async () => {
    const { buildDailyFacts } = await import("./report-facts.mjs");
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = buildFixtureData();
    const markdown = scheduledReport.renderDailyReport(info, data);

    expect(markdown).toContain("### 多源新闻（事件聚类）");
    // 3 distinct, non-overlapping stories -> 3 clustered event cards, each
    // contributing its own compat-detail line (news.detail_depth's >=3
    // minimum) and its own source label (news.source_diversity_v2's >=3
    // minimum).
    expect(markdown).toContain("#### 1.");
    expect(markdown).toContain("#### 2.");
    expect(markdown).toContain("#### 3.");
    expect(markdown).toContain("- 新闻来源分布：");
    expect(markdown).toContain("- 非券商源占比：");
    expect(markdown).toContain("- 中文源占比：");

    const syncResult = validateReportMarkdown(markdown, { kind: "daily" });
    expect(syncResult.ok).toBe(true);
    expect(syncResult.failures).toEqual([]);

    // facts.numeric_match: build the SAME daily_facts the real prepareReport
    // pipeline would persist from this fixture's snapshot/quote, and confirm
    // the rendered narrative's numbers (净资产/现金/暴露%/剩余预算/QQQ 价与
    // 涨跌%) agree with them within tolerance - proving the two independent
    // computations (render vs. facts) never drifted apart for this fixture.
    const factsArray = buildDailyFacts({
      snapshot: data.officialPaperSnapshot,
      qqqQuote: data.qqqQuote,
      macroEntries: data.macroEvents,
      tradingDay: info.label
    });
    const factsMap = Object.fromEntries(factsArray.map((fact) => [fact.factKey, fact]));
    const numericResult = validateNarrativeNumbers(markdown, factsMap);
    expect(numericResult.ok).toBe(true);
    expect(numericResult.failures).toEqual([]);
  });

  it("renders the header disclosure marker and evidence-section warnings bullet when news search is degraded", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = {
      ...buildFixtureData(),
      newsSearchDegraded: true,
      newsSearchReason: "OpenClaw restricted-agent search backend requires P10 ignition"
    };
    const markdown = scheduledReport.renderDailyReport(info, data);

    // Header marker (Global Constraints / 07-03:213 semantic) - must appear
    // before the "## 1." section, i.e. near the very top of the document.
    expect(markdown.indexOf("⚠ agent 检索不可用（L1-only 模式）")).toBeGreaterThan(-1);
    expect(markdown.indexOf("⚠ agent 检索不可用（L1-only 模式）")).toBeLessThan(markdown.indexOf("## 1."));
    expect(markdown).toContain("OpenClaw restricted-agent search backend requires P10 ignition");
    // Matching warnings-entry disclosure inside "### 证据与来源".
    expect(markdown).toContain("新闻检索降级：agent 检索不可用（L1-only 模式）");
  });

  it("omits the degradation marker/bullet entirely when news search is not degraded", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, buildFixtureData());

    expect(markdown).not.toContain("⚠ agent 检索不可用");
    expect(markdown).not.toContain("新闻检索降级");
  });

  it("renders the weekly-only L3 deep-dive subsection (事件/证据/反方证据/不确定性) when l3DeepDive carries real results", async () => {
    const info = scheduledReport.resolveReportWindow("weekly", "2026-07-14");
    const baseData = buildFixtureData();
    // Cluster the fixture's own articles first so the L3 result's
    // eventClusterKey lines up with a real rendered card (same clustering
    // renderWeeklyReport itself will fall back to computing).
    const newsEngine = await import("./news-engine.mjs");
    const events = newsEngine
      .clusterArticles(baseData.marketNews)
      .map((cluster) => newsEngine.buildEventFromCluster(cluster, baseData.trackedSymbols));
    const targetEvent = events[0];

    const data = {
      ...baseData,
      newsEvents: events,
      l3DeepDive: {
        events: [
          {
            eventClusterKey: targetEvent.clusterKey,
            evidence: [{ title: "独立信源核实同一事件", publisher: "示例通讯社", url: "https://example.com/evidence-1" }],
            analysis: { direction: targetEvent.impact.direction, uncertainty: "medium" },
            counterEvidence: "not_found"
          }
        ],
        callsUsed: 3,
        droppedNoUrl: 0,
        droppedNotChinese: 0,
        degraded: false,
        degradedReason: null
      }
    };
    const markdown = scheduledReport.renderWeeklyReport(info, data);

    expect(markdown).toContain("### 深度核查（L3，周报专属）");
    expect(markdown).toContain(targetEvent.titleZh);
    expect(markdown).toContain("not_found（未找到反方证据）");
    expect(markdown).toContain("不确定性：中");
  });

  it("omits the L3 subsection entirely for the daily report (l3DeepDive.skipped)", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = { ...buildFixtureData(), l3DeepDive: { skipped: true, reason: "l3_disabled_daily" } };
    const markdown = scheduledReport.renderDailyReport(info, data);

    expect(markdown).not.toContain("### 深度核查");
  });

  it("shows an honest empty state when no events cluster out of an empty marketNews list", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = { ...buildFixtureData(), marketNews: [], newsWarnings: ["占位：测试用例强制清空新闻"] };
    const markdown = scheduledReport.renderDailyReport(info, data);

    expect(markdown).toContain("本窗口没有聚类出可用新闻事件");
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
