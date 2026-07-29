/**
 * CROSS-CHECK AGAINST THE REAL CONSUMER, NOT A COPY OF IT.
 *
 * The ocf1 envelope is not a shape this repo gets to define: OpenClaw's
 * `decodeFeishuCardAction` decides whether a click is `structured`, `legacy`
 * or `invalid`, and every prior round of this project has been burned by
 * tests whose "input shape" was authored by us instead of by the real
 * producer/consumer. So this file does not re-implement those rules - it
 * finds the INSTALLED openclaw's own decoder on disk and runs our envelopes
 * through it.
 *
 * The decoder is located BEHAVIOURALLY, not by export name: openclaw ships
 * minified bundles whose file names carry content hashes
 * (`dist/send-result-<hash>.js`) and whose exports are single letters
 * (`decodeFeishuCardAction as c`), both of which change on any upgrade. The
 * probe below imports each candidate module and keeps the function that
 * classifies a known ocf1 value as `structured` AND a known legacy value as
 * `legacy` - a signature no other export in that bundle has.
 *
 * When openclaw is not installed, the cases are registered as SKIPPED with
 * the reason in the test name rather than silently vanishing, because "the
 * cross-check did not run" and "the cross-check passed" must never look the
 * same in a test report. Point OPENCLAW_HOME at an install to run them
 * elsewhere.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildProposalDecisionEnvelope } from "./card-actions.js";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? "/opt/homebrew/lib/node_modules/openclaw";

type DecodeResult =
  | { kind: "structured"; envelope: Record<string, unknown> }
  | { kind: "legacy"; text: string }
  | { kind: "invalid"; reason: string };

type Decoder = (params: { event: unknown; now?: number }) => DecodeResult;

function makeEvent(value: unknown, overrides: { openId?: string; chatId?: string } = {}): unknown {
  return {
    token: "c-callback-token",
    operator: { open_id: overrides.openId ?? "ou_owner", union_id: "on_x", user_id: "u_x" },
    action: { tag: "button", value },
    context: { chat_id: overrides.chatId ?? "oc_dm", open_message_id: "om_1" }
  };
}

const PROBE_STRUCTURED = { oc: "ocf1", k: "quick", a: "probe.action", q: "probe" };
const PROBE_LEGACY = { value: "probe" };

async function findInstalledDecoder(): Promise<{ decoder: Decoder | null; reason: string }> {
  const distDir = join(OPENCLAW_HOME, "dist");
  if (!existsSync(distDir)) {
    return { decoder: null, reason: `no openclaw install at ${OPENCLAW_HOME}` };
  }

  const candidates = readdirSync(distDir)
    .filter((name) => name.endsWith(".js"))
    .filter((name) => {
      try {
        return readFileSync(join(distDir, name), "utf8").includes("function decodeFeishuCardAction(");
      } catch {
        return false;
      }
    });

  if (candidates.length === 0) {
    return { decoder: null, reason: `no module defining decodeFeishuCardAction under ${distDir}` };
  }

  for (const name of candidates) {
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(join(distDir, name)).href)) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const exported of Object.values(module)) {
      if (typeof exported !== "function") {
        continue;
      }
      try {
        const structured = (exported as Decoder)({ event: makeEvent(PROBE_STRUCTURED) });
        const legacy = (exported as Decoder)({ event: makeEvent(PROBE_LEGACY) });
        if (structured?.kind === "structured" && legacy?.kind === "legacy") {
          return { decoder: exported as Decoder, reason: `${name}` };
        }
      } catch {
        // Not the decoder - other exports in this bundle take different args.
      }
    }
  }

  return { decoder: null, reason: `found decodeFeishuCardAction in ${distDir} but could not identify its export` };
}

const { decoder, reason } = await findInstalledDecoder();

describe("ocf1 envelope vs. the installed OpenClaw decoder", () => {
  if (!decoder) {
    it.skip(`SKIPPED (${reason}) - the ocf1 envelope was NOT cross-checked against the real decoder`, () => {});
    return;
  }

  const decode = decoder;

  it("classifies an approval button's envelope as structured, with the command intact", () => {
    const envelope = buildProposalDecisionEnvelope({
      decision: "approved",
      token: "approval_abc",
      ownerOpenId: "ou_owner",
      expiresAtMs: Date.now() + 60_000
    });

    const result = decode({ event: makeEvent(envelope, { openId: "ou_owner" }) });

    expect(result.kind).toBe("structured");
    expect(result.kind === "structured" ? result.envelope.q : null).toBe("批准 approval_abc");
    expect(result.kind === "structured" ? result.envelope.a : null).toBe("alphaloop.proposal.decide");
  });

  it("accepts all three decision buttons", () => {
    for (const decision of ["approved", "approved_half", "rejected"] as const) {
      const envelope = buildProposalDecisionEnvelope({
        decision,
        token: "approval_abc",
        ownerOpenId: "ou_owner",
        expiresAtMs: Date.now() + 60_000
      });
      expect(decode({ event: makeEvent(envelope, { openId: "ou_owner" }) }).kind).toBe("structured");
    }
  });

  it("rejects a click by anyone other than the bound owner as wrong_user", () => {
    const envelope = buildProposalDecisionEnvelope({
      decision: "approved",
      token: "approval_abc",
      ownerOpenId: "ou_owner",
      expiresAtMs: Date.now() + 60_000
    });

    const result = decode({ event: makeEvent(envelope, { openId: "ou_someone_else" }) });

    expect(result).toEqual({ kind: "invalid", reason: "wrong_user" });
  });

  it("rejects a click past the envelope's expiry as stale", () => {
    const envelope = buildProposalDecisionEnvelope({
      decision: "approved",
      token: "approval_abc",
      ownerOpenId: "ou_owner",
      expiresAtMs: Date.now() - 1_000
    });

    const result = decode({ event: makeEvent(envelope, { openId: "ou_owner" }) });

    expect(result).toEqual({ kind: "invalid", reason: "stale" });
  });

  it("shows what the pre-fix button produced: a legacy text dispatch of raw JSON", () => {
    // This is the exact value buildFeishuCardPayload emitted before the ocf1
    // envelope landed - kept as the regression's fingerprint.
    const result = decode({ event: makeEvent({ value: "批准 approval_abc" }) });

    expect(result).toEqual({ kind: "legacy", text: '{"value":"批准 approval_abc"}' });
  });
});
