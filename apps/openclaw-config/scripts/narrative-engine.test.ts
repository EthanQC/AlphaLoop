// Phase 5 Task 3 (2026-07-15 plan): LLM 叙事编排层. Every test injects a fake
// `backend` - zero real network/LLM calls anywhere in this file, matching
// news-agent-search.test.ts's "every test injects a fake" convention for the
// same injectable-backend shape.
import { describe, expect, it, vi } from "vitest";

const narrativeEngine = await import("./narrative-engine.mjs");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function facts(overrides: Record<string, { valueNum: number | null; valueText?: string | null; unit?: string | null }> = {}) {
  return {
    "quote.last": { valueNum: 210.5, valueText: null, unit: "USD" },
    "quote.pct": { valueNum: 1.2, valueText: null, unit: "pct" },
    "valuation.pe": { valueNum: 22, valueText: null, unit: null },
    "valuation.marketCap": { valueNum: 122000, valueText: null, unit: "USD" },
    ...overrides
  };
}

function section(key: string, deterministicText = `${key} 的确定性文本。`) {
  return { key, deterministicText };
}

// ===========================================================================
// createNarrativeLlmBackend: real gateway wiring (injected fake client)
// ===========================================================================

describe("createNarrativeLlmBackend", () => {
  it("returns the gateway completion as { text } and forwards a facts-anchored prompt", async () => {
    const complete = vi.fn(async () => "最新价约为 210.5 美元，整体表现稳健。");
    const backend = narrativeEngine.createNarrativeLlmBackend({ client: { complete } });

    const out = await backend({
      symbol: "AAPL.US",
      sectionKey: "basic",
      factsDigest: "quote.last=210.5USD",
      deterministicText: "AAPL.US 最新价 210.5 美元。",
      retryReason: null
    });

    expect(out).toEqual({ text: "最新价约为 210.5 美元，整体表现稳健。" });
    expect(complete).toHaveBeenCalledTimes(1);
    const callArg = complete.mock.calls[0][0];
    // The facts digest and section are passed as prompt context; the numeric
    // rule is stated in the system message so a compliant model passes the
    // engine's numeric pre-check.
    expect(callArg.prompt).toContain("quote.last=210.5USD");
    expect(callArg.prompt).toContain("basic");
    expect(callArg.system).toContain("只能引用");
    expect(callArg.timeoutMs).toBe(60000);
  });

  it("propagates a gateway throw so generateNarrativeSections degrades globally", async () => {
    const complete = vi.fn(async () => {
      throw new Error("openclaw gateway error: request timed out after 60000ms");
    });
    const backend = narrativeEngine.createNarrativeLlmBackend({ client: { complete } });

    await expect(
      backend({ symbol: "AAPL.US", sectionKey: "basic", factsDigest: "", deterministicText: "" })
    ).rejects.toThrow(/openclaw gateway/);
  });

  it("passes a prior failure reason back to the model on retry (self-correction hook)", async () => {
    const complete = vi.fn(async () => "改写后的中文叙事，仅使用事实数字。");
    const backend = narrativeEngine.createNarrativeLlmBackend({ client: { complete } });

    await backend({
      symbol: "AAPL.US",
      sectionKey: "basic",
      factsDigest: "quote.last=210.5USD",
      deterministicText: "AAPL.US 稳健。",
      retryReason: "数字比对未通过：叙事包含数字 999.99"
    });

    expect(complete.mock.calls[0][0].prompt).toContain("999.99");
  });
});

// ===========================================================================
// generateNarrativeSections: well-behaved backend -> narrative adopted
// ===========================================================================

describe("generateNarrativeSections: well-behaved backend", () => {
  it("adopts backend text with no numbers at all (vacuously passes the numeric pre-check)", async () => {
    const backend = vi.fn(async () => ({ text: "该维度总体保持稳健，需持续关注后续验证信息。" }));

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("fundamentals")]
    });

    expect(result.degraded).toBe(false);
    expect(result.degradedSections).toEqual([]);
    expect(result.retriesUsed).toBe(0);
    expect(result.sections).toEqual([
      { key: "fundamentals", narrative: true, text: "该维度总体保持稳健，需持续关注后续验证信息。" }
    ]);
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it("adopts backend text whose numbers land within tolerance of a fact value (price +-0.01, boundary inclusive)", async () => {
    // quote.last = 210.5; 210.51 is exactly 0.01 away - the tolerance
    // boundary is inclusive (Math.abs(diff) > tolerance is the fail
    // condition, matching validateNarrativeNumbers' own `>` comparison).
    const backend = vi.fn(async () => ({ text: "最新价约为 210.51 美元，接近前期水平。" }));

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("basic")]
    });

    expect(result.sections[0]).toEqual({ key: "basic", narrative: true, text: "最新价约为 210.51 美元，接近前期水平。" });
    expect(result.degraded).toBe(false);
  });

  it("adopts backend text whose percentage lands within the tighter +-0.1 tolerance", async () => {
    // quote.pct = 1.2; 1.25% is 0.05 away - safely inside the +-0.1
    // tolerance (avoiding the exact 0.1 boundary, which floating-point
    // subtraction can land a hair on either side of - e.g. 1.3-1.2 evaluates
    // to 0.10000000000000009 in IEEE-754 double precision).
    const backend = vi.fn(async () => ({ text: "涨幅约 1.25%，符合近期走势。" }));

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("trading")]
    });

    expect(result.sections[0].narrative).toBe(true);
  });

  it("applies defuseMarkdownInText to adopted backend output (no numbers involved)", async () => {
    const backend = vi.fn(async () => ({ text: "详见［占位］公告 [公告详情](https://example.com/notice) 说明。" }));

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("catalysts")]
    });

    expect(result.sections[0].narrative).toBe(true);
    expect(result.sections[0].text).toContain("［公告详情］(https://example.com/notice)");
    expect(result.sections[0].text).not.toMatch(/\[公告详情\]\(/u);
  });
});

// ===========================================================================
// Bad sample: fabricated number never matches facts -> 2 retries -> degrade
// ===========================================================================

describe("generateNarrativeSections: fabricated-number bad sample", () => {
  it("retries a fabricating backend twice (reason carries the offending number), then falls back with the numeric marker", async () => {
    // facts say valuation.marketCap = 122000; the fake backend always
    // fabricates 122959.91, regardless of the retryReason it's handed back -
    // simulates a backend that cannot self-correct.
    const backend = vi.fn(async () => ({ text: "市值约为 122959.91 美元，估值偏高。" }));

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("fundamentals", "估值合理，市值约 122000 美元。")]
    });

    expect(backend).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(result.degraded).toBe(false); // this is a PER-SECTION degrade, not a backend throw
    expect(result.retriesUsed).toBe(2);
    expect(result.degradedSections).toEqual(["fundamentals"]);

    const rendered = result.sections[0];
    expect(rendered.narrative).toBe(false);
    expect(rendered.text).toBe("估值合理，市值约 122000 美元。（叙事降级：数字比对未通过）");
    expect(rendered.degradeReason).toMatch(/122959\.91/);

    // The failure reason from attempt N is appended to attempt N+1's call
    // args (self-correction hook), so a real LLM backend could see why its
    // previous output was rejected.
    expect(backend.mock.calls[0][0].retryReason).toBeNull();
    expect(backend.mock.calls[1][0].retryReason).toMatch(/122959\.91/);
    expect(backend.mock.calls[2][0].retryReason).toMatch(/122959\.91/);
  });
});

// ===========================================================================
// Bad sample: English-only output -> retries -> degrade
// ===========================================================================

describe("generateNarrativeSections: English-only bad sample", () => {
  it("retries a backend that only ever returns English, then falls back with the non-Chinese marker", async () => {
    const backend = vi.fn(async () => ({ text: "Strong fundamentals support further upside for the stock this quarter." }));

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("risks", "需关注估值与流动性风险。")]
    });

    expect(backend).toHaveBeenCalledTimes(3);
    expect(result.degraded).toBe(false);
    expect(result.retriesUsed).toBe(2);
    expect(result.sections[0]).toEqual({
      key: "risks",
      narrative: false,
      text: "需关注估值与流动性风险。（叙事降级：后端输出非中文）",
      degradeReason: expect.stringMatching(/非中文/)
    });
  });
});

// ===========================================================================
// Bad sample: backend throw -> global degrade, ALL sections fall back
// ===========================================================================

describe("generateNarrativeSections: throwing backend -> global degrade", () => {
  it("degrades every section (even ones not yet reached) and never calls the backend again after the throw", async () => {
    const backend = vi.fn(async () => {
      throw new Error("narrative backend unavailable: connection refused");
    });

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("basic", "基本信息确定性文本。"), section("thesis", "投资逻辑确定性文本。")]
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("narrative backend unavailable: connection refused");
    expect(result.degradedSections).toEqual(["basic", "thesis"]);
    expect(result.sections).toEqual([
      { key: "basic", narrative: false, text: "基本信息确定性文本。" },
      { key: "thesis", narrative: false, text: "投资逻辑确定性文本。" }
    ]);
    // Only ONE call was ever attempted - the throw on the very first section
    // stops the second section from being attempted at all (mirrors
    // news-agent-search.mjs's executeQueries: a throw stops further calls
    // immediately).
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it("discards an EARLIER section's already-successful narrative once a LATER section's backend call throws", async () => {
    let call = 0;
    const backend = vi.fn(async ({ sectionKey }: { sectionKey: string }) => {
      call += 1;
      if (sectionKey === "basic") {
        return { text: "该段已通过校验，无需回落。" };
      }
      throw new Error("second call fails");
    });

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("basic", "基本信息确定性文本。"), section("thesis", "投资逻辑确定性文本。")]
    });

    expect(call).toBe(2);
    expect(result.degraded).toBe(true);
    // basic succeeded on the backend call, but the WHOLE run degrades once
    // thesis's call throws - basic's narrative text must NOT survive.
    expect(result.sections).toEqual([
      { key: "basic", narrative: false, text: "基本信息确定性文本。" },
      { key: "thesis", narrative: false, text: "投资逻辑确定性文本。" }
    ]);
  });

  it("REPORT_DEGRADED_HEADER is the exact caller-facing disclosure string", () => {
    expect(narrativeEngine.REPORT_DEGRADED_HEADER).toBe("叙事引擎不可用（纯事实表报告）");
  });
});

// ===========================================================================
// retriesUsed accounting across multiple sections
// ===========================================================================

describe("generateNarrativeSections: retriesUsed accounting", () => {
  it("sums retries per-section: one section recovers on its 1st retry, another succeeds immediately", async () => {
    const callCountBySection: Record<string, number> = {};
    const backend = vi.fn(async ({ sectionKey }: { sectionKey: string }) => {
      const count = callCountBySection[sectionKey] ?? 0;
      callCountBySection[sectionKey] = count + 1;
      if (sectionKey === "basic") {
        return count === 0 ? { text: "This is English and will be rejected." } : { text: "该段已修正，无需担忧。" };
      }
      return { text: "结论保持稳健，无需调整。" };
    });

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("basic"), section("conclusion")]
    });

    expect(result.degraded).toBe(false);
    expect(result.sections).toEqual([
      { key: "basic", narrative: true, text: "该段已修正，无需担忧。" },
      { key: "conclusion", narrative: true, text: "结论保持稳健，无需调整。" }
    ]);
    // basic: 1 retry consumed (failed once, then succeeded); conclusion: 0.
    expect(result.retriesUsed).toBe(1);
    expect(backend).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// Numeric pre-check: extra/unmatched numbers still fail even mixed with
// matching ones; ISO dates are not treated as numbers to check.
// ===========================================================================

describe("generateNarrativeSections: numeric pre-check edge cases", () => {
  it("fails when ONE extra number has no match, even if other numbers in the same text do match", async () => {
    // 210.5 matches quote.last; 999.99 matches nothing in `facts()`.
    const backend = vi.fn(async () => ({ text: "最新价 210.5 美元，另有异常数字 999.99 美元。" }));

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("basic", "回落文本。")]
    });

    expect(result.sections[0].narrative).toBe(false);
    expect(result.sections[0].degradeReason).toMatch(/999\.99/);
  });

  it("does not treat an embedded ISO date (options.nextExpiry-style) as a number to check", async () => {
    const backend = vi.fn(async () => ({ text: "下一次期权到期日参考 2026-08-15，请留意到期前后的流动性变化。" }));

    const result = await narrativeEngine.generateNarrativeSections({
      backend,
      symbol: "AAPL.US",
      facts: facts(),
      sections: [section("options")]
    });

    expect(result.sections[0].narrative).toBe(true);
  });
});
