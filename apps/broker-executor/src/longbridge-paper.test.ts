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
