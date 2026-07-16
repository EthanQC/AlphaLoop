// Phase 9 Task 4 (2026-07-16 plan): the monthly review reading page
// (GET /review/<id>) and its confirm endpoint
// (POST /api/reviews/:id/confirm). Exercised through the real HTTP server
// (createPlatformServer), same convention as research.test.ts/
// api-research.test.ts.
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApiTokenRepository,
  MemberRepository,
  MonthlyReviewRepository,
  migrate,
  type Member,
  type MonthlyReviewResult
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
    id: "member_a",
    email: "member-a@example.com",
    displayName: "Member A",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

// A fully-populated result_json fixture (field-for-field the shape
// review-engine.mjs's buildMonthlyReview produces, per data/monthly-review.ts's
// re-declared MonthlyReviewResultShape) with real, non-empty-state numbers in
// every one of the six sections - so the reading-page assertions below
// exercise the real rendering path, not just the empty-state fallbacks.
// `symbol: "A&B.US"` is deliberately chosen for one decision entry - an
// unescaped `&` in HTML output is invalid, so asserting `A&amp;B.US` in the
// rendered body (not the raw `A&B.US`) proves every value is actually routed
// through the escaping `html` tagged template, not string-concatenated.
function fullResultFixture(ownerId: string, period: string): MonthlyReviewResult {
  return {
    ownerId,
    period,
    generatedAt: "2026-07-20T00:00:00.000Z",
    predictionReview: {
      selfThesisHitRate: { sample: "ok", n: 12, hits: 8, total: 12, hitFraction: 0.67 },
      systemConfidenceCalibration: [
        { tier: "low", sample: "none", n: 0 },
        { tier: "medium", sample: "insufficient", n: 3 },
        { tier: "high", sample: "ok", n: 12, hits: 3, hitFraction: 0.25 }
      ],
      systemConfidenceCalibrationNote: "系统个股分析置信度校准——全平台口径，非本人专属"
    },
    decisionReview: {
      period,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
      benchmarkSymbol: "QQQ",
      executed: {
        sample: "ok",
        n: 10,
        priced: 10,
        avgDecisionReturnPct: 8.5,
        avgBenchmarkReturnPct: 3.2,
        avgAlphaPct: 5.3,
        entries: [
          {
            proposalId: "proposal_1",
            symbol: "A&B.US",
            side: "buy",
            entryPrice: 100,
            reviewPrice: 110,
            decisionReturnPct: 10,
            benchmarkSymbol: "QQQ",
            benchmarkEntryPrice: 400,
            benchmarkReviewPrice: 440,
            benchmarkReturnPct: 10,
            alphaPct: 0
          }
        ]
      },
      rejected: {
        sample: "ok",
        n: 1,
        disclaimer: "未执行，仅口径参考",
        entries: [
          {
            proposalId: "proposal_2",
            symbol: "REJ.US",
            side: "buy",
            proposalPrice: 100,
            reviewPrice: 120,
            hypotheticalReturnPct: 20,
            disclaimer: "未执行，仅口径参考"
          }
        ]
      }
    },
    disciplineReview: {
      complianceRate: { sample: "ok", checked: 10, passed: 8, failed: 2, rate: 0.8 },
      complianceValue: {
        compliant: { sample: "ok", n: 10, avgReturnPct: 10 },
        violating: { sample: "ok", n: 10, avgReturnPct: -5 },
        deltaPct: 15
      }
    },
    alertQuality: { sample: "ok", triggeredCount: 4, misreportCount: 2, misreportRate: 0.5 },
    errorCategories: ["策略纪律", "决策择时"],
    oneLineLesson: "本月遵守率偏低，需复核高频违反的规则。",
    nextSteps: ["1. 复核纪律执行情况", "2. 减少主动择时交易"],
    improvementSuggestions: {
      disclaimer: "以上为规则推导的改进建议，仅供参考；任何策略/纪律变更须本人在飞书或 CLI 中手动确认后生效。",
      items: ["建议一：收紧执行", "建议二：重新校准置信度"]
    }
  };
}

describe("monthly review reading page + confirm endpoint", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let memberA: Member;
  let memberB: Member;
  let tokenA: string;
  let tokenB: string;

  function startServer(): Promise<void> {
    server = createPlatformServer({ db, repoRoot });
    return new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-review-route-"));
    db = memoryDb();

    memberA = makeMember();
    memberB = makeMember({ id: "member_b", email: "member-b@example.com", displayName: "Member B" });
    new MemberRepository(db).upsert(memberA);
    new MemberRepository(db).upsert(memberB);
    tokenA = new ApiTokenRepository(db).issue(memberA.id, "a-token").token;
    tokenB = new ApiTokenRepository(db).issue(memberB.id, "b-token").token;

    await startServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function withBearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers });
  }

  function post(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method: "POST", headers, redirect: "manual" });
  }

  /** Mirrors a real `<form method="post">` confirm-button submission (the
   * reading page's own draft banner) - an empty
   * `application/x-www-form-urlencoded` body, `redirect: 'manual'` so the
   * 303 can be asserted rather than transparently followed. */
  function postForm(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: ""
    });
  }

  function seedDraft(ownerId: string, period: string): string {
    const review = new MonthlyReviewRepository(db).upsertDraft({
      ownerId,
      period,
      resultJson: fullResultFixture(ownerId, period)
    });
    return review.id;
  }

  function seedConfirmed(ownerId: string, period: string): string {
    const id = seedDraft(ownerId, period);
    new MonthlyReviewRepository(db).confirm(id, ownerId);
    return id;
  }

  // -------------------------------------------------------------------------
  // GET /review/<id>
  // -------------------------------------------------------------------------

  describe("GET /review/<id>", () => {
    it("returns 401 without any identity", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await get(`/review/${id}`);
      expect(response.status).toBe(401);
    });

    it("returns 404 for a nonexistent review id", async () => {
      const response = await get("/review/does-not-exist", withBearer(tokenA));
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("未找到");
    });

    it("returns 405 for non-GET requests", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await fetch(`${baseUrl}/review/${id}`, { method: "DELETE", headers: withBearer(tokenA) });
      expect(response.status).toBe(405);
    });

    it("owner isolation: member B opens member A's review -> 403, ALWAYS, even though A's review is confirmed (no public exception, unlike research)", async () => {
      const draftId = seedDraft(memberA.id, "2026-07");
      const confirmedId = seedConfirmed(memberA.id, "2026-06");

      const draftAsB = await get(`/review/${draftId}`, withBearer(tokenB));
      expect(draftAsB.status).toBe(403);
      expect(await draftAsB.text()).toContain("403 无权访问");

      const confirmedAsB = await get(`/review/${confirmedId}`, withBearer(tokenB));
      expect(confirmedAsB.status).toBe(403);
      expect(await confirmedAsB.text()).toContain("403 无权访问");
    });

    it("draft review: renders the 待确认 banner with a confirm form targeting /api/reviews/<id>/confirm", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await get(`/review/${id}`, withBearer(tokenA));
      expect(response.status).toBe(200);
      const body = await response.text();

      expect(body).toContain("待确认");
      expect(body).toContain(`<form method="post" action="/api/reviews/${id}/confirm">`);
      expect(body).toMatch(/<button[^>]*type="submit"[^>]*>确认复盘<\/button>/u);
      expect(body).not.toContain("已确认于");
    });

    it("confirmed review: renders the 已确认于 <date> pill, no confirm banner/button", async () => {
      const id = seedConfirmed(memberA.id, "2026-07");
      const response = await get(`/review/${id}`, withBearer(tokenA));
      const body = await response.text();

      expect(body).toContain("已确认于");
      expect(body).not.toContain("待确认");
      expect(body).not.toContain("确认复盘");
    });

    it("renders all six sections with every number pulled straight from result_json, values properly HTML-escaped", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await get(`/review/${id}`, withBearer(tokenA));
      const body = await response.text();

      // ① 预测复盘
      expect(body).toContain("预测复盘");
      expect(body).toContain("67%"); // selfThesisHitRate.hitFraction 0.67
      expect(body).toContain("8/12");
      expect(body).toContain("系统个股分析置信度校准——全平台口径，非本人专属");
      expect(body).toContain("25%"); // high tier hitFraction

      // ② 决策复盘
      expect(body).toContain("决策复盘");
      expect(body).toContain("A&amp;B.US"); // escaped, never raw "A&B.US"
      expect(body).not.toContain("A&B.US");
      expect(body).toContain("+8.50%"); // avgDecisionReturnPct
      expect(body).toContain("+5.30%"); // avgAlphaPct
      expect(body).toContain("REJ.US");
      expect(body).toContain("+20.00%"); // rejected hypotheticalReturnPct
      expect(body).toContain("未执行，仅口径参考"); // rejected disclaimer

      // ③ 策略纪律复盘
      expect(body).toContain("策略纪律复盘");
      expect(body).toContain("80%"); // complianceRate.rate
      expect(body).toContain("+15.00%"); // complianceValue.deltaPct
      expect(body).toContain("-5.00%"); // violating.avgReturnPct

      // ④ 提醒质量
      expect(body).toContain("提醒质量");
      expect(body).toContain("50%"); // misreportRate

      // ⑤ 错误归类 · 一句话教训 · 下一步
      expect(body).toContain("错误归类");
      expect(body).toContain("策略纪律");
      expect(body).toContain("决策择时");
      expect(body).toContain("本月遵守率偏低，需复核高频违反的规则。");
      expect(body).toContain("1. 复核纪律执行情况");

      // ⑥ 改进建议
      expect(body).toContain("改进建议");
      expect(body).toContain("建议一：收紧执行");
      expect(body).toContain("以上为规则推导的改进建议，仅供参考；任何策略/纪律变更须本人在飞书或 CLI 中手动确认后生效。");
    });

    it("sections appear in the plan's fixed order: 预测复盘 -> 决策复盘 -> 策略纪律复盘 -> 提醒质量 -> 错误归类 -> 改进建议", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await get(`/review/${id}`, withBearer(tokenA));
      const body = await response.text();

      const order = ["预测复盘", "决策复盘", "策略纪律复盘", "提醒质量", "错误归类", "改进建议"];
      let cursor = -1;
      for (const marker of order) {
        const index = body.indexOf(marker);
        expect(index).toBeGreaterThan(cursor);
        cursor = index;
      }
    });

    it("样本不足/暂无数据 is shown honestly for empty-state sub-metrics, never a fabricated number", async () => {
      const id = new MonthlyReviewRepository(db).upsertDraft({
        ownerId: memberA.id,
        period: "2026-07",
        resultJson: {
          ownerId: memberA.id,
          period: "2026-07",
          generatedAt: "2026-07-20T00:00:00.000Z",
          predictionReview: {
            selfThesisHitRate: { sample: "insufficient", n: 3 },
            systemConfidenceCalibration: [{ tier: "low", sample: "none", n: 0 }],
            systemConfidenceCalibrationNote: "系统个股分析置信度校准——全平台口径，非本人专属"
          },
          decisionReview: {
            period: "2026-07",
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
      }).id;

      const response = await get(`/review/${id}`, withBearer(tokenA));
      const body = await response.text();

      expect(body).toContain("样本不足");
      expect(body).toContain("暂无数据");
      expect(body).not.toContain("NaN");
      expect(body).not.toContain("undefined");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/reviews/<id>/confirm
  // -------------------------------------------------------------------------

  describe("POST /api/reviews/<id>/confirm", () => {
    it("401s without any identity", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await post(`/api/reviews/${id}/confirm`);
      expect(response.status).toBe(401);
    });

    it("404s for a nonexistent review id", async () => {
      const response = await post("/api/reviews/does-not-exist/confirm", withBearer(tokenA));
      expect(response.status).toBe(404);
    });

    it("403s for a non-owner (owner-gate)", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await post(`/api/reviews/${id}/confirm`, withBearer(tokenB));
      expect(response.status).toBe(403);

      const stillDraft = new MonthlyReviewRepository(db).getById(id);
      expect(stillDraft?.status).toBe("draft"); // B's rejected attempt never mutated A's review
    });

    it("returns 405 for non-POST requests", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await fetch(`${baseUrl}/api/reviews/${id}/confirm`, { method: "GET", headers: withBearer(tokenA) });
      expect(response.status).toBe(405);
    });

    it("a bearer/JSON caller: confirms (draft -> confirmed) and gets the {ok, review, mirror, notify} JSON shape, both fire-and-forget side effects degrading gracefully (P10 not wired)", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await post(`/api/reviews/${id}/confirm`, withBearer(tokenA));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const payload = (await response.json()) as {
        ok: boolean;
        review: { status: string; confirmedAt?: string };
        mirror: { mirrored: boolean; reason?: string };
        notify: { delivered: boolean; reason?: string };
      };
      expect(payload.ok).toBe(true);
      expect(payload.review.status).toBe("confirmed");
      expect(payload.review.confirmedAt).toBeTruthy();
      // Both P10-gated placeholders throw today - confirm itself must still
      // succeed (the SQL status change already committed).
      expect(payload.mirror.mirrored).toBe(false);
      expect(payload.notify.delivered).toBe(false);

      const persisted = new MonthlyReviewRepository(db).getById(id);
      expect(persisted?.status).toBe("confirmed");
    });

    it("a form submission (reading page's own confirm button): 303-redirects to /review/<id>", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await postForm(`/api/reviews/${id}/confirm`, withBearer(tokenA));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/review/${id}`);

      const persisted = new MonthlyReviewRepository(db).getById(id);
      expect(persisted?.status).toBe("confirmed");
    });

    it("works via the Access-email identity chain too (the real reading-page caller, behind Cloudflare Access)", async () => {
      const id = seedDraft(memberA.id, "2026-07");
      const response = await postForm(`/api/reviews/${id}/confirm`, { "cf-access-authenticated-user-email": memberA.email });
      expect(response.status).toBe(303);
    });

    it("is idempotent: confirming an already-confirmed review succeeds again (no throw, no re-stamped confirmed_at change of status)", async () => {
      const id = seedConfirmed(memberA.id, "2026-07");
      const response = await post(`/api/reviews/${id}/confirm`, withBearer(tokenA));
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { ok: boolean; review: { status: string } };
      expect(payload.ok).toBe(true);
      expect(payload.review.status).toBe("confirmed");
    });
  });
});
