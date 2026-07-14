// Task H7 (2026-07-14 legacy audit): two fixes in this file.
// (1) parseLongbridgeJson used to treat empty/whitespace-only CLI stdout as
//     a successful `{}` payload - the alert poller would then record a
//     GREEN cycle with zero quotes (the data-side twin of the H1 delivery-
//     blindness bug). It must throw instead so every caller's existing
//     error handling (run_log + escalation chain) sees a real failure.
// (2) the `quote` rate-limit lock's TTL (10s) used to be shorter than the
//     CLI timeout it guards (45s default) - a slow call could have its lock
//     stolen mid-flight. The TTL is now derived from the CLI timeout.
//
// These tests stub the Longbridge CLI via LONGBRIDGE_CLI_PATH (the exact
// mechanism this task's live-check instructions name: "stub the longbridge
// CLI (PATH override to a script printing nothing)") rather than mocking
// child_process, so they exercise the real execFileSync/lock/parse path.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeStubCli(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-longbridge-stub-"));
  tempDirs.push(dir);
  const path = join(dir, "longbridge-stub.mjs");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  delete process.env.LONGBRIDGE_CLI_PATH;
  delete process.env.LONGBRIDGE_READ_RETRY_ATTEMPTS;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("parseLongbridgeJson via the real CLI wrapper (empty stdout must fail loudly)", () => {
  it("throws instead of returning {} when the CLI exits 0 with empty stdout (silent alert blindness)", async () => {
    const stubPath = makeStubCli(`#!/usr/bin/env node
process.exit(0);
`);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    process.env.LONGBRIDGE_READ_RETRY_ATTEMPTS = "1";
    const { runLongbridgeJson, runLongbridgeJsonWithRetry } = await import("./_longbridge.mjs");

    await expect(runLongbridgeJson("quote", ["quote", "AAPL.US"])).rejects.toThrow(/empty/iu);
    await expect(
      runLongbridgeJsonWithRetry("quote", ["quote", "AAPL.US"], { attempts: 1 })
    ).rejects.toThrow(/empty/iu);
  });

  it("throws instead of returning {} when the CLI prints only whitespace", async () => {
    const stubPath = makeStubCli(`#!/usr/bin/env node
process.stdout.write("   \\n  \\n");
process.exit(0);
`);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    const { runLongbridgeJson } = await import("./_longbridge.mjs");

    await expect(runLongbridgeJson("quote", ["quote", "AAPL.US"])).rejects.toThrow(/empty/iu);
  });

  it("still parses real JSON stdout correctly (empty-stdout fix must not break the normal path)", async () => {
    const stubPath = makeStubCli(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ symbol: "AAPL.US", last: "210.5" }));
process.exit(0);
`);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    const { runLongbridgeJson } = await import("./_longbridge.mjs");

    await expect(runLongbridgeJson("quote", ["quote", "AAPL.US"])).resolves.toEqual({
      symbol: "AAPL.US",
      last: "210.5"
    });
  });
});

describe("Longbridge rate-limit lock TTL >= CLI timeout it guards (task H7)", () => {
  it("keeps the default quote and trade lock TTLs at or above the default 45s CLI timeout", async () => {
    const mod = await import(`./_longbridge.mjs?ttl-default`);
    const config = mod.getLongbridgeRateLimitConfig();

    expect(config.quote.lockTtlMs).toBeGreaterThanOrEqual(45_000);
    expect(config.trade.lockTtlMs).toBeGreaterThanOrEqual(45_000);
  });

  it("derives the lock TTL from LONGBRIDGE_CLI_TIMEOUT_MS so the two can never drift apart", async () => {
    process.env.LONGBRIDGE_CLI_TIMEOUT_MS = "12345";
    try {
      const mod = await import(`./_longbridge.mjs?ttl-custom`);
      const config = mod.getLongbridgeRateLimitConfig();

      expect(config.quote.lockTtlMs).toBeGreaterThanOrEqual(12_345);
      expect(config.trade.lockTtlMs).toBeGreaterThanOrEqual(12_345);
    } finally {
      delete process.env.LONGBRIDGE_CLI_TIMEOUT_MS;
    }
  });
});
