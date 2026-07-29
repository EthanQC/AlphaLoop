// Phase 5 Task 2 (2026-07-15 plan): conclusion-box.mjs is the single
// render+parse+confidence-label source of truth shared by stock-analysis.mjs
// (this task), report-quality.mjs's stock.conclusion_box gate (Task 4), and
// the platform stock.ts summary card (Task 5). These tests pin down the
// exact contract every one of those callers depends on: a fixed bullet
// shape, a round-trip that never lossily mutates the input, and "missing
// any required key -> null, never guess".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_LABELS,
  confidenceFromLabel,
  parseConclusionBox,
  parseReportConclusionBox,
  renderConclusionBox,
  renderReportConclusionBox
} from "./conclusion-box.mjs";

// Phase 5 Task 5 (2026-07-15 plan): SHARED-FIXTURE anti-drift check. This
// exact JSON file is also read by apps/platform-app/src/reports/
// conclusion-box.test.ts - both suites run parseConclusionBox over the SAME
// inputs and assert deep-equal outputs (including the null cases), so the
// TS port over there can never silently drift from this .mjs source of
// truth without a test failing on at least one side.
interface ConclusionBoxFixtureSample {
  name: string;
  input: string;
  expected: unknown;
}

const FIXTURES_PATH = fileURLToPath(new URL("./__fixtures__/conclusion-box-samples.json", import.meta.url));

function loadFixtureSamples(): ConclusionBoxFixtureSample[] {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as ConclusionBoxFixtureSample[];
}

function boxInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    coreConclusion: "短线偏上行：守住支撑位 210.50 美元并放量突破 220.00 美元，上行概率约 +45.00%",
    confidence: "medium",
    valueRange: { low: 205.12, high: 230.5, basis: "近20日支撑位 205.12 美元与卖方一年目标价 230.50 美元（来源：yahoo-quote）" },
    pricePosition: "现价 210.50 美元，位于合理区间内（205.12–230.50 美元）",
    reviewTrigger: "若价格跌破支撑位 205.12 美元，或基本面/新闻面出现方向性反转，需重新评估当前结论",
    reviewDate: "2026-08-15",
    ...overrides
  };
}

describe("CONFIDENCE_LABELS / confidenceFromLabel: single-source Chinese mapping", () => {
  it("maps every enum value to its Chinese label", () => {
    expect(CONFIDENCE_LABELS).toEqual({ high: "高", medium: "中", low: "低" });
  });

  it("reverse-maps every Chinese label back to its enum value", () => {
    expect(confidenceFromLabel("高")).toBe("high");
    expect(confidenceFromLabel("中")).toBe("medium");
    expect(confidenceFromLabel("低")).toBe("low");
  });

  it("returns undefined (never guesses) for an invalid label", () => {
    expect(confidenceFromLabel("很高")).toBeUndefined();
    expect(confidenceFromLabel("")).toBeUndefined();
    expect(confidenceFromLabel(undefined as unknown as string)).toBeUndefined();
  });
});

describe("renderConclusionBox: fixed bullet shape", () => {
  it("starts with the '### 结论框' heading and renders all five bullets with the exact keys", () => {
    const markdown = renderConclusionBox(boxInput());

    expect(markdown.startsWith("### 结论框")).toBe(true);
    expect(markdown).toContain("- 核心结论：短线偏上行");
    expect(markdown).toContain("- 置信度：中");
    expect(markdown).toContain("- 合理价值区间：205.12–230.50 美元（依据：近20日支撑位 205.12 美元与卖方一年目标价 230.50 美元（来源：yahoo-quote））");
    expect(markdown).toContain("- 当前价格位置：现价 210.50 美元");
    expect(markdown).toContain("- 复盘触发：若价格跌破支撑位 205.12 美元");
    expect(markdown).toContain("（复盘日期：2026-08-15）");
  });

  it("renders the correct Chinese label for each confidence tier", () => {
    expect(renderConclusionBox(boxInput({ confidence: "high" }))).toContain("- 置信度：高");
    expect(renderConclusionBox(boxInput({ confidence: "medium" }))).toContain("- 置信度：中");
    expect(renderConclusionBox(boxInput({ confidence: "low" }))).toContain("- 置信度：低");
  });
});

describe("parseConclusionBox: round-trip with renderConclusionBox", () => {
  it("round-trips render -> parse back to the exact same shape (high/medium/low)", () => {
    for (const confidence of ["high", "medium", "low"] as const) {
      const input = boxInput({ confidence });
      const rendered = renderConclusionBox(input);
      expect(parseConclusionBox(rendered)).toEqual(input);
    }
  });

  it("round-trips when the box is embedded inside a larger document with prose before and a heading after", () => {
    const input = boxInput();
    const rendered = renderConclusionBox(input);
    const document = [
      "## AAPL.US",
      "",
      "### 结论与复盘标签",
      "",
      "- 上行路径（约 +45.00%）：既有的三路径叙述文字保留在结论框之前。",
      "",
      rendered,
      "",
      "### 近期新闻",
      "",
      "- 这是下一节，不应被解析进结论框。"
    ].join("\n");

    expect(parseConclusionBox(document)).toEqual(input);
  });

  it("reads only the FIRST box when the text contains more than one (caller must pre-scope per symbol)", () => {
    const first = boxInput({ confidence: "high" });
    const second = boxInput({ confidence: "low" });
    const document = `${renderConclusionBox(first)}\n\n${renderConclusionBox(second)}`;

    expect(parseConclusionBox(document)?.confidence).toBe("high");
  });
});

describe("parseConclusionBox: missing or invalid required key -> null, never guess", () => {
  it("returns null when the '### 结论框' heading itself is absent", () => {
    expect(parseConclusionBox("- 核心结论：foo\n- 置信度：高")).toBeNull();
  });

  it("returns null when 核心结论 is missing", () => {
    const lines = renderConclusionBox(boxInput()).split("\n").filter((line) => !line.startsWith("- 核心结论："));
    expect(parseConclusionBox(lines.join("\n"))).toBeNull();
  });

  it("returns null when 置信度 is missing", () => {
    const lines = renderConclusionBox(boxInput()).split("\n").filter((line) => !line.startsWith("- 置信度："));
    expect(parseConclusionBox(lines.join("\n"))).toBeNull();
  });

  it("returns null when 置信度 has an invalid (non 高|中|低) label", () => {
    const markdown = renderConclusionBox(boxInput()).replace("- 置信度：中", "- 置信度：很高");
    expect(parseConclusionBox(markdown)).toBeNull();
  });

  it("returns null when 合理价值区间 is missing", () => {
    const lines = renderConclusionBox(boxInput()).split("\n").filter((line) => !line.startsWith("- 合理价值区间："));
    expect(parseConclusionBox(lines.join("\n"))).toBeNull();
  });

  it("returns null when 合理价值区间 does not parse (malformed range text)", () => {
    const markdown = renderConclusionBox(boxInput()).replace(/- 合理价值区间：.*/u, "- 合理价值区间：数据不可得");
    expect(parseConclusionBox(markdown)).toBeNull();
  });

  it("returns null when 当前价格位置 is missing", () => {
    const lines = renderConclusionBox(boxInput()).split("\n").filter((line) => !line.startsWith("- 当前价格位置："));
    expect(parseConclusionBox(lines.join("\n"))).toBeNull();
  });

  it("returns null when 复盘触发 is missing", () => {
    const lines = renderConclusionBox(boxInput()).split("\n").filter((line) => !line.startsWith("- 复盘触发："));
    expect(parseConclusionBox(lines.join("\n"))).toBeNull();
  });

  it("returns null when 复盘触发's embedded 复盘日期 is missing/malformed", () => {
    const markdown = renderConclusionBox(boxInput()).replace("（复盘日期：2026-08-15）", "（复盘日期：未知）");
    expect(parseConclusionBox(markdown)).toBeNull();
  });
});

describe("parseConclusionBox: SHARED-FIXTURE anti-drift check (Phase 5 Task 5)", () => {
  const samples = loadFixtureSamples();

  it("the fixture file itself is non-empty and covers both valid and null cases", () => {
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.some((sample) => sample.expected !== null)).toBe(true);
    expect(samples.some((sample) => sample.expected === null)).toBe(true);
  });

  it.each(samples.map((sample) => [sample.name, sample] as const))("%s", (_name, sample) => {
    expect(parseConclusionBox(sample.input)).toEqual(sample.expected);
  });
});

// Task 13 (2026-07-28 spec-drift plan): the daily/weekly report gets its own
// conclusion box. 2026-07-12 requirements §1.4「摘要卡先行（核心结论+置信度）」
// and §3.5「核心结论（一行观点+置信度三档+"截至"时间）」. It shares this
// module's vocabulary - the same "### 结论框" heading, the same 核心结论/置信度
// keys, the same 高/中/低 labels - so the reading page, the Feishu card and the
// report itself cannot drift into three different words for the same thing.
// What it does NOT share is the per-symbol box's 合理价值区间/当前价格位置/
// 复盘触发: a whole-market daily conclusion has no single valuation range, and
// rendering one would be fabrication.
describe("renderReportConclusionBox / parseReportConclusionBox (daily+weekly)", () => {
  type ConfidenceTier = "high" | "medium" | "low";
  interface ReportBoxInput {
    coreConclusion: string;
    confidence: ConfidenceTier;
    basis: string[];
    asOf: string;
  }

  function reportBoxInput(overrides: Partial<ReportBoxInput> = {}): ReportBoxInput {
    return {
      coreConclusion: "QQQ 最新价 721.34，较前收上涨 4.22（0.59%）；中性偏多，可以继续观察强势延续，但不因单日新闻直接加仓",
      confidence: "medium",
      basis: ["行情：QQQ 实时行情可用", "新闻：读取 3 条，覆盖 2/2 标的", "降级：agent 检索不可用（L1-only 模式）"],
      asOf: "2026-07-14 13:00（北京时间）",
      ...overrides
    };
  }

  it("renders 核心结论 + 置信度 + 依据 + 截至 under the shared 结论框 heading", () => {
    const rendered = renderReportConclusionBox(reportBoxInput());

    expect(rendered.split("\n")).toEqual([
      "### 结论框",
      "",
      "- 核心结论：QQQ 最新价 721.34，较前收上涨 4.22（0.59%）；中性偏多，可以继续观察强势延续，但不因单日新闻直接加仓",
      "- 置信度：中",
      "- 依据：行情：QQQ 实时行情可用；新闻：读取 3 条，覆盖 2/2 标的；降级：agent 检索不可用（L1-only 模式）",
      "- 截至：2026-07-14 13:00（北京时间）"
    ]);
  });

  it("renders each tier with the SAME 高/中/低 labels the per-symbol box uses", () => {
    for (const [confidence, label] of Object.entries(CONFIDENCE_LABELS) as Array<[ConfidenceTier, string]>) {
      expect(renderReportConclusionBox(reportBoxInput({ confidence }))).toContain(`- 置信度：${label}`);
    }
  });

  it("round-trips through parseReportConclusionBox without mutating anything", () => {
    for (const confidence of ["high", "medium", "low"] as const) {
      const input = reportBoxInput({ confidence });
      expect(parseReportConclusionBox(renderReportConclusionBox(input))).toEqual({
        coreConclusion: input.coreConclusion,
        confidence,
        basis: input.basis.join("；"),
        asOf: input.asOf
      });
    }
  });

  it("reads the box out of a whole report document, not just the block", () => {
    const document = [
      "# OpenClaw 日报 2026-07-14",
      "",
      "## 1. 今日结论",
      "",
      renderReportConclusionBox(reportBoxInput()),
      "",
      "### 今日要点",
      "",
      "- 市场信号：QQQ 最新价 721.34。"
    ].join("\n");

    expect(parseReportConclusionBox(document)?.confidence).toBe("medium");
  });

  it("returns null when any required key is missing", () => {
    for (const key of ["- 核心结论：", "- 置信度：", "- 依据：", "- 截至："]) {
      const rendered = renderReportConclusionBox(reportBoxInput())
        .split("\n")
        .filter((line) => !line.startsWith(key))
        .join("\n");
      expect(parseReportConclusionBox(rendered), `dropping ${key} must not still parse`).toBeNull();
    }
  });

  it("returns null for a confidence label outside 高/中/低 instead of guessing a tier", () => {
    const rendered = renderReportConclusionBox(reportBoxInput()).replace("- 置信度：中", "- 置信度：很高");
    expect(parseReportConclusionBox(rendered)).toBeNull();
  });

  it("returns null when the 结论框 heading itself is absent", () => {
    const rendered = renderReportConclusionBox(reportBoxInput()).replace("### 结论框", "### 摘要");
    expect(parseReportConclusionBox(rendered)).toBeNull();
  });

  // The two boxes must be distinguishable: a caller (the platform reading page,
  // the stock summary card) that parses the wrong one must get null, not a
  // half-filled object it then renders as fact.
  it("does not accept the per-symbol box, and the per-symbol parser does not accept this one", () => {
    expect(parseReportConclusionBox(renderConclusionBox(boxInput()))).toBeNull();
    expect(parseConclusionBox(renderReportConclusionBox(reportBoxInput()))).toBeNull();
  });
});

// Task 13: the SAME shared-fixture anti-drift check, for the daily/weekly box.
// apps/platform-app/src/reports/conclusion-box.test.ts reads this exact file
// and asserts the same outputs, so the TS port and this .mjs cannot drift.
const REPORT_FIXTURES_PATH = fileURLToPath(new URL("./__fixtures__/report-conclusion-box-samples.json", import.meta.url));

function loadReportFixtureSamples(): ConclusionBoxFixtureSample[] {
  return JSON.parse(readFileSync(REPORT_FIXTURES_PATH, "utf8")) as ConclusionBoxFixtureSample[];
}

describe("parseReportConclusionBox: SHARED-FIXTURE anti-drift check (Task 13)", () => {
  const samples = loadReportFixtureSamples();

  it("the fixture file itself is non-empty and covers both valid and null cases", () => {
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.some((sample) => sample.expected !== null)).toBe(true);
    expect(samples.some((sample) => sample.expected === null)).toBe(true);
  });

  it.each(samples.map((sample) => [sample.name, sample] as const))("%s", (_name, sample) => {
    expect(parseReportConclusionBox(sample.input)).toEqual(sample.expected);
  });

  // The fixture inputs must be the RENDERER's own bytes, not markdown typed
  // into a JSON file: re-render the first sample's parsed shape and require it
  // back verbatim.
  it("every valid sample's input is exactly what renderReportConclusionBox emits", () => {
    for (const sample of samples.filter((entry) => entry.expected !== null)) {
      const parsed = sample.expected as { coreConclusion: string; confidence: "high" | "medium" | "low"; basis: string; asOf: string };
      expect(sample.input).toContain(renderReportConclusionBox({
        coreConclusion: parsed.coreConclusion,
        confidence: parsed.confidence,
        basis: parsed.basis,
        asOf: parsed.asOf
      }));
    }
  });
});
