import { describe, expect, it } from "vitest";

import {
  compareThesesWithReport,
  compareThesisWithSection,
  findSymbolSection,
  inferConclusionStance,
  listAnalysedSymbols,
  type ComparableThesis
} from "./strategy-comparison.js";

/**
 * THE REAL PRODUCER of every string this module classifies. Imported rather
 * than restated: a matcher tested against markdown typed into its own test
 * file proves only that the author can match the author. The eight rounds of
 * drift on this repo include a consistency engine that matched `Side: buy`
 * while the real writer emitted pure Chinese - every line degraded forever
 * with the suite green. A .test.ts may import a sibling app's .mjs (see
 * data/news.seam.test.ts, routes/reports.test.ts), so it does.
 */
const stockAnalysis = await import("../../../openclaw-config/scripts/stock-analysis.mjs");
/** The real box RENDERER, for the one case the deterministic pipeline cannot
 * produce on demand: a box whose 核心结论 carries no readable direction. */
const conclusionBoxMjs = await import("../../../openclaw-config/scripts/conclusion-box.mjs");

const GENERATED_AT = "2026-07-12T12:00:00Z";

/** A quote whose close is ABOVE its previous close - the producer's own
 * probability model then puts the bullish path highest. */
const BULL_QUOTE = { open: 100, high: 110, low: 90, volume: 1000, last: 110, prev_close: 100 };
/** ...and below it, which puts the bearish path highest. */
const BEAR_QUOTE = { open: 100, high: 110, low: 90, volume: 1000, last: 90, prev_close: 100 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function record(symbol: string, quote: Record<string, number>): any {
  return {
    symbol,
    quote,
    news: [],
    extraData: {},
    analysis: stockAnalysis.buildDeterministicAnalysis(symbol, quote, [], {}, GENERATED_AT)
  };
}

/** A whole stock-analysis report, rendered by the shipped renderer. */
function realReport(records: ReturnType<typeof record>[]): string {
  return stockAnalysis.renderBatchStockAnalysis({
    label: "2026-07-12",
    generatedAt: GENERATED_AT,
    records
  });
}

function thesis(overrides: Partial<ComparableThesis> & { symbol: string }): ComparableThesis {
  return {
    id: `thesis_${overrides.symbol}`,
    direction: "bull",
    targetLow: null,
    targetHigh: null,
    invalidationPrice: null,
    visibility: "system",
    ...overrides
  };
}

describe("inferConclusionStance", () => {
  it("classifies the bullish 核心结论 the real producer emits", () => {
    const produced = stockAnalysis.buildDeterministicAnalysis("AAPL.US", BULL_QUOTE, [], {}, GENERATED_AT);
    expect(inferConclusionStance(produced.conclusionBox.coreConclusion)).toBe("bull");
  });

  it("classifies the bearish 核心结论 the real producer emits", () => {
    const produced = stockAnalysis.buildDeterministicAnalysis("AAPL.US", BEAR_QUOTE, [], {}, GENERATED_AT);
    expect(inferConclusionStance(produced.conclusionBox.coreConclusion)).toBe("bear");
  });

  // The guard against the failure this module exists to prevent: a matcher
  // keyed on words the writer never emits. Sweeping the producer's own input
  // space says which openings it CAN write, and every one of them must
  // classify - if a future change to computeCoreConclusion introduces a
  // fourth phrasing, this fails rather than degrading every reader's §9 to
  // 无对照 in silence.
  it("classifies EVERY 核心结论 the producer can emit across its own input sweep", () => {
    const seen = new Set<string>();
    for (let last = 40; last <= 200; last += 4) {
      const produced = stockAnalysis.buildDeterministicAnalysis(
        "AAPL.US",
        { open: 100, high: 210, low: 30, volume: 1, last, prev_close: 100 },
        [],
        {},
        GENERATED_AT
      );
      const core = String(produced.conclusionBox.coreConclusion);
      seen.add(core.split("：")[0] ?? core);
      expect(inferConclusionStance(core), core).not.toBeNull();
    }
    // A sweep that produced one shape would pass the assertion above while
    // proving nothing about the others.
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it("returns null - never a fabricated neutral - for wording it cannot read", () => {
    expect(inferConclusionStance("本次不做方向判断，等财报。")).toBeNull();
    expect(inferConclusionStance("")).toBeNull();
  });

  it("refuses to guess when a hand-written box carries both directions", () => {
    expect(inferConclusionStance("有人看多有人看空")).toBeNull();
  });

  it("still reads a hand-written box that uses 看多/看空 rather than the generator's wording", () => {
    expect(inferConclusionStance("维持看多，等回踩加仓")).toBe("bull");
    expect(inferConclusionStance("转为看空")).toBe("bear");
  });
});

describe("listAnalysedSymbols / findSymbolSection", () => {
  it("lists the symbols of a real batch and excludes its 本批次结论 heading", () => {
    const md = realReport([record("AAPL.US", BULL_QUOTE), record("TSM.US", BEAR_QUOTE)]);
    expect(md).toContain("## 本批次结论");
    expect(listAnalysedSymbols(md)).toEqual(["AAPL.US", "TSM.US"]);
  });

  it("scopes each symbol to its OWN section, so one symbol never inherits another's box", () => {
    const md = realReport([record("AAPL.US", BULL_QUOTE), record("TSM.US", BEAR_QUOTE)]);
    const aapl = findSymbolSection(md, "AAPL.US") ?? "";
    const tsm = findSymbolSection(md, "TSM.US") ?? "";
    expect(aapl).toContain("短线偏上行");
    expect(aapl).not.toContain("TSM.US");
    expect(tsm).toContain("短线偏回撤");
    expect(tsm).not.toContain("AAPL.US");
  });

  it("returns null for a symbol the batch never analysed", () => {
    const md = realReport([record("AAPL.US", BULL_QUOTE)]);
    expect(findSymbolSection(md, "NVDA.US")).toBeNull();
  });
});

describe("compareThesesWithReport against a real rendered batch", () => {
  const md = realReport([record("AAPL.US", BULL_QUOTE), record("TSM.US", BEAR_QUOTE)]);

  it("calls a 看多 thesis 一致 with a bullish run", () => {
    const [result] = compareThesesWithReport([thesis({ symbol: "AAPL.US", direction: "bull" })], md);
    expect(result?.verdict).toBe("aligned");
    expect(result?.reportStance).toBe("bull");
    expect(result?.reason).toContain("你看多");
  });

  it("calls a 看多 thesis 冲突 with a bearish run", () => {
    const [result] = compareThesesWithReport([thesis({ symbol: "TSM.US", direction: "bull" })], md);
    expect(result?.verdict).toBe("conflict");
    expect(result?.reportStance).toBe("bear");
  });

  it("calls a 看空 thesis 一致 with a bearish run", () => {
    const [result] = compareThesesWithReport([thesis({ symbol: "TSM.US", direction: "bear" })], md);
    expect(result?.verdict).toBe("aligned");
  });

  it("has no verdict - and says why - for a symbol this batch did not analyse", () => {
    const [result] = compareThesesWithReport([thesis({ symbol: "NVDA.US", direction: "bull" })], md);
    expect(result?.verdict).toBe("none");
    expect(result?.reason).toContain("本次批次没有分析 NVDA.US");
    expect(result?.box).toBeNull();
  });

  it("has no verdict - and says why - for a neutral thesis", () => {
    const [result] = compareThesesWithReport([thesis({ symbol: "AAPL.US", direction: "neutral" })], md);
    expect(result?.verdict).toBe("none");
    expect(result?.reason).toContain("中性");
    // The run's own stance is still reported, so the reader sees what they
    // are NOT being compared against.
    expect(result?.reportStance).toBe("bull");
  });

  it("orders the analysed symbols in the batch's own order, uncovered ones last", () => {
    const results = compareThesesWithReport(
      [
        thesis({ symbol: "NVDA.US", id: "t_nvda" }),
        thesis({ symbol: "TSM.US", id: "t_tsm" }),
        thesis({ symbol: "AAPL.US", id: "t_aapl" })
      ],
      md
    );
    expect(results.map((entry) => entry.symbol)).toEqual(["AAPL.US", "TSM.US", "NVDA.US"]);
  });

  it("compares the thesis target range against the run's own 合理价值区间", () => {
    const inRange = compareThesesWithReport(
      [thesis({ symbol: "AAPL.US", targetLow: 100, targetHigh: 120 })],
      md
    )[0];
    expect(inRange?.rangeNote).toContain("有重叠");

    const outOfRange = compareThesesWithReport(
      [thesis({ symbol: "AAPL.US", targetLow: 500, targetHigh: 600 })],
      md
    )[0];
    expect(outOfRange?.rangeNote).toContain("之外");
  });

  it("leaves rangeNote null when the thesis has no target range at all", () => {
    const [result] = compareThesesWithReport([thesis({ symbol: "AAPL.US" })], md);
    expect(result?.rangeNote).toBeNull();
  });
});

describe("compareThesisWithSection degradation cases", () => {
  it("says the box was unparseable rather than reporting no conclusion", () => {
    const result = compareThesisWithSection(thesis({ symbol: "AAPL.US" }), "### 结论框\n\n- 核心结论：短线偏上行：xxx\n");
    expect(result.verdict).toBe("none");
    expect(result.reason).toContain("结论框缺少必填项");
  });

  it("says the wording was unreadable rather than guessing a direction", () => {
    const md = conclusionBoxMjs.renderConclusionBox({
      coreConclusion: "本次不做方向判断，等财报落地",
      confidence: "low",
      valueRange: { low: 100, high: 120, basis: "测试" },
      pricePosition: "现价 110.00 美元，位于合理区间内",
      reviewTrigger: "财报后重估",
      reviewDate: "2026-08-15"
    });
    const result = compareThesisWithSection(thesis({ symbol: "AAPL.US" }), md);
    expect(result.verdict).toBe("none");
    expect(result.reason).toContain("没有用可判定方向的措辞");
    expect(result.box?.confidence).toBe("low");
  });
});
