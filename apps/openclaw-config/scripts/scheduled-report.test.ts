// Task H7 (2026-07-14 legacy audit): scheduled-report.mjs previously ran its
// entire CLI dispatch unconditionally at module load time (parsing real
// process.argv), which made the module impossible to `import` for testing
// at all - see the isMainModule guard this task added. This is the first
// direct test coverage the module has ever had.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

import {
  buildDegradedQuoteSnapshot,
  buildTrackedSymbols,
  normalizeMacroCalendarPayload,
  normalizeOfficialPaperSnapshot,
  normalizeQuotePayload
} from "./report-data.mjs";
import { CONFIDENCE_LABELS, parseReportConclusionBox } from "./conclusion-box.mjs";
import { validateNarrativeNumbers, validateReportMarkdown } from "./report-quality.mjs";

const scheduledReport = await import("./scheduled-report.mjs");

// Temp databases only - runtime/trading.sqlite is never touched by a test.
const execScopeDirs: string[] = [];

afterAll(() => {
  while (execScopeDirs.length > 0) {
    const dir = execScopeDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Task 10 (2026-07-28): buildTrackedSymbols now REQUIRES the trading db - the
 * tracked pool is the union of every member's `stock_analysis_targets` plus
 * held positions (§0.4). Fixtures get a real, empty temp database rather than a
 * stub, so the fixture's tracked pool is produced by the same code path
 * production uses.
 */
function makeFixtureDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-scheduled-report-fixture-"));
  execScopeDirs.push(dir);
  return openTradingDatabase(join(dir, "trading.sqlite"));
}

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

  const trackedSymbols = buildTrackedSymbols({ db: makeFixtureDb(), positions: officialPaperSnapshot.positions });

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

  // Task 14 (§0.4 「PDF 已退役」). Both bodies used to state 「投递：飞书摘要卡片 +
  // PDF」 and 「渠道：飞书只发送摘要卡片 + PDF」 - four lines describing a delivery
  // that had not happened for weeks. The mini's own state file recorded
  // `pdfUploaded: false` on every entry while 28 PDFs piled up in reports/.
  //
  // The sentence is now taken FROM the delivery layer
  // (REPORT_DELIVERY_DESCRIPTION, packages/shared-types/notifications.ts), so
  // it is the same string the channels' own doc comment is written against and
  // cannot drift from them independently.
  it("describes delivery the way the delivery layer does, and never mentions a PDF", async () => {
    const { REPORT_DELIVERY_DESCRIPTION } = await import("../../../packages/shared-types/dist/index.js");
    const dailyInfo = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const weeklyInfo = scheduledReport.resolveReportWindow("weekly", "2026-07-14");

    for (const markdown of [
      scheduledReport.renderDailyReport(dailyInfo, buildFixtureData()),
      scheduledReport.renderWeeklyReport(weeklyInfo, buildFixtureData())
    ]) {
      expect(markdown).toContain(`- 投递：${REPORT_DELIVERY_DESCRIPTION}。`);
      expect(markdown).toContain(`- 渠道：${REPORT_DELIVERY_DESCRIPTION}。`);
      expect(markdown).not.toMatch(/PDF/iu);
    }
  });

  // Task 23 (2026-07-30): the daily report's 宏观日历 section must render
  // Chinese labels. THE FIXTURE HERE IS THE REAL PRODUCER'S SHAPE, not the
  // all-Chinese one buildFixtureData carries: Longbridge's US macro calendar
  // sends English `content` and English `data_kv` keys, which is why the live
  // 2026-07-30 daily on the mini shipped
  // 「美国 United States, Policy Rates, Fed Funds Target Rate（Previous3.625 …）」
  // inside an otherwise all-Chinese report while every test stayed green.
  it("renders macro calendar rows in Chinese with the English original in parentheses", async () => {
    const { normalizeMacroCalendarPayload } = await import("./report-data.mjs");
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = buildFixtureData();
    data.macroEvents = normalizeMacroCalendarPayload({
      list: [
        {
          date: "2026-07-14",
          infos: [
            {
              id: "evt-real-1",
              content: "United States, Jobless Claims, National, Initial",
              date: "20:30",
              market: "US",
              star: 2,
              type: "macrodata",
              datetime: "1752863400",
              data_kv: [
                { key: "Previous", value: "187" },
                { key: "Estimate", value: "200" },
                { key: "Actual", value: "--" }
              ]
            },
            {
              id: "evt-real-2",
              content: "United States, Widget Shipments, Total",
              date: "20:30",
              market: "US",
              star: 2,
              type: "macrodata",
              datetime: "1752863400",
              data_kv: [{ key: "Previous", value: "1.2" }]
            }
          ]
        }
      ]
    });

    const markdown = scheduledReport.renderDailyReport(info, data);

    expect(markdown).toContain("初请失业金人数（United States, Jobless Claims, National, Initial）");
    expect(markdown).toContain("前值 187 / 预期 200 / 实际 --");
    // The exact live defect: a bare English name, and a glued key+value.
    expect(markdown).not.toContain("Previous187");
    expect(markdown).not.toMatch(/美国 United States, Jobless/u);
    // An indicator with no Chinese mapping says so instead of printing
    // English as if it were the label.
    expect(markdown).toContain("暂无中文名（英文原名：United States, Widget Shipments, Total）");
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
    // the rendered narrative's numbers agree with them within tolerance -
    // proving the two independent computations (render vs. facts) never
    // drifted apart for this fixture. Task 4 (2026-07-28) took the paper.*
    // numbers (净资产/现金/暴露%/剩余预算) out of the PUBLIC body, so what this
    // still covers here is the QQQ pair; the paper.* patterns keep their
    // coverage in report-quality.test.ts against LEAKY_PERSONAL_REPORT.
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

  it("renders the L3 deep-dive subsection (事件/证据/反方证据/不确定性) when l3DeepDive carries real results", async () => {
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

    expect(markdown).toContain("### 事件深挖（L3 深度核查）");
    expect(markdown).toContain(targetEvent.titleZh);
    expect(markdown).toContain("not_found（未找到反方证据）");
    expect(markdown).toContain("不确定性：中");
    // Task 20: the heading no longer claims 周报专属 - §3.1 puts 事件深挖 in the
    // DAILY report too.
    expect(markdown).not.toContain("周报专属");

    // Same payload through the DAILY renderer renders the same section.
    const dailyInfo = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const dailyMarkdown = scheduledReport.renderDailyReport(dailyInfo, data);
    expect(dailyMarkdown).toContain("### 事件深挖（L3 深度核查）");
    expect(dailyMarkdown).toContain(targetEvent.titleZh);
  });

  it("omits the L3 subsection only when the deep dive was actually skipped", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = { ...buildFixtureData(), l3DeepDive: { skipped: true, reason: "l3_disabled" } };
    const markdown = scheduledReport.renderDailyReport(info, data);

    expect(markdown).not.toContain("### 事件深挖");
  });

  it("says 今日/本周 - not always 本周 - when the deep dive found no high-impact event", () => {
    const emptyL3 = { events: [], callsUsed: 0, degraded: false, degradedReason: null };
    const dailyInfo = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const weeklyInfo = scheduledReport.resolveReportWindow("weekly", "2026-07-14");
    const data = { ...buildFixtureData(), l3DeepDive: emptyL3 };

    expect(scheduledReport.renderDailyReport(dailyInfo, data)).toContain("今日没有触发深度核查的高影响事件");
    expect(scheduledReport.renderWeeklyReport(weeklyInfo, data)).toContain("本周没有触发深度核查的高影响事件");
  });

  // Task 20 (2026-07-28 spec-drift plan), requirements §3.1「事件深挖（top 2-3，
  // 每事件 ≤5 轮）」/ §3.3「深挖 3-5 个每事件 ≤8 轮」.
  //
  // This drives the REAL runL3DeepDive with the REAL budget object
  // scheduled-report.mjs hands it, against a counting fake backend - so it
  // measures what the daily run would actually spend, rather than asserting
  // that a constant equals a number.
  it("spends the daily budget the spec names (top 3 events, <=5 rounds each) and the weekly its larger one", async () => {
    const agentSearch = await import("./news-agent-search.mjs");
    const makeEvent = (clusterKey: string, affected: string[]) => ({
      clusterKey,
      titleZh: `事件 ${clusterKey}`,
      summaryZh: "摘要",
      impact: { direction: "bullish", affected, reason: "r" },
      firstPublishedAt: "2026-07-14T00:00:00.000Z",
      lastPublishedAt: "2026-07-14T00:00:00.000Z",
      sources: []
    });
    // Six candidate events, each with more affected symbols than any per-event
    // budget can pay for, so both the event cap and the round cap bite.
    const events = Array.from({ length: 6 }, (_, i) =>
      makeEvent(`e${i}`, Array.from({ length: 10 }, (_, j) => `S${i}_${j}`))
    );

    const dailyBackend = vi.fn(async () => ({ results: [] }));
    const daily = await agentSearch.runL3DeepDive({
      searchBackend: dailyBackend,
      events,
      enabled: true,
      ...scheduledReport.L3_BUDGETS.daily
    });
    expect(daily.events).toHaveLength(3);
    expect(dailyBackend).toHaveBeenCalledTimes(3 * 5);

    const weeklyBackend = vi.fn(async () => ({ results: [] }));
    const weekly = await agentSearch.runL3DeepDive({
      searchBackend: weeklyBackend,
      events,
      enabled: true,
      ...scheduledReport.L3_BUDGETS.weekly
    });
    expect(weekly.events).toHaveLength(5);
    expect(weeklyBackend).toHaveBeenCalledTimes(5 * 8);
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
  const originalRateLimitDir = process.env.LONGBRIDGE_RATE_LIMIT_DIR;

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
    // H1 (2026-07-28): the rate limiter records this call BEFORE the CLI runs,
    // and fetchMacroCalendar threads no options, so without this the degraded-
    // path test rewrote the repo's real runtime/longbridge-rate-limit-quote.json
    // - the live ledger on the deploy machine. Caught by
    // test/runtime-write-guard.ts, which fails any test that touches runtime/.
    process.env.LONGBRIDGE_RATE_LIMIT_DIR = mkdtempSync(join(tmpdir(), "openclaw-macro-ratelimit-"));

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
      if (originalRateLimitDir === undefined) {
        delete process.env.LONGBRIDGE_RATE_LIMIT_DIR;
      } else {
        process.env.LONGBRIDGE_RATE_LIMIT_DIR = originalRateLimitDir;
      }
    }
  });
});

// Task 4 (2026-07-28 spec-drift plan) - 2026-07-12 requirements §3.1: the
// PUBLIC daily/weekly report is "不含任何个人持仓与策略内容". renderCoreSummary
// used to put 净资产/现金/持仓/剩余预算/模拟盘暴露 straight into the body every
// reader of /daily/<date> sees. With one member nothing leaked; with two, B
// would read A's account. The data is not deleted - it moves to the per-owner
// personal page, which is why the renderers below are still exported and still
// render it in full.
describe("Task 4: the public daily/weekly body carries no personal holdings or account data", () => {
  for (const kind of ["daily", "weekly"] as const) {
    it(`keeps 净资产/现金/持仓/剩余预算/模拟盘暴露 out of the public ${kind} body`, () => {
      const window = scheduledReport.resolveReportWindow(kind, "2026-07-14");
      const markdown = kind === "daily"
        ? scheduledReport.renderDailyReport(window, buildFixtureData())
        : scheduledReport.renderWeeklyReport(window, buildFixtureData());

      expect(markdown).not.toContain("净资产");
      expect(markdown).not.toContain("现金");
      expect(markdown).not.toContain("购买力");
      expect(markdown).not.toContain("模拟盘暴露");
      expect(markdown).not.toMatch(/剩余[^\n]*预算/u);
      // "持仓" as a data label ("当前持仓 QQQ.US …", "官方持仓 2 个") and the
      // per-position bullet renderOfficialPaperSnapshot emits.
      expect(markdown).not.toMatch(/持仓\s*[：:]?\s*[0-9A-Z]/u);
      expect(markdown).not.toContain("QQQ.US（纳指 100 交易型开放式指数基金）");

      const result = validateReportMarkdown(markdown, { kind });
      expect(result.failures.some((failure) => failure.startsWith("report.no_personal_content"))).toBe(false);
      expect(result).toEqual({ ok: true, failures: [] });
    });
  }

  it("still ships the public-value sections (行情/新闻/宏观/QQQ 基准)", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(window, buildFixtureData());

    expect(markdown).toContain("### 多源新闻（事件聚类）");
    expect(markdown).toContain("### 宏观日历");
    expect(markdown).toContain("## 4. QQQ 固定观察");
    expect(markdown).toContain("最新价：721.34");
    // The removal is disclosed rather than silent - the reader is told why the
    // account block is absent, not left to assume the data was unavailable.
    expect(markdown).toContain("账户与仓位明细不进入公共报告");
  });

  it("still renders the account snapshot in full for the per-owner personal page (moved, not lost)", () => {
    const data = buildFixtureData();

    const personal = scheduledReport.renderOfficialPaperSnapshot(data.officialPaperSnapshot);

    expect(personal).toContain("净资产：100,000.00");
    expect(personal).toContain("现金：20,000.00");
    expect(personal).toContain("QQQ.US（纳指 100 交易型开放式指数基金）");
    expect(scheduledReport.summarizeOfficialAccount(data.officialPaperSnapshot)).toContain("净资产 100,000.00");
    expect(scheduledReport.summarizeOfficialPositions(data.officialPaperSnapshot.positions)).toContain("QQQ.US");
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

// 2026-07-26: `node scheduled-report.mjs daily run` crashed with
// "ReferenceError: Cannot access 'CHANNEL_LABELS' before initialization"
// inside deriveChannelLabel for every run that clustered at least one news
// event - the CLI dispatch's top-level `await` used to suspend module
// evaluation ~980 lines ABOVE that const, so the whole pipeline ran while it
// was still in its temporal dead zone (cli-entry-order.test.ts pins the
// ordering invariant that makes this impossible now). The fix only MOVED the
// dispatch, so these pin that the label mapping the crash surfaced through
// still renders exactly as before.
describe("news channel labels (deriveChannelLabel)", () => {
  function withNewsEvents(sources: Array<Record<string, unknown>>) {
    return sources.map((source, index) => ({
      clusterKey: `cluster-${index}`,
      titleZh: `事件 ${index}`,
      summaryZh: `事件 ${index} 摘要`,
      impact: { direction: "neutral", affected: ["QQQ.US"], reason: "测试事件" },
      sources: [source]
    }));
  }

  it("maps known origins to their Chinese channel labels and leaves unknown origins verbatim", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, {
      ...buildFixtureData(),
      newsEvents: withNewsEvents([
        { origin: "rsshub-cls", publisher: "", titleRaw: "美联储维持利率不变", url: "https://example.com/a", publishedAt: "2026-07-14T01:00:00.000Z", lang: "zh" },
        { origin: "openclaw-l2-search", publisher: "", titleRaw: "检索补充", url: "https://example.com/b", publishedAt: "2026-07-14T00:50:00.000Z", lang: "zh" },
        { origin: "an-origin-with-no-mapping", publisher: "", titleRaw: "Unmapped origin", url: "https://example.com/c", publishedAt: "2026-07-14T00:40:00.000Z", lang: "en" }
      ])
    });

    expect(markdown).toContain("渠道：财联社电报");
    expect(markdown).toContain("渠道：OpenClaw 检索");
    // Unmapped origins fall through to the raw origin string - the
    // "未知渠道" default is reserved for a null/undefined origin.
    expect(markdown).toContain("渠道：an-origin-with-no-mapping");
  });

  it("falls back to 未知渠道 when a source carries no origin at all", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, {
      ...buildFixtureData(),
      newsEvents: withNewsEvents([
        { origin: undefined, publisher: "", titleRaw: "无渠道来源", url: "https://example.com/d", publishedAt: "2026-07-14T00:30:00.000Z", lang: "zh" }
      ])
    });

    expect(markdown).toContain("渠道：未知渠道");
  });
});

// 2026-07-28 outage fix: deliverReport no longer throws away a finished report
// because a third-party news link did not answer; it appends this disclosure
// instead (see report-quality.mjs's URL_HARD_FAILURE_THRESHOLD comment).
describe("appendUrlVerificationDisclosure", () => {
  const disclosure = "- 链接核验：抽样 3 条原文链接，其中 1 条未能核验（请求超时），未核验不等于链接已确认有效，也不等于已确认失效。";

  it("places the disclosure with the report's other tail-statistics lines", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, buildFixtureData());

    const disclosed = scheduledReport.appendUrlVerificationDisclosure(markdown, disclosure);
    const lines = disclosed.split("\n");
    const ratioIndex = lines.findIndex((line: string) => line.startsWith("- 中文源占比："));

    expect(ratioIndex).toBeGreaterThan(-1);
    expect(lines[ratioIndex + 1]).toBe(disclosure);
    // The disclosure must not disturb any gate the report already passes.
    expect(validateReportMarkdown(disclosed, { kind: "daily" }).ok).toBe(true);
  });

  it("is idempotent across a re-delivery of an already-disclosed report", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, buildFixtureData());
    const once = scheduledReport.appendUrlVerificationDisclosure(markdown, disclosure);

    expect(scheduledReport.appendUrlVerificationDisclosure(once, disclosure)).toBe(once);
  });

  it("appends at the end rather than dropping the disclosure when there is no statistics block", () => {
    const disclosed = scheduledReport.appendUrlVerificationDisclosure("# 旧格式报告\n\n- 无来源统计\n", disclosure);

    expect(disclosed.trimEnd().endsWith(disclosure)).toBe(true);
  });

  it("returns the markdown untouched when there is nothing to disclose", () => {
    expect(scheduledReport.appendUrlVerificationDisclosure("# 报告", null)).toBe("# 报告");
  });
});

// ---------------------------------------------------------------------------
// C1 (2026-07-28 adversarial review): Task 4 moved the ACCOUNT snapshot out of
// the public body but left renderExecutionDigest expanding the last 8
// execution_reports rows into it, so member two reading /daily/<date> saw
// member one's order flow ("标的 NVDA；方向 买入；数量 300；参考价格 …"), plus
// renderCoreSummary's 「- 执行边界」 line publishing per-member trade and
// rejection counts.
//
// These assertions are on the CONTRACT that decides what the group chat sees -
// the markdown renderDailyReport/renderWeeklyReport actually produce - and the
// fixture is deliberately adversarial: it hands the renderers exactly the rows
// the old digest would have printed. A renderer that ignores them passes; a
// renderer that grows the digest back fails.
// ---------------------------------------------------------------------------
function buildDataWithFills() {
  return {
    ...buildFixtureData(),
    executionRows: [
      {
        id: "exec_leak_1",
        category: "trade",
        title: "AMD.US 执行报告",
        body: "标的 AMD.US；方向 buy；数量 300；价格 178.42；ticket=tk_member_one",
        metadata: "{}",
        created_at: "2026-07-14T10:00:00.000Z",
        owner_id: "member_one"
      },
      {
        id: "exec_leak_2",
        category: "trade",
        title: "META.US 执行报告",
        body: "标的 META.US；方向 sell；数量 120；价格 250.10；rejected 拒绝",
        metadata: "{}",
        created_at: "2026-07-14T11:00:00.000Z",
        owner_id: "member_two"
      },
      {
        id: "exec_leak_3",
        category: "daily",
        title: "每日复盘",
        body: "标的 GOOG.US；方向 buy；数量 50",
        metadata: "{}",
        created_at: "2026-07-14T12:00:00.000Z",
        owner_id: null
      }
    ]
  };
}

describe("C1: the public daily/weekly body carries no per-member fills and no execution counts", () => {
  for (const kind of ["daily", "weekly"] as const) {
    it(`prints no fill detail from execution_reports in the public ${kind} body`, () => {
      const window = scheduledReport.resolveReportWindow(kind, "2026-07-14");
      const markdown = kind === "daily"
        ? scheduledReport.renderDailyReport(window, buildDataWithFills())
        : scheduledReport.renderWeeklyReport(window, buildDataWithFills());

      // AMD/META/GOOG appear NOWHERE in buildFixtureData (its own symbols are
      // QQQ.US and NVDA.US), so any appearance here came from the fills.
      expect(markdown).not.toContain("AMD.US");
      expect(markdown).not.toContain("META.US");
      expect(markdown).not.toContain("GOOG.US");
      // The digest's own composite fact form, "标的 X；方向 买入；数量 N；参考
      // 价格 P。" - narrower than a bare 标的 so the legitimately public
      // 「跟踪标的 QQQ.US」 and 「- 标的：QQQ.US」 (QQQ benchmark) still pass.
      expect(markdown).not.toMatch(/标的\s+[A-Z]+(?:\.US)?；/u);
      expect(markdown).not.toContain("方向 买入");
      expect(markdown).not.toContain("方向 卖出");
      expect(markdown).not.toMatch(/数量\s*\d/u);
      expect(markdown).not.toContain("参考价格");
      // The per-row audit index leaked the execution report id itself.
      expect(markdown).not.toContain("exec_leak_1");
      expect(markdown).not.toContain("审计索引");
      expect(markdown).not.toMatch(/###\s*记录\s*\d/u);
    });

    it(`publishes no trade/rejection counts in the public ${kind} body`, () => {
      const window = scheduledReport.resolveReportWindow(kind, "2026-07-14");
      const markdown = kind === "daily"
        ? scheduledReport.renderDailyReport(window, buildDataWithFills())
        : scheduledReport.renderWeeklyReport(window, buildDataWithFills());

      expect(markdown).not.toMatch(/交易\/执行报告\s*\d+\s*条/u);
      expect(markdown).not.toMatch(/拒绝或未执行\s*\d+\s*条/u);
      expect(markdown).not.toMatch(/共有\s*\d+\s*条执行记录/u);
      // The rule the line exists to state is public and must survive.
      expect(markdown).toContain("没有自动提交实盘订单");
      expect(markdown).toContain("期权自动化保持禁用");
    });

    it(`discloses WHY execution detail is absent from the public ${kind} body instead of going silent`, () => {
      const window = scheduledReport.resolveReportWindow(kind, "2026-07-14");
      const markdown = kind === "daily"
        ? scheduledReport.renderDailyReport(window, buildDataWithFills())
        : scheduledReport.renderWeeklyReport(window, buildDataWithFills());

      expect(markdown).toContain("成交与执行明细不进入公共报告");
      expect(markdown).toContain("个人页");
      // Unchanged: the fixture with fills must still pass the whole gate.
      expect(validateReportMarkdown(markdown, { kind })).toEqual({ ok: true, failures: [] });
    });
  }
});

describe("C1: selectExecutionReports is owner-scoped", () => {
  function seedExecutionDb() {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-exec-scope-"));
    execScopeDirs.push(dir);
    const db = openTradingDatabase(join(dir, "trading.sqlite"));
    for (const id of ["member_one", "member_two"]) {
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
    const insert = db.prepare(`
      INSERT INTO execution_reports (id, category, title, body, metadata, created_at, owner_id)
      VALUES (?, ?, ?, ?, '{}', ?, ?)
    `);
    insert.run("er_one", "trade", "NVDA.US 执行报告", "标的 NVDA.US 方向 buy 数量 300", "2026-07-14T10:00:00.000Z", "member_one");
    insert.run("er_two", "trade", "TSLA.US 执行报告", "标的 TSLA.US 方向 sell 数量 120", "2026-07-14T11:00:00.000Z", "member_two");
    insert.run("er_legacy", "trade", "QQQ.US 执行报告", "标的 QQQ.US 方向 buy 数量 5", "2026-07-14T12:00:00.000Z", null);
    insert.run("er_out_of_window", "trade", "NVDA.US 执行报告", "标的 NVDA.US", "2026-06-01T10:00:00.000Z", "member_one");
    return db;
  }

  it("returns only the requested owner's rows - never another member's, never an unattributed one", () => {
    const db = seedExecutionDb();
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");

    const forOne = scheduledReport.selectExecutionReports(db, window, "member_one");
    expect(forOne.map((row: { id: string }) => row.id)).toEqual(["er_one"]);

    const forTwo = scheduledReport.selectExecutionReports(db, window, "member_two");
    expect(forTwo.map((row: { id: string }) => row.id)).toEqual(["er_two"]);
  });

  it("refuses to run without an owner rather than defaulting to every member's rows", () => {
    const db = seedExecutionDb();
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    expect(() => scheduledReport.selectExecutionReports(db, window)).toThrow(/ownerId/u);
  });

  it("counts the unattributed rows separately so their exclusion can be disclosed, not hidden", () => {
    const db = seedExecutionDb();
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    expect(scheduledReport.countUnattributedExecutionReports(db, window)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F4 (2026-07-28 round 3): classifyExecutionStatus decided whether a trade
// happened by regexing the body. The reconcile writer's own end-to-end case is
// pinned in reconcile-official-paper-orders.test.ts, against a row that writer
// really produced. These cover the OTHER writer's row shape and the two
// fallbacks.
//
// The broker-executor rows here get their metadata from the REAL exported
// buildExecutionReportMetadata - that function, not this test, decides that the
// stage nests at metadata.result.brokerOrderStage, which is the contract
// classifyExecutionStatus now depends on. The stage/localStatus VALUES come out
// of the shared broker-status-map module rather than being typed in here, so
// this file cannot invent a status vocabulary the rest of the system does not
// use.
// ---------------------------------------------------------------------------
const brokerExecutor = await import("../../broker-executor/src/server.ts");
const { mapBrokerStatusToStage } = await import("./broker-status-map.mjs");

function brokerExecutorRow(brokerStatus: string, symbol = "NVDA.US") {
  const { stage, localStatus } = mapBrokerStatusToStage(brokerStatus);
  const ticket = {
    id: "ticket_prop_p_f4",
    source: "proposals-cli",
    submittedAt: "2026-07-14T10:00:00.000Z",
    environment: "paper" as const,
    assetClass: "stock" as const,
    symbol,
    side: "buy" as const,
    quantity: 4,
    conviction: "normal" as const,
    notionalUsd: 400,
    ownerId: "member_one",
    proposalId: "p_f4"
  };
  const result = {
    ticketId: ticket.id,
    environment: "paper" as const,
    status: localStatus,
    provider: "longbridge-paper" as const,
    externalOrderId: "ext_f4",
    brokerStatus,
    brokerOrderStage: stage,
    limitPrice: 100,
    reasons: [`长桥券商状态为 ${brokerStatus}；本地状态为 ${localStatus}。`]
  };
  return {
    category: "trade",
    title: `${symbol} 执行报告`,
    body: brokerExecutor.buildExecutionReportBody(ticket, result),
    // Stored as a JSON string, which is what selectExecutionReports' raw
    // SELECT hands the renderer - not the parsed object the repository returns.
    metadata: JSON.stringify(brokerExecutor.buildExecutionReportMetadata(ticket, "p_f4", result))
  };
}

describe("F4: execution status is classified from the row's structured outcome", () => {
  it("reads broker-executor's nested metadata.result.brokerOrderStage", () => {
    expect(scheduledReport.summarizeExecutionRow(brokerExecutorRow("Filled")).status)
      .toBe("券商已确认成交。");
    expect(scheduledReport.summarizeExecutionRow(brokerExecutorRow("New")).status)
      .toBe("订单已提交至券商并存活，尚未观察到成交。");
    expect(scheduledReport.summarizeExecutionRow(brokerExecutorRow("Rejected")).status)
      .toBe("券商拒绝该订单，未成交。");
    expect(scheduledReport.summarizeExecutionRow(brokerExecutorRow("Canceled")).status)
      .toBe("订单已撤销，未成交。");
    // 'accepted' is the local status for BOTH filled and cancelled, so a
    // partial fill must not be rounded up into a 成交 claim either.
    expect(scheduledReport.summarizeExecutionRow(brokerExecutorRow("PartialFilled")).status)
      .toContain("尚未确认为全部成交");
  });

  it("names an unmapped broker status instead of guessing whether it traded", () => {
    const row = brokerExecutorRow("SomeBrandNewBrokerStatus");
    expect(JSON.parse(row.metadata).result.brokerOrderStage).toBe("unknown_broker_status");
    expect(scheduledReport.summarizeExecutionRow(row).status)
      .toBe("券商状态「SomeBrandNewBrokerStatus」不在本系统的状态映射表内，无法判定是否成交。");
  });

  it("still reads the prose for a row that carries no structured outcome at all", () => {
    // Pre-metadata history: body only. This is the ONLY path the English
    // failure regexes are still reachable from.
    const legacy = { category: "trade", title: "AAPL execution", body: "Status: failed - API error", metadata: "{}" };
    expect(scheduledReport.summarizeExecutionRow(legacy).status).toBe("写入或回查失败，未确认为新成交。");

    const daily = { category: "daily", title: "日报", body: "已入库。", metadata: "" };
    expect(scheduledReport.summarizeExecutionRow(daily).status).toBe("报告记录已入库。");
  });

  // Round-7 finding K5. THIS IS A SOURCE-LEVEL ASSERTION and says so: driving
  // the refusal branch end to end needs a full report run plus a Feishu
  // transport, which this suite does not have. What it does prove is the one
  // thing that rotted - the comment above deliverReportToFeishu has claimed
  // since J2 that the refusal 「arrives as `sent:false` + `groupFallback`, both
  // recorded below」, and only the SUCCESS branch carried the field. The
  // consequence was measurable elsewhere: the doctor's
  // `notification-routing.last_delivery_missed_group` reads exactly this field
  // off the newest state entry, so an error-severity check had become
  // unreachable. The reader's half is covered for real in
  // openclaw-runtime-doctor-probes.test.ts.
  it("records groupFallback on the refusal path too, not only on the successful one", () => {
    const source = readFileSync(
      join(process.cwd(), "apps/openclaw-config/scripts/scheduled-report.mjs"),
      "utf8"
    );
    const refusalBranch = source.slice(
      source.indexOf("if (!result.sent) {"),
      source.indexOf("const outcome = summarizeRunOutcome(")
    );

    expect(refusalBranch).toContain("deliveryFailedAt");
    expect(refusalBranch).toContain("groupFallback: result.groupFallback ?? false");
    expect(refusalBranch).toContain("result.groupFallbackReason");
  });

  // G5 (2026-07-28 round 4): a case here used to hand-write a reconcile row -
  // two lines lifted out of a twelve-line body, plus a six-field metadata
  // object invented on the spot - under a comment claiming it was "the exact
  // sentence reconcile-official-paper-orders.mjs writes into every body". The
  // real writer's body also carries 工单/执行方/外部订单号/券商状态/生命周期阶段/
  // 限价 and its metadata carries ticketId/proposalId/environment/assetClass/
  // source/note, so the fixture was a shape no producer emits. Deleted rather
  // than repaired: reconcile-official-paper-orders.test.ts's
  // "classifies the REAL writer's row from its structured stage, not from the
  // word 'failed' in its Chinese prose" already proves the same property by
  // running the actual writer into a temp db and reading its row back out,
  // which is strictly stronger than anything typed in here could be.
});

// Task 13 (2026-07-28 spec-drift plan) - 2026-07-12 requirements §1.4
// 「摘要卡先行（核心结论+置信度）」 and §3.5「核心结论（一行观点+置信度三档+
// "截至"时间）」. The live 2026-07-30 daily report on the mini opens straight
// into 「- 市场信号：…」: no conclusion, no tier, nothing the platform's summary
// card or the Feishu conclusion card can read a headline out of.
//
// Every case below renders through the REAL renderers and reads the box back
// with the REAL parser (conclusion-box.mjs) - never by matching a hand-typed
// string - so the render side and the parse side cannot drift apart.
describe("Task 13: daily and weekly lead with a conclusion box carrying a derived confidence tier", () => {
  for (const kind of ["daily", "weekly"] as const) {
    it(`renders 核心结论/置信度/依据/截至 ahead of the ${kind} body`, () => {
      const window = scheduledReport.resolveReportWindow(kind, "2026-07-14");
      const markdown = kind === "daily"
        ? scheduledReport.renderDailyReport(window, buildFixtureData())
        : scheduledReport.renderWeeklyReport(window, buildFixtureData());

      const box = parseReportConclusionBox(markdown);
      expect(box, "the report carries no parseable 结论框").not.toBeNull();
      expect(box?.coreConclusion).toContain("QQQ 最新价 721.34");
      expect(Object.keys(CONFIDENCE_LABELS)).toContain(box?.confidence);
      expect(box?.basis).not.toBe("");
      // 截至 is the DATA's timestamp (sourceEvidence.fetchedAt = 05:00Z),
      // not the moment the renderer ran.
      expect(box?.asOf).toBe("2026-07-14 13:00（北京时间）");
      // 摘要卡先行: the box sits before the second section.
      expect(markdown.indexOf("### 结论框")).toBeLessThan(markdown.indexOf("## 2."));
    });
  }

  it("claims 高 only when every source answered and every tracked symbol got news", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(window, buildFixtureData());

    const box = parseReportConclusionBox(markdown);
    expect(box?.confidence).toBe("high");
    expect(box?.basis).toContain("覆盖 2/2 标的");
  });

  it("degrades to 中 and names the reason when the agent news search is unavailable", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = { ...buildFixtureData(), newsSearchDegraded: true, newsSearchReason: "openclaw 检索后端未接入" };
    const box = parseReportConclusionBox(scheduledReport.renderDailyReport(window, data));

    expect(box?.confidence).toBe("medium");
    expect(box?.basis).toContain("openclaw 检索后端未接入");
  });

  it("degrades to 中 and names the uncovered symbol when part of the pool got no news", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const fixture = buildFixtureData();
    const data = { ...fixture, trackedSymbols: [...fixture.trackedSymbols, "TSM.US", "AMZN.US"] };
    const box = parseReportConclusionBox(scheduledReport.renderDailyReport(window, data));

    expect(box?.confidence).toBe("medium");
    expect(box?.basis).toContain("覆盖 2/4 标的");
    expect(box?.basis).toContain("TSM.US");
    expect(box?.basis).toContain("AMZN.US");
  });

  it("drops to 低 when fewer than half the tracked pool got any news", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const fixture = buildFixtureData();
    const data = {
      ...fixture,
      trackedSymbols: [...fixture.trackedSymbols, "TSM.US", "AMZN.US", "GOOG.US"],
      marketNews: fixture.marketNews.filter((article) => article.symbol === "QQQ.US")
    };
    const box = parseReportConclusionBox(scheduledReport.renderDailyReport(window, data));

    expect(box?.confidence).toBe("low");
    expect(box?.basis).toContain("覆盖 1/5 标的");
  });

  it("drops to 低 when the QQQ quote itself came back degraded", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    // The real degraded-quote producer, not a hand-written {degraded:true}.
    const degradedQuote = buildDegradedQuoteSnapshot("QQQ.US", {
      fetchedAt: "2026-07-14T05:00:00.000Z",
      reason: "Longbridge 行情读取失败：token expired"
    });
    const data = { ...buildFixtureData(), qqqQuote: degradedQuote, longbridgeWarnings: ["QQQ 行情读取降级：token expired"] };
    const box = parseReportConclusionBox(scheduledReport.renderDailyReport(window, data));

    expect(box?.confidence).toBe("low");
    expect(box?.basis).toContain("行情不可用");
    expect(box?.basis).toContain("token expired");
    // And the headline must not pretend a price it never had.
    expect(box?.coreConclusion).toContain("QQQ 行情不可用");
    expect(box?.coreConclusion).not.toMatch(/最新价\s*[0-9]/u);
  });

  it("drops to 低 when no news was read at all", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = { ...buildFixtureData(), marketNews: [], newsWarnings: ["全部新闻源读取失败"] };
    const box = parseReportConclusionBox(scheduledReport.renderDailyReport(window, data));

    expect(box?.confidence).toBe("low");
    expect(box?.basis).toContain("新闻");
    expect(box?.basis).toContain("全部新闻源读取失败");
  });

  it("counts symbols the news cap left out as a degradation and names them", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const data = { ...buildFixtureData(), symbolsBeyondNewsLimit: ["GOOG.US"], newsSymbolLimit: 2 };
    const markdown = scheduledReport.renderDailyReport(window, data);
    const box = parseReportConclusionBox(markdown);

    expect(box?.confidence).toBe("medium");
    expect(box?.basis).toContain("GOOG.US");
    // Task 10's disclosure line says the same thing in the evidence block.
    expect(markdown).toContain("标的池截断");
    expect(markdown).toContain("这些标的本次没有被搜过，而不是没有新闻");
  });

  it("is refused by the quality gate when the conclusion box is missing", () => {
    const window = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(window, buildFixtureData());
    expect(validateReportMarkdown(markdown, { kind: "daily" })).toEqual({ ok: true, failures: [] });

    const stripped = markdown.split("\n").filter((line) => !/^-\s*置信度：/u.test(line)).join("\n");
    expect(validateReportMarkdown(stripped, { kind: "daily" }).failures).toContain("report.conclusion_box");
  });
});

// ===========================================================================
// Task 20 (2026-07-28 spec-drift plan): 宏观与财报日历 + the weekly's own summary
// ===========================================================================

describe("Task 20: the report section is 宏观与财报日历, with a real earnings half", () => {
  // The rows below are the shape report-earnings.mjs's normalizer produces
  // from the live Finnhub payload captured on 2026-07-30 - see
  // report-earnings.test.ts's fixture-provenance header for the raw curl.
  const earningsCalendar = {
    entries: [
      {
        queriedSymbol: "NVDA.US",
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
    ],
    queriedSymbols: ["NVDA.US", "AMZN.US"],
    lookaheadDays: 30,
    warnings: [],
    skippedReason: null
  };

  it("renders the spec's section name with both halves under it, in the daily report", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, { ...buildFixtureData(), earningsCalendar });

    expect(markdown).toContain("### 宏观与财报日历");
    expect(markdown).toContain("#### 宏观日历");
    expect(markdown).toContain("#### 财报日历");
    expect(markdown).toContain("2026-08-26 盘后 NVDA.US 2027 财年 Q2 财报");
    expect(markdown).toContain("EPS 预期 2.1274");
  });

  it("discloses the reason instead of rendering an empty earnings list", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, {
      ...buildFixtureData(),
      earningsCalendar: {
        entries: [],
        queriedSymbols: [],
        lookaheadDays: 30,
        warnings: [],
        skippedReason: "未配置 FINNHUB_API_KEY，本次没有向 Finnhub 查询任何标的的财报日期。"
      }
    });

    expect(markdown).toContain("#### 财报日历");
    expect(markdown).toContain("财报日历本次未查询");
    expect(markdown).toContain("FINNHUB_API_KEY");
  });

  // The heading text is consumed OUTSIDE this file too: notifications.ts's
  // extractActionableSummaryBullets pulls a macro bullet for the Feishu card by
  // heading pattern. This is the producer half of that coupling - it pins the
  // exact heading literals the real renderer emits; notifications.test.ts's
  // "Task 20" case is the consumer half, asserting those same three literals
  // are matched. (The `^###\s+宏观日历` pattern it used before cannot match a
  // level-4 `#### 宏观日历`: the 4th character is `#`, not whitespace.)
  it("emits exactly the three heading literals the Feishu card builder matches on", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, { ...buildFixtureData(), earningsCalendar });
    const headings = markdown.split("\n").filter((line) => /^#{3,4}\s+.*日历/u.test(line));

    expect(headings).toEqual(["### 宏观与财报日历", "#### 宏观日历", "#### 财报日历"]);
  });

  it("still satisfies the completeness check and the quality gate with the renamed section", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport.renderDailyReport(info, { ...buildFixtureData(), earningsCalendar });

    expect(scheduledReport.isPreparedReportMarkdownComplete(markdown)).toBe(true);
    expect(validateReportMarkdown(markdown, { kind: "daily" }).failures).not.toContain("macro.evidence");
    expect(validateReportMarkdown(markdown, { kind: "daily" }).failures).not.toContain("macro.earnings_missing");
  });

  it("a report that loses the earnings sub-section fails the gate rather than shipping short", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");
    const markdown = scheduledReport
      .renderDailyReport(info, { ...buildFixtureData(), earningsCalendar })
      .replace("#### 财报日历", "#### 无关小标题");

    expect(validateReportMarkdown(markdown, { kind: "daily" }).failures).toContain("macro.earnings_missing");
    expect(scheduledReport.isPreparedReportMarkdownComplete(markdown)).toBe(true);
  });
});

describe("Task 20: the weekly report summarizes the WEEK, not one instant", () => {
  const info = scheduledReport.resolveReportWindow("weekly", "2026-07-28");

  it("renders week open -> week close return and the in-week drawdown", () => {
    const weeklyMarketPerformance = {
      available: true,
      symbolLabel: "QQQ",
      openDay: "2026-07-21",
      openPrice: 677.96,
      closeDay: "2026-07-28",
      closePrice: 682.12,
      returnPct: 0.6136,
      maxDrawdownPct: 5.0725,
      drawdownPeakDay: "2026-07-22",
      drawdownTroughDay: "2026-07-23",
      observedDays: 5,
      missingDays: ["2026-07-25", "2026-07-26"],
      reason: null
    };
    const markdown = scheduledReport.renderWeeklyReport(info, {
      ...buildFixtureData(),
      weeklyMarketPerformance
    });

    expect(markdown).toContain("### 周度行情归因");
    expect(markdown).toContain("周开：2026-07-21 QQQ 677.96");
    expect(markdown).toContain("周收：2026-07-28 QQQ 682.12");
    expect(markdown).toContain("区间收益：+0.61%");
    expect(markdown).toContain("最大回撤：5.07%");
    expect(markdown).toContain("自 2026-07-22 高点回落至 2026-07-23");
    expect(markdown).toContain("2026-07-25、2026-07-26");
  });

  it("does NOT write the weekly return as 涨跌 - that phrase is claimed by the single-day numeric gate", () => {
    // report-quality.mjs's facts.numeric_match matches `涨跌 … %` against the
    // SINGLE-DAY qqq.changePct fact. A weekly return written that way would be
    // compared against today's daily change and fail every correct report.
    const weeklyMarketPerformance = {
      available: true,
      symbolLabel: "QQQ",
      openDay: "2026-07-21",
      openPrice: 677.96,
      closeDay: "2026-07-28",
      closePrice: 682.12,
      returnPct: 0.6136,
      maxDrawdownPct: 5.0725,
      drawdownPeakDay: "2026-07-22",
      drawdownTroughDay: "2026-07-23",
      observedDays: 5,
      missingDays: [],
      reason: null
    };
    const markdown = scheduledReport.renderWeeklyReport(info, {
      ...buildFixtureData(),
      weeklyMarketPerformance
    });

    const weeklySection = markdown.slice(markdown.indexOf("### 周度行情归因"), markdown.indexOf("- 标的："));
    expect(weeklySection).not.toContain("涨跌");

    const qqqFacts = {
      "qqq.price": { valueNum: 721.34 },
      "qqq.changePct": { valueNum: 0.5885 }
    };
    expect(validateNarrativeNumbers(markdown, qqqFacts).failures).toEqual([]);
  });

  it("says why the week cannot be summarized instead of printing a 0.00% week", () => {
    const markdown = scheduledReport.renderWeeklyReport(info, {
      ...buildFixtureData(),
      weeklyMarketPerformance: {
        available: false,
        symbolLabel: "QQQ",
        observedDays: 0,
        missingDays: [],
        reason: "本窗口没有任何一天记录到 QQQ 的每日行情事实（daily_facts.qqq.price），无法计算周度收益与回撤"
      }
    });

    expect(markdown).toContain("周度收益与回撤本次不可得");
    expect(markdown).toContain("daily_facts.qqq.price");
    expect(markdown).not.toContain("区间收益：");
    expect(markdown).not.toContain("最大回撤：");
  });

  it("the daily report does not grow a weekly section", () => {
    const dailyInfo = scheduledReport.resolveReportWindow("daily", "2026-07-28");
    const markdown = scheduledReport.renderDailyReport(dailyInfo, buildFixtureData());

    expect(markdown).not.toContain("### 周度行情归因");
  });

  it("reads exactly the window's own days, newest last, excluding the start boundary", () => {
    // The window is half-open `(start, end]`: a run on startLabel writes its
    // facts AT the boundary instant, which belongs to the previous window.
    expect(scheduledReport.reportWindowDateLabels(info)).toEqual([
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
      "2026-07-27",
      "2026-07-28"
    ]);
    expect(scheduledReport.reportWindowDateLabels(scheduledReport.resolveReportWindow("daily", "2026-07-28"))).toEqual([
      "2026-07-28"
    ]);
  });
});

// ===========================================================================
// Task 21 (2026-07-28 spec-drift plan): the US-market-holiday guard
// ===========================================================================

describe("Task 21: a full US market holiday produces an honest skip, not an empty report", () => {
  it("skips the daily report whose window covers only a full NYSE close", () => {
    // Thanksgiving 2026 is Thursday 2026-11-26 (full close). The Beijing-dated
    // daily report that covers it is the NEXT day's, 2026-11-27: its window is
    // 2026-11-26 20:00 -> 2026-11-27 20:00 Beijing = 11-26 08:00 -> 11-27 08:00
    // New York, which brackets exactly the 11-26 session.
    const info = scheduledReport.resolveReportWindow("daily", "2026-11-27");
    const skip = scheduledReport.resolveUsMarketHolidaySkip("daily", info);

    expect(skip).toMatchObject({ ok: true, skipped: "us-market-holiday", kind: "daily", label: "2026-11-27" });
    expect(skip.coveredUsDates).toEqual(["2026-11-26"]);
    expect(skip.reason).toContain("2026-11-26");
    expect(skip.reason).toContain("休市");
  });

  it("does NOT skip the day after the holiday - an early close is still a session", () => {
    // 2026-11-27 is a half day, not a close, so the 2026-11-28 report runs.
    const info = scheduledReport.resolveReportWindow("daily", "2026-11-28");

    expect(scheduledReport.resolveUsMarketHolidaySkip("daily", info)).toBeNull();
  });

  it("does not skip an ordinary trading day", () => {
    const info = scheduledReport.resolveReportWindow("daily", "2026-07-30");

    expect(scheduledReport.resolveUsMarketHolidaySkip("daily", info)).toBeNull();
    expect(scheduledReport.resolveUsMarketHolidaySkip("daily", scheduledReport.resolveReportWindow("daily", "2026-12-25"))).toBeNull();
  });

  it("never skips a weekly report - a 7-day window always contains an open session", () => {
    for (const label of ["2026-11-30", "2026-12-28", "2026-01-05"]) {
      expect(scheduledReport.resolveUsMarketHolidaySkip("weekly", scheduledReport.resolveReportWindow("weekly", label))).toBeNull();
    }
  });

  it("refuses to skip when the holiday calendar cannot answer for that year", () => {
    // trading-schedule.mjs only carries 2026. A 2027 date reads as "cannot
    // tell", and an un-updated calendar must never cancel a year of reports.
    const info = scheduledReport.resolveReportWindow("daily", "2027-01-02");

    expect(scheduledReport.resolveUsMarketHolidaySkip("daily", info)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2026-07-30: news.chinese_ratio stops being a delivery blocker
// ---------------------------------------------------------------------------

/**
 * REAL headlines, copied verbatim out of the mini's live `news_event_sources`
 * table (2026-07-29/30 rows, read over ssh from a byte-copy of
 * runtime/trading.sqlite). Provenance matters here: this test's whole point is
 * that a sub-30% Chinese ratio SHIPS with a disclosure instead of destroying the
 * report, and the ratio is decided by `isNativeCjkArticle` (news-engine.mjs)
 * running over the article titles - so the titles have to be the ones the real
 * feeds actually publish, not seven strings shaped by whoever wrote the test.
 * The 7:2 English-to-Chinese mix is the shape of a real run too: the four
 * English sources are fetched PER SYMBOL while the three Chinese RSSHub feeds
 * are fetched once per run.
 *
 * Everything downstream of these titles is the production code path:
 * renderDailyReport -> renderClusteredNewsSection -> clusterArticles /
 * buildEventFromCluster -> computeChineseSourceRatio ->
 * renderChineseRatioDisclosure, then report-quality.mjs's real gate.
 */
const LIVE_ENGLISH_HEADLINES = [
  {
    title: "Oil jumps after Iran attempts ‘surprise attack’; chip stocks slump further as AI sell-off continues – as it happened",
    url: "https://www.theguardian.com/business/live/2026/jul/29/oil-jumps-iran-surprise-attack-chip-stocks-slump-ai-sell-off-economy-latest-news",
    publishedAt: "2026-07-13T21:41:00.000Z",
    source: "openclaw-l2-search",
    publisher: "The Guardian"
  },
  {
    title: "Daily Breadth Improves, but the Broader Trend Stays Fragile",
    url: "https://finnhub.io/api/news?id=8fd934ea9e1da2faf4a4d1a3a071f29756788b8e712aff8fcf6618b355e2e6c3",
    publishedAt: "2026-07-13T21:18:21.000Z",
    source: "finnhub",
    publisher: "ChartMill"
  },
  {
    title: "Markets Hold Back As Crude Oil Prices Climb",
    url: "https://finnhub.io/api/news?id=100d233e5e5121aa0f2ff3b2d63ec525c26c3c754c3c7939ca40033c9e1c4d13",
    publishedAt: "2026-07-13T21:19:00.000Z",
    source: "finnhub",
    publisher: "SeekingAlpha"
  },
  {
    title: "The AI Bubble Is Bursting - Don't Get Mauled",
    url: "https://finnhub.io/api/news?id=80a61f6172cff48ce5cb175aed2a2dec8476b640ce200faa20406565fc773cdc",
    publishedAt: "2026-07-13T20:11:53.000Z",
    source: "finnhub",
    publisher: "SeekingAlpha"
  },
  {
    title: "The most important stretch of earnings season is here — and Wall Street wants receipts from AI giants",
    url: "https://www.businessinsider.com/meta-microsoft-amazon-q2-earnings-preview-what-hyperscaler-investors-expect-2026-7",
    publishedAt: "2026-07-13T19:50:01.217Z",
    source: "openclaw-l2-search",
    publisher: "Business Insider"
  },
  {
    title: "Chips Sell First, Ask Questions Later - And SK Hynix Just Handed Them the Answer",
    url: "https://finnhub.io/api/news?id=2dd0609fece9b7df7d96e884291a99b4db8c8f2618b80ae5cd0c2bffda101783",
    publishedAt: "2026-07-13T19:12:44.000Z",
    source: "finnhub",
    publisher: "ChartMill"
  },
  {
    title: "The Worst Of 1999 And 2008: Bubbles, Moral Hazard, And Bailouts",
    url: "https://finnhub.io/api/news?id=69f4e09a926087b601fe96a2f598e2aad912b8bb59d5f388db8c14cd15f6241d",
    publishedAt: "2026-07-13T19:09:48.000Z",
    source: "finnhub",
    publisher: "SeekingAlpha"
  }
];

const LIVE_CHINESE_HEADLINES = [
  {
    title: "意大利和沙特重申支持落实“两国方案”",
    url: "https://wallstreetcn.com/livenews/3141798",
    publishedAt: "2026-07-13T22:04:36.000Z",
    source: "rsshub-wallstreetcn",
    publisher: "华尔街见闻"
  },
  {
    title: "美国三大股指均跌超1%，道指目前跌860点、跌幅1.6%，纳指跌1.4%，半导体指数跌4.1%，银行指数跌1.9%，罗素2000指数跌1.4%。",
    url: "https://wallstreetcn.com/livenews/3141797",
    publishedAt: "2026-07-13T22:00:09.000Z",
    source: "rsshub-wallstreetcn",
    publisher: "华尔街见闻"
  }
];

function buildEnglishHeavyNewsData(overrides: Record<string, unknown> = {}) {
  const marketNews = [...LIVE_CHINESE_HEADLINES, ...LIVE_ENGLISH_HEADLINES].map((entry, index) => ({
    id: entry.url,
    symbol: "QQQ.US",
    title: entry.title,
    url: entry.url,
    publishedAt: entry.publishedAt,
    publishedAtMs: Date.parse(entry.publishedAt),
    source: entry.source,
    sourceName: entry.publisher,
    publisher: entry.publisher,
    order: index
  }));
  return { ...buildFixtureData(), marketNews, newsEvents: undefined, ...overrides };
}

describe("news.chinese_ratio: a sub-floor ratio discloses, an unexplained one blocks", () => {
  const info = scheduledReport.resolveReportWindow("daily", "2026-07-14");

  it("ships a 22% report with a disclosure that names the ratio, the feeds and the symbol count", () => {
    const markdown = scheduledReport.renderDailyReport(info, buildEnglishHeavyNewsData());

    // 2 of 9 sources are Chinese - measured by the renderer, not asserted into
    // existence: this is the number the real computeChineseSourceRatio prints.
    expect(markdown).toContain("- 中文源占比：22.22%。");
    expect(markdown).toContain("- 中文源覆盖不足：本次中文源占比 22.22%，低于 30% 目标；");
    expect(markdown).toMatch(/本节展示的 \d+ 张事件卡中有 \d+ 张带中文来源/u);
    expect(markdown).toContain("英文源按标的逐只检索");
    // With no sourceHealth on the data (this fixture never ran collectL1News),
    // the line says the status is unrecorded rather than implying success.
    expect(markdown).toContain("本次采集状态未记录");

    // The whole point: the gate lets it through.
    const result = validateReportMarkdown(markdown, { kind: "daily" });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names the unreachable RSSHub feed verbatim when collectL1News recorded one", () => {
    const markdown = scheduledReport.renderDailyReport(
      info,
      buildEnglishHeavyNewsData({
        newsSourceHealth: {
          "rsshub-cls": "failed",
          "rsshub-wallstreetcn": "ok",
          "rsshub-gelonghui": "failed"
        },
        newsWarnings: ["RSSHub 财联社读取失败：fetch failed", "RSSHub 格隆汇读取失败：HTTP 502"]
      })
    );

    expect(markdown).toContain("RSSHub 财联社读取失败：fetch failed");
    expect(markdown).toContain("RSSHub 格隆汇读取失败：HTTP 502");
    expect(markdown).toContain("华尔街见闻 已读取 2 条");
    expect(validateReportMarkdown(markdown, { kind: "daily" }).ok).toBe(true);
  });

  it("blocks the same report once the disclosure line is stripped out", () => {
    const markdown = scheduledReport.renderDailyReport(info, buildEnglishHeavyNewsData());
    const stripped = markdown
      .split("\n")
      .filter((line) => !line.startsWith("- 中文源覆盖不足"))
      .join("\n");

    const result = validateReportMarkdown(stripped, { kind: "daily" });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.chinese_ratio:未披露(22.22%)");
  });

  it("blocks a report whose 中文源占比 statistic went missing altogether", () => {
    const markdown = scheduledReport.renderDailyReport(info, buildEnglishHeavyNewsData());
    const stripped = markdown
      .split("\n")
      .filter((line) => !line.startsWith("- 中文源占比："))
      .join("\n");

    const result = validateReportMarkdown(stripped, { kind: "daily" });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.chinese_ratio:统计行缺失");
  });

  it("does not print the disclosure when the ratio clears the floor", () => {
    const markdown = scheduledReport.renderDailyReport(info, buildFixtureData());

    expect(markdown).toContain("- 中文源占比：");
    expect(markdown).not.toContain("- 中文源覆盖不足");
    expect(validateReportMarkdown(markdown, { kind: "daily" }).ok).toBe(true);
  });
});

describe("REPORT_NEWS_SYMBOL_LIMIT: the default cap covers the §0.4 pool", () => {
  it("defaults to 40 - two members' 20-symbol watchlists, not 8", async () => {
    // Read from the module's own resolution path rather than re-declaring the
    // number: `fetchRequiredReportMarketData` is not exported, so this asserts
    // on the literal the source actually carries, which is what a drift here
    // would change.
    const source = readFileSync(new URL("./scheduled-report.mjs", import.meta.url), "utf8");
    expect(source).toContain("const DEFAULT_NEWS_SYMBOL_LIMIT = 40;");
    expect(source).toContain("Number(process.env.REPORT_NEWS_SYMBOL_LIMIT ?? DEFAULT_NEWS_SYMBOL_LIMIT)");
    // The cap must stay under the Finnhub limiter's own ceiling, or the surplus
    // symbols silently lose their Finnhub leg to a rate-limit warning each.
    const { createFinnhubRateLimiter } = await import("./news-sources.mjs");
    const limiter = createFinnhubRateLimiter();
    for (let i = 0; i < 40; i += 1) {
      limiter.acquire(`symbol-${i}`);
    }
    expect(limiter.size()).toBe(40);
  });
});
