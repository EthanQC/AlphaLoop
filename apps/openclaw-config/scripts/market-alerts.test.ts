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
  db.prepare(`
    INSERT INTO stock_analysis_targets (symbol, active, created_at, updated_at, owner_id)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET owner_id = excluded.owner_id
  `).run(symbol, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", ownerId);
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

describe("runAdd: symbol pool validation (watchlist ∪ positions)", () => {
  it("accepts a symbol in the actor's watchlist (stock_analysis_targets, owner_id=actor)", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "NVDA.US", "member_1");

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

describe("runRemove / runPause / runResume: owner enforcement", () => {
  it("removes an owned rule", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const rule = addOwnedRule(db, options, "member_1");

    const result = cli.runRemove({ actor: "member_1", rule: rule.id }, options);

    expect(result).toEqual({ ok: true, ruleId: rule.id, removed: true });
    expect(store.getRule(db, rule.id)).toBeNull();
  });

  it("rejects removing another owner's rule", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const rule = addOwnedRule(db, options, "member_1");

    expect(() => cli.runRemove({ actor: "member_2", rule: rule.id }, options)).toThrow(/不是你的规则/);
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
