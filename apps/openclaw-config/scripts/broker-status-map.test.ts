// Phase 6 Task 5 (2026-07-15 plan): broker-status-map.mjs is the single
// canonical {stage, localStatus} source of truth shared by broker-executor's
// longbridge-paper.ts (via its own TS port, broker-status-map.ts) and
// reconcile-official-paper-orders.mjs (this app, imports it directly). These
// tests pin down the exact contract both callers depend on, plus the
// SHARED-FIXTURE anti-drift check against the TS port's own test suite.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BROKER_STATUS_TABLE_KEYS, mapBrokerStatusToStage } from "./broker-status-map.mjs";

interface BrokerStatusFixtureSample {
  name: string;
  input: string;
  expected: { stage: string; localStatus: string };
}

const FIXTURES_PATH = fileURLToPath(new URL("./__fixtures__/broker-status-map-samples.json", import.meta.url));

function loadFixtureSamples(): BrokerStatusFixtureSample[] {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as BrokerStatusFixtureSample[];
}

describe("mapBrokerStatusToStage: own contract", () => {
  it("covers the full required Longbridge status set named in the Phase 6 Task 5 deliverable", () => {
    const required = [
      "filled", "partialfilled", "new", "waittonew", "waittosubmit", "notreported", "pending",
      "partialwithdrawal", "waittocancel", "pendingcancel", "canceled", "replaced", "rejected",
      "expired", "waittodeal"
    ];
    for (const key of required) {
      expect(BROKER_STATUS_TABLE_KEYS).toContain(key);
    }
  });

  it("is case-insensitive and strips punctuation/spacing", () => {
    expect(mapBrokerStatusToStage("Filled")).toEqual({ stage: "filled", localStatus: "accepted" });
    expect(mapBrokerStatusToStage("FILLED")).toEqual({ stage: "filled", localStatus: "accepted" });
    expect(mapBrokerStatusToStage("wait_to_cancel")).toEqual({ stage: "pending", localStatus: "pending" });
  });

  it("maps cancel-in-progress statuses to 'pending', never 'unknown_broker_status' (finding #5)", () => {
    expect(mapBrokerStatusToStage("WaitToCancel")).toEqual({ stage: "pending", localStatus: "pending" });
    expect(mapBrokerStatusToStage("PendingCancel")).toEqual({ stage: "pending", localStatus: "pending" });
  });

  it("never silently maps an unrecognized status to 'accepted'", () => {
    const result = mapBrokerStatusToStage("TotallyMadeUpStatus");
    expect(result).toEqual({ stage: "unknown_broker_status", localStatus: "unknown" });
  });
});

describe("mapBrokerStatusToStage: SHARED-FIXTURE anti-drift check (Phase 6 Task 5)", () => {
  const samples = loadFixtureSamples();

  it("the fixture file itself is non-empty and covers both recognized and unknown cases", () => {
    expect(samples.length).toBeGreaterThan(20);
    expect(samples.some((sample) => sample.expected.stage !== "unknown_broker_status")).toBe(true);
    expect(samples.some((sample) => sample.expected.stage === "unknown_broker_status")).toBe(true);
  });

  it.each(samples.map((sample) => [sample.name, sample] as const))("%s", (_name, sample) => {
    expect(mapBrokerStatusToStage(sample.input)).toEqual(sample.expected);
  });
});
