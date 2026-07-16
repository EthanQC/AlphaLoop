import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MemberRepository, MonthlyReviewRepository, migrate, type Member, type MonthlyReviewResult } from "@packages/shared-types";

import { loadOwnerReviews, loadReviewById } from "./monthly-review.js";

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

function fullResult(ownerId: string, period: string): MonthlyReviewResult {
  return {
    ownerId,
    period,
    generatedAt: "2026-07-20T00:00:00.000Z",
    predictionReview: {
      selfThesisHitRate: { sample: "insufficient", n: 3 },
      systemConfidenceCalibration: [{ tier: "low", sample: "none", n: 0 }],
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
  };
}

describe("data/monthly-review.ts", () => {
  describe("loadOwnerReviews", () => {
    it("returns this owner's reviews only, newest period first, with result_json parsed", () => {
      const db = memoryDb();
      new MemberRepository(db).upsert(makeMember());
      const repo = new MonthlyReviewRepository(db);
      repo.upsertDraft({ ownerId: "member_a", period: "2026-05", resultJson: fullResult("member_a", "2026-05") });
      repo.upsertDraft({ ownerId: "member_a", period: "2026-07", resultJson: fullResult("member_a", "2026-07") });
      repo.upsertDraft({ ownerId: "member_a", period: "2026-06", resultJson: fullResult("member_a", "2026-06") });

      const reviews = loadOwnerReviews(db, "member_a");

      expect(reviews.map((r) => r.period)).toEqual(["2026-07", "2026-06", "2026-05"]);
      expect(reviews[0]?.result?.oneLineLesson).toBe("本月各项指标样本不足或表现正常，暂无可归纳的一句话教训。");
      expect(reviews[0]?.status).toBe("draft");
    });

    it("owner isolation: never returns another owner's reviews", () => {
      const db = memoryDb();
      new MemberRepository(db).upsert(makeMember());
      new MemberRepository(db).upsert(makeMember({ id: "member_b", email: "b@example.com" }));
      const repo = new MonthlyReviewRepository(db);
      repo.upsertDraft({ ownerId: "member_b", period: "2026-07", resultJson: fullResult("member_b", "2026-07") });

      expect(loadOwnerReviews(db, "member_a")).toEqual([]);
    });

    it("returns an empty array for an owner with no reviews at all", () => {
      const db = memoryDb();
      new MemberRepository(db).upsert(makeMember());
      expect(loadOwnerReviews(db, "member_a")).toEqual([]);
    });
  });

  describe("loadReviewById", () => {
    it("returns the typed review (parsed result, status, confirmedAt) for an existing id", () => {
      const db = memoryDb();
      new MemberRepository(db).upsert(makeMember());
      const repo = new MonthlyReviewRepository(db);
      const created = repo.upsertDraft({ ownerId: "member_a", period: "2026-07", resultJson: fullResult("member_a", "2026-07") });
      repo.confirm(created.id, "member_a");

      const review = loadReviewById(db, created.id);

      expect(review).not.toBeNull();
      expect(review?.id).toBe(created.id);
      expect(review?.ownerId).toBe("member_a");
      expect(review?.status).toBe("confirmed");
      expect(review?.confirmedAt).toBeTruthy();
      expect(review?.result?.disciplineReview.complianceRate).toEqual({ sample: "none" });
    });

    it("returns null for a nonexistent id", () => {
      const db = memoryDb();
      expect(loadReviewById(db, "does-not-exist")).toBeNull();
    });

    it("does NOT itself enforce ownership - returns the row regardless of who's asking (the caller/route is responsible for the owner-gate)", () => {
      const db = memoryDb();
      new MemberRepository(db).upsert(makeMember());
      const repo = new MonthlyReviewRepository(db);
      const created = repo.upsertDraft({ ownerId: "member_a", period: "2026-07", resultJson: fullResult("member_a", "2026-07") });

      const review = loadReviewById(db, created.id);
      expect(review?.ownerId).toBe("member_a");
    });

    it("degrades to result: null (never throws) for a draft with no result_json written yet", () => {
      const db = memoryDb();
      new MemberRepository(db).upsert(makeMember());
      const created = new MonthlyReviewRepository(db).upsertDraft({ ownerId: "member_a", period: "2026-07" });

      const review = loadReviewById(db, created.id);

      expect(review).not.toBeNull();
      expect(review?.result).toBeNull();
    });
  });
});
