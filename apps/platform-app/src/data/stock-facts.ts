/**
 * Reader for the `stock_facts` table - the machine-checked numbers behind a
 * stock-analysis report (2026-07-30 spec-drift remediation, U3).
 *
 * WHY: `/stock/<code>` rendered a one-paragraph conclusion box and nothing
 * else, while the row-level facts that conclusion was computed FROM were
 * already sitting in this table with a per-fact `data_time` and `source`.
 * Spec §1.9 wants the drill-down page to open with 代码/名称/数据时间, and
 * §0.4 requires 每个数字标注数据时间 - both of which need these rows.
 *
 * SHAPE, VERIFIED AGAINST THE LIVE TABLE (not assumed): every fact carries a
 * `fact_key`, exactly one of `value_num`/`value_text`, a free-text `unit`,
 * a `source` (which may name SEVERAL producers joined by `、`), and its own
 * `data_time`. `unit` is NOT a closed enum - the live rows include `USD`,
 * `pct`, `shares`, `contracts`, `count`, an empty unit for ratios like P/E,
 * and `136日` (a window label on the long moving average). Anything this
 * module does not recognize is shown verbatim next to the number rather
 * than dropped or reinterpreted.
 *
 * `value_text` carries producer-authored prose, INCLUDING honest
 * unavailability notes: the live TSM.US row for `institutional.holdings` is
 * `value_text = '不可得'`, `source = '数据不可得（EDGAR 13F 已裁）'`. That
 * text is rendered verbatim by the page - it is the producer's own
 * disclosure and must never be replaced with a 0, a dash, or silence.
 */
import type { DatabaseSync } from "node:sqlite";

export interface StockFactRow {
  factKey: string;
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
  source: string;
  /** Producer-stamped instant OR day - the live table holds both shapes
   * (`2026-07-27T16:36:22.000Z` for a Longbridge quote, `2026-07-27` for a
   * daily valuation pull). Callers must handle both. */
  dataTime: string;
}

export interface SymbolFactSheet {
  /** The trading day these facts belong to (`YYYY-MM-DD`). */
  tradingDay: string;
  byKey: Map<string, StockFactRow>;
}

function mapRow(row: Record<string, unknown>): StockFactRow {
  return {
    factKey: String(row.fact_key),
    valueNum: row.value_num === null || row.value_num === undefined ? null : Number(row.value_num),
    valueText: row.value_text === null || row.value_text === undefined ? null : String(row.value_text),
    unit: row.unit === null || row.unit === undefined ? null : String(row.unit),
    source: String(row.source ?? ""),
    dataTime: String(row.data_time ?? "")
  };
}

/**
 * The newest trading day's complete fact sheet for one symbol, or null when
 * the symbol has no facts at all. Deliberately loads ONE day rather than
 * "newest value per key": mixing a fresh quote with a three-week-old
 * valuation under a single 数据时间 header would be exactly the kind of
 * silently-stale composite this remediation exists to remove.
 */
export function loadLatestFactSheet(db: DatabaseSync, symbol: string): SymbolFactSheet | null {
  const dayRow = db
    .prepare(`SELECT trading_day FROM stock_facts WHERE symbol = ? ORDER BY trading_day DESC LIMIT 1`)
    .get(symbol) as { trading_day?: unknown } | undefined;
  const tradingDay = dayRow?.trading_day === undefined ? null : String(dayRow.trading_day);
  if (!tradingDay) {
    return null;
  }

  const rows = db
    .prepare(`
      SELECT fact_key, value_num, value_text, unit, source, data_time
      FROM stock_facts
      WHERE symbol = ? AND trading_day = ?
      ORDER BY fact_key ASC
    `)
    .all(symbol, tradingDay) as Array<Record<string, unknown>>;

  const byKey = new Map<string, StockFactRow>();
  for (const row of rows) {
    const mapped = mapRow(row);
    byKey.set(mapped.factKey, mapped);
  }
  return { tradingDay, byKey };
}
