// Phase 7 Task 5 (2026-07-15 plan): SHARED-FIXTURE anti-drift check between
// apps/openclaw-config/scripts/thesis-outcome.mjs (source of truth, T3) and
// this app's `computeThesisOutcome` TS port (data/strategy.ts - see that
// file's own doc comment). Both this suite and the .mjs one
// (thesis-outcome.test.ts there) read the exact same JSON fixture and
// assert computeThesisOutcome produces the exact same output - a silent
// drift between the two implementations fails on at least one side. Same
// mechanism as reports/conclusion-box.test.ts's own shared-fixture check.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { computeThesisOutcome, type ThesisOutcomeInput, type ThesisOutcomeResult } from "./strategy.js";

interface ThesisOutcomeFixtureSample {
  name: string;
  input: ThesisOutcomeInput;
  expected: ThesisOutcomeResult;
}

const FIXTURES_PATH = fileURLToPath(
  new URL("../../../openclaw-config/scripts/__fixtures__/thesis-outcome-samples.json", import.meta.url)
);

function loadFixtureSamples(): ThesisOutcomeFixtureSample[] {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as ThesisOutcomeFixtureSample[];
}

describe("computeThesisOutcome: SHARED-FIXTURE anti-drift check against thesis-outcome.mjs", () => {
  const samples = loadFixtureSamples();

  it("the fixture file itself is non-empty and covers multiple verdicts", () => {
    expect(samples.length).toBeGreaterThan(0);
    const verdicts = new Set(samples.flatMap((sample) => sample.expected.perJudgment.map((row) => row.verdict)));
    expect(verdicts.has("toward_target")).toBe(true);
    expect(verdicts.has("toward_invalidation")).toBe(true);
    expect(verdicts.has("neutral")).toBe(true);
    expect(verdicts.has("insufficient")).toBe(true);
    expect(verdicts.has("no_price")).toBe(true);
  });

  it.each(samples.map((sample) => [sample.name, sample] as const))("%s", (_name, sample) => {
    expect(computeThesisOutcome(sample.input)).toEqual(sample.expected);
  });
});
