/**
 * Strategy-memory READ layer (Phase 7 Task 5, 2026-07-15 plan) shared by
 * routes/strategy.ts, routes/member-card.ts, and routes/stock.ts: theses
 * (now carrying bull_points/bear_points evidence), strategy_cards, the
 * append-only thesis_history timeline, the deterministic post-hoc outcome
 * backtest, and the 近30天遵守 discipline compliance statistic.
 *
 * VISIBILITY ENFORCEMENT (Global Constraints: "服务端强制隔离"): every reader
 * below that crosses an owner boundary filters `visibility = 'public'` (and,
 * where relevant, `owner_id != ?` / `members.status = 'active'`) IN THE SQL
 * WHERE clause itself - never fetched unfiltered and trimmed in JS. This
 * mirrors the discipline routes/strategy.ts's own loadOwnTheses/
 * loadCirclePublicTheses already established (Task 7) and centralizes it
 * here now that bull/bear JSON parsing would otherwise have to be
 * duplicated identically in three separate route files.
 *
 * computeThesisOutcome below is a from-scratch TypeScript RE-IMPLEMENTATION
 * of apps/openclaw-config/scripts/thesis-outcome.mjs's export of the same
 * name - NOT an import (that .mjs file has no build step/dist of its own;
 * this app's established convention - conclusion-box.ts, data/strategy-
 * write.ts - is to re-declare a source-of-truth shape/algorithm locally with
 * a comment pointing back at the original, rather than reach across an app
 * boundary from production code). ANTI-DRIFT: any change to thesis-
 * outcome.mjs's verdict rules, hit-rate gate, or rounding MUST be mirrored
 * here (or vice versa) - the shared fixture at apps/openclaw-config/scripts/
 * __fixtures__/thesis-outcome-samples.json is read by BOTH sides' test
 * suites (thesis-outcome.test.ts there, data/thesis-outcome-parity.test.ts
 * here) and asserts they compute the exact same outputs for the exact same
 * inputs.
 */
import type { DatabaseSync } from "node:sqlite";

export type ThesisDirection = "bull" | "bear" | "neutral";
export type StrategyVisibility = "system" | "public";
export type ThesisStatus = "active" | "withdrawn" | "superseded";
export type StrategyCardStatus = "active" | "paused" | "retired";

export interface ThesisEvidenceRow {
  id: string;
  ownerId: string;
  ownerDisplayName: string;
  symbol: string;
  direction: ThesisDirection;
  targetLow: number | null;
  targetHigh: number | null;
  invalidationPrice: number | null;
  bullPoints: string[];
  bearPoints: string[];
  visibility: StrategyVisibility;
  status: ThesisStatus;
  createdAt: string;
}

export interface ThesisHistoryRow {
  id: string;
  note: string;
  source: string;
  createdAt: string;
}

export interface StrategyCardRow {
  id: string;
  ownerId: string;
  ownerDisplayName: string;
  name: string;
  scene: string | null;
  entryCondition: string | null;
  riskControl: string | null;
  exitRule: string | null;
  status: StrategyCardStatus;
  visibility: StrategyVisibility;
  createdAt: string;
}

export interface ThesisGroup {
  ownerId: string;
  ownerDisplayName: string;
  theses: ThesisEvidenceRow[];
}

// ---------------------------------------------------------------------------
// JSON decode helper (mirrors data/strategy-write.ts's decodeJsonArray -
// "缺任一必填键→null，绝不猜" doesn't apply here since a malformed/missing
// bull_points/bear_points column value degrades to "no points recorded",
// never a thrown error on a read path).
// ---------------------------------------------------------------------------

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

function mapThesisEvidenceRow(row: Record<string, unknown>): ThesisEvidenceRow {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerDisplayName: String(row.owner_display_name),
    symbol: String(row.symbol),
    direction: row.direction as ThesisDirection,
    targetLow: row.target_low === null || row.target_low === undefined ? null : Number(row.target_low),
    targetHigh: row.target_high === null || row.target_high === undefined ? null : Number(row.target_high),
    invalidationPrice:
      row.invalidation_price === null || row.invalidation_price === undefined ? null : Number(row.invalidation_price),
    bullPoints: decodeJsonArray(row.bull_points),
    bearPoints: decodeJsonArray(row.bear_points),
    visibility: row.visibility as StrategyVisibility,
    status: row.status as ThesisStatus,
    createdAt: String(row.created_at)
  };
}

const THESIS_EVIDENCE_SELECT = `
  SELECT t.id AS id, t.owner_id AS owner_id, m.display_name AS owner_display_name,
         t.symbol AS symbol, t.direction AS direction, t.target_low AS target_low,
         t.target_high AS target_high, t.invalidation_price AS invalidation_price,
         t.bull_points AS bull_points, t.bear_points AS bear_points,
         t.visibility AS visibility, t.status AS status, t.created_at AS created_at
  FROM theses t
  JOIN members m ON m.id = t.owner_id
`;

/** The viewer's OWN theses, every visibility - "本人全见" (plan Task 7/5). */
export function loadOwnTheses(db: DatabaseSync, ownerId: string): ThesisEvidenceRow[] {
  const rows = db
    .prepare(`${THESIS_EVIDENCE_SELECT} WHERE t.owner_id = ? ORDER BY t.created_at DESC`)
    .all(ownerId) as Array<Record<string, unknown>>;
  return rows.map(mapThesisEvidenceRow);
}

/**
 * OTHER active members' `public` theses only - "他人仅 public". `owner_id !=
 * ?` and `visibility = 'public'` are both enforced in the WHERE clause
 * itself, never filtered in JS after an unfiltered fetch; joining `members`
 * with `status = 'active'` keeps a revoked member's old public theses out of
 * the circle view.
 */
export function loadCirclePublicTheses(db: DatabaseSync, viewerId: string): ThesisEvidenceRow[] {
  const rows = db
    .prepare(`
      ${THESIS_EVIDENCE_SELECT}
      WHERE t.visibility = 'public' AND t.owner_id != ? AND m.status = 'active'
      ORDER BY m.display_name ASC, t.created_at DESC
    `)
    .all(viewerId) as Array<Record<string, unknown>>;
  return rows.map(mapThesisEvidenceRow);
}

/**
 * One symbol's theses visible to `viewerId`: their own (every visibility)
 * plus anyone else's `public` ones - used by stock.ts's 我的论点卡. Enforced
 * in the WHERE clause itself (`t.owner_id = ? OR t.visibility = 'public'`).
 */
export function loadThesesForSymbol(db: DatabaseSync, viewerId: string, symbol: string): ThesisEvidenceRow[] {
  const rows = db
    .prepare(`
      ${THESIS_EVIDENCE_SELECT}
      WHERE t.symbol = ? AND (t.owner_id = ? OR t.visibility = 'public')
      ORDER BY (t.owner_id = ?) DESC, t.created_at DESC
    `)
    .all(symbol, viewerId, viewerId) as Array<Record<string, unknown>>;
  return rows.map(mapThesisEvidenceRow);
}

/**
 * `subject`'s theses for member-card.ts. `includePrivate` (true only when
 * the viewer IS the subject) decides whether the `visibility = 'public'`
 * filter is applied - enforced in the WHERE clause itself.
 */
export function loadSubjectTheses(db: DatabaseSync, subjectId: string, includePrivate: boolean): ThesisEvidenceRow[] {
  const visibilityClause = includePrivate ? "" : "AND t.visibility = 'public'";
  const rows = db
    .prepare(`${THESIS_EVIDENCE_SELECT} WHERE t.owner_id = ? ${visibilityClause} ORDER BY t.created_at DESC`)
    .all(subjectId) as Array<Record<string, unknown>>;
  return rows.map(mapThesisEvidenceRow);
}

/** Append-only judgment timeline for one thesis, oldest first - a timeline
 * reads top-to-bottom as "what happened, in order". */
export function loadThesisHistory(db: DatabaseSync, thesisId: string): ThesisHistoryRow[] {
  const rows = db
    .prepare(`SELECT id, note, source, created_at FROM thesis_history WHERE thesis_id = ? ORDER BY created_at ASC`)
    .all(thesisId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    note: String(row.note),
    source: String(row.source),
    createdAt: String(row.created_at)
  }));
}

/** Groups an already-ordered thesis list by owner, preserving first-seen
 * order (the SQL query's own ORDER BY decides which owner appears first). */
export function groupThesesByOwner(theses: readonly ThesisEvidenceRow[]): ThesisGroup[] {
  const order: string[] = [];
  const byOwner = new Map<string, ThesisGroup>();
  for (const thesis of theses) {
    let group = byOwner.get(thesis.ownerId);
    if (!group) {
      group = { ownerId: thesis.ownerId, ownerDisplayName: thesis.ownerDisplayName, theses: [] };
      byOwner.set(thesis.ownerId, group);
      order.push(thesis.ownerId);
    }
    group.theses.push(thesis);
  }
  return order.map((ownerId) => byOwner.get(ownerId) as ThesisGroup);
}

// ---------------------------------------------------------------------------
// strategy_cards
// ---------------------------------------------------------------------------

function mapStrategyCardRow(row: Record<string, unknown>): StrategyCardRow {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerDisplayName: String(row.owner_display_name),
    name: String(row.name),
    scene: row.scene === null || row.scene === undefined ? null : String(row.scene),
    entryCondition: row.entry_condition === null || row.entry_condition === undefined ? null : String(row.entry_condition),
    riskControl: row.risk_control === null || row.risk_control === undefined ? null : String(row.risk_control),
    exitRule: row.exit_rule === null || row.exit_rule === undefined ? null : String(row.exit_rule),
    status: row.status as StrategyCardStatus,
    visibility: row.visibility as StrategyVisibility,
    createdAt: String(row.created_at)
  };
}

const STRATEGY_CARD_SELECT = `
  SELECT c.id AS id, c.owner_id AS owner_id, m.display_name AS owner_display_name,
         c.name AS name, c.scene AS scene, c.entry_condition AS entry_condition,
         c.risk_control AS risk_control, c.exit_rule AS exit_rule,
         c.status AS status, c.visibility AS visibility, c.created_at AS created_at
  FROM strategy_cards c
  JOIN members m ON m.id = c.owner_id
`;

/** The viewer's OWN strategy cards, every visibility (system + public) -
 * same "本人全见" rule theses use. */
export function loadStrategyCardsForOwner(db: DatabaseSync, ownerId: string): StrategyCardRow[] {
  const rows = db
    .prepare(`${STRATEGY_CARD_SELECT} WHERE c.owner_id = ? ORDER BY c.created_at DESC`)
    .all(ownerId) as Array<Record<string, unknown>>;
  return rows.map(mapStrategyCardRow);
}

/**
 * `subject`'s strategy cards for member-card.ts. `includePrivate` (true only
 * when the viewer IS the subject) decides whether the `visibility =
 * 'public'` filter is applied - enforced in the WHERE clause itself, same
 * discipline as loadSubjectTheses.
 */
export function loadSubjectStrategyCards(db: DatabaseSync, subjectId: string, includePrivate: boolean): StrategyCardRow[] {
  const visibilityClause = includePrivate ? "" : "AND c.visibility = 'public'";
  const rows = db
    .prepare(`${STRATEGY_CARD_SELECT} WHERE c.owner_id = ? ${visibilityClause} ORDER BY c.created_at DESC`)
    .all(subjectId) as Array<Record<string, unknown>>;
  return rows.map(mapStrategyCardRow);
}

/** OTHER active members' `public` strategy cards only - enforced in the
 * WHERE clause itself, same discipline as loadCirclePublicTheses. */
export function loadPublicStrategyCards(db: DatabaseSync, excludeOwnerId: string): StrategyCardRow[] {
  const rows = db
    .prepare(`
      ${STRATEGY_CARD_SELECT}
      WHERE c.visibility = 'public' AND c.owner_id != ? AND m.status = 'active'
      ORDER BY m.display_name ASC, c.created_at DESC
    `)
    .all(excludeOwnerId) as Array<Record<string, unknown>>;
  return rows.map(mapStrategyCardRow);
}

// ---------------------------------------------------------------------------
// 近30天遵守 compliance statistics (strategy.ts §1)
// ---------------------------------------------------------------------------

export type ComplianceStats =
  | { sample: "none" }
  | { sample: "ok"; checked: number; passed: number; failed: number };

const COMPLIANCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface DisciplineReportEntry {
  ruleId?: unknown;
  pass?: unknown;
}

/**
 * Real (non-placeholder) 近30天遵守 statistic for one discipline rule: reads
 * this owner's `proposals` created within the last 30 days (any status -
 * pending or decided, no status filter, per plan "从 proposals 该 owner 该
 * 规则 proposal_check 命中/违反数"), parses each row's `discipline_report`
 * JSON array (discipline-engine.mjs's own report shape:
 * `{ruleId, ruleText, enforcement, pass, detail}[]`), and tallies how many
 * entries for THIS rule id came back `pass: true` vs `pass: false`.
 * `pass: null` ("无法判定") entries are counted in neither bucket - they are
 * not a completed check. No proposal in the window ever mentioned this rule
 * -> `{sample: 'none'}` (renders as "近30天无相关提案", never a fabricated 0/0).
 */
export function computeComplianceStats(
  db: DatabaseSync,
  ownerId: string,
  ruleId: string,
  now: Date
): ComplianceStats {
  const windowStart = new Date(now.getTime() - COMPLIANCE_WINDOW_MS).toISOString();
  const rows = db
    .prepare(`SELECT discipline_report FROM proposals WHERE owner_id = ? AND created_at >= ?`)
    .all(ownerId, windowStart) as Array<{ discipline_report: unknown }>;

  let passed = 0;
  let failed = 0;
  for (const row of rows) {
    let entries: DisciplineReportEntry[];
    try {
      const parsed: unknown = JSON.parse(String(row.discipline_report ?? "[]"));
      entries = Array.isArray(parsed) ? (parsed as DisciplineReportEntry[]) : [];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry?.ruleId !== ruleId) {
        continue;
      }
      if (entry.pass === true) {
        passed += 1;
      } else if (entry.pass === false) {
        failed += 1;
      }
      // entry.pass === null ("无法判定") counts toward neither bucket.
    }
  }

  const checked = passed + failed;
  if (checked === 0) {
    return { sample: "none" };
  }
  return { sample: "ok", checked, passed, failed };
}

// ---------------------------------------------------------------------------
// stock_facts latest price (for computeThesisOutcome's `latestPrice` input)
// ---------------------------------------------------------------------------

/**
 * The most recent `quote.last` numeric fact recorded for `symbol` across all
 * trading days (re-declares stock-facts-store.mjs's `stock_facts` table
 * shape/fact_key convention locally rather than importing across the app
 * boundary - see module header). `null` when no such fact exists yet -
 * NEVER guessed; callers treat this the same as computeThesisOutcome's own
 * `latestPrice: null` -> `verdict: 'no_price'` path.
 */
export function loadLatestPriceForSymbol(db: DatabaseSync, symbol: string): number | null {
  const row = db
    .prepare(`
      SELECT value_num FROM stock_facts
      WHERE symbol = ? AND fact_key = 'quote.last' AND value_num IS NOT NULL
      ORDER BY trading_day DESC
      LIMIT 1
    `)
    .get(symbol) as { value_num: number } | undefined;
  return row ? Number(row.value_num) : null;
}

// ---------------------------------------------------------------------------
// computeThesisOutcome: TS port of thesis-outcome.mjs (see module header for
// the anti-drift contract). Deliberately pure/zero-IO, identical algorithm.
// ---------------------------------------------------------------------------

export type ThesisOutcomeVerdict = "toward_target" | "toward_invalidation" | "neutral" | "insufficient" | "no_price";

export interface ThesisOutcomeThesisInput {
  direction: string;
  targetLow?: number | null;
  targetHigh?: number | null;
  invalidationPrice?: number | null;
}

export interface ThesisOutcomeJudgmentInput {
  id: string;
}

export interface ThesisOutcomeInput {
  thesis: ThesisOutcomeThesisInput;
  judgments: ThesisOutcomeJudgmentInput[];
  latestPrice: number | null | undefined;
}

export interface ThesisOutcomeJudgmentResult {
  judgmentId: string;
  priceAtRender: number | null;
  vsTargetPct: number | null;
  vsInvalidationPct: number | null;
  verdict: ThesisOutcomeVerdict;
}

export type ThesisHitRate =
  | { sample: "insufficient"; n: number; reason?: string }
  | { sample: "ok"; n: number; hits: number; total: number; hitFraction: number };

export interface ThesisOutcomeResult {
  perJudgment: ThesisOutcomeJudgmentResult[];
  hitRate: ThesisHitRate;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pctFrom(reference: number | null, latestPrice: number): number | null {
  if (!isFiniteNumber(reference)) {
    return null;
  }
  return round2(((latestPrice - reference) / reference) * 100);
}

interface ReferenceLevels {
  targetRef: number | null;
  invalidationRef: number | null;
  rangeLow: number | null;
  rangeHigh: number | null;
}

function resolveReferenceLevels(thesis: ThesisOutcomeThesisInput): ReferenceLevels | null {
  const targetLow = isFiniteNumber(thesis?.targetLow) ? thesis.targetLow : null;
  const targetHigh = isFiniteNumber(thesis?.targetHigh) ? thesis.targetHigh : null;
  const invalidationPrice = isFiniteNumber(thesis?.invalidationPrice) ? thesis.invalidationPrice : null;

  if (thesis?.direction === "bull") {
    return { targetRef: targetHigh, invalidationRef: invalidationPrice, rangeLow: null, rangeHigh: null };
  }
  if (thesis?.direction === "bear") {
    return { targetRef: targetLow, invalidationRef: invalidationPrice, rangeLow: null, rangeHigh: null };
  }
  if (thesis?.direction === "neutral") {
    return { targetRef: null, invalidationRef: invalidationPrice, rangeLow: targetLow, rangeHigh: targetHigh };
  }
  return null;
}

function resolveVerdict(thesis: ThesisOutcomeThesisInput, latestPrice: number): ThesisOutcomeVerdict {
  const levels = resolveReferenceLevels(thesis);
  if (!levels) {
    return "insufficient"; // unrecognized/missing direction - never guessed
  }

  if (thesis.direction === "neutral") {
    if (levels.rangeLow === null || levels.rangeHigh === null) {
      return "insufficient";
    }
    return latestPrice >= levels.rangeLow && latestPrice <= levels.rangeHigh ? "neutral" : "toward_invalidation";
  }

  // bull / bear: both need a target reference AND an invalidation reference.
  if (levels.targetRef === null || levels.invalidationRef === null) {
    return "insufficient";
  }

  const distToTarget = Math.abs(latestPrice - levels.targetRef);
  const distToInvalidation = Math.abs(latestPrice - levels.invalidationRef);
  return distToTarget <= distToInvalidation ? "toward_target" : "toward_invalidation";
}

/**
 * Deterministic post-hoc outcome backtest for one thesis's judgment history -
 * see thesis-outcome.mjs's module header for the full verdict-rule / hit-
 * rate specification this ports verbatim. NOT an AI feature: every value
 * here is arithmetic on the thesis's own stored numeric levels vs. a single
 * caller-supplied `latestPrice` snapshot.
 */
export function computeThesisOutcome({ thesis, judgments, latestPrice }: ThesisOutcomeInput): ThesisOutcomeResult {
  const judgmentList = judgments ?? [];
  const hasPrice = isFiniteNumber(latestPrice);

  const levels = hasPrice ? resolveReferenceLevels(thesis) : null;
  const verdict: ThesisOutcomeVerdict = hasPrice ? resolveVerdict(thesis, latestPrice as number) : "no_price";
  const vsTargetPct = hasPrice && levels ? pctFrom(levels.targetRef, latestPrice as number) : null;
  const vsInvalidationPct = hasPrice && levels ? pctFrom(levels.invalidationRef, latestPrice as number) : null;
  const priceAtRender = hasPrice ? (latestPrice as number) : null;

  const perJudgment: ThesisOutcomeJudgmentResult[] = judgmentList.map((judgment) => ({
    judgmentId: judgment.id,
    priceAtRender,
    vsTargetPct,
    vsInvalidationPct,
    verdict
  }));

  const n = judgmentList.length;
  let hitRate: ThesisHitRate;
  if (n < 10) {
    hitRate = { sample: "insufficient", n };
  } else {
    const hits = perJudgment.filter((row) => row.verdict === "toward_target").length;
    const misses = perJudgment.filter((row) => row.verdict === "toward_invalidation").length;
    const total = hits + misses;
    if (total === 0) {
      hitRate = {
        sample: "insufficient",
        n,
        reason: "无法计算方向命中率（缺少最新价格，或论点缺少目标价/失效价，无法判断方向）"
      };
    } else {
      hitRate = { sample: "ok", n, hits, total, hitFraction: round2(hits / total) };
    }
  }

  return { perJudgment, hitRate };
}
