import type { Event } from "@packages/shared-types";
import { nowIso } from "@packages/shared-types";

import type { SourceAdapter } from "./base.js";
import { runLongbridgeJson } from "../longbridge-cli.js";

export class CalendarAdapter implements SourceAdapter {
  readonly name = "calendar-adapter";

  async poll(_since?: string): Promise<Event[]> {
    const start = formatDate(new Date());
    const end = formatDate(addDays(new Date(), Number(process.env.EVENT_INGESTOR_CALENDAR_LOOKAHEAD_DAYS ?? 14)));
    const payload = await runLongbridgeJson([
      "finance-calendar",
      "macrodata",
      "--market",
      "US",
      "--star",
      "2",
      "--star",
      "3",
      "--start",
      start,
      "--end",
      end,
      "--count",
      String(Number(process.env.EVENT_INGESTOR_CALENDAR_COUNT ?? 20))
    ]);
    return flattenCalendar(payload).map((row) => calendarToEvent(row)).filter((event): event is Event => Boolean(event));
  }
}

function flattenCalendar(payload: unknown): Array<Record<string, unknown> & { groupDate?: string }> {
  const groups = Array.isArray((payload as { list?: unknown[] })?.list)
    ? (payload as { list: unknown[] }).list
    : Array.isArray(payload)
      ? payload
      : [];
  const out: Array<Record<string, unknown> & { groupDate?: string }> = [];
  for (const group of groups) {
    const item = group as Record<string, unknown>;
    const infos = Array.isArray(item.infos) ? item.infos : [];
    for (const info of infos) {
      out.push({ ...(info as Record<string, unknown>), groupDate: String(item.date ?? "") });
    }
  }
  return out;
}

function calendarToEvent(row: Record<string, unknown> & { groupDate?: string }): Event | null {
  const id = String(row.id ?? "").trim();
  const title = String(row.content ?? "").replace(/\s+/gu, " ").trim();
  if (!id || !title) {
    return null;
  }
  const ts = normalizeEpoch(row.datetime, row.groupDate);
  return {
    id: stableEventId("longbridge_calendar", id),
    type: "calendar",
    source: "longbridge-finance-calendar",
    symbols: [],
    ts,
    payload: {
      id,
      title,
      market: String(row.market ?? ""),
      star: toNumber(row.star),
      date: String(row.groupDate ?? ""),
      time: String(row.date ?? ""),
      values: Array.isArray(row.data_kv) ? row.data_kv : []
    },
    importance: Number(row.star ?? 0) >= 3 ? 0.8 : 0.6,
    dedupeKey: `longbridge-calendar:${id}`
  };
}

function stableEventId(prefix: string, value: string): string {
  return `event_${prefix}_${value.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function normalizeEpoch(value: unknown, fallbackDate: unknown): string {
  const epoch = Number(value);
  if (Number.isFinite(epoch) && epoch > 0) {
    return new Date(epoch > 10_000_000_000 ? epoch : epoch * 1000).toISOString();
  }
  const parsed = new Date(String(fallbackDate ?? "")).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso();
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
