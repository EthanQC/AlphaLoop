import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// CLI env seam guard (2026-07-30).
//
// The first LIVE run of the approval loop failed on its last hop because
// proposals.mjs was the only CLI in this directory that never called
// loadLocalEnv: it read process.env.BROKER_EXECUTOR_SHARED_SECRET raw, so it
// worked from a login shell that happened to export the secret and silently
// sent an EMPTY auth header when the control agent (whose daemon environment
// carries no secrets) invoked it. Every unit test passed, because unit tests
// inject env and fetch directly - nothing owned the CLI boundary.
//
// This guard is deliberately a SOURCE-level ratchet, and that weakness is
// stated rather than hidden: a subprocess-level proof would have to run the
// real CLIs, whose repoRoot is baked in by import.meta.url - they would read
// the DEVELOPER'S real .env.local (contents vary by machine, so the assertion
// would be flaky) and open the real runtime database (which the runtime-write
// guard rightly fails the run for). What a source check CAN hold is exactly
// the invariant that broke: a script that consumes a credential must load the
// env file it is documented to be configured by, not hope its parent exported
// the right variables. The behavioural half lives in proposals.test.ts's
// runResubmit suite, which asserts the secret ON THE WIRE against a real HTTP
// server.
// ---------------------------------------------------------------------------

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));

// The credentials a script might consume. Reading ANY of these means the
// script is configured through .env.local on every deployed machine.
const SECRET_ENV_PATTERN =
  /process\.env\.(BROKER_EXECUTOR_SHARED_SECRET|FEISHU_APP_SECRET|LARK_APP_SECRET|LONGBRIDGE_APP_SECRET|LONGBRIDGE_ACCESS_TOKEN|PLATFORM_SESSION_SECRET|FINNHUB_API_KEY)\b/u;

describe("every CLI that consumes a credential loads .env.local itself", () => {
  const consumers = readdirSync(SCRIPTS_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => SECRET_ENV_PATTERN.test(readFileSync(join(SCRIPTS_DIR, name), "utf8")));

  it("actually found credential consumers (an empty set would make this guard vacuous)", () => {
    // proposals.mjs is the one that bit us; if the sweep stops seeing even
    // that, the pattern broke and every assertion below is passing on nothing.
    // Only TWO scripts read a credential directly today (proposals.mjs and
    // stock-analysis.mjs) - the rest go through shared-types resolvers, which
    // this guard deliberately does not chase: an indirect consumer that skips
    // loadLocalEnv fails at the resolver with a named error, not silently.
    expect(consumers).toContain("proposals.mjs");
    expect(consumers.length).toBeGreaterThanOrEqual(2);
  });

  for (const name of readdirSync(SCRIPTS_DIR).filter((n) => n.endsWith(".mjs"))) {
    const source = readFileSync(join(SCRIPTS_DIR, name), "utf8");
    if (!SECRET_ENV_PATTERN.test(source)) {
      continue;
    }
    it(`${name} calls loadLocalEnv`, () => {
      expect(
        source.includes("loadLocalEnv("),
        `${name} reads a credential from process.env but never calls loadLocalEnv - ` +
          "it will work from a login shell and silently send empty credentials when " +
          "a daemon (gateway/control agent/launchd job) invokes it. That is exactly " +
          "how the first live approval click lost its broker secret."
      ).toBe(true);
    });
  }
});
