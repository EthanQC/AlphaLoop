import { describe, expect, it } from "vitest";

const outcome = await import("./thesis-outcome.mjs");

function judgments(n: number): Array<{ id: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `thesis_hist_${i + 1}` }));
}

// ---------------------------------------------------------------------------
// no_price: latestPrice missing/null -> EVERY judgment is 'no_price', never
// guessed, regardless of direction or how complete the thesis's levels are.
// ---------------------------------------------------------------------------

describe("computeThesisOutcome: no_price (latestPrice missing/null)", () => {
  it("latestPrice undefined -> every judgment is 'no_price' with null pct fields", () => {
    const thesis = { direction: "bull", targetHigh: 250, invalidationPrice: 180 };
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(2), latestPrice: undefined });

    expect(result.perJudgment).toHaveLength(2);
    for (const row of result.perJudgment) {
      expect(row.verdict).toBe("no_price");
      expect(row.priceAtRender).toBeNull();
      expect(row.vsTargetPct).toBeNull();
      expect(row.vsInvalidationPct).toBeNull();
    }
  });

  it("latestPrice null -> 'no_price', even for a fully-specified thesis", () => {
    const thesis = { direction: "neutral", targetLow: 100, targetHigh: 120 };
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: null });
    expect(result.perJudgment[0].verdict).toBe("no_price");
  });

  it("latestPrice NaN -> 'no_price' (not a finite number, never coerced/guessed)", () => {
    const thesis = { direction: "bull", targetHigh: 250, invalidationPrice: 180 };
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: Number.NaN });
    expect(result.perJudgment[0].verdict).toBe("no_price");
  });
});

// ---------------------------------------------------------------------------
// bull direction: toward_target / toward_invalidation
// ---------------------------------------------------------------------------

describe("computeThesisOutcome: bull direction", () => {
  const thesis = { direction: "bull", targetHigh: 250, invalidationPrice: 180 };

  it("price closer to target_high -> toward_target", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 245 });
    expect(result.perJudgment[0].verdict).toBe("toward_target");
    expect(result.perJudgment[0].priceAtRender).toBe(245);
  });

  it("price closer to invalidation_price -> toward_invalidation", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 185 });
    expect(result.perJudgment[0].verdict).toBe("toward_invalidation");
  });

  it("price at or above target_high -> toward_target", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 260 });
    expect(result.perJudgment[0].verdict).toBe("toward_target");
  });

  it("price at or below invalidation_price -> toward_invalidation", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 170 });
    expect(result.perJudgment[0].verdict).toBe("toward_invalidation");
  });

  it("exact midpoint ties favor toward_target", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 215 });
    expect(result.perJudgment[0].verdict).toBe("toward_target");
  });

  it("computes vsTargetPct/vsInvalidationPct as percent distance from the reference levels", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 200 });
    expect(result.perJudgment[0].vsTargetPct).toBeCloseTo(((200 - 250) / 250) * 100, 2);
    expect(result.perJudgment[0].vsInvalidationPct).toBeCloseTo(((200 - 180) / 180) * 100, 2);
  });
});

// ---------------------------------------------------------------------------
// bear direction: inverted (target is the downside aim, invalidation upside)
// ---------------------------------------------------------------------------

describe("computeThesisOutcome: bear direction (inverted)", () => {
  const thesis = { direction: "bear", targetLow: 100, invalidationPrice: 160 };

  it("price closer to target_low -> toward_target", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 105 });
    expect(result.perJudgment[0].verdict).toBe("toward_target");
  });

  it("price closer to invalidation_price (upside break) -> toward_invalidation", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 155 });
    expect(result.perJudgment[0].verdict).toBe("toward_invalidation");
  });

  it("price at or below target_low -> toward_target", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 90 });
    expect(result.perJudgment[0].verdict).toBe("toward_target");
  });

  it("price at or above invalidation_price -> toward_invalidation", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 170 });
    expect(result.perJudgment[0].verdict).toBe("toward_invalidation");
  });
});

// ---------------------------------------------------------------------------
// neutral direction: within range = neutral, outside = toward_invalidation
// ---------------------------------------------------------------------------

describe("computeThesisOutcome: neutral direction", () => {
  const thesis = { direction: "neutral", targetLow: 100, targetHigh: 120 };

  it("price within [target_low, target_high] -> neutral", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 110 });
    expect(result.perJudgment[0].verdict).toBe("neutral");
  });

  it("price exactly at a range boundary -> neutral (inclusive)", () => {
    const low = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 100 });
    const high = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 120 });
    expect(low.perJudgment[0].verdict).toBe("neutral");
    expect(high.perJudgment[0].verdict).toBe("neutral");
  });

  it("price outside the range (either direction) -> toward_invalidation", () => {
    const above = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 130 });
    const below = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 80 });
    expect(above.perJudgment[0].verdict).toBe("toward_invalidation");
    expect(below.perJudgment[0].verdict).toBe("toward_invalidation");
  });

  it("vsTargetPct is always null for neutral (no single target reference, only a range)", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 110 });
    expect(result.perJudgment[0].vsTargetPct).toBeNull();
  });

  it("vsInvalidationPct still reports if the neutral thesis happens to carry an invalidation_price", () => {
    const withInvalidation = { direction: "neutral", targetLow: 100, targetHigh: 120, invalidationPrice: 90 };
    const result = outcome.computeThesisOutcome({ thesis: withInvalidation, judgments: judgments(1), latestPrice: 110 });
    expect(result.perJudgment[0].vsInvalidationPct).toBeCloseTo(((110 - 90) / 90) * 100, 2);
  });
});

// ---------------------------------------------------------------------------
// insufficient: thesis missing the level(s) its own direction needs
// ---------------------------------------------------------------------------

describe("computeThesisOutcome: insufficient (missing required levels)", () => {
  it("bull missing invalidationPrice -> insufficient", () => {
    const thesis = { direction: "bull", targetHigh: 250 };
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 200 });
    expect(result.perJudgment[0].verdict).toBe("insufficient");
  });

  it("bull missing targetHigh -> insufficient", () => {
    const thesis = { direction: "bull", invalidationPrice: 180 };
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 200 });
    expect(result.perJudgment[0].verdict).toBe("insufficient");
  });

  it("bear missing target_low or invalidation_price -> insufficient", () => {
    const missingTarget = outcome.computeThesisOutcome({
      thesis: { direction: "bear", invalidationPrice: 160 },
      judgments: judgments(1),
      latestPrice: 130
    });
    const missingInvalidation = outcome.computeThesisOutcome({
      thesis: { direction: "bear", targetLow: 100 },
      judgments: judgments(1),
      latestPrice: 130
    });
    expect(missingTarget.perJudgment[0].verdict).toBe("insufficient");
    expect(missingInvalidation.perJudgment[0].verdict).toBe("insufficient");
  });

  it("neutral missing target_low or target_high -> insufficient", () => {
    const missingLow = outcome.computeThesisOutcome({
      thesis: { direction: "neutral", targetHigh: 120 },
      judgments: judgments(1),
      latestPrice: 110
    });
    const missingHigh = outcome.computeThesisOutcome({
      thesis: { direction: "neutral", targetLow: 100 },
      judgments: judgments(1),
      latestPrice: 110
    });
    expect(missingLow.perJudgment[0].verdict).toBe("insufficient");
    expect(missingHigh.perJudgment[0].verdict).toBe("insufficient");
  });

  it("an unrecognized/malformed direction -> insufficient, never guessed", () => {
    const thesis = { direction: "sideways", targetHigh: 250, targetLow: 100, invalidationPrice: 180 };
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(1), latestPrice: 200 });
    expect(result.perJudgment[0].verdict).toBe("insufficient");
  });
});

// ---------------------------------------------------------------------------
// hitRate: sample-size gate (n < 10 -> insufficient) + directional fraction
// ---------------------------------------------------------------------------

describe("computeThesisOutcome: hitRate sample-size gate", () => {
  const thesis = { direction: "bull", targetHigh: 250, invalidationPrice: 180 };

  it("fewer than 10 judgments -> {sample: 'insufficient', n}", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(9), latestPrice: 245 });
    expect(result.hitRate).toEqual({ sample: "insufficient", n: 9 });
  });

  it("zero judgments -> {sample: 'insufficient', n: 0}", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: [], latestPrice: 245 });
    expect(result.hitRate).toEqual({ sample: "insufficient", n: 0 });
  });

  it("10+ judgments with a directional verdict -> {sample: 'ok', hitFraction}", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(10), latestPrice: 245 });
    expect(result.hitRate).toEqual({ sample: "ok", n: 10, hits: 10, total: 10, hitFraction: 1 });
  });

  it("10+ judgments but no directional verdict (no_price) -> still 'insufficient', with a reason", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(10), latestPrice: null });
    expect(result.hitRate.sample).toBe("insufficient");
    expect(result.hitRate.n).toBe(10);
    expect((result.hitRate as { reason: string }).reason).toMatch(/无法计算/);
  });

  it("10+ judgments with toward_invalidation -> hitFraction 0", () => {
    const result = outcome.computeThesisOutcome({ thesis, judgments: judgments(10), latestPrice: 170 });
    expect(result.hitRate).toEqual({ sample: "ok", n: 10, hits: 0, total: 10, hitFraction: 0 });
  });

  it("neutral verdicts are excluded from the hitFraction denominator", () => {
    const neutralThesis = { direction: "neutral", targetLow: 100, targetHigh: 120 };
    const result = outcome.computeThesisOutcome({ thesis: neutralThesis, judgments: judgments(10), latestPrice: 110 });
    // All 10 rows are 'neutral' - not toward_target/toward_invalidation, so
    // total (the denominator) is 0 even though n=10 -> insufficient.
    expect(result.hitRate.sample).toBe("insufficient");
  });
});
