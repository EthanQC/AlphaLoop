import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { migrate, createId, nowIso } from "../../../packages/shared-types/dist/index.js";

const mod = await import("./prediction-outcome.mjs");

const { computePredictionOutcome, fillPredictionOutcomes, assertWritableOutcome, WRITABLE_PREDICTION_OUTCOMES } = mod;

// Real production text, verbatim from stock-analysis.mjs's
// computeCoreConclusion/computeReviewTrigger (Phase 5 Task 2) - used
// throughout so this module is proven against what actually gets written,
// not just a hand-picked toy vocabulary.
const BULL_CONCLUSION = "短线偏上行：若守住支撑位 95.00 美元并放量突破 110.00 美元，上行概率约 +62.00%。";
const BEAR_CONCLUSION = "短线偏回撤：若跌破支撑位 95.00 美元，回撤概率约 +58.00%。";
const NEUTRAL_CONCLUSION = "短线震荡：价格围绕当前区间运行，观察概率约 +40.00%。";
const BELOW_TRIGGER = "若价格跌破支撑位 95.00 美元，或基本面/新闻面出现方向性反转，需重新评估当前结论";
const ABOVE_TRIGGER = "若价格涨破压力位 110.00 美元，或基本面/新闻面出现方向性反转，需重新评估当前结论";
const NO_NUMBER_TRIGGER = "若基本面或新闻面出现方向性反转，需重新评估当前结论";

function prediction(overrides: Partial<{ conclusion: string; reviewTrigger: string | null; reviewDate: string | null }> = {}) {
  return {
    conclusion: BULL_CONCLUSION,
    reviewTrigger: BELOW_TRIGGER,
    reviewDate: "2026-07-01",
    ...overrides
  };
}

const NOW = "2026-07-16T12:00:00.000Z";

describe("computePredictionOutcome: pending (never guessed)", () => {
  it("priceAtReview undefined -> pending", () => {
    expect(computePredictionOutcome({ prediction: prediction(), priceAtReview: undefined, now: NOW })).toBe("pending");
  });

  it("priceAtReview null -> pending", () => {
    expect(computePredictionOutcome({ prediction: prediction(), priceAtReview: null, now: NOW })).toBe("pending");
  });

  it("priceAtReview non-finite (NaN via a non-numeric string) -> pending", () => {
    expect(computePredictionOutcome({ prediction: prediction(), priceAtReview: "not a price" as unknown as number, now: NOW })).toBe(
      "pending"
    );
  });

  it("reviewDate strictly in the future (relative to now) -> pending, even with a real price", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ reviewDate: "2026-08-01" }),
        priceAtReview: 80,
        now: NOW
      })
    ).toBe("pending");
  });

  it("reviewDate missing -> pending", () => {
    expect(computePredictionOutcome({ prediction: prediction({ reviewDate: null }), priceAtReview: 80, now: NOW })).toBe(
      "pending"
    );
  });

  it("reviewDate malformed (computeReviewDate's own '待确认' fallback) -> pending", () => {
    expect(
      computePredictionOutcome({ prediction: prediction({ reviewDate: "待确认" }), priceAtReview: 80, now: NOW })
    ).toBe("pending");
  });

  it("reviewDate exactly equal to now's calendar date -> due (not pending on that basis alone)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ reviewDate: "2026-07-16" }),
        priceAtReview: 80,
        now: NOW
      })
    ).not.toBe("pending");
  });

  it("reviewTrigger has no parseable keyword+number pair -> pending, never a fabricated threshold", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ reviewTrigger: NO_NUMBER_TRIGGER }),
        priceAtReview: 80,
        now: NOW
      })
    ).toBe("pending");
  });

  it("reviewTrigger missing entirely -> pending", () => {
    expect(
      computePredictionOutcome({ prediction: prediction({ reviewTrigger: null }), priceAtReview: 80, now: NOW })
    ).toBe("pending");
  });

  it("direction unresolvable (neutral conclusion) AND trigger not breached -> pending (a quiet, undirected trigger grades nothing)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: NEUTRAL_CONCLUSION, reviewTrigger: BELOW_TRIGGER }),
        priceAtReview: 120, // well above the 95 threshold - not breached
        now: NOW
      })
    ).toBe("pending");
  });

  it("ambiguous conclusion (both bull and bear keywords present) is treated as no direction, same as neutral", () => {
    const ambiguous = `${BULL_CONCLUSION} ${BEAR_CONCLUSION}`;
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: ambiguous, reviewTrigger: BELOW_TRIGGER }),
        priceAtReview: 120,
        now: NOW
      })
    ).toBe("pending");
  });
});

describe("computePredictionOutcome: direction x operator x breached truth table", () => {
  it("bull + below-trigger + breached (price <= threshold) -> invalidated (bull's own stop got hit)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BULL_CONCLUSION, reviewTrigger: BELOW_TRIGGER }),
        priceAtReview: 90, // <= 95
        now: NOW
      })
    ).toBe("invalidated");
  });

  it("bull + below-trigger + NOT breached (price > threshold) -> hit (thesis held)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BULL_CONCLUSION, reviewTrigger: BELOW_TRIGGER }),
        priceAtReview: 100, // > 95
        now: NOW
      })
    ).toBe("hit");
  });

  it("bear + above-trigger + breached (price >= threshold) -> invalidated (bear's own stop got hit)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BEAR_CONCLUSION, reviewTrigger: ABOVE_TRIGGER }),
        priceAtReview: 115, // >= 110
        now: NOW
      })
    ).toBe("invalidated");
  });

  it("bear + above-trigger + NOT breached (price < threshold) -> hit (thesis held)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BEAR_CONCLUSION, reviewTrigger: ABOVE_TRIGGER }),
        priceAtReview: 100, // < 110
        now: NOW
      })
    ).toBe("hit");
  });

  it("bull + above-trigger (mismatched pairing) + breached -> hit (the predicted upward move happened)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BULL_CONCLUSION, reviewTrigger: ABOVE_TRIGGER }),
        priceAtReview: 115, // >= 110
        now: NOW
      })
    ).toBe("hit");
  });

  it("bull + above-trigger (mismatched pairing) + NOT breached -> miss (predicted upward move never happened)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BULL_CONCLUSION, reviewTrigger: ABOVE_TRIGGER }),
        priceAtReview: 100, // < 110
        now: NOW
      })
    ).toBe("miss");
  });

  it("bear + below-trigger (mismatched pairing) + breached -> hit (the predicted downward move happened)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BEAR_CONCLUSION, reviewTrigger: BELOW_TRIGGER }),
        priceAtReview: 90, // <= 95
        now: NOW
      })
    ).toBe("hit");
  });

  it("bear + below-trigger (mismatched pairing) + NOT breached -> miss (predicted downward move never happened)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BEAR_CONCLUSION, reviewTrigger: BELOW_TRIGGER }),
        priceAtReview: 100, // > 95
        now: NOW
      })
    ).toBe("miss");
  });

  it("direction null (neutral) + trigger breached -> invalidated (trigger fired, no direction to grade hit/miss against)", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: NEUTRAL_CONCLUSION, reviewTrigger: BELOW_TRIGGER }),
        priceAtReview: 90, // <= 95
        now: NOW
      })
    ).toBe("invalidated");
  });

  it("threshold boundary is inclusive: price exactly AT the below-threshold counts as breached", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BULL_CONCLUSION, reviewTrigger: BELOW_TRIGGER }),
        priceAtReview: 95, // exactly at threshold
        now: NOW
      })
    ).toBe("invalidated");
  });

  it("threshold boundary is inclusive: price exactly AT the above-threshold counts as breached", () => {
    expect(
      computePredictionOutcome({
        prediction: prediction({ conclusion: BEAR_CONCLUSION, reviewTrigger: ABOVE_TRIGGER }),
        priceAtReview: 110, // exactly at threshold
        now: NOW
      })
    ).toBe("invalidated");
  });
});

describe("assertWritableOutcome", () => {
  it("does not throw for hit/miss/invalidated", () => {
    for (const value of ["hit", "miss", "invalidated"]) {
      expect(() => assertWritableOutcome(value)).not.toThrow();
    }
  });

  it("throws for 'pending' (a pending row must be left NULL, never written)", () => {
    expect(() => assertWritableOutcome("pending")).toThrow(/Invalid outcome/);
  });

  it("throws for any other bogus value", () => {
    expect(() => assertWritableOutcome("bogus")).toThrow(/Invalid outcome "bogus"/);
  });

  it("WRITABLE_PREDICTION_OUTCOMES is exactly {hit, miss, invalidated}", () => {
    expect([...WRITABLE_PREDICTION_OUTCOMES].sort()).toEqual(["hit", "invalidated", "miss"]);
  });
});

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function insertPrediction(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    symbol: string;
    conclusion: string;
    confidence: string;
    reviewTrigger: string | null;
    reviewDate: string | null;
    outcome: string | null;
  }> = {}
): string {
  const id = overrides.id ?? createId("analysis_prediction");
  db.prepare(`
    INSERT INTO analysis_predictions (id, symbol, report_path, conclusion, confidence, review_trigger, review_date, outcome, created_at)
    VALUES (?, ?, '/tmp/report.md', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.symbol ?? "AAPL.US",
    overrides.conclusion ?? BULL_CONCLUSION,
    overrides.confidence ?? "medium",
    overrides.reviewTrigger === undefined ? BELOW_TRIGGER : overrides.reviewTrigger,
    overrides.reviewDate === undefined ? "2026-07-01" : overrides.reviewDate,
    overrides.outcome ?? null,
    nowIso()
  );
  return id;
}

describe("fillPredictionOutcomes", () => {
  it("fills a due, gradable row and counts it in `filled`", () => {
    const db = memoryDb();
    const id = insertPrediction(db, { conclusion: BULL_CONCLUSION, reviewTrigger: BELOW_TRIGGER, reviewDate: "2026-07-01" });

    const result = fillPredictionOutcomes(db, {
      now: NOW,
      priceReader: () => 100 // > 95 -> hit
    });

    expect(result).toEqual({ filled: 1, pending: 0 });
    const row = db.prepare("SELECT outcome FROM analysis_predictions WHERE id = ?").get(id) as { outcome: string };
    expect(row.outcome).toBe("hit");
  });

  it("leaves outcome NULL (does not write) and counts `pending` when priceReader returns no price for that day - never fabricated", () => {
    const db = memoryDb();
    const id = insertPrediction(db, { reviewDate: "2026-07-01" });

    const result = fillPredictionOutcomes(db, {
      now: NOW,
      priceReader: () => null // no stock_facts snapshot for that trading day
    });

    expect(result).toEqual({ filled: 0, pending: 1 });
    const row = db.prepare("SELECT outcome FROM analysis_predictions WHERE id = ?").get(id) as { outcome: string | null };
    expect(row.outcome).toBeNull();
  });

  it("does not touch a row whose review_date is still in the future", () => {
    const db = memoryDb();
    const id = insertPrediction(db, { reviewDate: "2026-12-01" });
    let priceReaderCalled = false;

    const result = fillPredictionOutcomes(db, {
      now: NOW,
      priceReader: () => {
        priceReaderCalled = true;
        return 100;
      }
    });

    expect(result).toEqual({ filled: 0, pending: 0 });
    expect(priceReaderCalled).toBe(false); // not even attempted - excluded by the SQL WHERE clause
    const row = db.prepare("SELECT outcome FROM analysis_predictions WHERE id = ?").get(id) as { outcome: string | null };
    expect(row.outcome).toBeNull();
  });

  it("does not re-grade a row that already has an outcome (idempotent / does not clobber a prior run)", () => {
    const db = memoryDb();
    const id = insertPrediction(db, { reviewDate: "2026-07-01", outcome: "miss" });

    const result = fillPredictionOutcomes(db, {
      now: NOW,
      priceReader: () => 100 // would otherwise compute 'hit' - must not overwrite the existing 'miss'
    });

    expect(result).toEqual({ filled: 0, pending: 0 });
    const row = db.prepare("SELECT outcome FROM analysis_predictions WHERE id = ?").get(id) as { outcome: string };
    expect(row.outcome).toBe("miss");
  });

  it("passes (symbol, review_date) through to priceReader for each row", () => {
    const db = memoryDb();
    insertPrediction(db, { symbol: "TSLA.US", reviewDate: "2026-07-02" });
    const calls: Array<[string, string]> = [];

    fillPredictionOutcomes(db, {
      now: NOW,
      priceReader: (symbol: string, reviewDate: string) => {
        calls.push([symbol, reviewDate]);
        return 100;
      }
    });

    expect(calls).toEqual([["TSLA.US", "2026-07-02"]]);
  });

  it("processes multiple due rows independently, mixing filled and pending outcomes in one run", () => {
    const db = memoryDb();
    const gradable = insertPrediction(db, {
      id: "pred_gradable",
      symbol: "AAPL.US",
      conclusion: BULL_CONCLUSION,
      reviewTrigger: BELOW_TRIGGER,
      reviewDate: "2026-07-01"
    });
    const noPriceYet = insertPrediction(db, { id: "pred_no_price", symbol: "TSLA.US", reviewDate: "2026-07-01" });

    const result = fillPredictionOutcomes(db, {
      now: NOW,
      priceReader: (symbol: string) => (symbol === "AAPL.US" ? 100 : null)
    });

    expect(result).toEqual({ filled: 1, pending: 1 });
    expect((db.prepare("SELECT outcome FROM analysis_predictions WHERE id = ?").get(gradable) as { outcome: string }).outcome).toBe(
      "hit"
    );
    expect(
      (db.prepare("SELECT outcome FROM analysis_predictions WHERE id = ?").get(noPriceYet) as { outcome: string | null }).outcome
    ).toBeNull();
  });
});
