// SQLite repository for the news engine's tables (news_events,
// news_event_sources, daily_facts - created by shared-types' migration index
// 7 / schema v8, Phase 4 Task 2). All camelCase <-> snake_case mapping and
// JSON encode/decode lives here; the clustering core (news-engine.mjs, a
// later task) and the report/platform renderers never touch SQL or
// JSON.stringify/parse directly - they call this module. Follows
// market-alerts-store.mjs's conventions (see that file's header).

import { createId, nowIso } from "../../../packages/shared-types/dist/index.js";

// ---------------------------------------------------------------------------
// news_events + news_event_sources
// ---------------------------------------------------------------------------

// Upserts one clustered news event (by cluster_key) and merges in a batch of
// raw sources, deduping against sources already stored for this event AND
// duplicates within the same batch. Recomputes and writes back the event's
// aggregate columns (source_count, zh_source_count, first/last_published_at)
// from the actual news_event_sources rows after the merge, so those columns
// are always a derived fact, never hand-maintained state that can drift.
//
// Runs as a single transaction: the event upsert, every source insert, and
// the aggregate write-back either all land or none do - a caller that
// crashes mid-merge must never see a source row that isn't reflected in the
// event's counts (or vice versa).
//
// @param {import('node:sqlite').DatabaseSync} db
// @param {{
//   clusterKey: string, titleZh: string, summaryZh?: string|null,
//   impactDirection?: 'bullish'|'bearish'|'neutral'|'unknown'|null,
//   impactAffected?: string[], impactReason?: string|null
// }} event
// @param {Array<{
//   origin: string, publisher: string, url?: string|null, titleRaw: string,
//   publishedAt?: string|null, lang?: string
// }>} sources
// @returns {{eventId: string, insertedSources: number, skippedDuplicates: number}}
export function upsertEventWithSources(db, event, sources) {
  const now = nowIso();
  const impactAffectedJson = toJson(event.impactAffected ?? []);

  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const existing = db
      .prepare(`SELECT id FROM news_events WHERE cluster_key = ?`)
      .get(event.clusterKey);

    let eventId;
    if (existing) {
      eventId = String(existing.id);
      db.prepare(`
        UPDATE news_events
        SET title_zh = ?, summary_zh = ?, impact_direction = ?, impact_affected = ?,
            impact_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(
        event.titleZh,
        event.summaryZh ?? null,
        event.impactDirection ?? null,
        impactAffectedJson,
        event.impactReason ?? null,
        now,
        eventId
      );
    } else {
      eventId = createId("news_event");
      db.prepare(`
        INSERT INTO news_events
        (id, cluster_key, title_zh, summary_zh, impact_direction, impact_affected, impact_reason,
         first_published_at, last_published_at, source_count, zh_source_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)
      `).run(
        eventId,
        event.clusterKey,
        event.titleZh,
        event.summaryZh ?? null,
        event.impactDirection ?? null,
        impactAffectedJson,
        event.impactReason ?? null,
        now,
        now
      );
    }

    const existingSourceRows = db
      .prepare(`SELECT url, title_raw FROM news_event_sources WHERE event_id = ?`)
      .all(eventId);
    const seenKeys = new Set(existingSourceRows.map((row) => dedupeKey(row.url, row.title_raw)));

    const insertSourceStmt = db.prepare(`
      INSERT INTO news_event_sources
      (id, event_id, origin, publisher, url, title_raw, published_at, lang, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let insertedSources = 0;
    let skippedDuplicates = 0;
    for (const source of sources ?? []) {
      const key = dedupeKey(source.url ?? null, source.titleRaw);
      if (seenKeys.has(key)) {
        skippedDuplicates += 1;
        continue;
      }
      seenKeys.add(key);
      insertSourceStmt.run(
        createId("news_source"),
        eventId,
        source.origin,
        source.publisher,
        source.url ?? null,
        source.titleRaw,
        source.publishedAt ?? null,
        source.lang ?? "unknown",
        now
      );
      insertedSources += 1;
    }

    // SQL aggregates (COUNT/SUM/MIN/MAX) ignore NULL inputs by definition, so
    // MIN/MAX(published_at) here already implements "MIN/MAX of non-null
    // published_at" without any special-casing - an event whose sources are
    // ALL unknown-time yields first/last_published_at = NULL, exactly the
    // "unknown time" state listEventsInWindow later excludes.
    const counts = db
      .prepare(`
        SELECT
          COUNT(*) AS source_count,
          SUM(CASE WHEN lang = 'zh' THEN 1 ELSE 0 END) AS zh_source_count,
          MIN(published_at) AS first_published_at,
          MAX(published_at) AS last_published_at
        FROM news_event_sources
        WHERE event_id = ?
      `)
      .get(eventId);

    db.prepare(`
      UPDATE news_events
      SET source_count = ?, zh_source_count = ?, first_published_at = ?, last_published_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      Number(counts?.source_count ?? 0),
      Number(counts?.zh_source_count ?? 0),
      counts?.first_published_at ?? null,
      counts?.last_published_at ?? null,
      now,
      eventId
    );

    db.exec("COMMIT");
    return { eventId, insertedSources, skippedDuplicates };
  } catch (error) {
    // The ROLLBACK itself can fail (connection already out of a transaction,
    // etc.) - that secondary failure must never replace `error`, the real
    // cause the caller needs to see (mirrors market-alerts-store.mjs's
    // persistCycle/deleteRule).
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore: best-effort only, `error` below is what matters.
    }
    throw error;
  }
}

// Source-level dedup key for upsertEventWithSources. Prefers a loosely
// normalized URL (lowercased host, trailing slash stripped off the path) so
// the exact same article URL fetched via two different origins (e.g. RSSHub
// vs Google News) isn't double-counted as two sources; falls back to the raw
// title (trimmed + lowercased) when no URL is present, per this task's spec.
//
// Tradeoff (documented per the task brief): this does NOT strip tracking
// query params (utm_*, fbclid) or unwrap redirect wrappers (e.g. Google
// News's /articles/ redirect shim) - that heavier normalization is
// news-engine.mjs's normalizeNewsUrl job (a later task), which runs on L1
// articles BEFORE they ever reach this store. Two URLs differing only by a
// tracking parameter will therefore be counted as two distinct sources here
// unless the caller already normalized them upstream. This is accepted for
// the store layer: it keeps news-store.mjs a thin, dependency-free
// persistence layer (no import of the clustering core), and the failure mode
// is a possibly-inflated source_count, not data loss or corruption.
function dedupeKey(url, titleRaw) {
  if (url) {
    return `url:${normalizeUrlLoosely(url)}`;
  }
  return `title:${String(titleRaw ?? "").trim().toLowerCase()}`;
}

function normalizeUrlLoosely(url) {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}${parsed.search}`;
  } catch {
    // Not a parseable absolute URL - fall back to a plain string
    // normalization rather than throwing (bad/partial URLs from upstream
    // sources must not crash the store).
    return String(url).trim().toLowerCase().replace(/\/+$/, "");
  }
}

// Lists events whose last_published_at falls within [sinceIso, now] - i.e.
// "in the last N days" windows, computed by the caller into a single
// sinceIso cutoff. Events with last_published_at = NULL (every source's
// published_at is unknown) are EXCLUDED, never treated as "now" - per the
// plan's binding rule that missing time never falls back to Date.now().
//
// symbol filter matches impact_affected (a JSON array of strings) via
// `LIKE '%"SYM"%'` rather than a real JSON containment check - SQLite's
// json_each/json_valid table-valued functions would be more precise, but the
// task brief explicitly allows the LIKE approach with the tradeoff
// documented: a symbol whose exact quoted-string form is a substring of a
// DIFFERENT symbol's quoted form (e.g. matching `"BABA.US"` would also match
// a hypothetical `"XBABA.US"` entry) could false-positive. In practice
// symbols here are short, well-formed tickers (`AAPL.US` style) from
// stock_analysis_targets, so this is accepted rather than pulling in
// json_each for one query.
//
// topic='宏观' matches events with an empty impact_affected (`'[]'`, i.e. no
// specific ticker was implicated - a macro/industry-wide story) OR one that
// explicitly lists '宏观' as an affected entry.
//
// Each event carries its sources as `sources[]` (mapped rows from
// news_event_sources). Implemented as two queries (fetch matching events,
// then fetch all their sources via `event_id IN (...)`, grouped in JS)
// rather than one query with a JOIN: a JOIN would repeat every event column
// once per source row, and SQLite's node:sqlite driver returns plain rows
// (no client-side aggregation into arrays), so the grouping work has to
// happen in JS either way - two queries avoids re-parsing the event's own
// columns N times per event and keeps each query's shape simple. The extra
// round trip is negligible at report-generation query volumes (single-digit
// to low hundreds of events per 7-day window).
//
// @param {import('node:sqlite').DatabaseSync} db
// @param {{sinceIso: string, symbol?: string, topic?: string}} filters
export function listEventsInWindow(db, { sinceIso, symbol, topic } = {}) {
  const conditions = ["last_published_at IS NOT NULL", "last_published_at >= ?"];
  const params = [sinceIso];

  if (symbol) {
    conditions.push("impact_affected LIKE ?");
    params.push(`%"${symbol}"%`);
  }
  if (topic === "宏观") {
    conditions.push("(impact_affected = '[]' OR impact_affected LIKE ?)");
    params.push(`%"宏观"%`);
  }

  const rows = db
    .prepare(`
      SELECT * FROM news_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY last_published_at DESC
    `)
    .all(...params);

  const events = rows.map(mapEventRow);
  if (events.length === 0) {
    return events;
  }

  const placeholders = events.map(() => "?").join(", ");
  const sourceRows = db
    .prepare(`SELECT * FROM news_event_sources WHERE event_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...events.map((event) => event.id));

  const sourcesByEvent = new Map();
  for (const row of sourceRows) {
    const mapped = mapSourceRow(row);
    if (!sourcesByEvent.has(mapped.eventId)) {
      sourcesByEvent.set(mapped.eventId, []);
    }
    sourcesByEvent.get(mapped.eventId).push(mapped);
  }

  for (const event of events) {
    event.sources = sourcesByEvent.get(event.id) ?? [];
  }

  return events;
}

// ---------------------------------------------------------------------------
// daily_facts
// ---------------------------------------------------------------------------

// Replaces the ENTIRE set of facts for one trading day in a single
// transaction (DELETE then INSERT-all), never a partial merge - callers
// (report generation, Task 6) always recompute the full fact set for that
// day from scratch, so a stale fact from an earlier, since-corrected run
// must never survive alongside the new ones.
//
// @param {import('node:sqlite').DatabaseSync} db
// @param {string} tradingDay
// @param {Array<{
//   factKey: string, valueNum?: number|null, valueText?: string|null,
//   unit?: string|null, source: string, dataTime: string
// }>} facts
export function replaceDailyFacts(db, tradingDay, facts) {
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.prepare(`DELETE FROM daily_facts WHERE trading_day = ?`).run(tradingDay);

    const insertStmt = db.prepare(`
      INSERT INTO daily_facts (id, trading_day, fact_key, value_num, value_text, unit, source, data_time, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const fact of facts ?? []) {
      insertStmt.run(
        createId("daily_fact"),
        tradingDay,
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
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore: best-effort only, `error` below is what matters.
    }
    throw error;
  }
}

// Returns this trading day's facts keyed by fact_key, e.g.
// `{ qqq_price: { valueNum: 522.31, unit: 'USD', ... } }` - the shape Task
// 6's facts.numeric_match quality gate needs to look up "what does the
// narrative's number for X claim to be, per the facts table" by key.
//
// @param {import('node:sqlite').DatabaseSync} db
// @param {string} tradingDay
// @returns {Record<string, {valueNum: number|null, valueText: string|null, unit: string|null, source: string, dataTime: string}>}
export function getDailyFacts(db, tradingDay) {
  const rows = db.prepare(`SELECT * FROM daily_facts WHERE trading_day = ?`).all(tradingDay);

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

// ---------------------------------------------------------------------------
// Row <-> camelCase mapping
// ---------------------------------------------------------------------------

function mapEventRow(row) {
  return {
    id: String(row.id),
    clusterKey: String(row.cluster_key),
    titleZh: String(row.title_zh),
    summaryZh: row.summary_zh ?? null,
    impactDirection: row.impact_direction ?? null,
    impactAffected: fromJsonArray(row.impact_affected),
    impactReason: row.impact_reason ?? null,
    firstPublishedAt: row.first_published_at ?? null,
    lastPublishedAt: row.last_published_at ?? null,
    sourceCount: Number(row.source_count),
    zhSourceCount: Number(row.zh_source_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapSourceRow(row) {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    origin: String(row.origin),
    publisher: String(row.publisher),
    url: row.url ?? null,
    titleRaw: String(row.title_raw),
    publishedAt: row.published_at ?? null,
    lang: String(row.lang),
    createdAt: String(row.created_at)
  };
}

function toJson(value) {
  return JSON.stringify(value ?? []);
}

function fromJsonArray(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
