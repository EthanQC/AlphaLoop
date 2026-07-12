#!/usr/bin/env node
// Rule-management CLI for the alert system (market_alerts). Owner enforcement
// is mandatory everywhere: `--actor` is required on every subcommand, and
// every mutating/inspecting-a-single-rule-or-event subcommand (remove/pause/
// resume/feedback) rejects cross-owner attempts with a Chinese, non-zero-exit
// error. All raw SQL lives in market-alerts-store.mjs (task brief's "reuse
// the store... rather than writing raw SQL in the CLI"); this file only does
// argument parsing, validation, and dispatch.
//
// `remove` is non-destructive by default: it soft-deletes (disables) the
// rule and keeps its alert_events (including 误报 feedback) so thresholds
// can still be tuned from history later. Pass `--purge` to opt into the old
// hard-delete behavior (rule + runtime state + events, unrecoverable).
//
// Schema v6 (packages/shared-types' migration index 5, alert_rules.removed_at):
// soft-remove now sets removed_at alongside enabled=0, so it's distinguishable
// from pause (which only flips enabled). `resume` checks removed_at and
// refuses to revive a removed rule - this was previously a documented,
// accepted overlap ("a soft-removed rule remains resumable, same as a paused
// one") because alert_rules had no marker column; that gap is now closed.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openTradingDatabase, resolveRuntimePaths } from "../../../packages/shared-types/dist/index.js";
import { DEFAULT_THRESHOLDS, EXPOSURE_SYMBOL, RULE_TYPE_FREQUENCY } from "./market-alerts-engine.mjs";
import * as store from "./market-alerts-store.mjs";
import { normalizeSymbol } from "./report-data.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// The 4 rule types come from RULE_TYPE_FREQUENCY (imported, not re-declared)
// so this list can never drift from what the engine actually supports.
const RULE_TYPES = Object.keys(RULE_TYPE_FREQUENCY);

// Reviewer-noted constraint: alert_rules.direction has no DDL CHECK and the
// engine (market-alerts-engine.mjs's directionMatches) silently treats any
// unrecognized value as 'both'. This CLI is the write-side gate that must
// NOT repeat that silent-widening behavior - reject anything outside this
// set instead of letting a typo quietly become 'both'.
const DIRECTIONS = ["both", "up", "down"];

// `--all` (list) and `--purge` (remove, Fix 3) are this CLI's only genuine
// no-value boolean flags. Every other flag (--actor/--symbol/--type/
// --threshold/--direction/--rule/--event/--note) always expects a value.
const BOOLEAN_FLAGS = new Set(["all", "purge"]);

// Fix 4 (task P2-4 fix round): the full set of flags this CLI understands,
// across every subcommand. parseFlags doesn't know which subcommand it's
// parsing for, so this is deliberately the union of all of them rather than
// a per-command allowlist - the per-command "which flags actually apply"
// validation still happens where it always has (each run* function). This
// set only exists to catch typos (`--treshold`) and stray flags fail-loud,
// matching the rest of this CLI's philosophy (see the direction gate and
// the omitted-value handling below) instead of silently ignoring them and
// falling back to a default with no error at all.
const KNOWN_FLAGS = new Set([
  "actor",
  "symbol",
  "type",
  "threshold",
  "direction",
  "rule",
  "event",
  "note",
  "all",
  "purge"
]);

/**
 * Parses `--flag value` / `--boolFlag` pairs from an argv slice (after the
 * subcommand). Flags in BOOLEAN_FLAGS are always `true` when present.
 *
 * Every other flag with no following value (end of argv, or immediately
 * followed by another `--flag`) is recorded as an empty string `""`, NOT the
 * JS boolean `true` (code review regression: `Number(true) === 1` let an
 * omitted `--threshold` silently become a valid positive threshold instead
 * of erroring, and `String(true).trim()` === "true" - a non-empty string -
 * let an omitted `--actor` slip past the "missing argument" check). An
 * empty-string value still fails every downstream `!value`/`Number(value)`
 * validation the same way a truly absent flag would, so this keeps "flag
 * present but empty" and "flag absent" both failing loud instead of one of
 * them silently succeeding with a bogus coerced value.
 *
 * An unrecognized `--flag` (a typo like `--treshold`) throws immediately
 * instead of being silently recorded and ignored (Fix 4, task P2-4 fix
 * round) - without this, `add --treshold 0.05` would fall back to the
 * type's default threshold with no error at all.
 */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) {
      throw new Error(`未知参数：--${name}。`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = "";
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

function requireActor(flags) {
  const actor = String(flags.actor ?? "").trim();
  if (!actor) {
    throw new Error("缺少 --actor 参数。");
  }
  return actor;
}

function withDb(options, fn) {
  const db = openTradingDatabase(options.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function requireOwnedRule(db, actor, ruleIdRaw) {
  const ruleId = String(ruleIdRaw ?? "").trim();
  if (!ruleId) {
    throw new Error("缺少 --rule 参数。");
  }
  const rule = store.getRule(db, ruleId);
  if (!rule) {
    throw new Error("规则不存在。");
  }
  if (rule.ownerId !== actor) {
    throw new Error("不是你的规则。");
  }
  return rule;
}

// Schema v6: a rule now has 3 distinguishable states instead of 2. `enabled`
// alone used to conflate "paused" and "removed" (both enabled:false);
// removed_at breaks that tie. Computed here rather than stored, since it's
// entirely derivable from the two existing columns.
function ruleStatus(rule) {
  if (rule.removedAt) {
    return "removed";
  }
  return rule.enabled ? "active" : "paused";
}

export function runList(flags, options = {}) {
  const actor = requireActor(flags);
  return withDb(options, (db) => {
    const rules = flags.all ? store.listAllRules(db) : store.listRulesByOwner(db, actor);
    return { ok: true, rules: rules.map((rule) => ({ ...rule, status: ruleStatus(rule) })) };
  });
}

export function runAdd(flags, options = {}) {
  const actor = requireActor(flags);
  const type = String(flags.type ?? "").trim();
  if (!RULE_TYPES.includes(type)) {
    throw new Error(`不支持的规则类型：${type || "(空)"}，仅支持 ${RULE_TYPES.join("/")}。`);
  }

  return withDb(options, (db) => {
    const member = store.getMemberById(db, actor);
    if (!member || member.status !== "active") {
      throw new Error("actor 不是有效的在职成员，无法创建提醒规则。");
    }

    const direction = flags.direction === undefined ? "both" : String(flags.direction).trim();
    if (!DIRECTIONS.includes(direction)) {
      throw new Error(`direction 参数无效：${direction}，仅支持 ${DIRECTIONS.join("/")}。`);
    }

    const threshold = flags.threshold === undefined ? DEFAULT_THRESHOLDS[type] : Number(flags.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      throw new Error("threshold 必须是正数。");
    }
    // Fix 2 (task P2-4 fix round): thresholds are decimal ratios (0.04 =
    // 4%), but nothing stopped `--threshold 5` from silently creating a
    // rule that needs a 500% move to ever fire - a rule that, in practice,
    // never fires, with no error at creation time. Reject >= 1 (100%) and
    // teach the correct form in the error rather than just rejecting.
    if (threshold >= 1) {
      throw new Error(
        `阈值请用小数（5% 写作 0.05）；收到的值 ${threshold} 相当于 ${Math.round(threshold * 100)}%。`
      );
    }

    const symbol = resolveAddSymbol(type, flags.symbol, db, actor);

    const existingCount = store.countRules(db, actor, symbol, type);
    if (existingCount >= 10) {
      throw new Error(`同一标的+类型的规则数已达上限（10 条）：${symbol} / ${type}。`);
    }

    const rule = store.insertRule(db, {
      ownerId: actor,
      symbol,
      ruleType: type,
      threshold,
      direction,
      frequency: RULE_TYPE_FREQUENCY[type],
      hysteresis: 0
    });

    return { ok: true, rule };
  });
}

// exposure is portfolio-level, not per-symbol: the brief fixes its symbol to
// '*' rather than letting it participate in the watchlist/positions pool
// check (there's no real symbol to validate). Consistent with the direction
// gate above, a user-supplied --symbol that disagrees with '*' is rejected
// rather than silently overridden - only an absent/already-'*' --symbol is
// accepted, so a confused caller finds out immediately instead of getting a
// rule for a different symbol than they asked for.
function resolveAddSymbol(type, rawSymbolFlag, db, actor) {
  if (type === "exposure") {
    const rawSymbol = rawSymbolFlag === undefined ? EXPOSURE_SYMBOL : String(rawSymbolFlag).trim();
    if (rawSymbol !== EXPOSURE_SYMBOL) {
      throw new Error("exposure 类型规则的 symbol 固定为 '*'（组合级），请勿指定具体标的。");
    }
    return EXPOSURE_SYMBOL;
  }

  const rawSymbol = String(rawSymbolFlag ?? "").trim();
  if (!rawSymbol) {
    throw new Error("缺少 --symbol 参数。");
  }
  const symbol = normalizeSymbol(rawSymbol);
  const inWatchlist = store.isSymbolWatched(db, actor, symbol);
  const inPositions = store.isSymbolInPositions(db, actor, symbol);
  if (!inWatchlist && !inPositions) {
    throw new Error(`标的 ${symbol} 不在你的自选池或当前持仓中，无法为其创建提醒规则。`);
  }
  return symbol;
}

// Fix 3 (spec-owner decision, task P2-4 fix round): `remove` used to hard-
// delete the rule AND cascade away its alert_events - including the 误报
// feedback that exists precisely to tune thresholds later. Default behavior
// is non-destructive:
//   - `remove --actor X --rule R`           -> soft delete: store.removeRule
//     (enabled=0 AND removed_at=now). Runtime state and events (including
//     feedback) survive untouched.
//   - `remove --actor X --rule R --purge`   -> the old hard delete
//     (rule + runtime state + events), opt-in and explicit.
//
// Schema v6 closed the gap this comment used to document: alert_rules now
// has `removed_at` (packages/shared-types migration index 5), so a
// soft-removed rule is distinguishable from a merely-paused one, and
// `resume` (below) refuses to revive it instead of silently re-enabling it.
export function runRemove(flags, options = {}) {
  const actor = requireActor(flags);
  const purge = Boolean(flags.purge);
  return withDb(options, (db) => {
    const rule = requireOwnedRule(db, actor, flags.rule);
    const eventCount = store.countEventsForRule(db, rule.id);

    if (purge) {
      store.deleteRule(db, rule.id);
      return {
        ok: true,
        ruleId: rule.id,
        action: "removed",
        mode: "purge",
        eventsDeleted: eventCount,
        message: "已彻底删除该规则及其全部历史事件（含误报反馈），无法恢复。"
      };
    }

    store.removeRule(db, rule.id);
    return {
      ok: true,
      ruleId: rule.id,
      action: "removed",
      mode: "soft",
      eventsPreserved: eventCount,
      message:
        "已删除该规则（软删除）：历史事件与误报反馈已保留，可用于日后调整阈值。" +
        "该规则已无法通过 resume 恢复，如需继续监控请重新创建。" +
        "如需彻底清除历史且不再需要恢复，请追加 --purge（不可恢复）。"
    };
  });
}

export function runPause(flags, options = {}) {
  const actor = requireActor(flags);
  return withDb(options, (db) => {
    const rule = requireOwnedRule(db, actor, flags.rule);
    store.setRuleEnabled(db, rule.id, false);
    return { ok: true, ruleId: rule.id, enabled: false };
  });
}

// Schema v6: refuses to revive a soft-removed rule. This used to be an
// accepted limitation (no DDL marker existed to tell "removed" apart from
// "paused", so resume worked on both) - alert_rules.removed_at now makes
// that distinction real, so a removed rule's resume attempt fails loud
// instead of quietly undoing the removal.
export function runResume(flags, options = {}) {
  const actor = requireActor(flags);
  return withDb(options, (db) => {
    const rule = requireOwnedRule(db, actor, flags.rule);
    if (rule.removedAt) {
      throw new Error("该规则已删除，请重新创建。");
    }
    store.setRuleEnabled(db, rule.id, true);
    return { ok: true, ruleId: rule.id, enabled: true };
  });
}

export function runFeedback(flags, options = {}) {
  const actor = requireActor(flags);
  const eventId = String(flags.event ?? "").trim();
  if (!eventId) {
    throw new Error("缺少 --event 参数。");
  }
  const note = flags.note === undefined ? "" : String(flags.note).trim();
  if (!note) {
    throw new Error("缺少 --note 参数。");
  }

  return withDb(options, (db) => {
    const event = store.getEvent(db, eventId);
    if (!event) {
      throw new Error("事件不存在。");
    }
    if (event.ownerId !== actor) {
      throw new Error("不是你的事件。");
    }
    store.setFeedback(db, eventId, note);
    return { ok: true, eventId, feedback: note };
  });
}

const COMMANDS = {
  list: runList,
  add: runAdd,
  remove: runRemove,
  pause: runPause,
  resume: runResume,
  feedback: runFeedback
};

export function runMarketAlertsCommand(command, flags, options = {}) {
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(
      `未知子命令：${command || "(空)"}，仅支持 ${Object.keys(COMMANDS).join("/")}。`
    );
  }
  return handler(flags, options);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const dbPath = resolveRuntimePaths(repoRoot).dbPath;

  try {
    const result = runMarketAlertsCommand(command, flags, { dbPath });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
