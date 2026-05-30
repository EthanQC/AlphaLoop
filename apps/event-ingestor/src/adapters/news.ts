import { nowIso } from "@packages/shared-types";

import type { Event } from "@packages/shared-types";

import type { SourceAdapter } from "./base.js";
import { parseSymbolList, runLongbridgeJson } from "../longbridge-cli.js";

export class NewsAdapter implements SourceAdapter {
  readonly name = "news-adapter";

  async poll(_since?: string): Promise<Event[]> {
    const symbols = parseSymbolList(process.env.EVENT_INGESTOR_NEWS_SYMBOLS, ["QQQ.US"]);
    const count = String(Number(process.env.EVENT_INGESTOR_NEWS_COUNT ?? 10));
    const events: Event[] = [];

    for (const symbol of symbols) {
      const payload = await runLongbridgeJson(["news", symbol, "--count", count]);
      const rows = Array.isArray(payload) ? payload : [];
      for (const row of rows) {
        const event = articleToEvent(symbol, row);
        if (event) {
          events.push(event);
        }
      }
    }

    const healthMinute = new Date().toISOString().slice(0, 16);
    events.push({
      id: stableEventId("health_news_adapter", healthMinute),
      type: "system_health",
      source: this.name,
      symbols,
      ts: nowIso(),
      payload: {
        mode: "longbridge-news",
        emittedNews: events.length,
        symbols
      },
      importance: 0.1,
      dedupeKey: `health:${this.name}:${healthMinute}`
    });

    return events;
  }
}

function articleToEvent(symbol: string, row: unknown): Event | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const article = row as Record<string, unknown>;
  const id = String(article.id ?? article.url ?? "").trim();
  const title = String(article.title ?? "").replace(/\s+/gu, " ").trim();
  if (!id || !title) {
    return null;
  }

  const publishedAt = normalizePublishedAt(article.published_at);
  return {
    id: stableEventId("longbridge_news", id),
    type: "news",
    source: "longbridge-news",
    symbols: [symbol],
    ts: publishedAt,
    payload: {
      id,
      title,
      url: String(article.url ?? ""),
      likes: toNumber(article.likes_count),
      comments: toNumber(article.comments_count)
    },
    importance: 0.7,
    dedupeKey: `longbridge-news:${id}`
  };
}

function stableEventId(prefix: string, value: string): string {
  return `event_${prefix}_${value.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function normalizePublishedAt(value: unknown): string {
  const epoch = Number(value);
  if (Number.isFinite(epoch) && epoch > 0) {
    return new Date(epoch > 10_000_000_000 ? epoch : epoch * 1000).toISOString();
  }
  return nowIso();
}

function toNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
