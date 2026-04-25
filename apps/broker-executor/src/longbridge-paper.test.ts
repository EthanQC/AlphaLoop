import { describe, expect, it } from "vitest";

import {
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
});
