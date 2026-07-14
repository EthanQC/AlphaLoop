import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const cli = await import("./market-alerts.mjs");
const store = await import("./market-alerts-store.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string; options: { dbPath: string } } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-market-alerts-cli-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath, options: { dbPath } };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id = "member_1", status: "active" | "revoked" = "active"): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status,
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function seedTarget(db: DatabaseSync, symbol: string, ownerId: string | null): void {
  // Schema v7 (task H3) rebuilt stock_analysis_targets with a composite
  // PRIMARY KEY (symbol, owner_id) and owner_id NOT NULL, backfilling any
  // pre-v7 NULL-owner row to the sentinel '__legacy_shared__' (interpreted
  // as "shared pool, visible to any member" - see isSymbolWatched below).
  // A caller passing `null` here means "seed the legacy shared-pool shape",
  // so normalize it to that same sentinel rather than a raw SQL NULL, which
  // the NOT NULL constraint would now reject outright.
  const normalizedOwnerId = ownerId ?? "__legacy_shared__";
  db.prepare(`
    INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(symbol, owner_id) DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at
  `).run(symbol, normalizedOwnerId, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
}

function seedSnapshot(
  db: DatabaseSync,
  { ownerId, fetchedAt = "2026-07-01T00:00:00.000Z", positions }: { ownerId: string | null; fetchedAt?: string; positions: Array<{ symbol: string }> }
): void {
  db.prepare(`
    INSERT INTO official_paper_snapshots (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'test', 1000, 500, 500, ?, '{}', ?)
  `).run(`snapshot_${Math.random().toString(36).slice(2)}`, fetchedAt, JSON.stringify(positions), ownerId);
}

describe("runList", () => {
  it("requires --actor", () => {
    const { options } = makeDb();
    expect(() => cli.runList({}, options)).toThrow(/--actor/);
  });

  it("returns only the actor's own rules by default", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    seedTarget(db, "AAPL.US", "member_1");
    seedTarget(db, "MSFT.US", "member_2");
    store.insertRule(db, { ownerId: "member_1", symbol: "AAPL.US", ruleType: "daily_move", threshold: 0.04, direction: "both", frequency: "once_daily", hysteresis: 0 });
    store.insertRule(db, { ownerId: "member_2", symbol: "MSFT.US", ruleType: "daily_move", threshold: 0.04, direction: "both", frequency: "once_daily", hysteresis: 0 });

    const result = cli.runList({ actor: "member_1" }, options);

    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].ownerId).toBe("member_1");
  });

  it("--all returns rules across all owners", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    store.insertRule(db, { ownerId: "member_1", symbol: "AAPL.US", ruleType: "daily_move", threshold: 0.04, direction: "both", frequency: "once_daily", hysteresis: 0 });
    store.insertRule(db, { ownerId: "member_2", symbol: "MSFT.US", ruleType: "daily_move", threshold: 0.04, direction: "both", frequency: "once_daily", hysteresis: 0 });

    const result = cli.runList({ actor: "member_1", all: true }, options);

    expect(result.rules).toHaveLength(2);
  });

  // Schema v6: list must distinguish all three states in its JSON output -
  // previously "removed" was indistinguishable from "paused" (both were just
  // enabled:false).
  it("distinguishes active / paused / removed via a status field", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");
    seedTarget(db, "MSFT.US", "member_1");
    seedTarget(db, "TSLA.US", "member_1");

    const active = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options).rule;
    const paused = cli.runAdd({ actor: "member_1", symbol: "MSFT", type: "daily_move" }, options).rule;
    const removed = cli.runAdd({ actor: "member_1", symbol: "TSLA", type: "daily_move" }, options).rule;
    cli.runPause({ actor: "member_1", rule: paused.id }, options);
    cli.runRemove({ actor: "member_1", rule: removed.id }, options);

    const result = cli.runList({ actor: "member_1" }, options);

    const byId = Object.fromEntries(result.rules.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(byId[active.id]).toBe("active");
    expect(byId[paused.id]).toBe("paused");
    expect(byId[removed.id]).toBe("removed");
  });
});

// Finding 2 (task P2-4 live-verification fix round): `list --actor <unknown>`
// used to return {ok:true, rules:[]} exit 0 - indistinguishable from "a real
// member with zero rules". That's misleading when the control agent relays
// it verbatim. `list` must reject a non-member/inactive actor the same way
// `add` already does, for both the owner-scoped and --all paths (the actor
// making the call must itself be a valid active member either way).
describe("runList: actor validation", () => {
  it("rejects an unknown actor", () => {
    const { options } = makeDb();
    expect(() => cli.runList({ actor: "no_such_member" }, options)).toThrow(/在职成员/);
  });

  it("rejects a revoked (inactive) actor", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", "revoked");

    expect(() => cli.runList({ actor: "member_1" }, options)).toThrow(/在职成员/);
  });

  it("rejects an unknown actor on the --all path too", () => {
    const { options } = makeDb();
    expect(() => cli.runList({ actor: "no_such_member", all: true }, options)).toThrow(/在职成员/);
  });

  it("rejects a revoked actor on the --all path too", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", "revoked");

    expect(() => cli.runList({ actor: "member_1", all: true }, options)).toThrow(/在职成员/);
  });

  it("still returns ok:true with an empty list for a valid member who genuinely has no rules", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    expect(cli.runList({ actor: "member_1" }, options)).toEqual({ ok: true, rules: [] });
  });
});

describe("runAdd: actor validation", () => {
  it("rejects an unknown actor", () => {
    const { options } = makeDb();
    expect(() => cli.runAdd({ actor: "no_such_member", symbol: "AAPL", type: "daily_move" }, options)).toThrow(/在职成员/);
  });

  it("rejects a revoked (inactive) actor", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", "revoked");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options)).toThrow(/在职成员/);
  });

  it("requires --actor", () => {
    const { options } = makeDb();
    expect(() => cli.runAdd({ symbol: "AAPL", type: "daily_move" }, options)).toThrow(/--actor/);
  });
});

describe("runAdd: rule type validation", () => {
  it("rejects an unsupported rule type", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "bogus_type" }, options)).toThrow(/不支持的规则类型/);
  });

  it("rejects a missing rule type", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL" }, options)).toThrow(/不支持的规则类型/);
  });
});

describe("runAdd: threshold defaults and validation", () => {
  it("uses the per-type default threshold when --threshold is omitted", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options);

    expect(result.rule.threshold).toBe(0.04);
  });

  it("uses each type's own default", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "unrealized_pnl" }, options).rule.threshold).toBe(0.06);
    expect(cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "spike_5m" }, options).rule.threshold).toBe(0.025);
    expect(cli.runAdd({ actor: "member_1", type: "exposure" }, options).rule.threshold).toBe(0.1);
  });

  it("accepts an explicit --threshold", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "0.08" }, options);

    expect(result.rule.threshold).toBe(0.08);
  });

  it("rejects a non-numeric threshold", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "not-a-number" }, options)).toThrow(/threshold/);
  });

  it("rejects a zero or negative threshold", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "0" }, options)).toThrow(/threshold/);
    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "-0.04" }, options)).toThrow(/threshold/);
  });

  // Fix 2 (task P2-4 fix round): thresholds are decimal ratios (0.04 = 4%).
  // `--threshold 5` used to silently create a rule needing a 500% move -
  // it would never fire, with no error at creation time. Reject threshold
  // >= 1 with a message that teaches the correct decimal form.
  it("rejects a threshold >= 1 with a Chinese message teaching the decimal form", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "5" }, options)).toThrow(
      /阈值请用小数.*0\.05.*500%/
    );
  });

  it("rejects a threshold of exactly 1 (upper bound is inclusive)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "1" }, options)).toThrow(/阈值请用小数/);
  });

  it("accepts a valid boundary threshold just under 1 (0.99)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "0.99" }, options);

    expect(result.rule.threshold).toBe(0.99);
  });

  it("rounds threshold percentage in rejection message (1.1 -> 110%, not 110.00000000000001%)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "1.1" }, options)).toThrow(
      /相当于 110%/
    );
  });
});

// C1 (CRITICAL, whole-branch-review finding): runAdd used to hardcode
// `hysteresis: 0` regardless of rule type, silently killing the spec's
// anti-flap band for unrealized_pnl/exposure (their ONLY anti-flap
// mechanism - unlike daily_move/spike_5m, which have once-daily/cooldown
// gating instead). DEFAULT_HYSTERESIS (market-alerts-engine.mjs) is the
// single source of truth for the spec's per-type values; runAdd must use it
// instead of a hardcoded 0.
describe("runAdd: hysteresis defaults per rule type (C1 fix)", () => {
  it("stores hysteresis 0 for daily_move (no anti-flap band; once-daily gating instead)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options);

    expect(result.rule.hysteresis).toBe(0);
  });

  it("stores hysteresis 0.01 for unrealized_pnl (its only anti-flap mechanism)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "unrealized_pnl" }, options);

    expect(result.rule.hysteresis).toBe(0.01);
  });

  it("stores hysteresis 0 for spike_5m (cooldown is its anti-flap mechanism instead)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "spike_5m" }, options);

    expect(result.rule.hysteresis).toBe(0);
  });

  it("stores hysteresis 0.01 for exposure (its only anti-flap mechanism)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = cli.runAdd({ actor: "member_1", type: "exposure" }, options);

    expect(result.rule.hysteresis).toBe(0.01);
  });

  it("keeps the type default hysteresis even when a custom --threshold is supplied (hysteresis is an absolute band, not a fraction of threshold)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "unrealized_pnl", threshold: "0.08" }, options);

    expect(result.rule.threshold).toBe(0.08);
    expect(result.rule.hysteresis).toBe(0.01);
  });

  // Follow-on hardening found during review of the C1 fix: before C1,
  // hysteresis was always hardcoded 0, so rearmBand (threshold - hysteresis)
  // was always exactly `threshold`, which is always > 0 (threshold > 0 is
  // already enforced above) - a negative/zero rearmBand was structurally
  // impossible. Now that hysteresis defaults to 0.01 for unrealized_pnl/
  // exposure, a caller-supplied --threshold at or below that 0.01 makes
  // rearmBand <= 0. For exposure specifically that's a PERMANENT latch: its
  // rearm check is exposureRatio <= rearmBand, and exposureRatio (from
  // computeExposure) never goes negative, so a rearmBand <= 0 can never be
  // satisfied again - the rule fires once and then silently never fires
  // again for the rest of its life, no matter how far over budget the
  // portfolio later gets. Verified directly against evaluateRule before this
  // guard existed: cycle 1 (exposureRatio 0.006) fires and disarms; cycle 2
  // (exposureRatio 0.5, drastically over budget) still returns
  // skip:disarmed forever. Reject the threshold at creation time instead.
  it("rejects an exposure threshold at or below its 0.01 hysteresis floor (would permanently latch after the first fire)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    expect(() => cli.runAdd({ actor: "member_1", type: "exposure", threshold: "0.005" }, options)).toThrow(/threshold/);
    expect(() => cli.runAdd({ actor: "member_1", type: "exposure", threshold: "0.01" }, options)).toThrow(/threshold/);
  });

  it("rejects an unrealized_pnl threshold at or below its 0.01 hysteresis floor", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "unrealized_pnl", threshold: "0.01" }, options)).toThrow(/threshold/);
  });

  it("accepts an unrealized_pnl threshold just above its hysteresis floor", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "unrealized_pnl", threshold: "0.011" }, options);

    expect(result.ok).toBe(true);
  });

  it("does not apply the hysteresis floor to daily_move/spike_5m, which have no hysteresis at all", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "0.005" }, options).ok).toBe(true);
    expect(cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "spike_5m", threshold: "0.001" }, options).ok).toBe(true);
  });
});

describe("runAdd: direction validation (reviewer-noted write-side gate)", () => {
  it("defaults direction to 'both' when omitted", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options);

    expect(result.rule.direction).toBe("both");
  });

  it("accepts 'up' and 'down'", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", direction: "up" }, options).rule.direction).toBe("up");
    expect(cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "unrealized_pnl", direction: "down" }, options).rule.direction).toBe("down");
  });

  // The engine (market-alerts-engine.mjs directionMatches) silently treats
  // any unrecognized direction as 'both'. This CLI is the write-side gate
  // that must reject a typo instead of letting it quietly become 'both'.
  it("rejects an invalid direction instead of silently widening to 'both'", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", direction: "sideways" }, options)).toThrow(/direction/);
  });
});

// I1 (Important, whole-branch-review finding): exposure is portfolio-level
// and one-sided by nature (over-budget only - there's no symmetric "down"
// side to gate on), yet the CLI accepted --direction for every type
// including exposure and stored/echoed it back, implying a control the
// engine's evaluateExposure never actually consults. Reject it outright
// instead of silently accepting a flag that does nothing.
describe("runAdd: exposure rejects --direction (I1 fix, one-sided by nature)", () => {
  it("rejects an explicit --direction for exposure with a Chinese message", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    expect(() => cli.runAdd({ actor: "member_1", type: "exposure", direction: "up" }, options)).toThrow(
      /敞口规则不支持 --direction/
    );
  });

  it("rejects even an explicit --direction 'both' for exposure (the flag itself is unsupported, not just non-'both' values)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    expect(() => cli.runAdd({ actor: "member_1", type: "exposure", direction: "both" }, options)).toThrow(
      /敞口规则不支持 --direction/
    );
  });

  it("still stores direction 'both' for exposure when --direction is simply omitted", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = cli.runAdd({ actor: "member_1", type: "exposure" }, options);

    expect(result.rule.direction).toBe("both");
  });
});

describe("runAdd: symbol pool validation (watchlist ∪ positions)", () => {
  it("accepts a symbol in the actor's watchlist (stock_analysis_targets, owner_id=actor)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "NVDA.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "NVDA", type: "daily_move" }, options);

    expect(result.ok).toBe(true);
    expect(result.rule.symbol).toBe("NVDA.US");
  });

  // Fix 1 (spec-owner decision, task P2-4 fix round): stock_analysis_targets
  // is a single shared watchlist in production (symbol is the PK; setTargets
  // never writes owner_id), so every real row has owner_id NULL. This is the
  // end-to-end regression test for the reported production bug: "add an
  // alert for a watchlist symbol I don't yet hold" must now succeed against
  // the shared pool instead of failing 100% of the time.
  it("accepts a symbol from the shared watchlist pool (owner_id=NULL row, the real production shape)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "NVDA.US", null);

    const result = cli.runAdd({ actor: "member_1", symbol: "NVDA", type: "daily_move" }, options);

    expect(result.ok).toBe(true);
    expect(result.rule.symbol).toBe("NVDA.US");
  });

  it("accepts a symbol in the actor's own latest snapshot positions", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", positions: [{ symbol: "TSLA.US" }] });

    const result = cli.runAdd({ actor: "member_1", symbol: "TSLA", type: "daily_move" }, options);

    expect(result.ok).toBe(true);
  });

  it("accepts a symbol from a legacy owner_id=NULL snapshot (pre-multi-tenant pool data)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: null, positions: [{ symbol: "MSFT.US" }] });

    const result = cli.runAdd({ actor: "member_1", symbol: "MSFT", type: "daily_move" }, options);

    expect(result.ok).toBe(true);
  });

  it("rejects a symbol that is in neither the actor's watchlist nor positions", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "GOOG", type: "daily_move" }, options)).toThrow(/不在你的自选池或当前持仓中/);
  });

  it("rejects another owner's watchlist symbol", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    seedTarget(db, "AAPL.US", "member_2");

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options)).toThrow(/不在你的自选池或当前持仓中/);
  });

  it("rejects another owner's explicitly-owned snapshot position", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    seedSnapshot(db, { ownerId: "member_2", positions: [{ symbol: "MSFT.US" }] });

    expect(() => cli.runAdd({ actor: "member_1", symbol: "MSFT", type: "daily_move" }, options)).toThrow(/不在你的自选池或当前持仓中/);
  });

  it("requires --symbol for non-exposure types", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    expect(() => cli.runAdd({ actor: "member_1", type: "daily_move" }, options)).toThrow(/--symbol/);
  });

  it("normalizes a bare ticker to the exchange-suffixed form before validating and storing", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "NVDA.US", "member_1");

    const result = cli.runAdd({ actor: "member_1", symbol: "nvda", type: "daily_move" }, options);

    expect(result.rule.symbol).toBe("NVDA.US");
  });
});

describe("runAdd: exposure type forces symbol to '*'", () => {
  it("stores symbol '*' when --symbol is omitted", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = cli.runAdd({ actor: "member_1", type: "exposure" }, options);

    expect(result.rule.symbol).toBe("*");
  });

  it("accepts an explicit --symbol '*'", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = cli.runAdd({ actor: "member_1", type: "exposure", symbol: "*" }, options);

    expect(result.rule.symbol).toBe("*");
  });

  it("rejects a mismatched --symbol for an exposure rule instead of silently overriding it", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    expect(() => cli.runAdd({ actor: "member_1", type: "exposure", symbol: "NVDA" }, options)).toThrow(/exposure.*'\*'/);
  });

  it("does not require exposure's symbol to be in the watchlist/positions pool", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    expect(() => cli.runAdd({ actor: "member_1", type: "exposure" }, options)).not.toThrow();
  });
});

describe("runAdd: <=10 rules per (owner, symbol, type)", () => {
  it("allows exactly 10 and rejects the 11th", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    for (let i = 0; i < 10; i += 1) {
      const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: String(0.01 + i * 0.001) }, options);
      expect(result.ok).toBe(true);
    }

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options)).toThrow(/上限（10 条）/);
  });

  it("counts paused (disabled) rules toward the cap", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    let lastRuleId = "";
    for (let i = 0; i < 10; i += 1) {
      const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: String(0.01 + i * 0.001) }, options);
      lastRuleId = result.rule.id;
    }
    cli.runPause({ actor: "member_1", rule: lastRuleId }, options);

    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options)).toThrow(/上限（10 条）/);
  });

  it("scopes the cap per symbol+type - a different symbol is unaffected", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");
    seedTarget(db, "NVDA.US", "member_1");

    for (let i = 0; i < 10; i += 1) {
      cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: String(0.01 + i * 0.001) }, options);
    }

    const result = cli.runAdd({ actor: "member_1", symbol: "NVDA", type: "daily_move" }, options);
    expect(result.ok).toBe(true);
  });
});

function addOwnedRule(db: DatabaseSync, options: { dbPath: string }, ownerId: string, symbol = "AAPL.US") {
  seedTarget(db, symbol, ownerId);
  return cli.runAdd({ actor: ownerId, symbol: symbol.replace(".US", ""), type: "daily_move" }, options).rule;
}

// Fix 3 (spec-owner decision, task P2-4 fix round): `remove` used to hard-
// delete the rule AND cascade away its alert_events - including the 误报
// feedback that exists precisely to tune thresholds later. New contract:
// - `remove` (no flag) soft-deletes: enabled=0 + removed_at, events survive.
// - `remove --purge` is the old hard delete, opt-in and explicit.
//
// Schema v6 added alert_rules.removed_at as a marker column, allowing
// `resume` to distinguish soft-removed rules from merely paused ones.
// `resume` now refuses to revive a removed rule with a user-facing error
// (「该规则已删除，请重新创建。」), whereas pause remains reversible.
describe("runRemove: soft delete (default) preserves events; --purge hard-deletes", () => {
  it("soft-deletes by default: disables the rule, keeps events, reports mode:soft", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");
    const [event] = store.recordEvents(db, [{ ruleId: rule.id, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);
    store.setFeedback(db, event.id, "误报，调高阈值");

    const result = cli.runRemove({ actor: "member_1", rule: rule.id }, options);

    expect(result.ok).toBe(true);
    expect(result.ruleId).toBe(rule.id);
    expect(result.action).toBe("removed");
    expect(result.mode).toBe("soft");
    expect(result.eventsPreserved).toBe(1);

    const stored = store.getRule(db, rule.id);
    expect(stored).not.toBeNull();
    expect(stored?.enabled).toBe(false);
    expect(store.getEvent(db, event.id)?.feedback).toBe("误报，调高阈值");
  });

  it("--purge hard-deletes the rule and its events, reports mode:purge", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");
    const [event] = store.recordEvents(db, [{ ruleId: rule.id, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);

    const result = cli.runRemove({ actor: "member_1", rule: rule.id, purge: true }, options);

    expect(result.ok).toBe(true);
    expect(result.ruleId).toBe(rule.id);
    expect(result.action).toBe("removed");
    expect(result.mode).toBe("purge");
    expect(result.eventsDeleted).toBe(1);

    expect(store.getRule(db, rule.id)).toBeNull();
    expect(store.getEvent(db, event.id)).toBeNull();
  });

  it("reports eventsPreserved: 0 / eventsDeleted: 0 when the rule never fired", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");

    expect(cli.runRemove({ actor: "member_1", rule: rule.id }, options).eventsPreserved).toBe(0);
  });

  it("rejects removing another owner's rule (soft path)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const rule = addOwnedRule(db, options, "member_1");

    expect(() => cli.runRemove({ actor: "member_2", rule: rule.id }, options)).toThrow(/不是你的规则/);
    expect(store.getRule(db, rule.id)?.enabled).toBe(true);
  });

  it("rejects removing another owner's rule (--purge path)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const rule = addOwnedRule(db, options, "member_1");

    expect(() => cli.runRemove({ actor: "member_2", rule: rule.id, purge: true }, options)).toThrow(/不是你的规则/);
    expect(store.getRule(db, rule.id)).not.toBeNull();
  });

  it("rejects removing an unknown rule id", () => {
    const { options } = makeDb();
    expect(() => cli.runRemove({ actor: "member_1", rule: "no_such_rule" }, options)).toThrow(/规则不存在/);
  });

  it("requires --rule", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    expect(() => cli.runRemove({ actor: "member_1" }, options)).toThrow(/--rule/);
  });

  // Schema v6 (task P2-4 follow-up): the previously accepted overlap between
  // soft-removed and paused is now closed. removed_at distinguishes them, so
  // `resume` must refuse a removed rule instead of silently reviving it.
  it("removed_at is set on soft removal", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");

    cli.runRemove({ actor: "member_1", rule: rule.id }, options);

    const stored = store.getRule(db, rule.id);
    expect(stored?.enabled).toBe(false);
    expect(typeof stored?.removedAt).toBe("string");
  });

  it("resume refuses to revive a removed rule (schema v6 closes the previously accepted overlap with pause)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");
    cli.runRemove({ actor: "member_1", rule: rule.id }, options);
    expect(store.getRule(db, rule.id)?.enabled).toBe(false);

    expect(() => cli.runResume({ actor: "member_1", rule: rule.id }, options)).toThrow(
      /该规则已删除，请重新创建。/
    );

    // The rejected resume must not have re-enabled the rule.
    expect(store.getRule(db, rule.id)?.enabled).toBe(false);
  });
});

describe("runRemove: a soft-removed rule frees its slot in the <=10 cap", () => {
  it("removing after reaching 10 allows an 11th (unlike pausing, which still counts)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    let firstRuleId = "";
    for (let i = 0; i < 10; i += 1) {
      const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: String(0.01 + i * 0.001) }, options);
      if (i === 0) {
        firstRuleId = result.rule.id;
      }
    }
    expect(() => cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move" }, options)).toThrow(/上限（10 条）/);

    cli.runRemove({ actor: "member_1", rule: firstRuleId }, options);

    const result = cli.runAdd({ actor: "member_1", symbol: "AAPL", type: "daily_move", threshold: "0.5" }, options);
    expect(result.ok).toBe(true);
  });
});

describe("runRemove / runPause / runResume: owner enforcement", () => {
  it("pauses and resumes an owned rule", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");

    expect(cli.runPause({ actor: "member_1", rule: rule.id }, options)).toEqual({ ok: true, ruleId: rule.id, enabled: false });
    expect(store.getRule(db, rule.id)?.enabled).toBe(false);

    expect(cli.runResume({ actor: "member_1", rule: rule.id }, options)).toEqual({ ok: true, ruleId: rule.id, enabled: true });
    expect(store.getRule(db, rule.id)?.enabled).toBe(true);
  });

  it("rejects pausing another owner's rule", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const rule = addOwnedRule(db, options, "member_1");

    expect(() => cli.runPause({ actor: "member_2", rule: rule.id }, options)).toThrow(/不是你的规则/);
  });

  it("rejects resuming another owner's rule", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const rule = addOwnedRule(db, options, "member_1");
    cli.runPause({ actor: "member_1", rule: rule.id }, options);

    expect(() => cli.runResume({ actor: "member_2", rule: rule.id }, options)).toThrow(/不是你的规则/);
    expect(store.getRule(db, rule.id)?.enabled).toBe(false);
  });
});

describe("runFeedback: owner enforcement", () => {
  it("sets feedback on the actor's own event", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");
    const [event] = store.recordEvents(db, [{ ruleId: rule.id, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);

    const result = cli.runFeedback({ actor: "member_1", event: event.id, note: "无用" }, options);

    expect(result).toEqual({ ok: true, eventId: event.id, feedback: "无用" });
    expect(store.getEvent(db, event.id)?.feedback).toBe("无用");
  });

  it("rejects feedback on another owner's event", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const rule = addOwnedRule(db, options, "member_1");
    const [event] = store.recordEvents(db, [{ ruleId: rule.id, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);

    expect(() => cli.runFeedback({ actor: "member_2", event: event.id, note: "无用" }, options)).toThrow(/不是你的事件/);
    expect(store.getEvent(db, event.id)?.feedback).toBeNull();
  });

  it("rejects an unknown event id", () => {
    const { options } = makeDb();
    expect(() => cli.runFeedback({ actor: "member_1", event: "no_such_event", note: "无用" }, options)).toThrow(/事件不存在/);
  });

  it("requires --event", () => {
    const { options } = makeDb();
    expect(() => cli.runFeedback({ actor: "member_1", note: "无用" }, options)).toThrow(/--event/);
  });

  it("requires a non-empty --note", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");
    const [event] = store.recordEvents(db, [{ ruleId: rule.id, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);

    expect(() => cli.runFeedback({ actor: "member_1", event: event.id }, options)).toThrow(/--note/);
  });
});

describe("runMarketAlertsCommand: dispatch", () => {
  it("rejects an unknown subcommand", () => {
    const { options } = makeDb();
    expect(() => cli.runMarketAlertsCommand("bogus", { actor: "member_1" }, options)).toThrow(/未知子命令/);
  });

  it("dispatches 'list' to runList", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = cli.runMarketAlertsCommand("list", { actor: "member_1" }, options);

    expect(result).toEqual({ ok: true, rules: [] });
  });
});

describe("parseFlags", () => {
  it("parses --flag value pairs and the --all boolean flag", () => {
    expect(cli.parseFlags(["--actor", "member_1", "--symbol", "AAPL", "--all"])).toEqual({
      actor: "member_1",
      symbol: "AAPL",
      all: true
    });
  });

  it("ignores non-flag tokens", () => {
    expect(cli.parseFlags(["stray", "--actor", "member_1"])).toEqual({ actor: "member_1" });
  });

  // Regression (code review finding): only `--all` is a genuine boolean
  // flag. Every other flag expects a value; a value-flag with nothing
  // after it (end of argv, or immediately followed by another `--flag`)
  // must NOT become the JS boolean `true` - `Number(true) === 1` and
  // `String(true).trim() === "true"` (both truthy/non-empty) would let a
  // typo'd/omitted value silently pass downstream validation instead of
  // being treated as "no value supplied".
  it("treats a value-flag with no following token as an empty string, not boolean true", () => {
    expect(cli.parseFlags(["--actor"])).toEqual({ actor: "" });
  });

  it("treats a value-flag immediately followed by another flag as an empty string, not boolean true", () => {
    expect(cli.parseFlags(["--threshold", "--direction", "up"])).toEqual({ threshold: "", direction: "up" });
  });

  // Fix 4 (task P2-4 fix round): fail loud on unrecognized flags instead of
  // silently ignoring them - matching this CLI's existing philosophy of
  // never letting a typo quietly fall back to a default (see the direction
  // gate and the omitted-value handling above). Before this fix,
  // `--treshold 0.05` would silently parse as an unused key and `add` would
  // fall back to the type's default threshold with no error at all.
  it("rejects an unknown flag instead of silently ignoring it (e.g. --treshold typo)", () => {
    expect(() => cli.parseFlags(["--actor", "member_1", "--treshold", "0.05"])).toThrow(/未知参数/);
  });

  it("rejects an unknown boolean-looking flag too", () => {
    expect(() => cli.parseFlags(["--al"])).toThrow(/未知参数/);
  });

  it("accepts --purge as a known boolean flag (Fix 3's hard-delete opt-in)", () => {
    expect(cli.parseFlags(["--actor", "member_1", "--rule", "r1", "--purge"])).toEqual({
      actor: "member_1",
      rule: "r1",
      purge: true
    });
  });
});

describe("runAdd / runList: omitted-value flags fail loud instead of silently coercing (code review regression)", () => {
  it("an --actor with no value still fails with the missing-argument error, not a stringified 'true'", () => {
    const { options } = makeDb();
    const flags = cli.parseFlags(["--actor"]);

    expect(() => cli.runList(flags, options)).toThrow(/--actor/);
  });

  it("a --threshold with no value is rejected, not silently coerced to 1 via Number(true)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");
    const flags = cli.parseFlags(["--actor", "member_1", "--symbol", "AAPL", "--type", "daily_move", "--threshold"]);

    expect(() => cli.runAdd(flags, options)).toThrow(/threshold/);
  });
});

// Finding 1 (task P2-4 live-verification fix round): `parseFlags` used to run
// OUTSIDE main()'s try/catch, so an unknown flag (or any other pre-dispatch
// throw) escaped as a raw uncaught exception - a Node stack trace on stderr -
// instead of the CLI's binding contract: a single line of JSON on stdout
// ({"ok":false,"error":"..."}) plus a non-zero exit. `buildCliResult` is the
// extracted, directly-testable entry function main() now delegates to; it
// wraps argv parsing AND dispatch in one try/catch so nothing pre-dispatch
// can throw past the envelope.
describe("buildCliResult: the whole pre-dispatch path (parse + dispatch) is wrapped in the JSON envelope", () => {
  it("converts an unknown-flag parseFlags throw into {ok:false, error} instead of throwing", () => {
    const { options } = makeDb();

    const result = cli.buildCliResult(
      ["add", "--actor", "x", "--symbol", "NVDA", "--type", "daily_move", "--treshold", "0.05"],
      options
    );

    expect(result).toEqual({ ok: false, error: "未知参数：--treshold。" });
  });

  it("converts a missing --actor into {ok:false, error}", () => {
    const { options } = makeDb();

    const result = cli.buildCliResult(["add", "--symbol", "NVDA", "--type", "daily_move"], options);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/--actor/);
  });

  it("converts an unknown subcommand into {ok:false, error}", () => {
    const { options } = makeDb();

    const result = cli.buildCliResult(["bogus"], options);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });

  it("converts no args at all into {ok:false, error} (command is undefined)", () => {
    const { options } = makeDb();

    const result = cli.buildCliResult([], options);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });

  it("still dispatches and returns {ok:true, ...} for a valid command", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "AAPL.US", "member_1");

    const result = cli.buildCliResult(["add", "--actor", "member_1", "--symbol", "AAPL", "--type", "daily_move"], options);

    expect(result.ok).toBe(true);
  });
});
