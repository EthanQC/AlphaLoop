import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeLongbridgePaperOrder,
  extractBrokerStatus,
  extractOrderId,
  mapBrokerStatusToStage,
  parseLongbridgeOutput,
  type LongbridgeExecFn
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

  // Phase 6 Task 4 (2026-07-15 plan), Global Constraint ⑥: execFileSync now
  // always carries an explicit timeout, and the function itself is
  // injectable so tests never spawn a real longbridge CLI process.
  describe("injectable exec function (Phase 6 Task 4)", () => {
    let previousMode: string | undefined;
    let previousEnabled: string | undefined;
    let previousLive: string | undefined;
    let previousTimeout: string | undefined;

    beforeEach(() => {
      previousMode = process.env.LONGBRIDGE_ACCOUNT_MODE;
      previousEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED;
      previousLive = process.env.ALLOW_LIVE_EXECUTION;
      previousTimeout = process.env.LONGBRIDGE_CLI_TIMEOUT_MS;
      process.env.LONGBRIDGE_ACCOUNT_MODE = "paper";
      process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED = "true";
      process.env.ALLOW_LIVE_EXECUTION = "false";
    });

    afterEach(() => {
      restoreEnv("LONGBRIDGE_ACCOUNT_MODE", previousMode);
      restoreEnv("LONGBRIDGE_OFFICIAL_PAPER_ENABLED", previousEnabled);
      restoreEnv("ALLOW_LIVE_EXECUTION", previousLive);
      restoreEnv("LONGBRIDGE_CLI_TIMEOUT_MS", previousTimeout);
    });

    it("calls the injected exec function (not the real CLI) with the default 45000ms timeout", () => {
      delete process.env.LONGBRIDGE_CLI_TIMEOUT_MS;
      const calls: Array<{ command: string; args: readonly string[]; options: { timeout: number } }> = [];
      const fakeExec: LongbridgeExecFn = (command, args, options) => {
        calls.push({ command, args, options });
        return JSON.stringify({ order_id: "fake_order_1", status: "Submitted" });
      };

      const result = executeLongbridgePaperOrder(baseTicket(), fakeExec);

      expect(result.externalOrderId).toBe("fake_order_1");
      // Two calls: the order submission itself, then the order-detail lookup
      // (readOrderDetail) that follows any successful submit - both must go
      // through the SAME injected fn, both with the timeout applied.
      expect(calls).toHaveLength(2);
      expect(calls[0]?.options.timeout).toBe(45_000);
      expect(calls[1]?.options.timeout).toBe(45_000);
    });

    it("honors LONGBRIDGE_CLI_TIMEOUT_MS when set", () => {
      process.env.LONGBRIDGE_CLI_TIMEOUT_MS = "5000";
      const calls: Array<{ options: { timeout: number } }> = [];
      const fakeExec: LongbridgeExecFn = (_command, _args, options) => {
        calls.push({ options });
        return JSON.stringify({ order_id: "fake_order_2", status: "Submitted" });
      };

      executeLongbridgePaperOrder(baseTicket(), fakeExec);

      expect(calls[0]?.options.timeout).toBe(5000);
    });

    it("propagates the exec function's throw directly instead of synthesizing a rejected ExecutionResult - the caller (broker-executor's /v1/tickets handler) is the one place that decides a failed/timed-out CLI call means submit_unconfirmed, not this module", () => {
      const timeoutError = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" });
      const fakeExec: LongbridgeExecFn = () => {
        throw timeoutError;
      };

      expect(() => executeLongbridgePaperOrder(baseTicket(), fakeExec)).toThrow("Command timed out");
    });

    it("propagates a throw even when the failed CLI call's message happens to contain an order_id-shaped string - no salvage guessing", () => {
      const fakeExec: LongbridgeExecFn = () => {
        throw new Error("non-zero exit, stdout had order_id: 999999");
      };

      expect(() => executeLongbridgePaperOrder(baseTicket(), fakeExec)).toThrow(/non-zero exit/);
    });

    it("routes the order-detail lookup through the SAME injected exec function", () => {
      const calls: string[] = [];
      const fakeExec: LongbridgeExecFn = (_command, args) => {
        calls.push(args.join(" "));
        if (args[0] === "order" && args[1] === "detail") {
          return JSON.stringify({ status: "Filled", executed_price: "101.50" });
        }
        return JSON.stringify({ order_id: "fake_order_3", status: "New" });
      };

      const result = executeLongbridgePaperOrder(baseTicket(), fakeExec);

      expect(calls.some((c) => c.startsWith("order detail fake_order_3"))).toBe(true);
      expect(result.brokerOrderStage).toBe("filled");
      expect(result.fillPrice).toBe(101.5);
    });
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
