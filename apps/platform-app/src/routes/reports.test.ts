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

/** The REAL card writer (apps/openclaw-config/scripts/official-paper-monitor.mjs).
 * Imported so the R4/F9 cases below can run the writer's own snapshot writes and
 * its own recipient resolution against this module's own route, instead of
 * restating either side's rule in a fixture. */
const officialPaperMonitor = await import("../../../openclaw-config/scripts/official-paper-monitor.mjs");

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function reportsDir(repoRoot: string, type: string): string {
  return join(repoRoot, "reports", type);
}

function writeReport(repoRoot: string, type: string, filename: string, content: string): void {
  const dir = reportsDir(repoRoot, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf8");
}

/** Just the reading page's 摘要 card, so an assertion about what the SUMMARY
 * says cannot be satisfied by the same words appearing in the rendered report
 * body further down the page. */
function summaryCard(body: string): string {
  const start = body.indexOf("<h2>摘要");
  if (start < 0) {
    return "";
  }
  const end = body.indexOf("</section>", start);
  return body.slice(start, end < 0 ? undefined : end);
}

/** A real `renderPnlReport` shaped body (official-paper-monitor.mjs): the
 * account's net assets, cash, position valuation and per-symbol holdings.
 * These exact numbers are what the B1 assertions below prove a non-owner
 * never receives. */
const PAPER_ACCOUNT_MARKDOWN = [
  "# OpenClaw 模拟盘收支变化 2026-06-17",
  "",
  "## 收支变化表",
  "",
  "| 对比项 | 净资产 | 现金 | 持仓估值 |",
  "| --- | ---: | ---: | ---: |",
  "| 当前 | 122951.22 USD | 122220.08 USD | 731.42 USD |",
  "",
  "## 持仓",
  "",
  "- QQQ.US：数量 1，成本 663.88 USD，最新价 731.42 USD。"
].join("\n");

/** Seeds one `official_paper_snapshots` row - the record the report generator
 * writes in the SAME run that writes `<date>-post-open.md`, and therefore the
 * only thing on the platform side that can say whose account that file
 * describes. `ownerId: null` reproduces a pre-schema-v4 historical row. */
function seedPaperSnapshot(
  db: DatabaseSync,
  opts: { fetchedAt: string; ownerId: string | null; reason?: string }
): void {
  db.prepare(
    `INSERT INTO official_paper_snapshots
     (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    createId("official_paper_snapshot"),
    opts.fetchedAt,
    opts.reason ?? "post_open_pnl",
    122951.22,
    122220.08,
    731.42,
    JSON.stringify([{ symbol: "QQQ.US", quantity: 1, costPrice: 663.88, price: 731.42, priceSource: "live" }]),
    JSON.stringify({ fetchedAt: opts.fetchedAt }),
    opts.ownerId
  );
}

describe("reports routes", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let token: string;
  let member: Member;
  let otherToken: string;
  let otherMember: Member;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-reports-route-"));
    db = memoryDb();
    member = {
      id: "member_1",
      email: "member1@example.com",
      displayName: "Member One",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active" as const,
      createdAt: "2026-07-01T00:00:00.000Z"
    };
    // A SECOND active member - the whole point of defect B1 is that an
    // ordinary active member (not the paper account's owner) must not be able
    // to read that account's content, and with only one member seeded no test
    // can ever observe that.
    otherMember = { ...member, id: "member_2", email: "member2@example.com", displayName: "Member Two" };
    new MemberRepository(db).upsert(member);
    new MemberRepository(db).upsert(otherMember);
    token = new ApiTokenRepository(db).issue(member.id, "test").token;
    otherToken = new ApiTokenRepository(db).issue(otherMember.id, "test-other").token;

    // Fixed clock (rather than the real wall clock) so the freshness
    // assertions below ("最新" for today's date, "延迟" for an older one)
    // are deterministic regardless of what day this suite actually runs on.
    // 2026-07-14T12:00:00Z is 2026-07-14 20:00 in Asia/Shanghai.
    server = createPlatformServer({ db, repoRoot, now: () => new Date("2026-07-14T12:00:00Z") });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function authed(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  /** Same request as `authed`, but as `otherMember` - an ordinary
   * `status='active'` member who owns no paper account. */
  function authedAsOther(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${otherToken}` } });
  }

  describe("GET /reports", () => {
    it("returns 401 without any identity", async () => {
      const response = await fetch(`${baseUrl}/reports`);
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(body).toContain("未获授权");
    });

    it("returns 200 with the Cf-Access-Authenticated-User-Email header for an active member", async () => {
      const response = await fetch(`${baseUrl}/reports`, {
        headers: { "cf-access-authenticated-user-email": "member1@example.com" }
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    });

    it("returns 200 with a valid bearer token and lists a scanned report as a card", async () => {
      writeReport(repoRoot, "daily", "2026-06-19.md", "# OpenClaw 日报 2026-06-19\n\n窗口内容。\n");

      const response = await authed("/reports");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("2026-06-19");
      expect(body).toContain("OpenClaw 日报 2026-06-19");
      expect(body).toContain("历史存档");
      expect(body).toContain("日报");
    });

    it("renders real, clickable 研判 AND 复盘 chips (P8 + P9 both shipped) - no disabled chips remain", async () => {
      const response = await authed("/reports");
      const body = await response.text();
      expect(body).toContain("研判");
      expect(body).not.toContain("研判</span><small class=\"mono\""); // no longer the disabled-chip markup
      expect(body).toMatch(/<a href="\/reports\?type=%E7%A0%94%E5%88%A4"[^>]*>研判<\/a>/u);
      expect(body).toContain("复盘");
      expect(body).not.toContain("复盘</span><small class=\"mono\""); // no longer the disabled-chip markup
      expect(body).toMatch(/<a href="\/reports\?type=%E5%A4%8D%E7%9B%98"[^>]*>复盘<\/a>/u);
      expect(body).not.toContain("P9 上线");
      expect(body).not.toContain("aria-disabled"); // no disabled chip markup anywhere
    });

    it("filters by ?type=", async () => {
      writeReport(repoRoot, "daily", "2026-06-19.md", "# 日报标题\n\n内容。\n");
      writeReport(repoRoot, "weekly", "2026-05-25.md", "# 周报标题\n\n内容。\n");

      const response = await authed("/reports?type=weekly");
      const body = await response.text();
      expect(body).toContain("周报标题");
      expect(body).not.toContain("日报标题");
    });

    it("returns 405 for non-GET requests", async () => {
      const response = await fetch(`${baseUrl}/reports`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(405);
    });
  });

  // Phase 8 Task 4 (2026-07-16 plan): the 研判 chip's real, DB-backed list.
  describe("GET /reports?type=研判 (real research archive, owner-filtered)", () => {
    function finishTask(
      ownerId: string,
      question: string,
      opts: { status?: "done" | "degraded"; confidence?: "low" | "medium" | "high"; title?: string } = {}
    ): string {
      const repo = new ResearchTaskRepository(db);
      const created = repo.createIfWithinQuota({ ownerId, question, tradingDay: "2026-07-14" });
      if (!created.ok) throw new Error("test setup: quota unexpectedly exceeded");
      repo.setResult(created.task.id, {
        status: opts.status ?? "done",
        confidence: opts.confidence ?? "medium",
        title: opts.title ?? question,
        finishedAt: "2026-07-14T09:00:00.000Z",
        resultJson: {
          conclusion: "测试结论",
          confidence: opts.confidence ?? "medium",
          keyPoints: [],
          dataTable: [],
          comparison: { theses: [], disciplines: [] },
          evidence: [],
          skipped: []
        }
      });
      return created.task.id;
    }

    it("lists the viewer's own done/degraded research as cards (title, confidence badge, date, /research/<id> link)", async () => {
      const id = finishTask(member.id, "NVDA财报前要减仓吗", { confidence: "high" });

      const response = await authed("/reports?type=研判");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("NVDA财报前要减仓吗");
      expect(body).toContain("高"); // CONFIDENCE_LABELS.high
      expect(body).toContain(`href="/research/${id}"`);
      expect(body).toContain("2026-07-14"); // finished date
    });

    it("includes degraded tasks alongside done ones", async () => {
      finishTask(member.id, "降级的研判", { status: "degraded", confidence: "low" });
      const response = await authed("/reports?type=研判");
      const body = await response.text();
      expect(body).toContain("降级的研判");
    });

    it("excludes queued/running/failed tasks (no conclusion to show yet)", async () => {
      new ResearchTaskRepository(db).createIfWithinQuota({
        ownerId: member.id,
        question: "还在排队的问题",
        tradingDay: "2026-07-14"
      });
      const response = await authed("/reports?type=研判");
      const body = await response.text();
      expect(body).not.toContain("还在排队的问题");
      expect(body).toContain("你还没有任何研判。");
    });

    it("owner isolation: member B's report list never shows member A's research", async () => {
      const memberA = { ...member, id: "member_a", email: "a@example.com" };
      new MemberRepository(db).upsert(memberA);
      finishTask("member_a", "A的私有研判问题");

      const response = await authed("/reports?type=研判");
      const body = await response.text();
      expect(body).not.toContain("A的私有研判问题");
      expect(body).toContain("你还没有任何研判。");
    });

    it("shows the no-research empty state when the viewer has no completed research at all", async () => {
      const response = await authed("/reports?type=研判");
      const body = await response.text();
      expect(body).toContain("你还没有任何研判。");
    });
  });

  // Phase 9 Task 4 (2026-07-16 plan): the 复盘 chip's real, DB-backed,
  // ALWAYS-owner-scoped list (monthly_reviews has no public visibility at
  // all, unlike research_tasks).
  describe("GET /reports?type=复盘 (real review archive, owner-filtered, no public path)", () => {
    function seedReview(
      ownerId: string,
      period: string,
      opts: { confirm?: boolean } = {}
    ): string {
      const repo = new MonthlyReviewRepository(db);
      const review = repo.upsertDraft({
        ownerId,
        period,
        resultJson: {
          ownerId,
          period,
          generatedAt: "2026-07-14T00:00:00.000Z",
          predictionReview: {
            selfThesisHitRate: { sample: "insufficient", n: 0 },
            systemConfidenceCalibration: [],
            systemConfidenceCalibrationNote: "系统个股分析置信度校准——全平台口径，非本人专属"
          },
          decisionReview: {
            period,
            periodStart: "2026-07-01T00:00:00.000Z",
            periodEnd: "2026-08-01T00:00:00.000Z",
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
        }
      });
      if (opts.confirm) {
        repo.confirm(review.id, ownerId);
      }
      return review.id;
    }

    it("lists the viewer's own reviews as cards (period, 草稿/已确认 status, /review/<id> link)", async () => {
      const draftId = seedReview(member.id, "2026-06");
      const confirmedId = seedReview(member.id, "2026-05", { confirm: true });

      const response = await authed("/reports?type=复盘");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("2026-06");
      expect(body).toContain("草稿");
      expect(body).toContain(`href="/review/${draftId}"`);
      expect(body).toContain("2026-05");
      expect(body).toContain("已确认");
      expect(body).toContain(`href="/review/${confirmedId}"`);
    });

    it("owner isolation: member B's report list never shows member A's reviews", async () => {
      const memberA = { ...member, id: "member_a", email: "a@example.com" };
      new MemberRepository(db).upsert(memberA);
      seedReview("member_a", "2026-06");

      const response = await authed("/reports?type=复盘");
      const body = await response.text();
      expect(body).not.toContain("2026-06");
      expect(body).toContain("你还没有任何月度复盘。");
    });

    it("shows 暂无复盘 (with the auto-generation hint) when the viewer has no reviews at all", async () => {
      const response = await authed("/reports?type=复盘");
      const body = await response.text();
      expect(body).toContain("你还没有任何月度复盘。");
      expect(body).toContain("每月第一个周末自动生成草稿");
    });
  });

  describe("GET /daily/<date> and friends (reading pages)", () => {
    it("returns 401 without identity", async () => {
      const response = await fetch(`${baseUrl}/daily/2026-06-19`);
      expect(response.status).toBe(401);
    });

    it("renders a real fixture report: summary, TOC, body, sources, and freshness", async () => {
      writeReport(
        repoRoot,
        "daily",
        "2026-06-19.md",
        [
          "# OpenClaw 日报 2026-06-19",
          "",
          "窗口内的摘要首段文本。",
          "",
          "## 今日结论",
          "",
          "市场信号见[原文](https://example.com/source)。",
          "",
          "## 风险与异常",
          "",
          "没有风险。"
        ].join("\n")
      );

      const response = await authed("/daily/2026-06-19");
      expect(response.status).toBe(200);
      const body = await response.text();

      expect(body).toContain("窗口内的摘要首段文本。"); // summary card
      expect(body).toContain('href="#今日结论"'); // TOC anchor
      expect(body).toContain('<h2 id="今日结论">今日结论</h2>'); // body heading with matching id
      expect(body).toContain(
        '<a href="https://example.com/source" rel="noreferrer" target="_blank">原文</a>'
      ); // sources list entry
      expect(body).toContain("历史存档"); // legacy archive banner - this file really is pre-marker
      expect(body).toContain("旧版格式");
      expect(body).toContain("延迟"); // not today -> delayed freshness
    });

    // -----------------------------------------------------------------------
    // Task 12 (2026-07-30): 历史存档 is now decided per file. Before this, a
    // report generated minutes ago wore the same 旧版格式 banner as a
    // 2026-05 archive, and its summary card claimed 旧格式无置信度.
    // -----------------------------------------------------------------------

    it("does NOT call a report carrying its family's current-format marker an archive", async () => {
      writeReport(
        repoRoot,
        "daily",
        "2026-07-14.md",
        ["# OpenClaw 日报 2026-07-14", "", "今天的摘要首段。", "", "### 多源新闻（事件聚类）", "", "- 事件：X。"].join("\n")
      );

      const body = await (await authed("/daily/2026-07-14")).text();

      expect(body).not.toContain("历史存档");
      expect(body).not.toContain("旧版格式");
      expect(body).not.toContain("旧格式");
    });

    it("says the conclusion box is MISSING - not that the report is old - for a new-format report without one", async () => {
      writeReport(
        repoRoot,
        "daily",
        "2026-07-14.md",
        ["# OpenClaw 日报 2026-07-14", "", "今天的摘要首段。", "", "### 多源新闻（事件聚类）", "", "- 事件：X。"].join("\n")
      );

      const body = await (await authed("/daily/2026-07-14")).text();

      expect(body).toContain("该报告未提供结论框");
      expect(body).not.toContain("旧格式无置信度");
    });

    it("renders the conclusion box itself - core conclusion + confidence - when the report carries one", async () => {
      writeReport(
        repoRoot,
        "weekly",
        "2026-07-14.md",
        [
          "# OpenClaw 周报 2026-07-14",
          "",
          "无关紧要的首段。",
          "",
          "### 多源新闻（事件聚类）",
          "",
          "- 事件：X。",
          "",
          // Bullet shape copied from a REAL rendered box (reports/
          // stock-analysis/2026-07-27.md on the deployed machine); the
          // parser's own contract test lives in reports/conclusion-box.test.ts
          // against the shared fixture.
          "### 结论框",
          "",
          "- 核心结论：科技股短期偏强，仓位不动。",
          "- 置信度：中",
          "- 合理价值区间：380.00–420.00 美元（依据：近20日支撑位与阻力位）",
          "- 当前价格位置：现价 400.00 美元，位于合理区间内（380.00–420.00 美元）",
          "- 复盘触发：跌破 380.00 美元需重新评估（复盘日期：2026-08-01）"
        ].join("\n")
      );

      const body = await (await authed("/weekly/2026-07-14")).text();
      // Scoped to the summary card - the same words appear in the rendered
      // report body regardless, so a whole-page match would pass even if the
      // summary card ignored the box entirely.
      const summary = summaryCard(body);

      expect(summary).toContain("科技股短期偏强，仓位不动。");
      expect(summary).toContain("置信度 中");
      expect(summary).not.toContain("无关紧要的首段。");
      expect(body).not.toContain("该报告未提供结论框");
      expect(body).not.toContain("旧格式");
    });

    it("never presents one symbol's box as the whole batch's conclusion on a multi-symbol analysis", async () => {
      writeReport(
        repoRoot,
        "stock-analysis",
        "2026-07-14.md",
        [
          "# OpenClaw 个股分析 2026-07-14",
          "",
          "本批次覆盖两只标的。",
          "",
          "## AMZN.US",
          "",
          "### 结论框",
          "",
          "- 核心结论：AMZN 维持观望。",
          "- 置信度：低",
          "- 合理价值区间：180.00–220.00 美元（依据：近20日支撑位与阻力位）",
          "- 当前价格位置：现价 185.00 美元，位于合理区间内（180.00–220.00 美元）",
          "- 复盘触发：跌破 180.00 美元需重新评估（复盘日期：2026-08-01）",
          "",
          "## GOOG.US",
          "",
          "### 结论框",
          "",
          "- 核心结论：GOOG 小幅加仓。",
          "- 置信度：高",
          "- 合理价值区间：150.00–190.00 美元（依据：近20日支撑位与阻力位）",
          "- 当前价格位置：现价 175.00 美元，位于合理区间内（150.00–190.00 美元）",
          "- 复盘触发：跌破 150.00 美元需重新评估（复盘日期：2026-08-01）"
        ].join("\n")
      );

      const body = await (await authed("/stock-analysis/2026-07-14")).text();

      // The batch summary must not silently become the first symbol's verdict.
      expect(body).toContain("本报告含 2 个逐标的结论框");
      expect(body).toContain("本批次覆盖两只标的。");
      expect(body).not.toContain("该报告未提供结论框");
    });

    it("says a legacy archive has no conclusion box BECAUSE of its era", async () => {
      writeReport(repoRoot, "daily", "2026-06-19.md", "# 日报\n\n旧的首段。\n");

      const body = await (await authed("/daily/2026-06-19")).text();

      expect(body).toContain("历史存档");
      expect(body).toContain("旧版格式");
      expect(body).not.toContain("该报告未提供结论框");
    });

    it("states the ACTUAL legacy difference per report family, not the daily/weekly one for all", async () => {
      writeReport(repoRoot, "stock-analysis", "2026-06-19.md", "# 个股分析\n\n旧的首段。\n");

      const body = await (await authed("/stock-analysis/2026-06-19")).text();

      expect(body).toContain("历史存档");
      // A stock analysis never carried the shared paper account - claiming it
      // did was the daily/weekly banner text leaking onto every kind.
      expect(body).not.toContain("共享模拟盘账户");
    });

    it("marks a report dated today (Beijing time) as 最新", async () => {
      writeReport(repoRoot, "daily", "2026-07-14.md", "# 今日日报\n\n内容。\n");

      const response = await authed("/daily/2026-07-14");
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("最新");
    });

    it("returns a Chinese 404 page for a well-formed but missing date", async () => {
      const response = await authed("/daily/2099-01-01");
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("未找到");
    });

    it("returns 404 (not a crash or 200) for a path-traversal-shaped date param", async () => {
      // `new URL(...)` (both here and inside Node's own `fetch`) applies
      // WHATWG dot-segment removal to a LITERAL `..` in the path before this
      // handler ever sees it - `/daily/../../etc/passwd` collapses to
      // `/etc/passwd` at parse time and never even matches this route. The
      // percent-encoded form below is NOT decoded by `.pathname` (encoded
      // slashes aren't path separators), so it DOES survive as a literal,
      // non-date `segments[1]` - exactly the shape the date regex guard
      // exists to reject before any filesystem lookup happens.
      const response = await authed("/daily/..%2F..%2Fetc%2Fpasswd");
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("未找到");
    });

    it("respects each type's own directory (weekly/stock-analysis/official-paper)", async () => {
      writeReport(repoRoot, "weekly", "2026-05-25.md", "# 周报 05-25\n\n周报内容。\n");
      writeReport(repoRoot, "stock-analysis", "2026-06-19.md", "# 个股分析 06-19\n\n分析内容。\n");
      writeReport(
        repoRoot,
        "official-paper",
        "2026-06-17-post-open.md",
        "# 模拟盘收支变化 06-17\n\n收支内容。\n"
      );
      // official-paper is owner-scoped (defect B1): the snapshot row written
      // alongside the file is what attributes it, so the viewer only gets a
      // 200 here because THEY own that day's account snapshot.
      seedPaperSnapshot(db, { fetchedAt: "2026-06-17T13:40:00.000Z", ownerId: member.id });

      const weekly = await authed("/weekly/2026-05-25");
      const stock = await authed("/stock-analysis/2026-06-19");
      const paper = await authed("/official-paper/2026-06-17");

      expect(weekly.status).toBe(200);
      expect(await weekly.text()).toContain("周报内容");
      expect(stock.status).toBe(200);
      expect(await stock.text()).toContain("分析内容");
      expect(paper.status).toBe(200);
      expect(await paper.text()).toContain("收支内容");
    });

    it("returns 405 for non-GET requests", async () => {
      const response = await fetch(`${baseUrl}/daily/2026-06-19`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(405);
    });

    // Task 6 (2026-07-28): the daily/weekly reading pages are where a member
    // finds their own personal page - the public body no longer carries any
    // personal holdings/strategy content (Task 4), so the entry point to it
    // has to be here.
    it("renders a 我的个人页 entry linking to /<type>/<date>/me on the daily and weekly reading pages", async () => {
      writeReport(repoRoot, "daily", "2026-07-14.md", "# 今日日报\n\n内容。\n");
      writeReport(repoRoot, "weekly", "2026-05-25.md", "# 周报 05-25\n\n周报内容。\n");

      const daily = await authed("/daily/2026-07-14");
      const dailyBody = await daily.text();
      expect(dailyBody).toContain("我的个人页");
      expect(dailyBody).toContain('href="/daily/2026-07-14/me"');

      const weekly = await authed("/weekly/2026-05-25");
      const weeklyBody = await weekly.text();
      expect(weeklyBody).toContain("我的个人页");
      expect(weeklyBody).toContain('href="/weekly/2026-05-25/me"');
    });

    it("does NOT offer a 我的个人页 entry on report types that have no personal page (个股分析/模拟盘快照)", async () => {
      writeReport(repoRoot, "stock-analysis", "2026-06-19.md", "# 个股分析 06-19\n\n分析内容。\n");

      const stock = await authed("/stock-analysis/2026-06-19");
      const body = await stock.text();
      expect(body).not.toContain("我的个人页");
      expect(body).not.toContain("/me\"");
    });
  });

  // -------------------------------------------------------------------------
  // Defect B1 (2026-07-28 adversarial review, CRITICAL live exposure):
  // `/official-paper/<date>` served the paper account's 净资产/现金/持仓明细 to
  // ANY status='active' member, and the /reports list linked it. The file on
  // disk carries no owner attribution, so the ONLY honest source is the
  // `official_paper_snapshots` row the generator wrote in the same run.
  //
  // These cases assert the contract that actually decides who sees the
  // account content - HTTP status + response body + what the listing links -
  // for every attribution state that column can be in (a real member, the
  // '__shared__' sentinel, a legacy NULL, two members on one date, nothing at
  // all). None of them touch an internal helper, so none of them can pass
  // while the URL still leaks.
  // -------------------------------------------------------------------------
  describe("GET /official-paper/<date> is readable ONLY by the member the account belongs to (B1)", () => {
    const DATE = "2026-06-17";
    const FETCHED_AT = `${DATE}T13:40:00.000Z`;
    /** Every account figure the file contains; none may reach a non-owner. */
    const ACCOUNT_FIGURES = ["122951.22", "122220.08", "731.42", "663.88", "QQQ.US", "净资产"];

    function writePaperReport(): void {
      writeReport(repoRoot, "official-paper", `${DATE}-post-open.md`, PAPER_ACCOUNT_MARKDOWN);
    }

    async function expectNoAccountContent(response: Response): Promise<string> {
      const body = await response.text();
      for (const figure of ACCOUNT_FIGURES) {
        expect(body).not.toContain(figure);
      }
      return body;
    }

    it("owner: 200 with the account content (the report is not lost, just owner-scoped)", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: member.id });

      const response = await authed(`/official-paper/${DATE}`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("122951.22");
      expect(body).toContain("QQQ.US");
    });

    // Defect B2: the snapshot reading page became owner-private with B1, so it
    // must forbid shared/intermediary caching for the same reason the personal
    // page does - an owner-only response that a cache may store is not
    // owner-only.
    it("owner-private responses forbid caching (cache-control: private, no-store)", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: member.id });

      const own = await authed(`/official-paper/${DATE}`);
      expect(own.status).toBe(200);
      expect(own.headers.get("cache-control")).toBe("private, no-store");

      const refused = await authedAsOther(`/official-paper/${DATE}`);
      expect(refused.status).toBe(403);
      expect(refused.headers.get("cache-control")).toBe("private, no-store");
    });

    it("non-owner: 403 and NOT ONE account figure in the body", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: member.id });

      const response = await authedAsOther(`/official-paper/${DATE}`);
      expect(response.status).toBe(403);
      const body = await expectNoAccountContent(response);
      expect(body).toContain("403 无权访问");
    });

    it("unattributable ('__shared__' sentinel): 403 for EVERY member, with the reason stated - never guessed onto the only active member", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: "__shared__" });

      for (const response of [await authed(`/official-paper/${DATE}`), await authedAsOther(`/official-paper/${DATE}`)]) {
        expect(response.status).toBe(403);
        const body = await expectNoAccountContent(response);
        expect(body).toContain("无法确认");
      }
    });

    it("unattributable (legacy NULL owner_id): 403 for every member", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: null });

      for (const response of [await authed(`/official-paper/${DATE}`), await authedAsOther(`/official-paper/${DATE}`)]) {
        expect(response.status).toBe(403);
        await expectNoAccountContent(response);
      }
    });

    it("unattributable (two members' snapshots on the same date): 403 for both - ambiguity is not ownership", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: member.id });
      seedPaperSnapshot(db, { fetchedAt: `${DATE}T13:41:00.000Z`, ownerId: otherMember.id });

      for (const response of [await authed(`/official-paper/${DATE}`), await authedAsOther(`/official-paper/${DATE}`)]) {
        expect(response.status).toBe(403);
        await expectNoAccountContent(response);
      }
    });

    it("unattributable (no snapshot row at all): 403, not 200 - an unattributed file is never readable", async () => {
      writePaperReport();

      const response = await authed(`/official-paper/${DATE}`);
      expect(response.status).toBe(403);
      await expectNoAccountContent(response);
    });

    it("a snapshot from another run kind (hourly poll) does not attribute the post-open report file", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: member.id, reason: "hourly_poll" });

      const response = await authed(`/official-paper/${DATE}`);
      expect(response.status).toBe(403);
      await expectNoAccountContent(response);
    });

    it("listing: a non-owner's /reports never links or labels the snapshot, and says how many were withheld", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: member.id });
      writeReport(repoRoot, "daily", "2026-06-19.md", "# OpenClaw 日报 2026-06-19\n\n公共内容。\n");

      const response = await authedAsOther("/reports");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(`href="/official-paper/${DATE}"`);
      expect(body).not.toContain("OpenClaw 模拟盘收支变化");
      expect(body).toContain("已隐藏 1 份"); // honest disclosure, not a silent drop
      // The rest of the library is untouched for that member.
      expect(body).toContain("OpenClaw 日报 2026-06-19");
    });

    it("listing: the owner's /reports still shows their own snapshot card", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: member.id });

      const body = await (await authed("/reports")).text();
      expect(body).toContain(`href="/official-paper/${DATE}"`);
      expect(body).toContain("OpenClaw 模拟盘收支变化 2026-06-17"); // the card's title, not just the type chip
      expect(body).not.toContain("已隐藏");
    });

    it("listing: ?type=official-paper for a non-owner lists nothing and discloses why", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: member.id });

      const body = await (await authedAsOther("/reports?type=official-paper")).text();
      expect(body).not.toContain(`href="/official-paper/${DATE}"`);
      expect(body).toContain("这个类型下还没有报告。");
      expect(body).toContain("已隐藏 1 份");
    });

    it("listing: an unattributable snapshot is withheld from the owner-ish member too, with its own reason", async () => {
      writePaperReport();
      seedPaperSnapshot(db, { fetchedAt: FETCHED_AT, ownerId: null });

      const body = await (await authed("/reports")).text();
      expect(body).not.toContain(`href="/official-paper/${DATE}"`);
      expect(body).toContain("归属无法确认");
    });
  });

  // -------------------------------------------------------------------------
  // 2026-07-28 (spec drift R4/F9). The card writer resolved its recipient from
  // ONE row (the run's own snapshot); this page resolves the 403 from EVERY
  // post_open_pnl row on the date. Two same-date rows with different owners
  // therefore DM'd member_1 a card for a page that 403s member_1 - while the
  // writer's doc claimed the two "cannot disagree about who owns the numbers".
  //
  // These cases run the REAL writer (official-paper-monitor.mjs: its own
  // saveSnapshot writes the rows, its own resolvePnlReportScope decides the
  // recipient) against the REAL route, on ONE database. No hand-written
  // snapshot row and no restated rule: if either side's rule changes alone,
  // this fails.
  // -------------------------------------------------------------------------
  describe("the card's scope and the page's attribution agree (spec drift R4/F9)", () => {
    const DATE = "2026-06-17";

    /** The writer's own snapshot shape, as `fetchOfficialPaperSnapshot` returns
     * it - saveSnapshot derives every persisted column from this. */
    function paperSnapshot(fetchedAt: string): Record<string, unknown> {
      return {
        fetchedAt,
        primaryAsset: { net_assets: "122951.22", total_cash: "122220.08" },
        positions: [{ symbol: "QQQ.US", quantity: 1, costPrice: 663.88, priceSource: "live", price: 731.42 }],
        quotes: [{ symbol: "QQQ.US", last: 731.42 }]
      };
    }

    beforeEach(() => {
      writeReport(repoRoot, "official-paper", `${DATE}-post-open.md`, PAPER_ACCOUNT_MARKDOWN);
      // The card can only be addressed to a member with a Feishu binding.
      new MemberRepository(db).upsert({ ...member, feishuOpenId: "ou_member_1" });
    });

    it("one owner on the date: the card is owner-private to that member and the page opens for exactly them", async () => {
      const snapshotId = officialPaperMonitor.saveSnapshot(
        db,
        paperSnapshot(`${DATE}T13:40:00.000Z`),
        "post_open_pnl",
        member.id
      );

      expect(officialPaperMonitor.resolvePnlReportScope(db, snapshotId)).toEqual({
        visibility: "owner-private",
        ownerOpenId: "ou_member_1"
      });
      expect((await authed(`/official-paper/${DATE}`)).status).toBe(200);
      expect((await authedAsOther(`/official-paper/${DATE}`)).status).toBe(403);
    });

    it("two owners on one date: the card is refused for the same reason the page 403s EVERYONE", async () => {
      officialPaperMonitor.saveSnapshot(db, paperSnapshot(`${DATE}T13:40:00.000Z`), "post_open_pnl", "__shared__");
      const snapshotId = officialPaperMonitor.saveSnapshot(
        db,
        paperSnapshot(`${DATE}T13:45:00.000Z`),
        "post_open_pnl",
        member.id
      );

      // Before the fix this was {visibility:"owner-private", ownerOpenId:"ou_member_1"}.
      const scope = officialPaperMonitor.resolvePnlReportScope(db, snapshotId);
      expect(scope.visibility).toBe("owner-unresolved");
      expect(scope.reason).toContain(DATE);

      for (const response of [await authed(`/official-paper/${DATE}`), await authedAsOther(`/official-paper/${DATE}`)]) {
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain("122951.22");
      }
    });

    it("the writer's date rule returns the same verdict as the page for every attribution state", async () => {
      const states = [
        { date: "2026-06-18", ownerId: "member_1", expectOwner: "member_1", ownerCanRead: true },
        { date: "2026-06-19", ownerId: "__shared__", expectOwner: null, ownerCanRead: false },
        { date: "2026-06-20", ownerId: null, expectOwner: null, ownerCanRead: false },
        { date: "2026-06-21", ownerId: "member_gone", expectOwner: "member_gone", ownerCanRead: false }
      ] as const;

      for (const state of states) {
        writeReport(repoRoot, "official-paper", `${state.date}-post-open.md`, PAPER_ACCOUNT_MARKDOWN);
        if (state.ownerId === null) {
          // No current writer can produce this: saveSnapshot always stamps an
          // owner (a member id or the sentinel). A NULL owner_id only exists on
          // rows written before schema v4, so it is seeded directly.
          seedPaperSnapshot(db, { fetchedAt: `${state.date}T13:40:00.000Z`, ownerId: null });
        } else {
          officialPaperMonitor.saveSnapshot(
            db,
            paperSnapshot(`${state.date}T13:40:00.000Z`),
            "post_open_pnl",
            state.ownerId
          );
        }

        const attribution = officialPaperMonitor.resolveOfficialPaperDateAttribution(db, state.date);
        expect(attribution.kind === "owner" ? attribution.ownerId : null).toBe(state.expectOwner);

        expect((await authed(`/official-paper/${state.date}`)).status).toBe(state.ownerCanRead ? 200 : 403);
        expect((await authedAsOther(`/official-paper/${state.date}`)).status).toBe(403);
      }
    });
  });
});
