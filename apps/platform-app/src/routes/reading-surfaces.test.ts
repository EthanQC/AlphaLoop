/**
 * Cross-page audit of the three defect classes the operator found on
 * `/stock/TSM.US` on 2026-07-30 (U1 unformatted values, U2 unlabelled
 * staleness, U3 uninformative empty states).
 *
 * WHY A SWEEP AND NOT PER-PAGE CASES: the stock page was not special. The
 * same raw `<time>{iso}</time>` shape existed on four other pages' timelines,
 * the same hard-coded `freshness: "最新"` on five, and the same bare 暂无X on
 * every one of them. A per-page test would have caught the page it was
 * written for and nothing else. This file drives the REAL server
 * (createPlatformServer) over HTTP for EVERY reading surface, twice - once
 * with realistic seeded data, once with an empty database - and asserts the
 * three properties structurally, so a NEW page or a new card inherits the
 * check for free.
 */
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApiTokenRepository,
  MemberRepository,
  MonthlyReviewRepository,
  ResearchTaskRepository,
  createId,
  migrate,
  type Member
} from "@packages/shared-types";

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
    displayName: "甲",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

/** Strips tags, attribute values, <style> and <script> so the assertions run
 * over what a READER actually sees. Raw values deliberately preserved in
 * `title="…"` tooltips (the audit trail) are attribute values and so are
 * correctly excluded here. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gu, " ")
    .replace(/<script[\s\S]*?<\/script>/gu, " ")
    .replace(/<[^>]*>/gu, " ");
}

/** `2026-07-29T14:40:10.879Z` and friends - a stored instant that reached a
 * reader unformatted (U1). */
const RAW_ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;
/** A bare float with 6+ decimals, e.g. `-0.03323902016262659` (U1). A price
 * (2dp), a percentage (2dp) and a share count are all well under this. */
const RAW_LONG_FLOAT_RE = /-?\d+\.\d{6,}/u;

describe("every reading surface: no raw values, honest staleness, informative empty states", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let token: string;
  let member: Member;

  const NOW = () => new Date("2026-07-29T16:18:00.000Z"); // 07-30 00:18 Beijing
  const TODAY = "2026-07-30";
  const THREE_DAYS_AGO = "2026-07-27";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-surfaces-"));
    db = memoryDb();
    server = createPlatformServer({ db, repoRoot, now: NOW });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    member = makeMember();
    new MemberRepository(db).upsert(member);
    token = new ApiTokenRepository(db).issue(member.id, "test").token;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  function writeReport(type: string, date: string, body: string): void {
    const dir = join(repoRoot, "reports", type);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.md`), body, "utf8");
  }

  // -------------------------------------------------------------------------
  // Realistic seed: every page has something to render, dated 3 days ago -
  // exactly the state the operator opened the site in.
  // -------------------------------------------------------------------------
  function seedEverything(): { proposalId: string; researchId: string; reviewId: string } {
    writeReport("daily", THREE_DAYS_AGO, "# 日报\n\n联储纪要偏鹰，半导体承压。\n\n## 市场速览\n\n- 略\n");
    writeReport("stock-analysis", THREE_DAYS_AGO, "# 个股分析\n\n## TSM.US\n\n### 结论框\n\n- 核心结论：支撑位 398.37\n- 置信度：中\n- 合理价值区间：380-420\n- 复盘日期：2026-08-27\n");

    // Snapshot (paper / home / member card)
    for (const fetchedAt of ["2026-07-26T12:00:00.000Z", "2026-07-27T12:00:00.000Z"]) {
      db.prepare(`
        INSERT INTO official_paper_snapshots (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
        VALUES (?, ?, 'manual', ?, ?, ?, ?, '{}', ?)
      `).run(
        createId("snapshot"),
        fetchedAt,
        108300.123456789,
        58300,
        50000,
        JSON.stringify([{ symbol: "TSM.US", quantity: 10, costPrice: 380.111111111, price: 394.525, priceSource: "live" }]),
        member.id
      );
    }

    // stock_facts (stock page)
    for (const [key, num, unit] of [
      ["quote.last", 394.525, "USD"],
      ["quote.pct", -2.20247390991796, "pct"],
      ["quote.volume", 8570295, "shares"]
    ] as Array<[string, number, string]>) {
      db.prepare(`
        INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
        VALUES (?, ?, 'TSM.US', ?, ?, NULL, ?, 'longbridge-quote', '2026-07-27T16:36:22.000Z', '2026-07-27T16:36:46.378Z')
      `).run(createId("stock_fact"), THREE_DAYS_AGO, key, num, unit);
    }

    // alert rule + event (home + stock) - the operator's own live values
    const ruleId = createId("alert_rule");
    db.prepare(`
      INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
      VALUES (?, ?, 'TSM.US', 'daily_move', 0.04, 'both', 'once_daily', 0.01, 1, '2026-07-01T00:00:00.000Z')
    `).run(ruleId, member.id);
    db.prepare(`
      INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value)
      VALUES (?, ?, ?, '2026-07-29T14:40:10.879Z', -0.0332390201626266)
    `).run(createId("alert_event"), ruleId, member.id);

    // thesis + judgment history (stock / strategy / member card)
    const thesisId = createId("thesis");
    db.prepare(`
      INSERT INTO theses (id, owner_id, symbol, direction, target_low, target_high, invalidation_price, visibility, created_at, updated_at, bull_points, bear_points)
      VALUES (?, ?, 'TSM.US', 'bull', 380, 460, 350, 'public', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '["先进制程满产"]', '["估值偏高"]')
    `).run(thesisId, member.id);
    db.prepare(`
      INSERT INTO thesis_history (id, thesis_id, note, source, created_at)
      VALUES (?, ?, '维持看多', 'feishu', '2026-07-05T09:30:00.000Z')
    `).run(createId("thesis_history"), thesisId);

    // discipline rule (home / strategy)
    db.prepare(`
      INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, linked_strategy, enabled, created_at)
      VALUES (?, ?, '财报周不加仓', 'proposal_check', NULL, 1, '2026-07-01T00:00:00.000Z')
    `).run(createId("discipline_rule"), member.id);

    // strategy card (strategy / member card)
    db.prepare(`
      INSERT INTO strategy_cards (id, owner_id, name, scene, entry_condition, risk_control, exit_rule, status, visibility, created_at, updated_at)
      VALUES (?, ?, '超跌反弹短线', '回调', '跌破 MA20', '单票 10%', '反弹 8% 减半', 'active', 'public', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `).run(createId("strategy_card"), member.id);

    // news event (news page)
    const eventId = createId("news_event");
    db.prepare(`
      INSERT INTO news_events (id, cluster_key, title_zh, summary_zh, impact_direction, impact_affected, impact_reason,
                               first_published_at, last_published_at, source_count, zh_source_count, created_at, updated_at)
      VALUES (?, 'tsm-revenue', '台积电月度营收超预期', '摘要', 'bullish', '["TSM.US"]', '需求强劲',
              '2026-07-27T09:00:00.000Z', '2026-07-27T09:00:00.000Z', 1, 1, '2026-07-27T10:00:00.000Z', '2026-07-27T10:00:00.000Z')
    `).run(eventId);
    db.prepare(`
      INSERT INTO news_event_sources (id, event_id, origin, publisher, url, title_raw, published_at, lang, created_at)
      VALUES (?, ?, 'rss', '路透', 'https://example.com/a', 'TSMC revenue beats', '2026-07-27T09:00:00.000Z', 'zh', '2026-07-27T10:00:00.000Z')
    `).run(createId("news_event_source"), eventId);

    // proposal (paper history + detail page)
    const proposalId = createId("proposal");
    db.prepare(`
      INSERT INTO proposals (id, owner_id, symbol, side, quantity, order_type, limit_price, reason, evidence,
                             discipline_report, status, decided_at, decided_by, created_at, expires_at)
      VALUES (?, ?, 'TSM.US', 'buy', 2, 'limit', 390.5, '回踩 MA20', '[]', '[]', 'approved',
              '2026-07-27T13:00:00.000Z', ?, '2026-07-27T12:30:00.000Z', '2026-07-28T12:30:00.000Z')
    `).run(proposalId, member.id, member.id);

    // research task (research page + reports list)
    const created = new ResearchTaskRepository(db).createIfWithinQuota({
      ownerId: member.id,
      question: "TSM 财报前要减仓吗",
      tradingDay: THREE_DAYS_AGO
    });
    if (!created.ok) throw new Error("test setup: research quota");
    new ResearchTaskRepository(db).setResult(created.task.id, {
      status: "done",
      finishedAt: "2026-07-27T14:00:00.000Z",
      confidence: "medium",
      title: "TSM 减仓研判",
      resultJson: {
        conclusion: "不必减仓",
        confidence: "medium",
        keyPoints: [{ text: "订单能见度到 Q4", evidenceRefs: ["E1"] }],
        dataTable: [{ label: "最新价", value: "394.52", source: "longbridge" }],
        comparison: { theses: [], disciplines: [] },
        suggestedAction: "维持仓位",
        evidence: [{ ref: "E1", title: "月度营收", url: "https://example.com/a", publisher: "路透" }],
        skipped: [],
        steps: [{ name: "拉取行情", status: "done" }]
      } as never
    });

    // monthly review (review page + reports list)
    // Shape mirrors review-engine.mjs's own output (the same fixture shape
    // routes/review.test.ts uses), not a shape invented here.
    const review = new MonthlyReviewRepository(db).upsertDraft({
      ownerId: member.id,
      period: "2026-06",
      resultJson: {
        ownerId: member.id,
        period: "2026-06",
        generatedAt: "2026-07-04T00:00:00.000Z",
        predictionReview: {
          selfThesisHitRate: { sample: "insufficient", n: 3 },
          systemConfidenceCalibration: [{ tier: "low", sample: "none", n: 0 }],
          systemConfidenceCalibrationNote: "系统个股分析置信度校准——全平台口径，非本人专属"
        },
        decisionReview: {
          period: "2026-06",
          periodStart: "2026-06-01T00:00:00.000Z",
          periodEnd: "2026-07-01T00:00:00.000Z",
          benchmarkSymbol: "QQQ",
          executed: { sample: "none", n: 0, priced: 0, entries: [] },
          rejected: { sample: "none", n: 0, disclaimer: "未执行，仅口径参考", entries: [] }
        },
        disciplineReview: {
          complianceRate: { sample: "none" },
          complianceValue: { compliant: { sample: "none", n: 0 }, violating: { sample: "none", n: 0 }, deltaPct: null }
        },
        alertQuality: { sample: "none", triggeredCount: 0, misreportCount: 0, misreportRate: null },
        errorCategories: [],
        oneLineLesson: "本月各项指标样本不足或表现正常，暂无可归纳的一句话教训。",
        nextSteps: ["暂无下一步动作建议——数据不足或本月各项指标均在正常范围内。"],
        improvementSuggestions: {
          disclaimer: "以上为规则推导的改进建议，仅供参考；任何策略/纪律变更须本人在飞书或 CLI 中手动确认后生效。",
          items: []
        }
      } as never
    });

    return { proposalId, researchId: created.task.id, reviewId: review.id };
  }

  function surfacePaths(ids: { proposalId: string; researchId: string; reviewId: string }): string[] {
    return [
      "/",
      "/reports",
      "/reports?type=daily",
      "/reports?type=research",
      "/reports?type=review",
      `/daily/${THREE_DAYS_AGO}`,
      "/news",
      "/paper",
      "/strategy",
      `/member/${member.id}`,
      "/stock/TSM.US",
      `/proposal/${ids.proposalId}`,
      `/research/${ids.researchId}`,
      `/review/${ids.reviewId}`
    ];
  }

  it("U1: not one reading surface leaks a raw ISO instant or a raw long float into visible text", async () => {
    const ids = seedEverything();
    for (const path of surfacePaths(ids)) {
      const response = await get(path);
      expect(response.status, `${path} should render`).toBe(200);
      const text = visibleText(await response.text());
      expect(RAW_ISO_RE.test(text), `${path} rendered a raw ISO instant: ${RAW_ISO_RE.exec(text)?.[0]}`).toBe(false);
      expect(
        RAW_LONG_FLOAT_RE.test(text),
        `${path} rendered a raw long float: ${RAW_LONG_FLOAT_RE.exec(text)?.[0]}`
      ).toBe(false);
    }
  });

  it("U2: every surface's topbar labels the request clock as 页面生成于, never as the data's time", async () => {
    const ids = seedEverything();
    for (const path of surfacePaths(ids)) {
      const body = await (await get(path)).text();
      expect(body, `${path} topbar`).toContain("页面生成于 07-30 周四 00:18");
      // The pre-fix shape: a bare "· 生成于 <request time>" that a reader
      // reasonably read as the data's time.
      expect(body, `${path} must not claim the request time as the data time`).not.toContain("· 生成于 07-30");
    }
  });

  it("U2: a surface whose data is 3 days old says so in the topbar and never shows a green 最新 pill", async () => {
    const ids = seedEverything();
    for (const path of [`/daily/${THREE_DAYS_AGO}`, "/reports?type=daily", "/stock/TSM.US", "/paper", "/"]) {
      const body = await (await get(path)).text();
      expect(body, `${path} must state a data time`).toContain("数据时间 ");
      expect(body, `${path} must not claim 最新 over 3-day-old data`).not.toContain('<span class="pill ok">最新</span>');
      void ids;
    }
  });

  it("U2: today's data IS allowed to say 最新 - the staleness rule is not just 'always warn'", async () => {
    writeReport("daily", TODAY, "# 日报\n\n今天的内容。\n");
    const body = await (await get(`/daily/${TODAY}`)).text();
    expect(body).toContain('<span class="pill ok">最新</span>');
    expect(body).toContain("（今日）");
  });

  it("U3: on an EMPTY database no surface shows a bare 暂无X - every empty block explains itself", async () => {
    // Nothing seeded at all: the state a brand-new member logs into.
    for (const path of ["/", "/reports", "/reports?type=research", "/reports?type=review", "/news", "/paper", "/strategy", `/member/${member.id}`, "/stock/TSM.US"]) {
      const body = await (await get(path)).text();
      const text = visibleText(body);
      // The shape being outlawed: a 暂无X that is the entire content of its
      // element (`>暂无提醒<`), with no follow-up telling the reader what
      // would fill it.
      const bareEmptyState = />\s*暂无[^<]{0,12}<\/p>/u.exec(body);
      expect(bareEmptyState?.[0], `${path} still renders a bare empty state`).toBeUndefined();
      // Every page must carry the two-line empty-state markup somewhere.
      expect(body, `${path} should use the shared empty-state block`).toContain('class="empty-state"');
      expect(text.length).toBeGreaterThan(200);
    }
  });

  it("U3: empty states point at a mechanism that exists, never at an unshipped phase", async () => {
    for (const path of ["/", "/paper", "/strategy", "/reports"]) {
      const body = await (await get(path)).text();
      // These strings were live on the site long after the phases shipped -
      // the page told a reader a feature was missing when it was just empty.
      for (const stale of ["P6 上线", "P7 上线", "P8 上线", "P9 上线", "待 P6/P9 完善", "P6 完善"]) {
        expect(body, `${path} still names ${stale}`).not.toContain(stale);
      }
    }
  });

  it("U2: a monthly review covering a month that ended weeks ago is never labelled 最新", async () => {
    // Found against the LIVE database on 2026-07-30: /review/<id> carried a
    // green 最新 pill next to 「数据时间 06-01（59 天前）」.
    const ids = seedEverything(); // seeds a 2026-06 review
    const body = await (await get(`/review/${ids.reviewId}`)).text();
    expect(body).toContain("数据时间 06-01（");
    expect(body).not.toContain('<span class="pill ok">最新</span>');
    // ...and its sub-metric notes explain the absence rather than saying 暂无数据.
    expect(body).not.toContain(">暂无数据。</p>");
    expect(body).toContain("本月没有可统计的样本，这一段不下结论。");
  });

  // Task 19 (2026-07-30). The topbar has THREE honest answers, and the third
  // one was missing: a page that shows content but cannot date it used to
  // render exactly like a page with no data at all - request clock only.
  it("Task 19: a surface with content but no resolvable data time says 数据时间未知 and why", async () => {
    // Empty database: no snapshot, no stock facts, no analysis - yet each of
    // these pages still renders database-backed blocks.
    for (const path of ["/paper", `/member/${member.id}`, "/stock/TSM.US"]) {
      const body = await (await get(path)).text();
      const text = visibleText(body);
      expect(text, `${path} must disclose the unknown data time`).toContain("数据时间未知");
      // The disclosure has to name a reason - 未知 on its own is the same
      // silence in different words. `visibleText` replaces the stripped tags
      // with spaces, so the reason is separated by whitespace here but not on
      // the page.
      expect(text, `${path} must name the reason`).toMatch(/数据时间未知\s*（.+?）/u);
      // ...and it must not read as a resolved data time.
      expect(body, `${path} must not claim a data time`).not.toContain("· 数据时间 ");
    }
  });

  it("Task 19: a surface WITH a data time never says 数据时间未知 - the disclosure is not blanket", async () => {
    const ids = seedEverything();
    for (const path of ["/", "/paper", `/member/${member.id}`, "/stock/TSM.US", `/review/${ids.reviewId}`]) {
      const body = await (await get(path)).text();
      expect(visibleText(body), `${path} should state a real data time`).not.toContain("数据时间未知");
      expect(body, `${path} should state a real data time`).toContain("数据时间 ");
    }
  });

  it("U1: the seeded alert reaches BOTH the home feed and the stock page as a percentage", async () => {
    seedEverything();
    for (const path of ["/", "/stock/TSM.US"]) {
      const body = await (await get(path)).text();
      expect(body, `${path} alert value`).toContain("-3.32%");
      expect(visibleText(body), `${path} must not show the stored ratio`).not.toContain("-0.0332390201626266");
    }
  });


  // -------------------------------------------------------------------------
  // Task 23 (2026-07-30): a report reading page must confine a wide table's
  // overflow to the table, and its TOC must highlight while you scroll -
  // under this site's nonce-only script CSP. Driven end to end through the
  // real server, because the CSP header and the page markup come from two
  // different modules and the whole point is that they agree.
  // -------------------------------------------------------------------------
  it("T23: a wide report table gets its own horizontal scroll container", async () => {
    writeReport(
      "daily",
      TODAY,
      "# 日报\n\n## 数据表\n\n| 标的 | 现价 | 涨跌 | 成交量 | 市值 | PE | 目标价 |\n| --- | --- | --- | --- | --- | --- | --- |\n| TSM.US | 375.10 | -1.2% | 12.3M | 1.9T | 28.4 | 420.00 |\n"
    );
    const body = await (await get(`/daily/${TODAY}`)).text();

    expect(body).toContain('<div class="table-scroll"');
    expect(body).toContain(".report-body .table-scroll{overflow-x:auto");
    expect(body).toMatch(/<div class="table-scroll"[^>]*><table>/u);
  });

  it("T23: the TOC's scroll-highlighting script carries the response's own CSP nonce", async () => {
    writeReport("daily", TODAY, "# 日报\n\n## 一、市场概览\n\n正文\n\n## 二、宏观日历\n\n正文\n");
    const response = await get(`/daily/${TODAY}`);
    const nonce = /nonce-([^']+)/u.exec(response.headers.get("content-security-policy") ?? "")?.[1];
    const body = await response.text();

    expect(nonce).toBeTruthy();
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).toContain("new IntersectionObserver");
    expect(body).toContain('data-toc-link="');
    // Every script on the page must be nonce'd, or the CSP blocks it.
    for (const tag of body.match(/<script[^>]*>/gu) ?? []) {
      expect(tag, `unnonced script: ${tag}`).toContain(`nonce="${nonce}"`);
    }
  });

  it("T23: the TOC script defers, because it really is emitted above the .report-body it queries", async () => {
    writeReport("daily", TODAY, "# 日报\n\n## 一、市场概览\n\n正文\n\n## 二、宏观日历\n\n正文\n");
    const body = await (await get(`/daily/${TODAY}`)).text();

    // The order that made the first version of this feature dead on arrival:
    // the script executes while `.report-body` is still unparsed, so a
    // synchronous querySelectorAll finds no headings and it silently gives up.
    // Caught only by driving the real page in a browser.
    const scriptAt = body.indexOf("new IntersectionObserver");
    const reportBodyAt = body.indexOf('class="report-body"');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(reportBodyAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(reportBodyAt);
    expect(body).toContain('if (document.readyState === "loading")');
  });

  it("T23: the TOC links resolve to anchors that exist in the rendered body", async () => {
    writeReport("daily", TODAY, "# 日报\n\n## 一、市场概览\n\n正文\n\n## 二、宏观日历\n\n正文\n");
    const body = await (await get(`/daily/${TODAY}`)).text();

    const targets = Array.from(body.matchAll(/data-toc-link="([^"]+)"/gu)).map((match) => match[1] as string);
    expect(targets.length).toBe(2);
    for (const id of targets) {
      expect(body).toContain(`<h2 id="${id}">`);
    }
  });
});
