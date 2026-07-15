import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const store = await import("./news-store.mjs");

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-news-store-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  return openTradingDatabase(dbPath);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function baseEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    clusterKey: "cluster_1",
    titleZh: "美联储维持利率不变",
    summaryZh: "美联储在最新会议上维持利率不变。",
    impactDirection: "neutral",
    impactAffected: ["宏观"],
    impactReason: "货币政策保持稳定",
    ...overrides
  };
}

function source(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    origin: "wallstreetcn",
    publisher: "华尔街见闻",
    url: "https://wallstreetcn.com/articles/123",
    titleRaw: "美联储维持利率不变",
    publishedAt: "2026-07-14T10:00:00.000Z",
    lang: "zh",
    ...overrides
  };
}

describe("upsertEventWithSources", () => {
  it("creates a new event with sources and returns eventId/insertedSources/skippedDuplicates", () => {
    const db = makeDb();

    const result = store.upsertEventWithSources(db, baseEvent(), [source()]);

    expect(result.eventId).toEqual(expect.any(String));
    expect(result.insertedSources).toBe(1);
    expect(result.skippedDuplicates).toBe(0);

    const row = db.prepare("SELECT * FROM news_events WHERE id = ?").get(result.eventId) as Record<string, unknown>;
    expect(row.cluster_key).toBe("cluster_1");
    expect(row.title_zh).toBe("美联储维持利率不变");
    expect(row.source_count).toBe(1);
    expect(row.zh_source_count).toBe(1);
    expect(row.first_published_at).toBe("2026-07-14T10:00:00.000Z");
    expect(row.last_published_at).toBe("2026-07-14T10:00:00.000Z");
  });

  it("upserting the same cluster_key twice updates the existing event instead of creating a duplicate row", () => {
    const db = makeDb();

    const first = store.upsertEventWithSources(db, baseEvent(), [source()]);
    const second = store.upsertEventWithSources(
      db,
      baseEvent({ titleZh: "美联储维持利率不变（更新）", summaryZh: "更新后的摘要" }),
      []
    );

    expect(second.eventId).toBe(first.eventId);

    const count = (db.prepare("SELECT COUNT(*) c FROM news_events").get() as { c: number }).c;
    expect(count).toBe(1);

    const row = db.prepare("SELECT title_zh, summary_zh FROM news_events WHERE id = ?").get(first.eventId) as {
      title_zh: string;
      summary_zh: string;
    };
    expect(row.title_zh).toBe("美联储维持利率不变（更新）");
    expect(row.summary_zh).toBe("更新后的摘要");
  });

  it("dedupes sources by normalized url - the same url added twice is only stored once", () => {
    const db = makeDb();

    store.upsertEventWithSources(db, baseEvent(), [source()]);
    const second = store.upsertEventWithSources(db, baseEvent(), [
      source({ url: "https://WallStreetCN.com/articles/123/" }) // same article, different case + trailing slash
    ]);

    expect(second.insertedSources).toBe(0);
    expect(second.skippedDuplicates).toBe(1);

    const count = (db.prepare("SELECT COUNT(*) c FROM news_event_sources").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("dedupes sources by title_raw when url is null", () => {
    const db = makeDb();

    store.upsertEventWithSources(db, baseEvent(), [source({ url: null, titleRaw: "同一篇报道" })]);
    const second = store.upsertEventWithSources(db, baseEvent(), [
      source({ url: null, titleRaw: "同一篇报道", origin: "gelonghui" })
    ]);

    expect(second.insertedSources).toBe(0);
    expect(second.skippedDuplicates).toBe(1);
  });

  it("deduplicates within a single batch, not just against already-stored sources", () => {
    const db = makeDb();

    const result = store.upsertEventWithSources(db, baseEvent(), [
      source({ url: "https://a.com/x" }),
      source({ url: "https://a.com/x", origin: "google-news" }),
      source({ url: "https://a.com/y" })
    ]);

    expect(result.insertedSources).toBe(2);
    expect(result.skippedDuplicates).toBe(1);
  });

  it("recomputes zh_source_count from only lang='zh' sources", () => {
    const db = makeDb();

    store.upsertEventWithSources(db, baseEvent(), [
      source({ url: "https://a.com/1", lang: "zh" }),
      source({ url: "https://a.com/2", lang: "en" }),
      source({ url: "https://a.com/3", lang: "unknown" })
    ]);

    const row = db.prepare("SELECT source_count, zh_source_count FROM news_events").get() as {
      source_count: number;
      zh_source_count: number;
    };
    expect(row.source_count).toBe(3);
    expect(row.zh_source_count).toBe(1);
  });

  it("computes first/last_published_at as MIN/MAX over non-null published_at, ignoring unknown-time sources", () => {
    const db = makeDb();

    store.upsertEventWithSources(db, baseEvent(), [
      source({ url: "https://a.com/1", publishedAt: "2026-07-14T08:00:00.000Z" }),
      source({ url: "https://a.com/2", publishedAt: "2026-07-14T12:00:00.000Z" }),
      source({ url: "https://a.com/3", publishedAt: null })
    ]);

    const row = db.prepare("SELECT first_published_at, last_published_at FROM news_events").get() as {
      first_published_at: string;
      last_published_at: string;
    };
    expect(row.first_published_at).toBe("2026-07-14T08:00:00.000Z");
    expect(row.last_published_at).toBe("2026-07-14T12:00:00.000Z");
  });

  it("first/last_published_at stay NULL when every source has an unknown publish time", () => {
    const db = makeDb();

    store.upsertEventWithSources(db, baseEvent(), [
      source({ url: "https://a.com/1", publishedAt: null }),
      source({ url: "https://a.com/2", publishedAt: null })
    ]);

    const row = db.prepare("SELECT first_published_at, last_published_at FROM news_events").get() as {
      first_published_at: string | null;
      last_published_at: string | null;
    };
    expect(row.first_published_at).toBeNull();
    expect(row.last_published_at).toBeNull();
  });

  it("rolls back the whole transaction when a source insert fails (e.g. a required field missing)", () => {
    const db = makeDb();

    expect(() =>
      store.upsertEventWithSources(db, baseEvent(), [
        source({ url: "https://a.com/ok" }),
        // titleRaw is NOT NULL in the DDL - passing undefined binds NULL and
        // must throw, and the whole upsert (including the otherwise-valid
        // first source) must roll back with it.
        source({ url: "https://a.com/bad", titleRaw: undefined })
      ])
    ).toThrow();

    const count = (db.prepare("SELECT COUNT(*) c FROM news_events").get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

describe("listEventsInWindow", () => {
  it("excludes events whose last_published_at is NULL (unknown time never matches a window)", () => {
    const db = makeDb();
    store.upsertEventWithSources(db, baseEvent({ clusterKey: "known" }), [
      source({ url: "https://a.com/1", publishedAt: "2026-07-14T10:00:00.000Z" })
    ]);
    store.upsertEventWithSources(db, baseEvent({ clusterKey: "unknown_time" }), [
      source({ url: "https://a.com/2", publishedAt: null })
    ]);

    const events = store.listEventsInWindow(db, { sinceIso: "2026-07-01T00:00:00.000Z" });

    expect(events.map((e: { clusterKey: string }) => e.clusterKey)).toEqual(["known"]);
  });

  it("excludes events whose last_published_at is before sinceIso", () => {
    const db = makeDb();
    store.upsertEventWithSources(db, baseEvent({ clusterKey: "old" }), [
      source({ url: "https://a.com/1", publishedAt: "2026-06-01T00:00:00.000Z" })
    ]);
    store.upsertEventWithSources(db, baseEvent({ clusterKey: "recent" }), [
      source({ url: "https://a.com/2", publishedAt: "2026-07-14T00:00:00.000Z" })
    ]);

    const events = store.listEventsInWindow(db, { sinceIso: "2026-07-01T00:00:00.000Z" });

    expect(events.map((e: { clusterKey: string }) => e.clusterKey)).toEqual(["recent"]);
  });

  it("orders results by last_published_at DESC", () => {
    const db = makeDb();
    store.upsertEventWithSources(db, baseEvent({ clusterKey: "earlier" }), [
      source({ url: "https://a.com/1", publishedAt: "2026-07-10T00:00:00.000Z" })
    ]);
    store.upsertEventWithSources(db, baseEvent({ clusterKey: "later" }), [
      source({ url: "https://a.com/2", publishedAt: "2026-07-14T00:00:00.000Z" })
    ]);

    const events = store.listEventsInWindow(db, { sinceIso: "2026-07-01T00:00:00.000Z" });

    expect(events.map((e: { clusterKey: string }) => e.clusterKey)).toEqual(["later", "earlier"]);
  });

  it("each event carries its sources[]", () => {
    const db = makeDb();
    store.upsertEventWithSources(db, baseEvent({ clusterKey: "with_sources" }), [
      source({ url: "https://a.com/1", publisher: "华尔街见闻" }),
      source({ url: "https://a.com/2", publisher: "格隆汇", origin: "gelonghui" })
    ]);

    const events = store.listEventsInWindow(db, { sinceIso: "2026-07-01T00:00:00.000Z" });

    expect(events).toHaveLength(1);
    expect(events[0].sources).toHaveLength(2);
    expect(events[0].sources.map((s: { publisher: string }) => s.publisher).sort()).toEqual(["华尔街见闻", "格隆汇"]);
  });

  it("filters by symbol via impact_affected containment", () => {
    const db = makeDb();
    store.upsertEventWithSources(
      db,
      baseEvent({ clusterKey: "aapl_event", impactAffected: ["AAPL.US"] }),
      [source({ url: "https://a.com/1", publishedAt: "2026-07-14T00:00:00.000Z" })]
    );
    store.upsertEventWithSources(
      db,
      baseEvent({ clusterKey: "msft_event", impactAffected: ["MSFT.US"] }),
      [source({ url: "https://a.com/2", publishedAt: "2026-07-14T00:00:00.000Z" })]
    );

    const events = store.listEventsInWindow(db, { sinceIso: "2026-07-01T00:00:00.000Z", symbol: "AAPL.US" });

    expect(events.map((e: { clusterKey: string }) => e.clusterKey)).toEqual(["aapl_event"]);
  });

  it("filters by topic='宏观' - matches empty impact_affected or an explicit '宏观' entry", () => {
    const db = makeDb();
    store.upsertEventWithSources(
      db,
      baseEvent({ clusterKey: "macro_explicit", impactAffected: ["宏观"] }),
      [source({ url: "https://a.com/1", publishedAt: "2026-07-14T00:00:00.000Z" })]
    );
    store.upsertEventWithSources(
      db,
      baseEvent({ clusterKey: "macro_empty", impactAffected: [] }),
      [source({ url: "https://a.com/2", publishedAt: "2026-07-14T00:00:00.000Z" })]
    );
    store.upsertEventWithSources(
      db,
      baseEvent({ clusterKey: "single_stock", impactAffected: ["AAPL.US"] }),
      [source({ url: "https://a.com/3", publishedAt: "2026-07-14T00:00:00.000Z" })]
    );

    const events = store.listEventsInWindow(db, { sinceIso: "2026-07-01T00:00:00.000Z", topic: "宏观" });

    expect(events.map((e: { clusterKey: string }) => e.clusterKey).sort()).toEqual(["macro_empty", "macro_explicit"]);
  });

  it("returns an empty array when nothing matches, without erroring on the sources lookup", () => {
    const db = makeDb();

    const events = store.listEventsInWindow(db, { sinceIso: "2026-07-01T00:00:00.000Z" });

    expect(events).toEqual([]);
  });
});

describe("daily facts", () => {
  it("replaceDailyFacts + getDailyFacts round-trip, keyed by fact_key", () => {
    const db = makeDb();

    store.replaceDailyFacts(db, "2026-07-14", [
      { factKey: "qqq_price", valueNum: 522.31, unit: "USD", source: "longbridge", dataTime: "2026-07-14T20:00:00.000Z" },
      { factKey: "qqq_change_pct", valueNum: 1.23, unit: "%", source: "longbridge", dataTime: "2026-07-14T20:00:00.000Z" }
    ]);

    const facts = store.getDailyFacts(db, "2026-07-14");

    expect(facts.qqq_price).toMatchObject({ valueNum: 522.31, unit: "USD", source: "longbridge" });
    expect(facts.qqq_change_pct).toMatchObject({ valueNum: 1.23, unit: "%" });
  });

  it("replaceDailyFacts fully replaces the day - a fact dropped from the new list disappears", () => {
    const db = makeDb();

    store.replaceDailyFacts(db, "2026-07-14", [
      { factKey: "qqq_price", valueNum: 522.31, unit: "USD", source: "longbridge", dataTime: "2026-07-14T20:00:00.000Z" },
      { factKey: "net_assets", valueNum: 100000, unit: "USD", source: "longbridge", dataTime: "2026-07-14T20:00:00.000Z" }
    ]);
    store.replaceDailyFacts(db, "2026-07-14", [
      { factKey: "qqq_price", valueNum: 530.0, unit: "USD", source: "longbridge", dataTime: "2026-07-14T21:00:00.000Z" }
    ]);

    const facts = store.getDailyFacts(db, "2026-07-14");

    expect(Object.keys(facts)).toEqual(["qqq_price"]);
    expect(facts.qqq_price.valueNum).toBe(530.0);
  });

  it("replaceDailyFacts does not touch a different trading_day's facts", () => {
    const db = makeDb();

    store.replaceDailyFacts(db, "2026-07-13", [
      { factKey: "qqq_price", valueNum: 500.0, unit: "USD", source: "longbridge", dataTime: "2026-07-13T20:00:00.000Z" }
    ]);
    store.replaceDailyFacts(db, "2026-07-14", [
      { factKey: "qqq_price", valueNum: 522.31, unit: "USD", source: "longbridge", dataTime: "2026-07-14T20:00:00.000Z" }
    ]);

    expect(store.getDailyFacts(db, "2026-07-13").qqq_price.valueNum).toBe(500.0);
    expect(store.getDailyFacts(db, "2026-07-14").qqq_price.valueNum).toBe(522.31);
  });

  it("getDailyFacts returns an empty object for a day with no facts", () => {
    const db = makeDb();

    expect(store.getDailyFacts(db, "2026-01-01")).toEqual({});
  });

  it("supports value_text facts (valueNum null) alongside numeric ones", () => {
    const db = makeDb();

    store.replaceDailyFacts(db, "2026-07-14", [
      { factKey: "market_regime", valueText: "risk-on", source: "manual", dataTime: "2026-07-14T20:00:00.000Z" }
    ]);

    const facts = store.getDailyFacts(db, "2026-07-14");
    expect(facts.market_regime).toMatchObject({ valueNum: null, valueText: "risk-on" });
  });
});

// Phase 4 Task 8 (news engine deployment wiring): openclaw-runtime-doctor-
// core.mjs's news-engine-health check needs "how many events, and what's the
// freshest one" without duplicating SQL outside this store module (per this
// file's own header - news-engine.mjs and renderers never touch SQL
// directly; the doctor follows the same rule).
describe("newsEngineHealthStats", () => {
  it("reports eventCount 0 and lastPublishedAt null on a freshly migrated, never-fed database", () => {
    const db = makeDb();

    const stats = store.newsEngineHealthStats(db);

    expect(stats).toEqual({ eventCount: 0, lastPublishedAt: null });
  });

  it("reports the true event count and the MAX(last_published_at) across all stored events", () => {
    const db = makeDb();

    store.upsertEventWithSources(db, baseEvent({ clusterKey: "cluster_a" }), [
      source({ publishedAt: "2026-07-10T00:00:00.000Z" })
    ]);
    store.upsertEventWithSources(db, baseEvent({ clusterKey: "cluster_b" }), [
      source({ publishedAt: "2026-07-14T09:00:00.000Z", url: "https://wallstreetcn.com/articles/456" })
    ]);

    const stats = store.newsEngineHealthStats(db);

    expect(stats.eventCount).toBe(2);
    expect(stats.lastPublishedAt).toBe("2026-07-14T09:00:00.000Z");
  });

  it("reports lastPublishedAt null when every stored event's own last_published_at is unknown (all sources unknown-time)", () => {
    const db = makeDb();

    store.upsertEventWithSources(db, baseEvent({ clusterKey: "cluster_unknown_time" }), [
      source({ publishedAt: null })
    ]);

    const stats = store.newsEngineHealthStats(db);

    expect(stats.eventCount).toBe(1);
    expect(stats.lastPublishedAt).toBeNull();
  });
});
