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

function reportsDir(repoRoot: string, type: string): string {
  return join(repoRoot, "reports", type);
}

function writeReport(repoRoot: string, type: string, filename: string, content: string): void {
  const dir = reportsDir(repoRoot, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf8");
}

describe("reports routes", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let token: string;
  let member: Member;

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
    new MemberRepository(db).upsert(member);
    token = new ApiTokenRepository(db).issue(member.id, "test").token;

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
      expect(body).toContain("暂无研判");
    });

    it("owner isolation: member B's report list never shows member A's research", async () => {
      const memberA = { ...member, id: "member_a", email: "a@example.com" };
      new MemberRepository(db).upsert(memberA);
      finishTask("member_a", "A的私有研判问题");

      const response = await authed("/reports?type=研判");
      const body = await response.text();
      expect(body).not.toContain("A的私有研判问题");
      expect(body).toContain("暂无研判");
    });

    it("shows 暂无研判 when the viewer has no completed research at all", async () => {
      const response = await authed("/reports?type=研判");
      const body = await response.text();
      expect(body).toContain("暂无研判");
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
      expect(body).toContain("暂无复盘");
    });

    it("shows 暂无复盘 (with the auto-generation hint) when the viewer has no reviews at all", async () => {
      const response = await authed("/reports?type=复盘");
      const body = await response.text();
      expect(body).toContain("暂无复盘");
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
      expect(body).toContain("历史存档"); // legacy archive banner
      expect(body).toContain("旧格式无置信度");
      expect(body).toContain("延迟"); // not today -> delayed freshness
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
  });
});
