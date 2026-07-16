/**
 * Monthly review READ layer (Phase 9 Task 4, 2026-07-16 plan): owner-scoped
 * readers over `MonthlyReviewRepository` (Task 1, packages/shared-types)
 * plus a typed view of `monthly_reviews.result_json`.
 *
 * WHY THIS FILE EXISTS AT ALL (not just `new MonthlyReviewRepository(db)`
 * called directly from routes/reports.ts and routes/review.ts): the
 * repository's own `MonthlyReview.resultJson` field is typed as the fully
 * generic `MonthlyReviewResult = JsonValue` (packages/shared-types/src/
 * domain.ts's own comment: "Task 2 replaces this with a real interface once
 * it owns that shape" - Task 2 never did, since `buildMonthlyReview`
 * (apps/openclaw-config/scripts/review-engine.mjs) is a plain-JS `.mjs` file
 * with no TypeScript type of its own to export). The interfaces below
 * (`MonthlyReviewResultShape` and friends) are a TS RE-DECLARATION of
 * review-engine.mjs's actual output shape - NOT an import (that .mjs file
 * has no build step/dist of its own; this app's established convention -
 * data/strategy.ts's `computeThesisOutcome`, data/strategy-write.ts,
 * data/memoryd-mirror.ts - is to re-declare a source-of-truth shape locally
 * with a comment pointing back at the original, rather than reach across an
 * app boundary from production code). ANTI-DRIFT: any change to
 * review-engine.mjs's result_json field names/shapes (predictionReview/
 * decisionReview/disciplineReview/alertQuality/errorCategories/
 * oneLineLesson/nextSteps/improvementSuggestions) MUST be mirrored here.
 * This module does NOT re-derive or recompute any of these numbers - it only
 * describes and defensively parses the shape review-engine.mjs already
 * computed and MonthlyReviewRepository already persisted; the independent
 * recomputation/consistency gate lives entirely in Task 3's
 * review-verifier.mjs + review-consistency.test.ts, not here.
 *
 * OWNER SCOPING (Global Constraint: "复盘页/列表 B 看不到 A 的" - unlike
 * research_tasks, monthly_reviews has NO public/private visibility split at
 * all; every review is unconditionally private to its own owner, full stop):
 * both readers below take `ownerId` from the resolved VIEWER's own identity,
 * never a query/body value, and pass it straight into
 * `MonthlyReviewRepository`'s own owner-scoped SQL (`listForOwner` filters
 * `WHERE owner_id = ?`; `getById` resolves by id alone - the caller
 * (routes/review.ts) is responsible for comparing `review.ownerId` against
 * the viewer and 403ing on mismatch, the same "resolve row first, compare
 * owner" discipline research.ts/proposal.ts already established).
 */
import type { DatabaseSync } from "node:sqlite";

import { MonthlyReviewRepository, type MonthlyReviewStatus } from "@packages/shared-types";

// ---------------------------------------------------------------------------
// result_json shape (TS re-declaration of review-engine.mjs's output - see
// module header for the anti-drift contract).
// ---------------------------------------------------------------------------

export type ReviewSample = "none" | "insufficient" | "ok";

export type SelfThesisHitRate =
  | { sample: "insufficient"; n: number; reason?: string }
  | { sample: "ok"; n: number; hits: number; total: number; hitFraction: number };

export type ConfidenceTierStat =
  | { tier: string; sample: "none"; n: number }
  | { tier: string; sample: "insufficient"; n: number }
  | { tier: string; sample: "ok"; n: number; hits: number; hitFraction: number };

export interface PredictionReview {
  selfThesisHitRate: SelfThesisHitRate;
  systemConfidenceCalibration: ConfidenceTierStat[];
  systemConfidenceCalibrationNote: string;
}

export interface DecisionEntry {
  proposalId: string;
  symbol: string;
  side: string;
  entryPrice: number | null;
  reviewPrice: number | null;
  decisionReturnPct: number | null;
  benchmarkSymbol: string;
  benchmarkEntryPrice: number | null;
  benchmarkReviewPrice: number | null;
  benchmarkReturnPct: number | null;
  alphaPct: number | null;
}

export interface RejectedEntry {
  proposalId: string;
  symbol: string;
  side: string;
  proposalPrice: number | null;
  reviewPrice: number | null;
  hypotheticalReturnPct: number | null;
  disclaimer: string;
}

export type ExecutedSummary =
  | { sample: "none"; n: number; priced: number; entries: DecisionEntry[] }
  | { sample: "insufficient"; n: number; priced: number; entries: DecisionEntry[] }
  | {
      sample: "ok";
      n: number;
      priced: number;
      avgDecisionReturnPct: number;
      avgBenchmarkReturnPct: number;
      avgAlphaPct: number;
      entries: DecisionEntry[];
    };

export interface RejectedSummary {
  sample: "none" | "ok";
  n: number;
  disclaimer: string;
  entries: RejectedEntry[];
}

export interface DecisionReview {
  period: string;
  periodStart: string;
  periodEnd: string;
  benchmarkSymbol: string;
  executed: ExecutedSummary;
  rejected: RejectedSummary;
}

export type ComplianceRate =
  | { sample: "none" }
  | { sample: "insufficient"; checked: number }
  | { sample: "ok"; checked: number; passed: number; failed: number; rate: number };

export type ReturnsSummary = { sample: "none"; n: number } | { sample: "insufficient"; n: number } | { sample: "ok"; n: number; avgReturnPct: number };

export interface ComplianceValue {
  compliant: ReturnsSummary;
  violating: ReturnsSummary;
  deltaPct: number | null;
}

export interface DisciplineReview {
  complianceRate: ComplianceRate;
  complianceValue: ComplianceValue;
}

export type AlertQuality =
  | { sample: "none"; triggeredCount: number; misreportCount: number; misreportRate: null }
  | { sample: "ok"; triggeredCount: number; misreportCount: number; misreportRate: number };

export interface ImprovementSuggestions {
  disclaimer: string;
  items: string[];
}

/** Field-for-field mirror of `buildMonthlyReview`'s return value
 * (review-engine.mjs) - the parsed shape of `monthly_reviews.result_json`. */
export interface MonthlyReviewResultShape {
  ownerId: string;
  period: string;
  generatedAt: string;
  predictionReview: PredictionReview;
  decisionReview: DecisionReview;
  disciplineReview: DisciplineReview;
  alertQuality: AlertQuality;
  errorCategories: string[];
  oneLineLesson: string;
  nextSteps: string[];
  improvementSuggestions: ImprovementSuggestions;
}

/** The typed view routes/reports.ts and routes/review.ts consume: the
 * MonthlyReview row's own fields plus `result` - the parsed, defensively
 * validated `result_json` (never thrown on a malformed/missing value, same
 * "degrade to an honest empty state, don't 500" discipline research.ts's
 * `renderVerdictBody` already applies to `ResearchTask.resultJson`). `null`
 * means "no result yet" (a draft the review engine hasn't populated, or a
 * persisted value that doesn't look like this shape) - callers render an
 * honest empty state, never a fabricated number. */
export interface TypedMonthlyReview {
  id: string;
  ownerId: string;
  period: string;
  status: MonthlyReviewStatus;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  result: MonthlyReviewResultShape | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defensive-only cast (mirrors research.ts's own `!result` guard comment):
 * the real pipeline (reviews.mjs's `generate`) always writes a value shaped
 * exactly like `MonthlyReviewResultShape` before a row is ever confirmed or
 * shown, but a hand-seeded/corrupted row must degrade to `null` here instead
 * of a route module throwing and 500ing the whole page. This performs a
 * shallow shape check only (top-level keys present) - it does not
 * recursively validate every nested field, matching the same
 * permissiveness research.ts's `normalizeStep` documents for the analogous
 * research_tasks.steps column.
 */
function toResultShape(raw: unknown): MonthlyReviewResultShape | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const requiredKeys: Array<keyof MonthlyReviewResultShape> = [
    "predictionReview",
    "decisionReview",
    "disciplineReview",
    "alertQuality",
    "errorCategories",
    "oneLineLesson",
    "nextSteps",
    "improvementSuggestions"
  ];
  for (const key of requiredKeys) {
    if (!(key in raw)) {
      return null;
    }
  }
  return raw as unknown as MonthlyReviewResultShape;
}

function toTypedMonthlyReview(review: {
  id: string;
  ownerId: string;
  period: string;
  status: MonthlyReviewStatus;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  resultJson?: unknown;
}): TypedMonthlyReview {
  return {
    id: review.id,
    ownerId: review.ownerId,
    period: review.period,
    status: review.status,
    ...(review.confirmedAt !== undefined ? { confirmedAt: review.confirmedAt } : {}),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    result: toResultShape(review.resultJson)
  };
}

/**
 * This owner's own monthly reviews, newest period first - ALWAYS private,
 * never a public/circle path (Global Constraint: monthly_reviews has no
 * visibility tier at all, unlike research_tasks/theses/strategy_cards).
 * `ownerId` must be the resolved VIEWER's own id - see module header.
 */
export function loadOwnerReviews(db: DatabaseSync, ownerId: string): TypedMonthlyReview[] {
  return new MonthlyReviewRepository(db).listForOwner(ownerId).map(toTypedMonthlyReview);
}

/**
 * One review by id, regardless of owner - the CALLER (routes/review.ts) is
 * responsible for the owner-gate (`review.ownerId === viewer.id`) and the
 * 403 it renders on mismatch; this reader intentionally mirrors
 * `ResearchTaskRepository.getById`'s own "resolve by id alone" contract so
 * that 404-vs-403 stays a route-level decision, not baked into the reader.
 */
export function loadReviewById(db: DatabaseSync, id: string): TypedMonthlyReview | null {
  const review = new MonthlyReviewRepository(db).getById(id);
  return review ? toTypedMonthlyReview(review) : null;
}
