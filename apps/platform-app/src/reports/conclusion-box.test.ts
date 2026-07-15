// Phase 5 Task 5 (2026-07-15 plan): pins down this file's own hand-rolled
// contract tests, PLUS the SHARED-FIXTURE anti-drift check against
// apps/openclaw-config/scripts/conclusion-box.mjs (the source of truth this
// module is a from-scratch TS port of - see conclusion-box.ts's own doc
// comment). Both this suite and the .mjs one read the exact same JSON
// fixture and assert parseConclusionBox produces the exact same output
// (including every null case) - a silent drift between the two
// implementations fails on at least one side.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONFIDENCE_LABELS, confidenceFromLabel, parseConclusionBox } from "./conclusion-box.js";

interface ConclusionBoxFixtureSample {
  name: string;
  input: string;
  expected: unknown;
}

const FIXTURES_PATH = fileURLToPath(
  new URL("../../../openclaw-config/scripts/__fixtures__/conclusion-box-samples.json", import.meta.url)
);

function loadFixtureSamples(): ConclusionBoxFixtureSample[] {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as ConclusionBoxFixtureSample[];
}

describe("CONFIDENCE_LABELS / confidenceFromLabel: single-source Chinese mapping (mirrors conclusion-box.mjs)", () => {
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
  });
});

describe("parseConclusionBox: missing or invalid required key -> null, never guess", () => {
  it("returns null when the '### 结论框' heading itself is absent", () => {
    expect(parseConclusionBox("- 核心结论：foo\n- 置信度：高")).toBeNull();
  });

  it("returns null for an empty/undefined input", () => {
    expect(parseConclusionBox("")).toBeNull();
  });
});

describe("parseConclusionBox: SHARED-FIXTURE anti-drift check against conclusion-box.mjs (Phase 5 Task 5)", () => {
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
