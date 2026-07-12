#!/usr/bin/env node
// Rule-management CLI for the alert system (market_alerts). Owner enforcement
// is mandatory everywhere: `--actor` is required on every subcommand, and
// every mutating/inspecting-a-single-rule-or-event subcommand (remove/pause/
// resume/feedback) rejects cross-owner attempts with a Chinese, non-zero-exit
// error. All raw SQL lives in market-alerts-store.mjs (task brief's "reuse
// the store... rather than writing raw SQL in the CLI"); this file only does
// argument parsing, validation, and dispatch.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openTradingDatabase, resolveRuntimePaths } from "../../../packages/shared-types/dist/index.js";
import { DEFAULT_THRESHOLDS, RULE_TYPE_FREQUENCY } from "./market-alerts-engine.mjs";
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

const EXPOSURE_SYMBOL = "*";

/**
 * Parses `--flag value` / `--boolFlag` pairs from an argv slice (after the
 * subcommand). A flag with no following value (or one followed immediately
 * by another `--flag`) is treated as a boolean `true` (e.g. `--all`).
 */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
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

export function runList(flags, options = {}) {
  const actor = requireActor(flags);
  return withDb(options, (db) => {
    const rules = flags.all ? store.listAllRules(db) : store.listRulesByOwner(db, actor);
    return { ok: true, rules };
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

export function runRemove(flags, options = {}) {
  const actor = requireActor(flags);
  return withDb(options, (db) => {
    const rule = requireOwnedRule(db, actor, flags.rule);
    store.deleteRule(db, rule.id);
    return { ok: true, ruleId: rule.id, removed: true };
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

export function runResume(flags, options = {}) {
  const actor = requireActor(flags);
  return withDb(options, (db) => {
    const rule = requireOwnedRule(db, actor, flags.rule);
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
