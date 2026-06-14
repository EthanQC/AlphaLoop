import { describe, expect, it } from "vitest";

import {
  executeLongbridgePaperOrder,
  extractBrokerStatus,
  extractOrderId,
  mapBrokerStatusToStage,
  parseLongbridgeOutput
} from "./longbridge-paper.js";

describe("Longbridge paper output parsing", () => {
  it("extracts an order id from mixed progress text and JSON", () => {
    const payload = parseLongbridgeOutput([
      "Submitting order to Longbridge...",
      "{\"data\":{\"order_id\":\"1232655181045305344\",\"status\":\"NotReported\"}}",
      "Done"
    ].join("\n"));

    expect(extractOrderId(payload)).toBe("1232655181045305344");
    expect(extractBrokerStatus(payload)).toBe("NotReported");
    expect(mapBrokerStatusToStage("NotReported")).toBe("submitted");
  });

  it("falls back to order-id regex when the CLI output is plain text", () => {
    const payload = parseLongbridgeOutput("Submitting...\norder_id: 1232655181045305344");

    expect(extractOrderId(payload)).toBe("1232655181045305344");
  });

  it("maps pending and terminal broker statuses", () => {
    expect(mapBrokerStatusToStage("Pending")).toBe("pending");
    expect(mapBrokerStatusToStage("Filled")).toBe("filled");
    expect(mapBrokerStatusToStage("Cancelled")).toBe("cancelled");
    expect(mapBrokerStatusToStage("Rejected")).toBe("rejected");
  });

  it("refuses non-paper and option tickets before the CLI path", () => {
    expect(executeLongbridgePaperOrder({ ...baseTicket(), environment: "live" }).status).toBe("rejected");
    expect(executeLongbridgePaperOrder({ ...baseTicket(), assetClass: "option", strategy: "long_call" }).status).toBe(
      "rejected"
    );
  });

  it("rejects paper tickets instead of falling back to a local simulator when official paper is not enabled", () => {
    const previousMode = process.env.LONGBRIDGE_ACCOUNT_MODE;
    const previousEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED;
    const previousLive = process.env.ALLOW_LIVE_EXECUTION;
    delete process.env.LONGBRIDGE_ACCOUNT_MODE;
    delete process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED;
    process.env.ALLOW_LIVE_EXECUTION = "false";

    try {
      const result = executeLongbridgePaperOrder(baseTicket());

      expect(result.status).toBe("rejected");
      expect(result.provider).toBe("longbridge-paper");
      expect(result.reasons.join(" ")).toMatch(/官方|Official Longbridge paper/u);
    } finally {
      restoreEnv("LONGBRIDGE_ACCOUNT_MODE", previousMode);
      restoreEnv("LONGBRIDGE_OFFICIAL_PAPER_ENABLED", previousEnabled);
      restoreEnv("ALLOW_LIVE_EXECUTION", previousLive);
    }
  });

  it("requires ALLOW_LIVE_EXECUTION to be exactly false before paper order writes", () => {
    const previousMode = process.env.LONGBRIDGE_ACCOUNT_MODE;
    const previousEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED;
    const previousLive = process.env.ALLOW_LIVE_EXECUTION;
    process.env.LONGBRIDGE_ACCOUNT_MODE = "paper";
    process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED = "true";

    try {
      for (const unsafeValue of [undefined, "", "0", "False"]) {
        restoreEnv("ALLOW_LIVE_EXECUTION", unsafeValue);
        const result = executeLongbridgePaperOrder(baseTicket());

        expect(result.status).toBe("rejected");
        expect(result.reasons.join(" ")).toMatch(/ALLOW_LIVE_EXECUTION=false/u);
      }
    } finally {
      restoreEnv("LONGBRIDGE_ACCOUNT_MODE", previousMode);
      restoreEnv("LONGBRIDGE_OFFICIAL_PAPER_ENABLED", previousEnabled);
      restoreEnv("ALLOW_LIVE_EXECUTION", previousLive);
    }
  });
});

function baseTicket() {
  return {
    id: "ticket_lb_guard",
    source: "test",
    submittedAt: new Date().toISOString(),
    environment: "paper" as const,
    assetClass: "stock" as const,
    symbol: "AAPL",
    side: "buy" as const,
    quantity: 1,
    conviction: "normal" as const,
    notionalUsd: 100,
    marketSnapshot: {
      last: 100,
      timestamp: new Date().toISOString()
    }
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
