/**
 * Platform-side WRITE port for the strategy-memory tables (Phase 7 Task 4 -
 * see docs/superpowers/plans/2026-07-15-phase7-strategy-memory.md).
 *
 * This is a from-scratch TypeScript RE-IMPLEMENTATION of a SUBSET of
 * apps/openclaw-config/scripts/strategy-store.mjs's exports (T1) - NOT an
 * import. apps/openclaw-config/scripts is plain .mjs with no build step/dist
 * of its own, and this app's established convention (data/news.ts's own
 * header comment; routes/stock.ts's `normalizeStockSymbol`) is to re-declare
 * a source-of-truth SQL shape locally, with a comment pointing back at the
 * original, rather than reach across an app boundary from production code
 * (test-only exceptions, e.g. routes/news.seam.test.ts, are excluded from
 * this app's tsconfig project and don't count). Any change to the SQL/
 * semantics of createThesis / appendThesisJudgment /
 * promoteThesisVisibilityToPublic (system -> public) / createRule /
 * disableRule / createCard here MUST be mirrored in strategy-store.mjs (or
 * vice versa).
 *
 * Ownership enforcement for a mutation on an EXISTING row (promote/disable)
 * is intentionally NOT duplicated in this module - the bearer-gated route
 * (routes/api-strategy.ts) already resolves the row and compares
 * `row.ownerId === identity.id` itself BEFORE calling into these functions
 * (the same "resolve row first, compare owner, 403 on mismatch" discipline
 * already established by routes/proposal.ts / routes/research.ts), so these
 * functions trust the caller has already authorized the write. This mirrors
 * strategy-store.mjs's own documented split for `appendThesisJudgment`
 * (which also takes no ownerId, by the same design), generalized here to
 * every mutator on an existing row.
 *
 * `theses`/`discipline_rules`/`strategy_cards` never get a delete/remove
 * export from this module either, for the same "可停用不可删" reason
 * strategy-store.mjs documents on its own exports.
 */
import type { DatabaseSync } from "node:sqlite";

import { createId, nowIso } from "@packages/shared-types";

export type ThesisDirection = "bull" | "bear" | "neutral";
export type StrategyVisibility = "system" | "public";
export type DisciplineEnforcement = "hard" | "proposal_check" | "self";

export interface ThesisRecord {
  id: string;
  ownerId: string;
  symbol: string;
  direction: ThesisDirection;
  targetLow: number | null;
  targetHigh: number | null;
  invalidationPrice: number | null;
  visibility: StrategyVisibility;
  status: string;
  memorySlug: string | null;
  bullPoints: string[];
  bearPoints: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ThesisJudgmentRecord {
  id: string;
  thesisId: string;
  note: string;
  source: string;
  createdAt: string;
}

export interface DisciplineRuleRecord {
  id: string;
  ownerId: string;
  ruleText: string;
  enforcement: DisciplineEnforcement;
  linkedStrategy: string | null;
  enabled: boolean;
  createdAt: string;
  disabledAt: string | null;
}

export interface StrategyCardRecord {
  id: string;
  ownerId: string;
  name: string;
  scene: string | null;
  entryCondition: string | null;
  riskControl: string | null;
  exitRule: string | null;
  status: string;
  visibility: StrategyVisibility;
  memorySlug: string | null;
  createdAt: string;
  updatedAt: string;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function decodeJsonArray(raw: unknown): string[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// theses / thesis_history
// ---------------------------------------------------------------------------

function mapThesisRow(row: Record<string, unknown>): ThesisRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    symbol: String(row.symbol),
    direction: row.direction as ThesisDirection,
    targetLow: nullableNumber(row.target_low),
    targetHigh: nullableNumber(row.target_high),
    invalidationPrice: nullableNumber(row.invalidation_price),
    visibility: row.visibility as StrategyVisibility,
    status: String(row.status),
    memorySlug: nullableString(row.memory_slug),
    bullPoints: decodeJsonArray(row.bull_points),
    bearPoints: decodeJsonArray(row.bear_points),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function getThesisById(db: DatabaseSync, thesisId: string): ThesisRecord | null {
  const row = db.prepare(`SELECT * FROM theses WHERE id = ?`).get(thesisId) as Record<string, unknown> | undefined;
  return row ? mapThesisRow(row) : null;
}

export interface CreateThesisInput {
  ownerId: string;
  symbol: string;
  direction: ThesisDirection;
  targetLow?: number;
  targetHigh?: number;
  invalidationPrice?: number;
  bullPoints?: string[];
  bearPoints?: string[];
  visibility?: StrategyVisibility;
}

export function createThesis(db: DatabaseSync, input: CreateThesisInput): ThesisRecord {
  const id = createId("thesis");
  const now = nowIso();
  const visibility = input.visibility ?? "system";
  const bullPoints = input.bullPoints ?? [];
  const bearPoints = input.bearPoints ?? [];

  db.prepare(
    `
    INSERT INTO theses
    (id, owner_id, symbol, direction, target_low, target_high, invalidation_price,
     visibility, status, memory_slug, created_at, updated_at, bull_points, bear_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)
  `
  ).run(
    id,
    input.ownerId,
    input.symbol,
    input.direction,
    input.targetLow ?? null,
    input.targetHigh ?? null,
    input.invalidationPrice ?? null,
    visibility,
    now,
    now,
    JSON.stringify(bullPoints),
    JSON.stringify(bearPoints)
  );

  return getThesisById(db, id) as ThesisRecord;
}

/** Append-only judgment log entry - no corresponding update/delete export
 * exists anywhere in this module (mirrors strategy-store.mjs's own
 * invariant). Takes no ownerId - see module header. */
export function appendThesisJudgment(
  db: DatabaseSync,
  thesisId: string,
  input: { note: string; source: string }
): ThesisJudgmentRecord {
  const id = createId("thesis_hist");
  const now = nowIso();
  db.prepare(
    `INSERT INTO thesis_history (id, thesis_id, note, source, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, thesisId, input.note, input.source, now);

  return { id, thesisId, note: input.note, source: input.source, createdAt: now };
}

/** system -> public only (theses have no 'private' tier); idempotent if
 * already public. Caller has already verified ownership - see module
 * header. Throws if thesisId doesn't resolve to a row (caller is expected to
 * have already 404'd on a missing row before reaching here too). */
export function promoteThesisVisibilityToPublic(db: DatabaseSync, thesisId: string): ThesisRecord {
  const thesis = getThesisById(db, thesisId);
  if (!thesis) {
    throw new Error(`未找到论点 ${thesisId}`);
  }
  if (thesis.visibility === "public") {
    return thesis;
  }

  const now = nowIso();
  db.prepare(`UPDATE theses SET visibility = 'public', updated_at = ? WHERE id = ?`).run(now, thesisId);
  return getThesisById(db, thesisId) as ThesisRecord;
}

// ---------------------------------------------------------------------------
// discipline_rules
// ---------------------------------------------------------------------------

function mapRuleRow(row: Record<string, unknown>): DisciplineRuleRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ruleText: String(row.rule_text),
    enforcement: row.enforcement as DisciplineEnforcement,
    linkedStrategy: nullableString(row.linked_strategy),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    disabledAt: nullableString(row.disabled_at)
  };
}

export function getRuleById(db: DatabaseSync, ruleId: string): DisciplineRuleRecord | null {
  const row = db.prepare(`SELECT * FROM discipline_rules WHERE id = ?`).get(ruleId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRuleRow(row) : null;
}

export interface CreateRuleInput {
  ownerId: string;
  ruleText: string;
  enforcement: DisciplineEnforcement;
  linkedStrategy?: string;
}

export function createRule(db: DatabaseSync, input: CreateRuleInput): DisciplineRuleRecord {
  const id = createId("discipline_rule");
  const now = nowIso();
  db.prepare(
    `
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, linked_strategy, enabled, created_at, disabled_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
  `
  ).run(id, input.ownerId, input.ruleText, input.enforcement, input.linkedStrategy ?? null, now);

  return getRuleById(db, id) as DisciplineRuleRecord;
}

/** enabled=0 + disabled_at set - never a delete. Idempotent: disabling an
 * already-disabled rule is a no-op that preserves the original disabled_at.
 * Caller has already verified ownership - see module header. */
export function disableRule(db: DatabaseSync, ruleId: string): DisciplineRuleRecord {
  const rule = getRuleById(db, ruleId);
  if (!rule) {
    throw new Error(`未找到纪律规则 ${ruleId}`);
  }
  if (!rule.enabled) {
    return rule;
  }

  const now = nowIso();
  db.prepare(`UPDATE discipline_rules SET enabled = 0, disabled_at = ? WHERE id = ?`).run(now, ruleId);
  return getRuleById(db, ruleId) as DisciplineRuleRecord;
}

// ---------------------------------------------------------------------------
// strategy_cards
// ---------------------------------------------------------------------------

function mapCardRow(row: Record<string, unknown>): StrategyCardRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    scene: nullableString(row.scene),
    entryCondition: nullableString(row.entry_condition),
    riskControl: nullableString(row.risk_control),
    exitRule: nullableString(row.exit_rule),
    status: String(row.status),
    visibility: row.visibility as StrategyVisibility,
    memorySlug: nullableString(row.memory_slug),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function getCardById(db: DatabaseSync, cardId: string): StrategyCardRecord | null {
  const row = db.prepare(`SELECT * FROM strategy_cards WHERE id = ?`).get(cardId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapCardRow(row) : null;
}

export interface CreateCardInput {
  ownerId: string;
  name: string;
  scene?: string;
  entryCondition?: string;
  riskControl?: string;
  exitRule?: string;
  visibility?: StrategyVisibility;
}

export function createCard(db: DatabaseSync, input: CreateCardInput): StrategyCardRecord {
  const id = createId("strategy_card");
  const now = nowIso();
  const visibility = input.visibility ?? "system";

  db.prepare(
    `
    INSERT INTO strategy_cards
    (id, owner_id, name, scene, entry_condition, risk_control, exit_rule, status, visibility, memory_slug, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)
  `
  ).run(
    id,
    input.ownerId,
    input.name,
    input.scene ?? null,
    input.entryCondition ?? null,
    input.riskControl ?? null,
    input.exitRule ?? null,
    visibility,
    now,
    now
  );

  return getCardById(db, id) as StrategyCardRecord;
}
