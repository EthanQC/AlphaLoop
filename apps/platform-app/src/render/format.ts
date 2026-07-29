/**
 * Shared display formatters for every reading surface in platform-app
 * (2026-07-30 spec-drift remediation, U1/U2).
 *
 * WHY THIS EXISTS: the operator opened `/stock/TSM.US` and read
 *
 *   2026-07-29T14:40:10.879Z  日内波动 -0.03323902016262659
 *
 * - a raw ISO instant and a raw decimal ratio, straight out of SQLite, in a
 * block meant for a human. Before this module the app had five private
 * copies of "format an instant" (home.ts, review.ts, research.ts, stock.ts,
 * reports.ts) and four private copies of "format a percent", and three
 * pages (stock.ts's alert history + thesis timeline, member-card.ts's and
 * strategy.ts's thesis timelines, proposal.ts's approval timeline) that had
 * no formatter at all and interpolated the column value directly. This
 * module is the one place those live now.
 *
 * UNIT CONTRACT FOR `formatAlertValue` - VERIFIED AGAINST THE REAL PRODUCER,
 * NOT ASSUMED. `alert_events.value` is written by market-alerts-poll.mjs
 * from market-alerts-engine.mjs's evaluator return, and every one of the
 * four rule types puts a DECIMAL RATIO there:
 *   - daily_move      `price / prevClose - 1`      (engine evaluateDailyMove)
 *   - unrealized_pnl  `price / costPrice - 1`      (engine evaluateUnrealizedPnl)
 *   - spike_5m        `price / referencePrice - 1` (engine evaluateSpike5m)
 *   - exposure        `exposureRatio`              (engine evaluateExposure)
 * The Feishu card renderer (market-alerts-cards.mjs) states the same
 * contract in its header ("`value` is a decimal ratio (e.g. -0.043 =
 * -4.3%)") and renders daily_move/unrealized_pnl/spike_5m SIGNED and
 * exposure UNSIGNED (its ratio is one-sided, over-budget only). This module
 * mirrors that split exactly, so the card a member gets in Feishu and the
 * row they later read on the web page describe the same event the same way.
 *
 * ONE DELIBERATE DIFFERENCE FROM THE CARD: the card uses 1 decimal
 * (`-4.3%`) because it is a glanceable push notification; the web page uses
 * 2 (`-3.32%`) because it is the durable record the operator scrolls back
 * through, and because -3.32% and -3.35% must not both read as "-3.3%" in a
 * history list. Both are honest roundings of the same stored ratio; neither
 * is the stored ratio itself, which is why the page keeps the full value in
 * the row's `title` attribute (see routes/stock.ts).
 *
 * NEVER FABRICATE (Global Constraints): an unparseable instant is returned
 * VERBATIM rather than rendered as "Invalid Date" or silently swallowed,
 * and a non-finite number renders as 数据缺失 rather than "NaN%" or "0%". A
 * computed 0 where the truth is "unknown" is a fabrication.
 */

const BEIJING_ZONE = "Asia/Shanghai";

const CN_WEEKDAY_BY_EN: Record<string, string> = {
  Sun: "日",
  Mon: "一",
  Tue: "二",
  Wed: "三",
  Thu: "四",
  Fri: "五",
  Sat: "六"
};

// Intl.DateTimeFormat construction is the expensive part; these are hoisted
// to module scope and reused across every row of every page (an alert
// history renders up to 20 rows, a report list up to a few hundred).
// Beijing has no DST, so a fixed IANA zone is exact year-round.
const SHORT_DATETIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: BEIJING_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const FULL_DATETIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: BEIJING_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: BEIJING_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const WEEKDAY_DATETIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: BEIJING_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short"
});

function partsOf(format: Intl.DateTimeFormat, date: Date): Map<string, string> {
  return new Map(format.formatToParts(date).map((part) => [part.type, part.value]));
}

function parseInstant(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `MM-DD HH:mm` Beijing, e.g. `2026-07-29T14:40:10.879Z` -> `07-29 22:40`.
 * An unparseable input is returned verbatim (see module header).
 */
export function formatBeijingShortTime(iso: string): string {
  const date = parseInstant(iso);
  if (!date) {
    return iso;
  }
  const p = partsOf(SHORT_DATETIME_FORMAT, date);
  return `${p.get("month")}-${p.get("day")} ${p.get("hour")}:${p.get("minute")}`;
}

/** `YYYY-MM-DD HH:mm` Beijing - for timelines that span more than a year. */
export function formatBeijingDateTime(iso: string): string {
  const date = parseInstant(iso);
  if (!date) {
    return iso;
  }
  const p = partsOf(FULL_DATETIME_FORMAT, date);
  return `${p.get("year")}-${p.get("month")}-${p.get("day")} ${p.get("hour")}:${p.get("minute")}`;
}

/** `YYYY-MM-DD` for an instant, in Beijing. */
export function formatBeijingDay(date: Date): string {
  const p = partsOf(DAY_FORMAT, date);
  return `${p.get("year")}-${p.get("month")}-${p.get("day")}`;
}

/**
 * `MM-DD 周X HH:mm` Beijing - the topbar's own long form. (layout.ts's
 * `formatBeijingGeneratedAt` delegates here; kept as a separate exported
 * name there because tests and other callers already reference it.)
 */
export function formatBeijingWeekdayTime(date: Date): string {
  const p = partsOf(WEEKDAY_DATETIME_FORMAT, date);
  const weekdayEn = p.get("weekday") ?? "";
  const weekdayCn = CN_WEEKDAY_BY_EN[weekdayEn] ?? weekdayEn;
  return `${p.get("month")}-${p.get("day")} 周${weekdayCn} ${p.get("hour")}:${p.get("minute")}`;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** What a reader sees where a number should be but the number is unknown.
 * Deliberately NOT "0", "-", or "—": those all read as a measured value. */
export const MISSING_NUMBER_TEXT = "数据缺失";

/** `-0.0332390201626266` -> `-3.32%`; `0.03` -> `+3.00%`. Non-finite input
 * (NaN/Infinity, e.g. a corrupt column) renders 数据缺失, never "NaN%". */
export function formatRatioAsSignedPercent(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) {
    return MISSING_NUMBER_TEXT;
  }
  const pct = ratio * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(digits)}%`;
}

/** `0.104` -> `10.40%` - for one-sided ratios where a "+" would be noise. */
export function formatRatioAsUnsignedPercent(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) {
    return MISSING_NUMBER_TEXT;
  }
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** A value ALREADY in percent units (e.g. stock_facts' `quote.pct`, whose
 * `unit` column literally says `pct`) -> `-2.20%`. Distinct from
 * formatRatioAsSignedPercent on purpose: multiplying an already-percent
 * value by 100 was exactly the class of bug this module exists to end. */
export function formatPercentUnits(pct: number, digits = 2): string {
  if (!Number.isFinite(pct)) {
    return MISSING_NUMBER_TEXT;
  }
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(digits)}%`;
}

/** Rule types whose stored ratio is one-sided (never negative) and so reads
 * better unsigned - mirrors market-alerts-cards.mjs's own exposure branch. */
const UNSIGNED_RULE_TYPES = new Set(["exposure"]);

/**
 * Formats an `alert_events.value` for display, given its rule type. See the
 * module header's UNIT CONTRACT: every rule type stores a decimal ratio;
 * only `exposure` is one-sided.
 */
export function formatAlertValue(ruleType: string, value: number): string {
  return UNSIGNED_RULE_TYPES.has(ruleType)
    ? formatRatioAsUnsignedPercent(value)
    : formatRatioAsSignedPercent(value);
}

/** `394.525` -> `394.53`; unknown -> 数据缺失. */
export function formatPrice(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return MISSING_NUMBER_TEXT;
  }
  return value.toFixed(digits);
}

/** Thousands-separated integer, e.g. `8570295` -> `8,570,295`. */
export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return MISSING_NUMBER_TEXT;
  }
  return Math.round(value).toLocaleString("en-US");
}

/** Big USD amounts as 万亿/亿/万 - a raw `60941068000000` is unreadable. */
export function formatLargeAmount(value: number | null | undefined, unit = "美元"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return MISSING_NUMBER_TEXT;
  }
  const abs = Math.abs(value);
  if (abs >= 1e12) {
    return `${(value / 1e12).toFixed(2)} 万亿${unit}`;
  }
  if (abs >= 1e8) {
    return `${(value / 1e8).toFixed(2)} 亿${unit}`;
  }
  if (abs >= 1e4) {
    return `${(value / 1e4).toFixed(2)} 万${unit}`;
  }
  return `${value.toFixed(2)} ${unit}`;
}

// ---------------------------------------------------------------------------
// Staleness (U2)
// ---------------------------------------------------------------------------

/** How old a reading surface's DATA is, in whole Beijing calendar days. */
export interface DataAge {
  /** Whole Beijing days between the data's day and today. 0 = today. */
  days: number;
  /** `今日` / `昨天` / `3 天前`. */
  ago: string;
  /** True once the data is old enough that a reader must be warned. */
  stale: boolean;
}

/** A reader is warned from 2 days on: yesterday's close is the normal state
 * of a pre-open daily report, but the day before that is not. */
export const STALE_AFTER_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole Beijing calendar days between `day` (a `YYYY-MM-DD` string, as
 * stored in `reports` filenames / `stock_facts.trading_day`) and `now`.
 * Returns null when `day` isn't a well-formed date - the caller must then
 * say so rather than print a computed 0 (a fabricated "今日").
 */
export function beijingDayAge(day: string, now: Date): DataAge | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
    return null;
  }
  const todayMs = Date.parse(`${formatBeijingDay(now)}T00:00:00Z`);
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(todayMs) || Number.isNaN(dayMs)) {
    return null;
  }
  const days = Math.round((todayMs - dayMs) / MS_PER_DAY);
  return { days, ago: describeAgo(days), stale: days >= STALE_AFTER_DAYS };
}

/** Same, for an instant rather than a calendar day: the age is measured
 * between the instant's Beijing DAY and today's, so a quote from 07-27
 * 16:36 is "3 天前" on 07-30 regardless of the hour. */
export function beijingInstantAge(iso: string, now: Date): DataAge | null {
  const date = parseInstant(iso);
  return date ? beijingDayAge(formatBeijingDay(date), now) : null;
}

function describeAgo(days: number): string {
  if (days <= 0) {
    // Negative would mean data dated in the future (a clock skew or a
    // mis-stamped row). Say so instead of silently calling it 今日.
    return days < 0 ? `数据日期晚于今日（${Math.abs(days)} 天后）` : "今日";
  }
  if (days === 1) {
    return "昨天";
  }
  return `${days} 天前`;
}

/**
 * The topbar's data-time descriptor: `07-27（3 天前）`. `day` is a
 * `YYYY-MM-DD`; an unrecognizable one is passed through with no age claim
 * rather than given a fabricated one.
 */
export function describeDataDay(day: string, now: Date): string {
  const age = beijingDayAge(day, now);
  const short = /^\d{4}-(\d{2}-\d{2})$/u.exec(day)?.[1] ?? day;
  return age ? `${short}（${age.ago}）` : day;
}

/** Same for an instant, keeping the time-of-day: `07-27 16:36（3 天前）`. */
export function describeDataInstant(iso: string, now: Date): string {
  const age = beijingInstantAge(iso, now);
  const shown = formatBeijingShortTime(iso);
  return age ? `${shown}（${age.ago}）` : shown;
}
