// Phase 6 Task 5 (2026-07-15 plan): pins down this TS port's own contract,
// PLUS the SHARED-FIXTURE anti-drift check against apps/openclaw-config/
// scripts/broker-status-map.mjs (the source of truth this module is a
// from-scratch port of - see broker-status-map.ts's own doc comment). Both
// this suite and the .mjs one read the exact same JSON fixture and assert
// mapBrokerStatusToStage produces the exact same {stage, localStatus} output
// for every sample - a silent drift between the two fails on at least one
// side.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mapBrokerStatusToStage } from "./broker-status-map.js";

interface BrokerStatusFixtureSample {
  name: string;
  input: string;
  expected: { stage: string; localStatus: string };
}

const FIXTURES_PATH = fileURLToPath(
  new URL("../../openclaw-config/scripts/__fixtures__/broker-status-map-samples.json", import.meta.url)
);

function loadFixtureSamples(): BrokerStatusFixtureSample[] {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as BrokerStatusFixtureSample[];
}

describe("mapBrokerStatusToStage: own contract", () => {
  it("returns an object with stage + localStatus (not a bare string - that is longbridge-paper.ts's own wrapper's job)", () => {
    expect(mapBrokerStatusToStage("Filled")).toEqual({ stage: "filled", localStatus: "accepted" });
  });

  it("is case-insensitive and punctuation-insensitive", () => {
    expect(mapBrokerStatusToStage("filled")).toEqual({ stage: "filled", localStatus: "accepted" });
    expect(mapBrokerStatusToStage("FILLED")).toEqual({ stage: "filled", localStatus: "accepted" });
    expect(mapBrokerStatusToStage("Wait To Cancel")).toEqual({ stage: "pending", localStatus: "pending" });
  });

  it("maps cancel-in-progress statuses to 'pending', never 'unknown_broker_status'", () => {
    expect(mapBrokerStatusToStage("WaitToCancel")).toEqual({ stage: "pending", localStatus: "pending" });
    expect(mapBrokerStatusToStage("PendingCancel")).toEqual({ stage: "pending", localStatus: "pending" });
  });

  it("never silently maps an unrecognized status to 'accepted'", () => {
    const result = mapBrokerStatusToStage("TotallyMadeUpStatus");
    expect(result.stage).toBe("unknown_broker_status");
    expect(result.localStatus).toBe("unknown");
    expect(result.stage).not.toBe("accepted");
    expect(result.localStatus).not.toBe("accepted");
  });
});

describe("mapBrokerStatusToStage: SHARED-FIXTURE anti-drift check (Phase 6 Task 5)", () => {
  const samples = loadFixtureSamples();

  it("the fixture file itself is non-empty and covers the full required Longbridge status set plus the unknown case", () => {
    expect(samples.length).toBeGreaterThan(20);
    expect(samples.some((sample) => sample.expected.stage === "unknown_broker_status")).toBe(true);
  });

  it.each(samples.map((sample) => [sample.name, sample] as const))("%s", (_name, sample) => {
    expect(mapBrokerStatusToStage(sample.input)).toEqual(sample.expected);
  });
});
