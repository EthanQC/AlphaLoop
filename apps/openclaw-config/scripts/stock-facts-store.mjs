// SQLite repository for stock_facts (schema v9, Phase 5 Task 1 - see
// packages/shared-types/src/database.ts's v9 migration step comment). This
// is the per-stock, per-trading-day analogue of news-store.mjs's
// daily_facts/replaceDailyFacts/getDailyFacts.
//
// Kept as its OWN module rather than folded into news-store.mjs: that file
// owns the shared/portfolio-wide news + daily_facts domain (see its own
// header comment), while stock_facts is per-symbol stock-analysis data -
// mixing the two would blur the domain boundary that file's header
// deliberately draws. Follows its conventions anyway: all camelCase <->
// snake_case mapping and SQL/JSON handling lives here; callers
// (report-facts.mjs's buildStockFacts/persistStockFacts wrapper,
// stock-analysis.mjs's runAnalysis) never touch SQL directly.

import { createId, nowIso } from "../../../packages/shared-types/dist/index.js";

// Phase 5 Task 4 (2026-07-15 plan): the confidence heuristic's 8-key
// "coverage" checklist (stock-analysis.mjs's computeFactsCoverage, Task 2)
// and report-quality.mjs's stock.facts_coverage gate (Task 4) must count
// "how many of 8 representative stock_facts keys came back with a real
// value" the SAME way - two independently-typed 8-item lists could silently
// drift apart, defeating the whole point of a shared denominator. This
// constant lives HERE (not in stock-analysis.mjs, where the heuristic that
// first needed it was written) for two concrete reasons: (1) stock-analysis.mjs
// already imports assertStockAnalysisQuality FROM report-quality.mjs, so
// report-quality.mjs importing this constant back from stock-analysis.mjs
// would be circular - safe in Node ESM only as long as neither side reads it
// at module-top-level, which is a fragile invariant to lean on; (2)
// stock-analysis.mjs's own module top level has real side effects
// (loadLocalEnv, two mkdirSync calls) that every test importing
// report-quality.mjs would otherwise silently start incurring. This module
// has neither problem (no project-external side effects beyond the pure
// createId/nowIso helpers above), and it is already the natural domain home
// for a list of stock_facts.fact_key literals.
export const CONFIDENCE_COVERAGE_CHECKPOINTS = [
  "quote.last", "quote.pct", "valuation.pe", "valuation.targetPrice",
  "history.ma20", "history.ma60", "options.callOi", "news.count"
];
export const CONFIDENCE_COVERAGE_THRESHOLD = 6;

// Replaces the facts for ONE (tradingDay, symbol) pair in a single
// transaction (DELETE scoped to that exact pair, then INSERT-all) -
// deliberately NOT a whole-trading-day delete like news-store.mjs's
// replaceDailyFacts. stock-analysis.mjs's runAnalysis persists facts once
// per symbol as each symbol's analysis completes within the same batch run
// (all sharing one trading_day) - a full-day delete here would silently wipe
// out every OTHER symbol's facts each time a single symbol's facts are
// (re)written, which is exactly the trap replaceDailyFacts's semantics would
// set for a per-symbol table like this one.
//
// @param {import('node:sqlite').DatabaseSync} db
// @param {string} tradingDay
// @param {string} symbol
// @param {Array<{
//   factKey: string, valueNum?: number|null, valueText?: string|null,
//   unit?: string|null, source: string, dataTime: string
// }>} facts
export function replaceStockFacts(db, tradingDay, symbol, facts) {
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.prepare(`DELETE FROM stock_facts WHERE trading_day = ? AND symbol = ?`).run(tradingDay, symbol);

    const insertStmt = db.prepare(`
      INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const fact of facts ?? []) {
      insertStmt.run(
        createId("stock_fact"),
        tradingDay,
        symbol,
        fact.factKey,
        fact.valueNum ?? null,
        fact.valueText ?? null,
        fact.unit ?? null,
        fact.source,
        fact.dataTime,
        now
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    // The ROLLBACK itself can fail (connection already out of a transaction,
    // etc.) - that secondary failure must never replace `error`, the real
    // cause the caller needs to see (mirrors news-store.mjs's
    // upsertEventWithSources/replaceDailyFacts).
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore: best-effort only, `error` below is what matters.
    }
    throw error;
  }
}

// Returns one (tradingDay, symbol)'s facts keyed by fact_key, e.g.
// `{ 'quote.last': { valueNum: 210.5, unit: 'USD', ... } }` - same shape
// convention as news-store.mjs's getDailyFacts, for the facts.numeric_match
// quality gate (Task 4) and any other per-symbol fact lookup.
//
// @param {import('node:sqlite').DatabaseSync} db
// @param {string} tradingDay
// @param {string} symbol
// @returns {Record<string, {valueNum: number|null, valueText: string|null, unit: string|null, source: string, dataTime: string}>}
export function getStockFacts(db, tradingDay, symbol) {
  const rows = db.prepare(`SELECT * FROM stock_facts WHERE trading_day = ? AND symbol = ?`).all(tradingDay, symbol);

  const result = {};
  for (const row of rows) {
    result[String(row.fact_key)] = {
      valueNum: row.value_num === null || row.value_num === undefined ? null : Number(row.value_num),
      valueText: row.value_text ?? null,
      unit: row.unit ?? null,
      source: String(row.source),
      dataTime: String(row.data_time)
    };
  }
  return result;
}
