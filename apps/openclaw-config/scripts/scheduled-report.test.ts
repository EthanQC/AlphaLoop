// Task H7 (2026-07-14 legacy audit): scheduled-report.mjs previously ran its
// entire CLI dispatch unconditionally at module load time (parsing real
// process.argv), which made the module impossible to `import` for testing
// at all - see the isMainModule guard this task added. This is the first
// direct test coverage the module has ever had.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

import {
  buildDegradedQuoteSnapshot,
  buildTrackedSymbols,
  normalizeMacroCalendarPayload,
  normalizeOfficialPaperSnapshot,
  normalizeQuotePayload
} from "./report-data.mjs";
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
