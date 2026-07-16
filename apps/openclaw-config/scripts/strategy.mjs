#!/usr/bin/env node
// Strategy-memory CLI (Phase 7 Task 3, 2026-07-15 plan): thesis / rule / card
// lifecycle commands over strategy-store.mjs (T1) + memoryd-mirror.mjs (T2).
// Conventions follow members.mjs/proposals.mjs EXACTLY (task brief): a single
// `buildCliResult` JSON envelope wrapping argv-parsing through dispatch,
// per-command flag allowlists (H6 pattern - a flag real for a DIFFERENT
// subcommand fails loud with "未知参数" instead of silently parsing and never
// being read), Chinese error messages, a non-zero exit on error, an
// audit_log row per mutating command (category `strategy_memory`), and a
// `STRATEGY_DB_PATH` env override mirroring members.mjs's `MEMBERS_DB_PATH`.
//
// Three top-level command groups - `thesis`, `rule`, `card` - are ALL
// two-word commands (`thesis create`, `rule list`, `card promote`, ...),
// exactly like members.mjs's `token issue`/`token revoke`: argv[0] is
// inspected first in resolveCommand() so the dispatch table can key on the
// literal two-word string.
//
// Every genuinely async command here awaits mirrorRecord (T2, fire-and-forget
// memoryd mirror) - `withDb` and every exported run* function are therefore
// async throughout, same shape as proposals.mjs.
//
// Ownership enforcement: strategy-store.mjs's mutators (promote/withdraw/
// disable/enable/setStatus/promoteVisibility) already assert ownership
// themselves and throw a Chinese "无权操作" error for a non-owner caller -
// this CLI does not duplicate that check for those commands. `thesis judge`
// is the one exception: appendThesisJudgment takes NO ownerId param BY
// DESIGN (strategy-store.mjs's own doc comment says the owner check for that
// action belongs in this CLI layer), so runThesisJudge fetches the thesis
// and checks `thesis.ownerId === actor` itself, mirroring proposals.mjs's
// runDecision ownership check. Every *create* command (thesis/rule/card)
// additionally requires the acting member to exist and be `active` -
// mirrors members.mjs's runTokenIssue/runRevoke member-status guard.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AuditLogRepository,
  MemberRepository,
  openTradingDatabase,
  resolveRuntimePaths
} from "../../../packages/shared-types/dist/index.js";

import { parseConclusionBox } from "./conclusion-box.mjs";
import { createMemorydBackend, mirrorRecord } from "./memoryd-mirror.mjs";
import {
  appendThesisJudgment,
  createCard,
  createRule,
  createThesis,
  disableRule,
  enableRule,
  getCardById,
  getThesisById,
  listCardsForOwner,
  listRulesForOwner,
  promoteThesisVisibility,
  promoteVisibility,
  setStatus,
  setThesisMemorySlug,
  withdrawThesis
} from "./strategy-store.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const DIRECTION_VALUES = new Set(["bull", "bear", "neutral"]);
const VISIBILITY_VALUES = new Set(["system", "public"]);
const ENFORCEMENT_VALUES = new Set(["hard", "proposal_check", "self"]);
const CARD_STATUS_VALUES = new Set(["active", "paused", "retired"]);

// This CLI has no genuine boolean/no-value flags (every flag always expects
// a value) - kept as an explicit empty set, matching members.mjs's own
// comment on the same convention.
const BOOLEAN_FLAGS = new Set();

// Per-command flag allowlist (H6 pattern). Scoped PER SUBCOMMAND so a flag
// real for a different subcommand fails loud with "未知参数" rather than
// parsing fine and then silently never being read.
const COMMAND_FLAGS = {
  "thesis create": new Set([
    "owner",
    "symbol",
    "direction",
    "target-low",
    "target-high",
    "invalidation",
    "bull",
    "bear",
    "visibility"
  ]),
  "thesis judge": new Set(["owner", "thesis", "note", "source"]),
  "thesis promote": new Set(["owner", "thesis"]),
  "thesis withdraw": new Set(["owner", "thesis"]),
  "thesis from-conclusion": new Set(["owner", "report", "symbol"]),
  "rule create": new Set(["owner", "text", "enforcement", "strategy"]),
  "rule disable": new Set(["owner", "rule"]),
  "rule enable": new Set(["owner", "rule"]),
  "rule list": new Set(["owner"]),
  "card create": new Set(["owner", "name", "scene", "entry", "risk", "exit", "visibility"]),
  "card status": new Set(["owner", "card", "to"]),
  "card promote": new Set(["owner", "card"]),
  "card list": new Set(["owner"])
};

// The three two-word command-group prefixes - mirrors members.mjs's `token`
// two-word special-case, generalized to three prefixes instead of one.
const COMMAND_PREFIXES = new Set(["thesis", "rule", "card"]);

/**
 * Parses `--flag value` pairs from an argv slice (after the subcommand).
 * Mirrors members.mjs/proposals.mjs's parseFlags exactly.
 *
 * @param {string[]} argv
 * @param {string} [command]
 */
export function parseFlags(argv, command) {
  const allowedFlags = COMMAND_FLAGS[command] ?? new Set();
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    if (!allowedFlags.has(name)) {
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

// `thesis`/`rule`/`card` are all two-word commands: argv = ["thesis",
// "create", ...] resolves to the literal dispatch key "thesis create". A
// bare prefix ("thesis" with no second word) or an unrecognized top-level
// word each resolve to a string simply absent from COMMANDS, falling
// through to the same "未知子命令" error as any other typo.
export function resolveCommand(argv) {
  const [first, second] = argv;
  if (COMMAND_PREFIXES.has(first)) {
    return second ? `${first} ${second}` : first;
  }
  return first ?? "";
}

function requireFlag(flags, name) {
  const value = String(flags[name] ?? "").trim();
  if (!value) {
    throw new Error(`缺少 --${name} 参数。`);
  }
  return value;
}

function parseOptionalNumber(flags, name) {
  if (flags[name] === undefined) {
    return undefined;
  }
  const raw = flags[name];
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} 必须是数字，收到：${raw}。`);
  }
  return value;
}

function parsePoints(raw) {
  if (raw === undefined) {
    return [];
  }
  return String(raw)
    .split(";")
    .map((point) => point.trim())
    .filter((point) => point.length > 0);
}

async function withDb(options, fn) {
  const db = openTradingDatabase(options.dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function resolveBackend(options) {
  return options.memorydBackend ?? createMemorydBackend();
}

// Every *create* command requires the acting member to exist and be active -
// mirrors members.mjs's runTokenIssue/runRevoke guard exactly (Chinese
// errors, same two failure messages).
function requireActiveMember(db, ownerId) {
  const member = new MemberRepository(db).getById(ownerId);
  if (!member) {
    throw new Error(`成员不存在：${ownerId}。`);
  }
  if (member.status !== "active") {
    throw new Error(`成员已被吊销，无法操作策略记忆：${ownerId}。`);
  }
  return member;
}

// ---------------------------------------------------------------------------
// thesis
// ---------------------------------------------------------------------------

export async function runThesisCreate(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const symbol = requireFlag(flags, "symbol");
  const direction = requireFlag(flags, "direction");
  if (!DIRECTION_VALUES.has(direction)) {
    throw new Error(`--direction 必须是 bull/bear/neutral 之一，收到：${direction}。`);
  }

  const targetLow = parseOptionalNumber(flags, "target-low");
  const targetHigh = parseOptionalNumber(flags, "target-high");
  const invalidationPrice = parseOptionalNumber(flags, "invalidation");
  const bullPoints = parsePoints(flags.bull);
  const bearPoints = parsePoints(flags.bear);

  let visibility;
  if (flags.visibility !== undefined) {
    visibility = String(flags.visibility).trim();
    if (!VISIBILITY_VALUES.has(visibility)) {
      throw new Error(`--visibility 必须是 system/public 之一，收到：${visibility}。`);
    }
  }

  return withDb(options, async (db) => {
    requireActiveMember(db, ownerId);

    const thesis = createThesis(db, {
      ownerId,
      symbol,
      direction,
      ...(targetLow !== undefined ? { targetLow } : {}),
      ...(targetHigh !== undefined ? { targetHigh } : {}),
      ...(invalidationPrice !== undefined ? { invalidationPrice } : {}),
      bullPoints,
      bearPoints,
      ...(visibility !== undefined ? { visibility } : {})
    });

    const mirror = await mirrorRecord(resolveBackend(options), {
      ownerId,
      recordType: "thesis",
      title: `${symbol} ${direction} 论点`,
      content: JSON.stringify({
        targetLow: thesis.targetLow,
        targetHigh: thesis.targetHigh,
        invalidationPrice: thesis.invalidationPrice,
        bullPoints: thesis.bullPoints,
        bearPoints: thesis.bearPoints
      }),
      visibility: thesis.visibility
    });

    // Mirror succeeded and returned an id -> back-fill memory_slug so a
    // later reader can cross-reference the SQL row to its memoryd mirror.
    // Mirror degradation (mirrored:false, or ok but no memoryId) never
    // blocks or unwinds the already-committed thesis row above.
    const final = mirror.mirrored && mirror.memoryId ? setThesisMemorySlug(db, thesis.id, ownerId, mirror.memoryId) : thesis;

    new AuditLogRepository(db).write("strategy_memory", "thesis create", {
      thesisId: final.id,
      ownerId,
      symbol,
      direction,
      mirrored: mirror.mirrored
    });

    return { ok: true, thesis: final, mirror };
  });
}

export async function runThesisJudge(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const thesisId = requireFlag(flags, "thesis");
  const note = requireFlag(flags, "note");
  const source = flags.source !== undefined && String(flags.source).trim() ? String(flags.source).trim() : "self";

  return withDb(options, async (db) => {
    const thesis = getThesisById(db, thesisId);
    if (!thesis) {
      throw new Error(`未找到论点：${thesisId}。`);
    }
    if (thesis.ownerId !== ownerId) {
      throw new Error(`非本人操作被拒：该论点属于 ${thesis.ownerId}，操作者 ${ownerId} 无权添加判断。`);
    }

    const judgment = appendThesisJudgment(db, thesisId, { note, source });

    const mirror = await mirrorRecord(resolveBackend(options), {
      ownerId,
      recordType: "thesis_judgment",
      title: `${thesis.symbol} 判断更新`,
      content: note,
      visibility: thesis.visibility
    });

    new AuditLogRepository(db).write("strategy_memory", "thesis judge", {
      thesisId,
      ownerId,
      judgmentId: judgment.id,
      mirrored: mirror.mirrored
    });

    return { ok: true, judgment, mirror };
  });
}

export async function runThesisPromote(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const thesisId = requireFlag(flags, "thesis");

  return withDb(options, async (db) => {
    const thesis = promoteThesisVisibility(db, thesisId, ownerId);

    new AuditLogRepository(db).write("strategy_memory", "thesis promote", { thesisId, ownerId });

    return { ok: true, thesis };
  });
}

export async function runThesisWithdraw(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const thesisId = requireFlag(flags, "thesis");

  return withDb(options, async (db) => {
    const thesis = withdrawThesis(db, thesisId, ownerId);

    new AuditLogRepository(db).write("strategy_memory", "thesis withdraw", { thesisId, ownerId });

    return { ok: true, thesis };
  });
}

// Deterministic keyword scan over the conclusion box's coreConclusion text -
// NOT an AI/LLM call. "看多/看涨/买入/增持/做多" -> bull, "看空/看跌/卖出/
// 减持/做空" -> bear, anything else (including no match at all) -> neutral
// (never guessed beyond this fixed keyword list; a report author who wants a
// directional thesis captured accurately should use one of these words in
// their 核心结论, or the owner can `thesis create`/re-judge manually
// afterward - this command only DRAFTS the thesis).
const BULL_KEYWORDS = ["看多", "看涨", "买入", "增持", "做多"];
const BEAR_KEYWORDS = ["看空", "看跌", "卖出", "减持", "做空"];

function inferDirectionFromConclusion(coreConclusion) {
  const text = String(coreConclusion ?? "");
  if (BULL_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return "bull";
  }
  if (BEAR_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return "bear";
  }
  return "neutral";
}

// Best-effort extraction of the FIRST numeric value out of the conclusion
// box's free-text 复盘触发 (review-trigger) string, e.g. "跌破 190 美元" ->
// 190. Returns undefined (never guessed) if no digit sequence is present at
// all - invalidation_price stays unset on the drafted thesis in that case,
// which the DDL allows (it is a nullable column).
function extractNumericPrice(text) {
  const match = String(text ?? "").match(/(\d+(?:\.\d+)?)/u);
  return match ? Number(match[1]) : undefined;
}

// Scopes a whole report document down to ONE `## <symbol>` section, the
// same "caller must pre-scope to one symbol's section" contract
// parseConclusionBox's own doc comment requires. Matches a heading line
// starting with `## <symbol>` followed by whitespace/end-of-line (so
// "## AAPL.US 苹果" matches for symbol "AAPL.US", but "## AAPL.USD" does
// not); the section runs until the next top-level `## ` heading, or end of
// document. Returns null if no such heading exists at all.
function extractSymbolSection(reportText, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escaped}(?:\\s.*)?$`, "mu");
  const match = reportText.match(headingPattern);
  if (!match) {
    return null;
  }
  const rest = reportText.slice(match.index + match[0].length);
  const nextHeadingMatch = rest.match(/\n##\s+/u);
  return nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
}

export async function runThesisFromConclusion(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const reportPath = requireFlag(flags, "report");
  const symbol = requireFlag(flags, "symbol");

  let reportText;
  try {
    reportText = readFileSync(reportPath, "utf8");
  } catch {
    throw new Error(`找不到复盘报告文件：${reportPath}。`);
  }

  const section = extractSymbolSection(reportText, symbol);
  if (section === null) {
    throw new Error(`报告中未找到 ${symbol} 的分析小节（未找到 "## ${symbol}"）：${reportPath}。`);
  }

  const parsed = parseConclusionBox(section);
  if (!parsed) {
    throw new Error(`结论框解析失败，无法从报告草拟论点：${symbol}（${reportPath}）。`);
  }

  const direction = inferDirectionFromConclusion(parsed.coreConclusion);
  const invalidationPrice = extractNumericPrice(parsed.reviewTrigger);

  return withDb(options, async (db) => {
    requireActiveMember(db, ownerId);

    const thesis = createThesis(db, {
      ownerId,
      symbol,
      direction,
      targetLow: parsed.valueRange.low,
      targetHigh: parsed.valueRange.high,
      ...(invalidationPrice !== undefined ? { invalidationPrice } : {})
    });

    const backend = resolveBackend(options);
    const thesisMirror = await mirrorRecord(backend, {
      ownerId,
      recordType: "thesis",
      title: `${symbol} ${direction} 论点（源自复盘结论框）`,
      content: JSON.stringify({
        targetLow: thesis.targetLow,
        targetHigh: thesis.targetHigh,
        invalidationPrice: thesis.invalidationPrice,
        source: reportPath
      }),
      visibility: thesis.visibility
    });

    const final =
      thesisMirror.mirrored && thesisMirror.memoryId
        ? setThesisMemorySlug(db, thesis.id, ownerId, thesisMirror.memoryId)
        : thesis;

    const judgment = appendThesisJudgment(db, thesis.id, {
      note: parsed.coreConclusion,
      source: "conclusion_box"
    });

    const judgmentMirror = await mirrorRecord(backend, {
      ownerId,
      recordType: "thesis_judgment",
      title: `${symbol} 判断更新（源自复盘结论框）`,
      content: parsed.coreConclusion,
      visibility: thesis.visibility
    });

    new AuditLogRepository(db).write("strategy_memory", "thesis from-conclusion", {
      thesisId: final.id,
      ownerId,
      symbol,
      direction,
      reportPath,
      mirrored: thesisMirror.mirrored
    });

    return {
      ok: true,
      thesis: final,
      judgment,
      mirror: { thesis: thesisMirror, judgment: judgmentMirror },
      source: "conclusion_box"
    };
  });
}

// ---------------------------------------------------------------------------
// rule (discipline)
// ---------------------------------------------------------------------------

export async function runRuleCreate(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const ruleText = requireFlag(flags, "text");
  const enforcement = requireFlag(flags, "enforcement");
  if (!ENFORCEMENT_VALUES.has(enforcement)) {
    throw new Error(`--enforcement 必须是 hard/proposal_check/self 之一，收到：${enforcement}。`);
  }
  const linkedStrategy = flags.strategy !== undefined ? String(flags.strategy).trim() || undefined : undefined;

  return withDb(options, async (db) => {
    requireActiveMember(db, ownerId);

    const rule = createRule(db, { ownerId, ruleText, enforcement, linkedStrategy });

    // discipline_rules has no visibility tier of its own (it is always a
    // personal/self-enforcement record, never published to the member
    // circle) - "system" is used purely as the memoryd tag label here, not
    // a read column on this table.
    const mirror = await mirrorRecord(resolveBackend(options), {
      ownerId,
      recordType: "discipline_rule",
      title: `纪律规则：${ruleText}`,
      content: JSON.stringify({ enforcement, linkedStrategy: rule.linkedStrategy }),
      visibility: "system"
    });

    new AuditLogRepository(db).write("strategy_memory", "rule create", {
      ruleId: rule.id,
      ownerId,
      enforcement,
      mirrored: mirror.mirrored
    });

    return { ok: true, rule, mirror };
  });
}

export async function runRuleDisable(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const ruleId = requireFlag(flags, "rule");

  return withDb(options, async (db) => {
    const rule = disableRule(db, ruleId, ownerId);

    new AuditLogRepository(db).write("strategy_memory", "rule disable", { ruleId, ownerId });

    return { ok: true, rule };
  });
}

export async function runRuleEnable(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const ruleId = requireFlag(flags, "rule");

  return withDb(options, async (db) => {
    const rule = enableRule(db, ruleId, ownerId);

    new AuditLogRepository(db).write("strategy_memory", "rule enable", { ruleId, ownerId });

    return { ok: true, rule };
  });
}

// Read-only - no audit_log row, matching members.mjs's runList convention.
export async function runRuleList(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");

  return withDb(options, (db) => ({ ok: true, rules: listRulesForOwner(db, ownerId) }));
}

// ---------------------------------------------------------------------------
// card (strategy cards / playbooks)
// ---------------------------------------------------------------------------

export async function runCardCreate(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const name = requireFlag(flags, "name");
  const scene = requireFlag(flags, "scene");
  const entry = requireFlag(flags, "entry");
  const risk = requireFlag(flags, "risk");
  const exit = requireFlag(flags, "exit");

  let visibility;
  if (flags.visibility !== undefined) {
    visibility = String(flags.visibility).trim();
    if (!VISIBILITY_VALUES.has(visibility)) {
      throw new Error(`--visibility 必须是 system/public 之一，收到：${visibility}。`);
    }
  }

  return withDb(options, async (db) => {
    requireActiveMember(db, ownerId);

    const card = createCard(db, {
      ownerId,
      name,
      scene,
      entryCondition: entry,
      riskControl: risk,
      exitRule: exit,
      ...(visibility !== undefined ? { visibility } : {})
    });

    const mirror = await mirrorRecord(resolveBackend(options), {
      ownerId,
      recordType: "strategy_card",
      title: name,
      content: JSON.stringify({ scene: card.scene, entry: card.entryCondition, risk: card.riskControl, exit: card.exitRule }),
      visibility: card.visibility
    });

    new AuditLogRepository(db).write("strategy_memory", "card create", {
      cardId: card.id,
      ownerId,
      mirrored: mirror.mirrored
    });

    return { ok: true, card, mirror };
  });
}

export async function runCardStatus(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const cardId = requireFlag(flags, "card");
  const to = requireFlag(flags, "to");
  if (!CARD_STATUS_VALUES.has(to)) {
    throw new Error(`--to 必须是 active/paused/retired 之一，收到：${to}。`);
  }

  return withDb(options, async (db) => {
    const card = setStatus(db, cardId, ownerId, to);

    new AuditLogRepository(db).write("strategy_memory", "card status", { cardId, ownerId, status: to });

    return { ok: true, card };
  });
}

export async function runCardPromote(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const cardId = requireFlag(flags, "card");

  return withDb(options, async (db) => {
    const card = promoteVisibility(db, cardId, ownerId);

    new AuditLogRepository(db).write("strategy_memory", "card promote", { cardId, ownerId });

    return { ok: true, card };
  });
}

// Read-only - no audit_log row.
export async function runCardList(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");

  return withDb(options, (db) => ({ ok: true, cards: listCardsForOwner(db, ownerId) }));
}

// getCardById is imported for parity/future use by callers wanting a single
// card lookup (e.g. tests, a future bearer API) without going through
// listCardsForOwner - re-exported so it is not an unused import.
export { getCardById };

const COMMANDS = {
  "thesis create": runThesisCreate,
  "thesis judge": runThesisJudge,
  "thesis promote": runThesisPromote,
  "thesis withdraw": runThesisWithdraw,
  "thesis from-conclusion": runThesisFromConclusion,
  "rule create": runRuleCreate,
  "rule disable": runRuleDisable,
  "rule enable": runRuleEnable,
  "rule list": runRuleList,
  "card create": runCardCreate,
  "card status": runCardStatus,
  "card promote": runCardPromote,
  "card list": runCardList
};

export async function runStrategyCommand(command, flags, options = {}) {
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`未知子命令：${command || "(空)"}，仅支持 ${Object.keys(COMMANDS).join("/")}。`);
  }
  return handler(flags, options);
}

// Same pre-dispatch-through-dispatch-in-one-try/catch shape as
// members.mjs/proposals.mjs's buildCliResult: this CLI's binding contract is
// always exactly one line of JSON on stdout, so nothing (an unknown flag, an
// unknown command, a validation error) may escape as a raw stack trace.
export async function buildCliResult(argv, options = {}) {
  try {
    const command = resolveCommand(argv);
    const rest = argv.slice(command ? command.split(" ").length : 0);
    const flags = parseFlags(rest, command);
    // STRATEGY_DB_PATH mirrors members.mjs's MEMBERS_DB_PATH: unset (and a
    // no-op) in normal operation, where the real runtime/trading.sqlite is
    // used; lets a live/manual verification run this exact binary against a
    // disposable temp db instead.
    const dbPath = options.dbPath ?? process.env.STRATEGY_DB_PATH ?? resolveRuntimePaths(repoRoot).dbPath;
    return await runStrategyCommand(command, flags, { ...options, dbPath });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const result = await buildCliResult(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
