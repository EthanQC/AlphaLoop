import type { Event } from "@packages/shared-types";
import { nowIso } from "@packages/shared-types";

import type { SourceAdapter } from "./base.js";
import { parseSymbolList, runLongbridgeJson } from "../longbridge-cli.js";

export class PriceAdapter implements SourceAdapter {
  readonly name = "price-adapter";

  async poll(_since?: string): Promise<Event[]> {
    const symbols = parseSymbolList(process.env.EVENT_INGESTOR_PRICE_SYMBOLS, ["QQQ.US"]);
    const payload = await runLongbridgeJson(["quote", ...symbols]);
    const rows = Array.isArray(payload) ? payload : [];

    return rows.map((row) => quoteToEvent(row)).filter((event): event is Event => Boolean(event));
  }
}

function quoteToEvent(row: unknown): Event | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const quote = row as Record<string, unknown>;
  const symbol = String(quote.symbol ?? "").toUpperCase();
  const last = toNumber(quote.last ?? quote.last_done);
  if (!symbol || last === null) {
    return null;
  }
  const timestamp = String(
    quote.timestamp
    ?? (quote.post_market_quote as Record<string, unknown> | undefined)?.timestamp
    ?? (quote.pre_market_quote as Record<string, unknown> | undefined)?.timestamp
    ?? nowIso()
  );

  return {
    id: stableEventId("longbridge_quote", `${symbol}_${timestamp.slice(0, 16)}`),
    type: "price_pulse",
    source: "longbridge-quote",
    symbols: [symbol],
    ts: normalizeTimestamp(timestamp),
    payload: {
      symbol,
      last,
      prevClose: toNumber(quote.prev_close),
      open: toNumber(quote.open),
      high: toNumber(quote.high),
      low: toNumber(quote.low),
      volume: toNumber(quote.volume),
      status: String(quote.status ?? "")
    },
    importance: 0.5,
    dedupeKey: `longbridge-quote:${symbol}:${timestamp.slice(0, 16)}`
  };
}

function stableEventId(prefix: string, value: string): string {
  return `event_${prefix}_${value.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function normalizeTimestamp(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso();
}

function toNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
