/**
 * Platform-side reader for the news engine's tables (Phase 4 Task 7).
 *
 * `news_events`/`news_event_sources` are written by ONE place only -
 * apps/openclaw-config/scripts/scheduled-report.mjs's report-generation
 * pipeline (via news-store.mjs's `upsertEventWithSources`, itself fed by
 * news-engine.mjs's `clusterArticles`/`buildEventFromCluster` over
 * news-sources.mjs's `collectL1News`) - single-writer principle: reports and
 * this platform read/write the SAME trading db from the same host, so this
 * module is read-only and never calls `upsertEventWithSources` itself.
 *
 * `listNewsEvents` below is a from-scratch TypeScript RE-IMPLEMENTATION of
 * news-store.mjs's `listEventsInWindow` (NOT an import - apps/openclaw-
 * config/scripts is plain .mjs with no build step/dist of its own, and P3's
 * established convention across this app is to re-declare a source-of-truth
 * shape/query locally with a comment pointing back at the original, rather
 * than reach across an app boundary for a few dozen lines - see e.g.
 * routes/stock.ts's `normalizeStockSymbol` doc comment re-declaring
 * report-data.mjs's `normalizeSymbol`). Any change to the SQL/semantics here
 * must be mirrored in news-store.mjs's `listEventsInWindow` (or vice versa) -
 * the seam test (routes/news.test.ts) exercises both sides of that
 * assumption by writing through the real news-engine/news-store functions
 * and reading back through this module.
 *
 * These tables have NO `owner_id` column (schema v8, database.ts) - news is a
 * PUBLIC asset shared across the whole stock pool (Global Constraints: "新闻
 * 表无 owner 列（公共资产...）"), so unlike every other data/*.ts port in this
 * app, there is no per-member filter to apply here. The platform's identity
 * gate (routes/news.ts's `resolveIdentity`) is a pure LOGIN gate for this
 * page, not an ownership filter - do not add an owner_id/member filter to any
 * query in this file.
 */
import type { DatabaseSync } from "node:sqlite";

export type ImpactDirection = "bullish" | "bearish" | "neutral" | "unknown" | null;

export interface NewsEventSourceRow {
  id: string;
  eventId: string;
  origin: string;
  publisher: string;
  url: string | null;
  titleRaw: string;
  publishedAt: string | null;
  lang: string;
  createdAt: string;
}

export interface NewsEventRow {
  id: string;
  clusterKey: string;
  titleZh: string;
  summaryZh: string | null;
  impactDirection: ImpactDirection;
  impactAffected: string[];
  impactReason: string | null;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  sourceCount: number;
  zhSourceCount: number;
  createdAt: string;
  updatedAt: string;
  sources: NewsEventSourceRow[];
}

export interface ListNewsEventsFilters {
  sinceIso: string;
  symbol?: string | undefined;
  topic?: string | undefined;
}

function fromJsonArray(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

function mapEventRow(row: Record<string, unknown>): NewsEventRow {
  return {
    id: String(row.id),
    clusterKey: String(row.cluster_key),
    titleZh: String(row.title_zh),
    summaryZh: row.summary_zh === null || row.summary_zh === undefined ? null : String(row.summary_zh),
    impactDirection: (row.impact_direction as ImpactDirection) ?? null,
    impactAffected: fromJsonArray(row.impact_affected),
    impactReason: row.impact_reason === null || row.impact_reason === undefined ? null : String(row.impact_reason),
    firstPublishedAt: row.first_published_at === null || row.first_published_at === undefined ? null : String(row.first_published_at),
    lastPublishedAt: row.last_published_at === null || row.last_published_at === undefined ? null : String(row.last_published_at),
    sourceCount: Number(row.source_count),
    zhSourceCount: Number(row.zh_source_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    sources: []
  };
}

function mapSourceRow(row: Record<string, unknown>): NewsEventSourceRow {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    origin: String(row.origin),
    publisher: String(row.publisher),
    url: row.url === null || row.url === undefined ? null : String(row.url),
    titleRaw: String(row.title_raw),
    publishedAt: row.published_at === null || row.published_at === undefined ? null : String(row.published_at),
    lang: String(row.lang),
    createdAt: String(row.created_at)
  };
}

/**
 * Lists clustered news events whose `last_published_at` falls within
 * `[sinceIso, now]` - same semantics as news-store.mjs's
 * `listEventsInWindow` (see that function's own doc comment for the full
 * rationale on each choice below):
 *   - events with `last_published_at IS NULL` (every source's time unknown)
 *     are EXCLUDED, never treated as "now" (published_at 可空=未知 rule).
 *   - `symbol` matches `impact_affected` (a JSON array of strings) via a
 *     `LIKE '%"SYM"%'` substring check, not a real JSON containment query -
 *     same documented tradeoff as the store (accepted: symbols here are
 *     short well-formed tickers from stock_analysis_targets).
 *   - `topic === '宏观'` matches events with an empty `impact_affected`
 *     (`'[]'`, i.e. no specific ticker implicated) OR one that explicitly
 *     lists `'宏观'`.
 *   - results ordered `last_published_at DESC`; each event carries its
 *     `sources[]` (a second query by `event_id IN (...)`, grouped in JS -
 *     same two-query shape as the store, for the same reason: this driver
 *     returns plain rows, not client-aggregated arrays).
 */
export function listNewsEvents(db: DatabaseSync, filters: ListNewsEventsFilters): NewsEventRow[] {
  const { sinceIso, symbol, topic } = filters;
  const conditions = ["last_published_at IS NOT NULL", "last_published_at >= ?"];
  const params: Array<string> = [sinceIso];

  if (symbol) {
    conditions.push("impact_affected LIKE ?");
    params.push(`%"${symbol}"%`);
  }
  if (topic === "宏观") {
    conditions.push("(impact_affected = '[]' OR impact_affected LIKE ?)");
    params.push(`%"宏观"%`);
  }

  const rows = db
    .prepare(`SELECT * FROM news_events WHERE ${conditions.join(" AND ")} ORDER BY last_published_at DESC`)
    .all(...params) as Array<Record<string, unknown>>;

  const events = rows.map(mapEventRow);
  if (events.length === 0) {
    return events;
  }

  const placeholders = events.map(() => "?").join(", ");
  const sourceRows = db
    .prepare(`SELECT * FROM news_event_sources WHERE event_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...events.map((event) => event.id)) as Array<Record<string, unknown>>;

  const sourcesByEvent = new Map<string, NewsEventSourceRow[]>();
  for (const row of sourceRows) {
    const mapped = mapSourceRow(row);
    const bucket = sourcesByEvent.get(mapped.eventId) ?? [];
    bucket.push(mapped);
    sourcesByEvent.set(mapped.eventId, bucket);
  }

  for (const event of events) {
    event.sources = sourcesByEvent.get(event.id) ?? [];
  }

  return events;
}

/**
 * Distinct, active symbols across the WHOLE `stock_analysis_targets` table -
 * every owner's pool, INCLUDING the `__legacy_shared__` sentinel row (schema
 * v7's backfill target for the pre-per-owner era) - deliberately NOT scoped
 * to the viewing member's own watchlist. News is a public asset (see this
 * module's header comment): the filter-chip row on the news page is meant to
 * read "every symbol anyone in the circle is tracking", not "my personal
 * watchlist", so this intentionally has no `owner_id` parameter at all.
 */
export function listFilterSymbols(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT symbol FROM stock_analysis_targets WHERE active = 1 ORDER BY symbol ASC`)
    .all() as Array<{ symbol: string }>;
  return rows.map((row) => String(row.symbol));
}
