// SQLite repository for the strategy-memory tables (schema v12, Phase 7 Task 1
// - see packages/shared-types/src/database.ts's v12 migration step comment):
// `theses` (+ its append-only `thesis_history` child), `discipline_rules`, and
// `strategy_cards`. Follows this codebase's established store conventions
// (market-alerts-store.mjs / stock-facts-store.mjs): ALL camelCase <->
// snake_case mapping and JSON encode/decode lives here; callers (the future
// strategy.mjs CLI, Task 3; the future bearer-gated write API, Task 4) never
// touch SQL or JSON.stringify/parse directly.
//
// Three binding invariants from the plan's Global Constraints, enforced here:
//   - "全部 owner 归属" - every write that mutates an existing row (promote/
//     withdraw/disable/enable/setStatus/setThesisMemorySlug) re-fetches the
//     row and rejects a caller-supplied ownerId that does not match the
//     row's own owner_id. This is application-level ownership enforcement -
//     the DDL has no way to express "only the owner may flip this column".
//   - "判断历史 append-only" - thesis_history has an INSERT helper
//     (appendThesisJudgment) and a read helper (listThesisJudgments) and
//     DELIBERATELY NO delete/update export of any kind. A correction is
//     always a NEW judgment row, never an edit or removal of a prior one.
//   - "规则/论点/策略卡可停用不可删" - discipline_rules has disableRule (sets
//     enabled=0 + disabled_at) instead of a delete; theses has withdrawThesis
//     (status -> 'withdrawn') instead of a delete; strategy_cards has
//     setStatus('retired') instead of a delete. None of the three tables get
//     a delete/remove export from this module.
//
// Visibility promotion (theses.visibility / strategy_cards.visibility) is a
// ONE-WAY, single-step ratchet for both tables today: 'system' -> 'public'
// only (neither table has a 'private' tier - see the plan's Global
// Constraints: "私有...theses/strategy_cards 无此档"). Promoting an
// already-public row is idempotent (returns the row unchanged, does not
// throw) - re-clicking "公开" in a future UI must never be an error.

import { createId, nowIso } from "../../../packages/shared-types/dist/index.js";

// ---------------------------------------------------------------------------
// ThesisStore
// ---------------------------------------------------------------------------

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   ownerId: string, symbol: string, direction: 'bull'|'bear'|'neutral',
 *   targetLow?: number, targetHigh?: number, invalidationPrice?: number,
 *   bullPoints?: string[], bearPoints?: string[], visibility?: 'system'|'public'
 * }} input
 */
export function createThesis(db, input) {
  const id = createId("thesis");
  const now = nowIso();
  const visibility = input.visibility ?? "system";
  const bullPoints = input.bullPoints ?? [];
  const bearPoints = input.bearPoints ?? [];

  db.prepare(`
    INSERT INTO theses
    (id, owner_id, symbol, direction, target_low, target_high, invalidation_price,
     visibility, status, memory_slug, created_at, updated_at, bull_points, bear_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)
  `).run(
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

  return getThesisById(db, id);
}

export function getThesisById(db, thesisId) {
  const row = db.prepare(`SELECT * FROM theses WHERE id = ?`).get(thesisId);
  return row ? mapThesisRow(row) : null;
}

function requireThesis(db, thesisId) {
  const thesis = getThesisById(db, thesisId);
  if (!thesis) {
    throw new Error(`未找到论点 ${thesisId}`);
  }
  return thesis;
}

function assertOwner(record, ownerId, label) {
  if (record.ownerId !== ownerId) {
    throw new Error(`无权操作：${label} ${record.id} 属于其他成员，当前操作者 ${ownerId} 不是所有者`);
  }
}

/**
 * Append-only judgment log for one thesis. NO corresponding delete/update
 * export exists anywhere in this module - a correction is always a NEW
 * judgment row (source can carry e.g. 'correction' or a conclusion-box ref),
 * never an edit or removal of a prior one.
 *
 * Deliberately takes NO ownerId param (per the plan's own Task 1 interface
 * spec: `appendThesisJudgment(db, thesisId, {note, source})`) - the owner
 * check for this action lives in the CLI layer (Task 3: "thesis judge
 * --owner --thesis <id> ... （owner 校验）→ appendThesisJudgment"), not here.
 * thesisId must reference a real thesis - thesis_history.thesis_id is a NOT
 * NULL FK to theses(id), so an unknown id throws a FOREIGN KEY error from
 * SQLite itself rather than silently no-opping.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} thesisId
 * @param {{note: string, source: string}} input
 */
export function appendThesisJudgment(db, thesisId, input) {
  const id = createId("thesis_hist");
  const now = nowIso();
  db.prepare(`
    INSERT INTO thesis_history (id, thesis_id, note, source, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, thesisId, input.note, input.source, now);

  return { id, thesisId, note: input.note, source: input.source, createdAt: now };
}

/** Oldest-first (a timeline reads top-to-bottom as "what happened, in
 * order" - matches strategy.ts's loadThesisHistory convention). */
export function listThesisJudgments(db, thesisId) {
  const rows = db
    .prepare(`SELECT * FROM thesis_history WHERE thesis_id = ? ORDER BY created_at ASC`)
    .all(thesisId);
  return rows.map(mapThesisHistoryRow);
}

/**
 * system -> public only (theses have no 'private' tier). Non-owner: rejected.
 * Already public: idempotent no-op (returns the row unchanged, does not
 * throw - re-promoting must never be an error).
 */
export function promoteThesisVisibility(db, thesisId, ownerId) {
  const thesis = requireThesis(db, thesisId);
  assertOwner(thesis, ownerId, "论点");

  if (thesis.visibility === "public") {
    return thesis;
  }

  const now = nowIso();
  db.prepare(`UPDATE theses SET visibility = 'public', updated_at = ? WHERE id = ?`).run(now, thesisId);
  return getThesisById(db, thesisId);
}

/** status -> 'withdrawn'. History (thesis_history) is untouched - "降档不回
 * 收已生成历史" (withdrawing never retroactively erases what was already
 * recorded). Idempotent: withdrawing an already-withdrawn thesis is a no-op. */
export function withdrawThesis(db, thesisId, ownerId) {
  const thesis = requireThesis(db, thesisId);
  assertOwner(thesis, ownerId, "论点");

  if (thesis.status === "withdrawn") {
    return thesis;
  }

  const now = nowIso();
  db.prepare(`UPDATE theses SET status = 'withdrawn', updated_at = ? WHERE id = ?`).run(now, thesisId);
  return getThesisById(db, thesisId);
}

export function setThesisMemorySlug(db, thesisId, ownerId, slug) {
  const thesis = requireThesis(db, thesisId);
  assertOwner(thesis, ownerId, "论点");

  const now = nowIso();
  db.prepare(`UPDATE theses SET memory_slug = ?, updated_at = ? WHERE id = ?`).run(slug, now, thesisId);
  return getThesisById(db, thesisId);
}

function mapThesisRow(row) {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    symbol: String(row.symbol),
    direction: String(row.direction),
    targetLow: row.target_low === null || row.target_low === undefined ? null : Number(row.target_low),
    targetHigh: row.target_high === null || row.target_high === undefined ? null : Number(row.target_high),
    invalidationPrice:
      row.invalidation_price === null || row.invalidation_price === undefined
        ? null
        : Number(row.invalidation_price),
    visibility: String(row.visibility),
    status: String(row.status),
    memorySlug: row.memory_slug ?? null,
    bullPoints: decodeJsonArray(row.bull_points),
    bearPoints: decodeJsonArray(row.bear_points),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapThesisHistoryRow(row) {
  return {
    id: String(row.id),
    thesisId: String(row.thesis_id),
    note: String(row.note),
    source: String(row.source),
    createdAt: String(row.created_at)
  };
}

// ---------------------------------------------------------------------------
// DisciplineStore
// ---------------------------------------------------------------------------

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ownerId: string, ruleText: string, enforcement: 'hard'|'proposal_check'|'self', linkedStrategy?: string}} input
 */
export function createRule(db, input) {
  const id = createId("discipline_rule");
  const now = nowIso();
  db.prepare(`
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, linked_strategy, enabled, created_at, disabled_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
  `).run(id, input.ownerId, input.ruleText, input.enforcement, input.linkedStrategy ?? null, now);

  return getRuleById(db, id);
}

export function getRuleById(db, ruleId) {
  const row = db.prepare(`SELECT * FROM discipline_rules WHERE id = ?`).get(ruleId);
  return row ? mapRuleRow(row) : null;
}

function requireRule(db, ruleId) {
  const rule = getRuleById(db, ruleId);
  if (!rule) {
    throw new Error(`未找到纪律规则 ${ruleId}`);
  }
  return rule;
}

/** enabled=0 + disabled_at set - NEVER a delete (discipline-engine.mjs's
 * evaluateDiscipline reads `WHERE enabled = 1`, so this is sufficient to stop
 * enforcement while keeping the row, and every rule referenced by
 * discipline_report history stays resolvable). Idempotent: disabling an
 * already-disabled rule is a no-op that preserves the ORIGINAL disabled_at
 * rather than overwriting it with a later timestamp. */
export function disableRule(db, ruleId, ownerId) {
  const rule = requireRule(db, ruleId);
  assertOwner(rule, ownerId, "纪律规则");

  if (!rule.enabled) {
    return rule;
  }

  const now = nowIso();
  db.prepare(`UPDATE discipline_rules SET enabled = 0, disabled_at = ? WHERE id = ?`).run(now, ruleId);
  return getRuleById(db, ruleId);
}

/** Re-arms a disabled rule: enabled=1, disabled_at cleared. Idempotent on an
 * already-enabled rule. */
export function enableRule(db, ruleId, ownerId) {
  const rule = requireRule(db, ruleId);
  assertOwner(rule, ownerId, "纪律规则");

  if (rule.enabled) {
    return rule;
  }

  db.prepare(`UPDATE discipline_rules SET enabled = 1, disabled_at = NULL WHERE id = ?`).run(ruleId);
  return getRuleById(db, ruleId);
}

/** Includes disabled rules too (each row is flagged via its own `enabled`
 * field) - unlike market-alerts-store.mjs's listEnabledRules, this is the
 * owner-facing "everything I have" view (plan: "listRulesForOwner（含停
 * 用，标注）"), not the engine's enforcement-time filter. */
export function listRulesForOwner(db, ownerId) {
  const rows = db
    .prepare(`SELECT * FROM discipline_rules WHERE owner_id = ? ORDER BY created_at ASC`)
    .all(ownerId);
  return rows.map(mapRuleRow);
}

function mapRuleRow(row) {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ruleText: String(row.rule_text),
    enforcement: String(row.enforcement),
    linkedStrategy: row.linked_strategy ?? null,
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    disabledAt: row.disabled_at ?? null
  };
}

// ---------------------------------------------------------------------------
// StrategyCardStore
// ---------------------------------------------------------------------------

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   ownerId: string, name: string, scene?: string, entryCondition?: string,
 *   riskControl?: string, exitRule?: string, visibility?: 'system'|'public'
 * }} input
 */
export function createCard(db, input) {
  const id = createId("strategy_card");
  const now = nowIso();
  const visibility = input.visibility ?? "system";

  db.prepare(`
    INSERT INTO strategy_cards
    (id, owner_id, name, scene, entry_condition, risk_control, exit_rule, status, visibility, memory_slug, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)
  `).run(
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

  return getCardById(db, id);
}

export function getCardById(db, cardId) {
  const row = db.prepare(`SELECT * FROM strategy_cards WHERE id = ?`).get(cardId);
  return row ? mapCardRow(row) : null;
}

function requireCard(db, cardId) {
  const card = getCardById(db, cardId);
  if (!card) {
    throw new Error(`未找到策略卡 ${cardId}`);
  }
  return card;
}

/** active|paused|retired - 'retired' is this table's non-destructive stand-in
 * for delete (no delete/remove export exists on strategy_cards either). */
export function setStatus(db, cardId, ownerId, status) {
  const card = requireCard(db, cardId);
  assertOwner(card, ownerId, "策略卡");

  const now = nowIso();
  db.prepare(`UPDATE strategy_cards SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, cardId);
  return getCardById(db, cardId);
}

/** system -> public only, non-owner rejected, already-public idempotent -
 * same ratchet semantics as promoteThesisVisibility above. */
export function promoteVisibility(db, cardId, ownerId) {
  const card = requireCard(db, cardId);
  assertOwner(card, ownerId, "策略卡");

  if (card.visibility === "public") {
    return card;
  }

  const now = nowIso();
  db.prepare(`UPDATE strategy_cards SET visibility = 'public', updated_at = ? WHERE id = ?`).run(now, cardId);
  return getCardById(db, cardId);
}

/** Every card owned by ownerId, any status/visibility - the owner's own
 * "everything I have" view (mirrors loadOwnTheses's "本人全见" convention in
 * strategy.ts). */
export function listCardsForOwner(db, ownerId) {
  const rows = db
    .prepare(`SELECT * FROM strategy_cards WHERE owner_id = ? ORDER BY created_at DESC`)
    .all(ownerId);
  return rows.map(mapCardRow);
}

/** OTHER owners' `public` cards only - `visibility = 'public' AND owner_id
 * != ?` is enforced in the WHERE clause itself (server-side isolation, per
 * the plan's Global Constraint "隔离在 SQL 层"), never filtered in JS after
 * an unfiltered fetch. */
export function listPublicCards(db, excludeOwnerId) {
  const rows = db
    .prepare(`SELECT * FROM strategy_cards WHERE visibility = 'public' AND owner_id != ? ORDER BY created_at DESC`)
    .all(excludeOwnerId);
  return rows.map(mapCardRow);
}

function mapCardRow(row) {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    scene: row.scene ?? null,
    entryCondition: row.entry_condition ?? null,
    riskControl: row.risk_control ?? null,
    exitRule: row.exit_rule ?? null,
    status: String(row.status),
    visibility: String(row.visibility),
    memorySlug: row.memory_slug ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function decodeJsonArray(raw) {
  if (raw === null || raw === undefined) {
    return [];
  }
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
