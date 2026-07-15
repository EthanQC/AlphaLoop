import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createId, migrate } from "@packages/shared-types";

import { listFilterSymbols, listNewsEvents } from "./news.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function insertEvent(
  db: DatabaseSync,
  opts: {
    clusterKey: string;
    titleZh: string;
    impactAffected?: string[];
    lastPublishedAt: string | null;
    firstPublishedAt?: string | null;
  }
): string {
  const id = createId("news_event");
  const now = "2026-07-14T00:00:00.000Z";
  db.prepare(`
    INSERT INTO news_events
      (id, cluster_key, title_zh, summary_zh, impact_direction, impact_affected, impact_reason,
       first_published_at, last_published_at, source_count, zh_source_count, created_at, updated_at)
    VALUES (?, ?, ?, '摘要', 'neutral', ?, '理由', ?, ?, 1, 1, ?, ?)
  `).run(
    id,
    opts.clusterKey,
    opts.titleZh,
    JSON.stringify(opts.impactAffected ?? []),
    opts.firstPublishedAt ?? opts.lastPublishedAt,
    opts.lastPublishedAt,
    now,
    now
  );
  return id;
}

function insertSource(
  db: DatabaseSync,
  opts: { eventId: string; origin: string; publisher: string; url?: string | null; titleRaw: string; publishedAt?: string | null; lang?: string }
): void {
  db.prepare(`
    INSERT INTO news_event_sources
      (id, event_id, origin, publisher, url, title_raw, published_at, lang, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId("news_source"),
    opts.eventId,
    opts.origin,
    opts.publisher,
    opts.url ?? null,
    opts.titleRaw,
    opts.publishedAt ?? null,
    opts.lang ?? "zh",
    "2026-07-14T00:00:00.000Z"
  );
}

describe("listNewsEvents", () => {
  it("excludes events whose last_published_at is unknown (NULL) rather than treating them as now", () => {
    const db = memoryDb();
    insertEvent(db, { clusterKey: "known", titleZh: "已知时间事件", lastPublishedAt: "2026-07-14T10:00:00.000Z" });
    insertEvent(db, { clusterKey: "unknown", titleZh: "未知时间事件", lastPublishedAt: null });

    const events = listNewsEvents(db, { sinceIso: "2026-07-07T00:00:00.000Z" });

    expect(events).toHaveLength(1);
    expect(events[0]?.titleZh).toBe("已知时间事件");
  });

  it("applies the 7-day (or any) sinceIso window and orders newest last_published_at first", () => {
    const db = memoryDb();
    insertEvent(db, { clusterKey: "old", titleZh: "过期事件", lastPublishedAt: "2026-06-01T00:00:00.000Z" });
    insertEvent(db, { clusterKey: "newer", titleZh: "较新事件", lastPublishedAt: "2026-07-13T00:00:00.000Z" });
    insertEvent(db, { clusterKey: "newest", titleZh: "最新事件", lastPublishedAt: "2026-07-14T00:00:00.000Z" });

    const events = listNewsEvents(db, { sinceIso: "2026-07-07T00:00:00.000Z" });

    expect(events.map((event) => event.titleZh)).toEqual(["最新事件", "较新事件"]);
  });

  it("filters by symbol via impact_affected LIKE substring match", () => {
    const db = memoryDb();
    insertEvent(db, { clusterKey: "aapl-1", titleZh: "苹果相关事件", impactAffected: ["AAPL.US"], lastPublishedAt: "2026-07-14T00:00:00.000Z" });
    insertEvent(db, { clusterKey: "nvda-1", titleZh: "英伟达相关事件", impactAffected: ["NVDA.US"], lastPublishedAt: "2026-07-14T00:00:00.000Z" });

    const events = listNewsEvents(db, { sinceIso: "2026-07-07T00:00:00.000Z", symbol: "AAPL.US" });

    expect(events).toHaveLength(1);
    expect(events[0]?.titleZh).toBe("苹果相关事件");
  });

  it("filters by topic='宏观' matching an empty impact_affected OR an explicit '宏观' entry", () => {
    const db = memoryDb();
    insertEvent(db, { clusterKey: "macro-empty", titleZh: "宏观空标的事件", impactAffected: [], lastPublishedAt: "2026-07-14T00:00:00.000Z" });
    insertEvent(db, { clusterKey: "macro-explicit", titleZh: "宏观显式标记事件", impactAffected: ["宏观"], lastPublishedAt: "2026-07-14T00:00:00.000Z" });
    insertEvent(db, { clusterKey: "stock-only", titleZh: "个股事件", impactAffected: ["MSFT.US"], lastPublishedAt: "2026-07-14T00:00:00.000Z" });

    const events = listNewsEvents(db, { sinceIso: "2026-07-07T00:00:00.000Z", topic: "宏观" });

    expect(events.map((event) => event.titleZh).sort()).toEqual(["宏观显式标记事件", "宏观空标的事件"].sort());
  });

  it("attaches each event's sources, ordered by created_at ascending", () => {
    const db = memoryDb();
    const eventId = insertEvent(db, { clusterKey: "multi-source", titleZh: "多源事件", lastPublishedAt: "2026-07-14T00:00:00.000Z" });
    insertSource(db, { eventId, origin: "rsshub-cls", publisher: "财联社", url: "https://cls.cn/telegraph/1", titleRaw: "标题一", lang: "zh" });
    insertSource(db, { eventId, origin: "yahoo-finance-rss", publisher: "Barchart", url: "https://finance.yahoo.com/example", titleRaw: "Headline Two", lang: "en" });

    const events = listNewsEvents(db, { sinceIso: "2026-07-07T00:00:00.000Z" });

    expect(events).toHaveLength(1);
    expect(events[0]?.sources).toHaveLength(2);
    expect(events[0]?.sources.map((source) => source.publisher)).toEqual(["财联社", "Barchart"]);
  });
});

describe("listFilterSymbols", () => {
  it("returns distinct, active symbols across ALL owners (public news pool, not one member's watchlist)", () => {
    const db = memoryDb();
    const now = "2026-07-14T00:00:00.000Z";
    db.prepare(`INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
      .run("AAPL.US", "member_1", now, now);
    db.prepare(`INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
      .run("AAPL.US", "member_2", now, now);
    db.prepare(`INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
      .run("NVDA.US", "__legacy_shared__", now, now);
    db.prepare(`INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at) VALUES (?, ?, 0, ?, ?)`)
      .run("MSFT.US", "member_1", now, now);

    const symbols = listFilterSymbols(db);

    expect(symbols).toEqual(["AAPL.US", "NVDA.US"]);
  });
});
