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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Phase 6 Task 6 (2026-07-15 plan): region-cache/rate-limit paths accept an
// optional per-call override, so a per-member subprocess env
// (member-credentials.mjs) can isolate both without touching the single
// shared account's files. Every test below stubs the CLI via
// LONGBRIDGE_CLI_PATH exactly like the existing H7 tests above - no real
// longbridge binary/subprocess involved.
describe("per-call overrides (Task 6 multi-account scaffold)", () => {
  it("isolates the rate-limit state file into options.rateLimitDir instead of the shared runtime dir", async () => {
    const stubPath = makeStubCli(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true }));
process.exit(0);
`);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    const rateLimitDir = mkdtempSync(join(tmpdir(), "openclaw-longbridge-ratelimit-"));
    tempDirs.push(rateLimitDir);
    const { runLongbridgeJson } = await import("./_longbridge.mjs?ratelimit-override");

    await runLongbridgeJson("trade", ["assets"], { rateLimitDir });

    expect(existsSync(join(rateLimitDir, "longbridge-rate-limit-trade.json"))).toBe(true);
  });

  it("falls back to env.LONGBRIDGE_RATE_LIMIT_DIR when options.rateLimitDir is not given explicitly", async () => {
    const stubPath = makeStubCli(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true }));
process.exit(0);
`);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    const rateLimitDir = mkdtempSync(join(tmpdir(), "openclaw-longbridge-ratelimit-env-"));
    tempDirs.push(rateLimitDir);
    const { runLongbridgeJson } = await import("./_longbridge.mjs?ratelimit-env-override");

    await runLongbridgeJson("trade", ["assets"], {
      env: { ...process.env, LONGBRIDGE_RATE_LIMIT_DIR: rateLimitDir }
    });

    expect(existsSync(join(rateLimitDir, "longbridge-rate-limit-trade.json"))).toBe(true);
  });

  it("passes options.env through to the CLI subprocess verbatim", async () => {
    const stubPath = makeStubCli(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ seen: process.env.OPENCLAW_TEST_MARKER ?? null }));
process.exit(0);
`);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    const { runLongbridgeJson } = await import("./_longbridge.mjs?env-passthrough");

    const result = await runLongbridgeJson("quote", ["quote", "AAPL.US"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENCLAW_TEST_MARKER: "member-value" }
    });

    expect(result).toEqual({ seen: "member-value" });
  });

  it("heals the region cache under options.env.HOME instead of the calling process's own HOME", async () => {
    const stubPath = makeStubCli(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ connectivity: { global: { ok: true } }, region: { active: "global" } }));
process.exit(0);
`);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    const memberHome = mkdtempSync(join(tmpdir(), "openclaw-longbridge-member-home-"));
    tempDirs.push(memberHome);
    mkdirSync(join(memberHome, ".longbridge", "openapi"), { recursive: true });
    const { runLongbridgeJson } = await import("./_longbridge.mjs?region-cache-override");

    await runLongbridgeJson("trade", ["check"], {
      env: { PATH: process.env.PATH, HOME: memberHome }
    });

    const regionCachePath = join(memberHome, ".longbridge", "openapi", "region-cache");
    expect(existsSync(regionCachePath)).toBe(true);
    expect(readFileSync(regionCachePath, "utf8")).toBe("global");
  });

  it("two members' rate-limit state files never collide with each other", async () => {
    const stubPath = makeStubCli(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true }));
process.exit(0);
`);
    process.env.LONGBRIDGE_CLI_PATH = stubPath;
    const dirA = mkdtempSync(join(tmpdir(), "openclaw-longbridge-member-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "openclaw-longbridge-member-b-"));
    tempDirs.push(dirA, dirB);
    const { runLongbridgeJson } = await import("./_longbridge.mjs?two-member-ratelimit");

    await runLongbridgeJson("trade", ["assets"], { rateLimitDir: dirA });
    await runLongbridgeJson("trade", ["assets"], { rateLimitDir: dirB });

    expect(existsSync(join(dirA, "longbridge-rate-limit-trade.json"))).toBe(true);
    expect(existsSync(join(dirB, "longbridge-rate-limit-trade.json"))).toBe(true);
  });
});
