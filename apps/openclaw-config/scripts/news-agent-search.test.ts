// Phase 4 Task 5: L2/L3 restricted search orchestration. Every test injects a
// fake `searchBackend` - zero real network/agent calls anywhere in this file,
// matching the task brief's "tests all use an injected fake" requirement.
import { describe, expect, it, vi } from "vitest";

const agentSearch = await import("./news-agent-search.mjs");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function rawItem(overrides: Record<string, unknown> = {}) {
  return {
    title: "Fed holds interest rates steady",
    publisher: "Reuters",
    url: "https://example.com/fed-holds-rates",
    publishedAt: "2026-07-10T10:00:00.000Z",
    summary_zh: "美联储维持利率不变，符合市场预期。",
    impact: { direction: "neutral", affected: ["AAPL.US"], reason: "宏观流动性预期变化" },
    evidence_quote: "The Federal Reserve held rates steady on Wednesday.",
    ...overrides
  };
}

function backendReturning(resultsByCallIndex: Array<Record<string, unknown>[]>) {
  let call = 0;
  return vi.fn(async () => {
    const results = resultsByCallIndex[call] ?? [];
    call += 1;
    return { results };
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    clusterKey: "https://example.com/event-a",
    titleZh: "美联储维持利率不变",
    summaryZh: "美联储维持利率不变\n市场解读为鸽派信号。",
    impact: { direction: "bullish", affected: ["AAPL.US", "MSFT.US"], reason: "流动性预期改善" },
    firstPublishedAt: "2026-07-10T09:00:00.000Z",
    lastPublishedAt: "2026-07-10T10:00:00.000Z",
    sources: [],
    ...overrides
  };
}

// ===========================================================================
// runL2TopicSearch
// ===========================================================================

describe("runL2TopicSearch", () => {
  it("plans one query per symbol plus at least two macro/industry queries when budget is generous", async () => {
    const searchBackend = vi.fn(async () => ({ results: [] }));
    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 20,
      symbols: ["AAPL.US", "MSFT.US"],
      l1Titles: []
    });

    expect(result.queries).toHaveLength(4);
    const kinds = result.queries.map((q: { kind: string }) => q.kind);
    expect(kinds.filter((k: string) => k === "symbol")).toHaveLength(2);
    expect(kinds.filter((k: string) => k === "macro")).toHaveLength(2);
    expect(result.callsUsed).toBe(4);
    expect(result.budgetExhausted).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it("priority rule: trims symbol queries first but always preserves the two-query macro minimum", async () => {
    const searchBackend = vi.fn(async () => ({ results: [] }));
    // 5 symbols + budget 4 -> macro reserves 2, leaving room for only 2 of
    // the 5 symbol queries (the FIRST two, in list order).
    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 4,
      symbols: ["AAA", "BBB", "CCC", "DDD", "EEE"],
      l1Titles: []
    });

    expect(result.queries).toHaveLength(4);
    const symbolQueries = result.queries.filter((q: { kind: string }) => q.kind === "symbol");
    const macroQueries = result.queries.filter((q: { kind: string }) => q.kind === "macro");
    expect(symbolQueries).toHaveLength(2);
    expect(macroQueries).toHaveLength(2);
    expect(symbolQueries[0].query).toContain("AAA");
    expect(symbolQueries[1].query).toContain("BBB");
    expect(result.budgetExhausted).toBe(true);
  });

  it("budget accounting: a 30-budget run against a 35-query ideal plan stops at exactly 30 calls, the 31st is never attempted", async () => {
    const symbols = Array.from({ length: 33 }, (_, i) => `SYM${String(i + 1).padStart(2, "0")}`);
    const searchBackend = vi.fn(async () => ({ results: [] }));

    const result = await agentSearch.runL2TopicSearch({ searchBackend, budget: 30, symbols, l1Titles: [] });

    expect(result.queries).toHaveLength(30);
    expect(result.callsUsed).toBe(30);
    expect(searchBackend).toHaveBeenCalledTimes(30);
    expect(result.budgetExhausted).toBe(true);
    // budget exhaustion is normal completion, not degradation.
    expect(result.degraded).toBe(false);

    // The last 5 symbols (index 28..32, i.e. SYM29..SYM33) were trimmed by
    // the planner and their queries were never sent to the backend at all.
    const calledQueries = searchBackend.mock.calls.map((call) => call[0].query);
    expect(calledQueries.some((q: string) => q.includes("SYM33"))).toBe(false);
    expect(calledQueries.some((q: string) => q.includes("SYM29"))).toBe(false);
    // The first 28 symbols DID get their query attempted.
    expect(calledQueries.some((q: string) => q.includes("SYM01"))).toBe(true);
    expect(calledQueries.some((q: string) => q.includes("SYM28"))).toBe(true);
  });

  it("drops a result item with no url and counts it as droppedNoUrl", async () => {
    const searchBackend = backendReturning([[rawItem({ url: "" })], [], [], []]);
    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 4,
      symbols: ["AAPL.US"],
      l1Titles: []
    });

    expect(result.results).toHaveLength(0);
    expect(result.droppedNoUrl).toBe(1);
    expect(result.droppedNotChinese).toBe(0);
  });

  it("drops a result item whose summary_zh has no Chinese characters and counts it as droppedNotChinese", async () => {
    const searchBackend = backendReturning([[rawItem({ summary_zh: "The Fed held rates steady." })], [], [], []]);
    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 4,
      symbols: ["AAPL.US"],
      l1Titles: []
    });

    expect(result.results).toHaveLength(0);
    expect(result.droppedNotChinese).toBe(1);
    expect(result.droppedNoUrl).toBe(0);
  });

  it("keeps a well-formed item and defuses a malicious markdown-link title", async () => {
    const searchBackend = backendReturning([
      [rawItem({ title: "[点击领取空投](http://evil.example.com/steal)" })],
      [],
      [],
      []
    ]);
    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 4,
      symbols: ["AAPL.US"],
      l1Titles: []
    });

    expect(result.results).toHaveLength(1);
    const [item] = result.results;
    expect(item.title).not.toContain("](");
    expect(item.title).toContain("［点击领取空投］");
    expect(item.url).toBe("https://example.com/fed-holds-rates");
  });

  it("wraps raw external text with the untrusted-data delimiters in a dedicated rawText field", async () => {
    const searchBackend = backendReturning([[rawItem({ title: "Fed decision explained" })], [], [], []]);
    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 4,
      symbols: ["AAPL.US"],
      l1Titles: []
    });

    const [item] = result.results;
    expect(item.rawText.startsWith("<<<EXTERNAL_UNTRUSTED>>>")).toBe(true);
    expect(item.rawText.endsWith("<<<END_EXTERNAL>>>")).toBe(true);
    expect(item.rawText).toContain("Fed decision explained");
  });

  it("normalizes an unparseable publishedAt to null, never to 'now'", async () => {
    const searchBackend = backendReturning([[rawItem({ publishedAt: "not-a-date" })], [], [], []]);
    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 4,
      symbols: ["AAPL.US"],
      l1Titles: []
    });

    expect(result.results[0].publishedAt).toBeNull();
  });

  it("degrades and keeps partial results when the backend throws mid-run", async () => {
    let call = 0;
    const searchBackend = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { results: [rawItem()] };
      }
      throw new Error("upstream search agent unavailable");
    });

    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 10,
      symbols: ["AAPL.US", "MSFT.US"],
      l1Titles: []
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toMatch(/upstream search agent unavailable/);
    expect(result.results).toHaveLength(1);
    // Distinguishes degradation from budget exhaustion (budget was 10, far
    // from exhausted - the run stopped because of the throw, not the budget).
    expect(result.budgetExhausted).toBe(false);
  });

  it("planner is deterministic: identical inputs produce the identical query sequence", async () => {
    const seenA = backendReturning([[], [], [], []]);
    const seenB = backendReturning([[], [], [], []]);
    const args = { budget: 4, symbols: ["AAPL.US", "MSFT.US"], l1Titles: ["半导体需求持续增长"] };

    const resultA = await agentSearch.runL2TopicSearch({ searchBackend: seenA, ...args });
    const resultB = await agentSearch.runL2TopicSearch({ searchBackend: seenB, ...args });

    expect(resultA.queries).toEqual(resultB.queries);
    expect(seenA.mock.calls.map((c) => c[0].query)).toEqual(seenB.mock.calls.map((c) => c[0].query));
  });

  it("l1Titles can flavor the industry query with a spotted keyword", async () => {
    const searchBackend = vi.fn(async () => ({ results: [] }));
    const result = await agentSearch.runL2TopicSearch({
      searchBackend,
      budget: 10,
      symbols: ["AAPL.US"],
      l1Titles: ["台积电半导体产能吃紧，AI 芯片需求旺盛"]
    });

    const industryQuery = result.queries.find((q: { kind: string }) => q.kind === "macro" && q.query.includes("行业动态"));
    expect(industryQuery.query).toContain("半导体");
  });
});

// ===========================================================================
// runL3DeepDive
// ===========================================================================

describe("runL3DeepDive", () => {
  it("is disabled by default (daily) and never touches the backend", async () => {
    const searchBackend = vi.fn(async () => ({ results: [] }));
    const result = await agentSearch.runL3DeepDive({ searchBackend, events: [event()] });

    expect(result).toEqual({ skipped: true, reason: "l3_disabled_daily" });
    expect(searchBackend).not.toHaveBeenCalled();
  });

  it("stays disabled even when explicitly passed enabled: false", async () => {
    const searchBackend = vi.fn(async () => ({ results: [] }));
    const result = await agentSearch.runL3DeepDive({ searchBackend, events: [event()], enabled: false });

    expect(result).toEqual({ skipped: true, reason: "l3_disabled_daily" });
  });

  it("weekly run (enabled: true) selects the top maxEvents by impact score and stays within perEventBudget calls per event", async () => {
    const highImpact = event({ clusterKey: "high", impact: { direction: "bullish", affected: ["AAPL.US", "MSFT.US", "NVDA.US"], reason: "r" } });
    const midImpact = event({ clusterKey: "mid", impact: { direction: "bearish", affected: ["AAPL.US"], reason: "r" } });
    const noImpact = event({ clusterKey: "low", impact: { direction: "unknown", affected: [], reason: null } });

    const searchBackend = vi.fn(async () => ({ results: [] }));
    const result = await agentSearch.runL3DeepDive({
      searchBackend,
      events: [noImpact, midImpact, highImpact],
      enabled: true,
      perEventBudget: 8,
      maxEvents: 2
    });

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e: { eventClusterKey: string }) => e.eventClusterKey)).toEqual(["high", "mid"]);

    // Each event's evidence + counter-evidence calls combined never exceed
    // perEventBudget (8): highImpact has 3 affected symbols -> 1 topic query
    // + 3 symbol queries + 1 counter = 5 calls; well within 8.
    expect(searchBackend.mock.calls.length).toBeLessThanOrEqual(2 * 8);
  });

  it("caps evidence+counter calls at perEventBudget even with many affected symbols", async () => {
    const manySymbols = Array.from({ length: 10 }, (_, i) => `SYM${i}`);
    const bigEvent = event({ clusterKey: "big", impact: { direction: "bullish", affected: manySymbols, reason: "r" } });

    const searchBackend = vi.fn(async () => ({ results: [] }));
    await agentSearch.runL3DeepDive({
      searchBackend,
      events: [bigEvent],
      enabled: true,
      perEventBudget: 5,
      maxEvents: 1
    });

    expect(searchBackend).toHaveBeenCalledTimes(5);
  });

  it("reports counterEvidence as 'not_found' when the refutation query returns nothing", async () => {
    const searchBackend = vi.fn(async ({ kind }: { kind: string }) => {
      if (kind === "counter_evidence") {
        return { results: [] };
      }
      return { results: [rawItem()] };
    });

    const result = await agentSearch.runL3DeepDive({
      searchBackend,
      events: [event()],
      enabled: true,
      perEventBudget: 5,
      maxEvents: 1
    });

    expect(result.events[0].counterEvidence).toBe("not_found");
    expect(result.events[0].evidence.length).toBeGreaterThan(0);
  });

  it("reports counterEvidence as a validated item array when the refutation query finds something", async () => {
    const searchBackend = vi.fn(async ({ kind }: { kind: string }) => {
      if (kind === "counter_evidence") {
        return { results: [rawItem({ title: "分析师质疑该解读", summary_zh: "有分析师提出不同看法。" })] };
      }
      return { results: [rawItem()] };
    });

    const result = await agentSearch.runL3DeepDive({
      searchBackend,
      events: [event()],
      enabled: true,
      perEventBudget: 5,
      maxEvents: 1
    });

    expect(Array.isArray(result.events[0].counterEvidence)).toBe(true);
    expect((result.events[0].counterEvidence as unknown[]).length).toBe(1);
    expect(result.events[0].analysis.uncertainty).toBe("high");
  });

  it("always includes a counterEvidence field even when perEventBudget leaves no room for evidence queries", async () => {
    const searchBackend = vi.fn(async () => ({ results: [] }));
    const result = await agentSearch.runL3DeepDive({
      searchBackend,
      events: [event()],
      enabled: true,
      perEventBudget: 1,
      maxEvents: 1
    });

    expect(result.events[0]).toHaveProperty("counterEvidence");
    expect(result.events[0].counterEvidence).toBe("not_found");
    expect(searchBackend).toHaveBeenCalledTimes(1);
  });

  it("degrades and keeps partial event results when the backend throws mid-dive", async () => {
    const firstEvent = event({ clusterKey: "first", impact: { direction: "bullish", affected: ["AAPL.US"], reason: "r" } });
    const secondEvent = event({ clusterKey: "second", impact: { direction: "bearish", affected: ["MSFT.US", "NVDA.US"], reason: "r" } });

    let call = 0;
    const searchBackend = vi.fn(async () => {
      call += 1;
      if (call <= 2) {
        return { results: [] };
      }
      throw new Error("agent search timed out");
    });

    const result = await agentSearch.runL3DeepDive({
      searchBackend,
      events: [firstEvent, secondEvent],
      enabled: true,
      perEventBudget: 5,
      maxEvents: 2
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toMatch(/agent search timed out/);
    expect(result.events.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// createOpenclawSearchBackend
// ===========================================================================

describe("createOpenclawSearchBackend", () => {
  it("returns a searchBackend-shaped function that throws the P10-ignition error when invoked", async () => {
    const backend = agentSearch.createOpenclawSearchBackend();
    expect(typeof backend).toBe("function");
    await expect(backend({ query: "test", kind: "symbol" })).rejects.toThrow(/P10 ignition/);
  });
});
