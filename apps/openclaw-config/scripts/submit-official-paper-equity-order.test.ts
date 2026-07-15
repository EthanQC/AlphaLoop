import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Phase 6 Task 4 (2026-07-15 plan): submit-official-paper-equity-order.mjs
// used to POST a hand-built OrderTicket directly to broker-executor with no
// proposal and no shared secret - that path is now permanently closed
// server-side (403, see apps/broker-executor/src/index.test.ts). This script
// is now a thin shell that makes NO network call at all and always refuses,
// pointing operators at proposals.mjs create + approve instead. These tests
// spawn the real script as a subprocess (not an in-process import) because
// its top-level code calls process.exit(1), which would kill the test
// runner if imported directly.
const scriptPath = fileURLToPath(new URL("./submit-official-paper-equity-order.mjs", import.meta.url));

function runScript(args: string[]): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stderr: "", stdout };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? 1, stderr: err.stderr ?? "", stdout: err.stdout ?? "" };
  }
}

describe("submit-official-paper-equity-order.mjs (Phase 6 Task 4: thin shell, no direct submission)", () => {
  it("refuses to submit and exits non-zero even with a full legacy argv (buy/sell, symbol, quantity)", () => {
    const result = runScript(["buy", "AAPL.US", "1"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/不再直接下单/u);
  });

  it("prints the proposals.mjs create + approve replacement flow", () => {
    const result = runScript(["buy", "AAPL.US", "1"]);

    expect(result.stderr).toMatch(/proposals\.mjs create/u);
    expect(result.stderr).toMatch(/proposals\.mjs approve/u);
  });

  it("refuses even with no arguments at all (no accidental no-op success)", () => {
    const result = runScript([]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/不再直接下单/u);
  });

  it("makes no network call - refusing is instantaneous, not a timed-out connection attempt", () => {
    const start = Date.now();
    const result = runScript(["buy", "AAPL.US", "1"]);
    const elapsedMs = Date.now() - start;

    expect(result.status).not.toBe(0);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
