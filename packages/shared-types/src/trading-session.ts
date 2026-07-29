/**
 * "Which US regular-hours trading session are we in / was the last one?"
 * (Task 22, 2026-07-30).
 *
 * WHY THIS EXISTS
 * ---------------
 * Requirements §1.1 defines the home page's 提醒流水 as "最近一个美股交易时段
 * （北京时间约 21:30–次日凌晨 4/5 点）". The page's empty state already SAID
 * exactly that - 「最近一个美股交易时段你没有触发过提醒」 - while the reader
 * behind it (`loadRecentAlertEvents`) had no session filter at all and simply
 * returned the newest 10 rows of any age. A member whose last alert fired
 * three sessions ago was told it was from the most recent one. That is the
 * claim-dishonesty class, in production, in Chinese, on the front page.
 *
 * WHY IT IS IN shared-types AND NOT COPIED INTO platform-app
 * ----------------------------------------------------------
 * The NYSE close calendar already exists, in
 * apps/openclaw-config/scripts/trading-schedule.mjs, which is a plain .mjs
 * outside platform-app's tsc project (apps/platform-app can't import it
 * statically - see research/worker.ts's header for that whole story). The
 * tempting move is to paste the holiday list here. A pasted calendar drifts
 * the first time someone adds a year to only one copy, and NOTHING would
 * fail - the web page would just quietly disagree with the scheduler about
 * which days the market is open.
 *
 * So the list lives here ONCE, and trading-session.test.ts extracts the
 * literal `NYSE_FULL_CLOSE_DATES` / `NYSE_EARLY_CLOSE_DATES` sets out of
 * trading-schedule.mjs's SOURCE TEXT and asserts they equal these. Add a year
 * to one file and that test fails by name. This mirrors the parity check
 * trading-schedule.test.ts already runs on the two copies of
 * `nyMidnightUtcIso` - an executable guard, not a cross-referencing comment.
 *
 * All zone math is delegated to `usEasternTradingDayUtcRange` in database.ts
 * (the DST-correct local-midnight computation, itself parity-checked against
 * the .mjs), so this module adds no third implementation of it.
 */
import { usEasternTradingDayUtcRange } from "./database.js";

const NEW_YORK_TIMEZONE = "America/New_York";

/**
 * Dates the NYSE is CLOSED all day. Kept in sync with
 * apps/openclaw-config/scripts/trading-schedule.mjs by
 * trading-session.test.ts's source-text parity check (see module header).
 */
export const NYSE_FULL_CLOSE_DATES: ReadonlySet<string> = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25"
]);

/** Dates the NYSE closes early (13:00 ET instead of 16:00 ET). Same parity
 * guard as the full-close set above. */
export const NYSE_EARLY_CLOSE_DATES: ReadonlySet<string> = new Set([
  "2026-11-27",
  "2026-12-24"
]);

/** Years the two calendars above actually cover. Outside these, this module
 * refuses to answer rather than silently treating an uncovered year as
 * "no holidays" - the same posture trading-schedule.mjs's
 * `assertCalendarCoverage` takes. */
export const TRADING_CALENDAR_YEARS: readonly number[] = Array.from(
  new Set([...NYSE_FULL_CLOSE_DATES, ...NYSE_EARLY_CLOSE_DATES].map((label) => Number(label.slice(0, 4))))
).sort((a, b) => a - b);

const WEEKDAY_INDEX = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6]
]);

interface ZonedParts {
  year: number;
  weekday: number;
  hour: number;
  minute: number;
  dateLabel: string;
}

function newYorkParts(date: Date): ZonedParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: NEW_YORK_TIMEZONE,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    weekday: WEEKDAY_INDEX.get(String(parts.weekday)) ?? -1,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dateLabel: `${parts.year}-${parts.month}-${parts.day}`
  };
}

function shiftDateLabel(dateLabel: string, days: number): string {
  // Anchored at noon UTC before shifting: America/New_York is at most 5h
  // behind UTC, so a noon anchor never lands on a different calendar day
  // there. Same trick trading-schedule.mjs's own `shiftDateLabel` uses.
  const anchor = new Date(`${dateLabel}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  const y = anchor.getUTCFullYear();
  const m = String(anchor.getUTCMonth() + 1).padStart(2, "0");
  const d = String(anchor.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A weekday that is not a full NYSE holiday. */
export function isUsTradingDay(dateLabel: string): boolean {
  const weekday = new Date(`${dateLabel}T12:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5 && !NYSE_FULL_CLOSE_DATES.has(dateLabel);
}

/** Regular-session close, in minutes past midnight ET: 13:00 on an early-close
 * date, 16:00 otherwise. Open is always 09:30. */
const OPEN_MINUTE = 9 * 60 + 30;
function closeMinute(dateLabel: string): number {
  return NYSE_EARLY_CLOSE_DATES.has(dateLabel) ? 13 * 60 : 16 * 60;
}

export interface UsTradingSession {
  /** US/Eastern calendar date of the session, 'YYYY-MM-DD'. */
  tradingDay: string;
  /** UTC instant of 09:30 America/New_York on `tradingDay`. */
  startUtcIso: string;
  /**
   * UTC instant of the session's close (16:00 ET, or 13:00 ET on an
   * early-close date) - or `now` when the session is still running, so a
   * caller filtering `[startUtcIso, endUtcIso)` never claims to cover time
   * that has not happened yet.
   */
  endUtcIso: string;
  /** True while `now` is inside this session's regular hours. */
  inProgress: boolean;
}

/**
 * The most recent US regular-hours session as of `now`: today's if the market
 * has already opened today, otherwise the last day it was open (skipping
 * weekends and full-close holidays; up to 10 calendar days back, which covers
 * any real holiday cluster).
 *
 * Returns `null` when `now` falls outside the years the calendar above covers
 * - the honest answer is "I don't know when the last session was", not a
 * weekday-only guess that would silently call a holiday a trading day.
 */
export function latestUsTradingSession(now: Date): UsTradingSession | null {
  const parts = newYorkParts(now);
  if (!TRADING_CALENDAR_YEARS.includes(parts.year)) {
    return null;
  }

  const minuteOfDay = parts.hour * 60 + parts.minute;
  const todayHasOpened = isUsTradingDay(parts.dateLabel) && minuteOfDay >= OPEN_MINUTE;

  let dayLabel = todayHasOpened ? parts.dateLabel : shiftDateLabel(parts.dateLabel, -1);
  for (let back = 0; back < 10; back += 1) {
    if (isUsTradingDay(dayLabel)) {
      const { dayStart } = usEasternTradingDayUtcRange(dayLabel);
      const dayStartMs = Date.parse(dayStart);
      const startMs = dayStartMs + OPEN_MINUTE * 60_000;
      const closeMs = dayStartMs + closeMinute(dayLabel) * 60_000;
      const nowMs = now.getTime();
      const inProgress = nowMs >= startMs && nowMs < closeMs;
      return {
        tradingDay: dayLabel,
        startUtcIso: new Date(startMs).toISOString(),
        endUtcIso: new Date(inProgress ? nowMs : closeMs).toISOString(),
        inProgress
      };
    }
    dayLabel = shiftDateLabel(dayLabel, -1);
  }
  return null;
}

/**
 * UTC instant of 00:00 America/New_York on the Monday of the US/Eastern week
 * containing `now` - the baseline boundary circuit-breaker.mjs's
 * `computeWeeklyLoss` uses ("本交易周" = Monday 00:00 ET onward). Exported so
 * the platform's read-side weekly-loss figure is measured over the exact same
 * window the real breaker measures, not a re-invented one.
 */
export function usEasternWeekStartUtcIso(now: Date): string {
  const parts = newYorkParts(now);
  // WEEKDAY_INDEX: Sun=0..Sat=6; days since the most recent Monday is
  // Mon=0..Sun=6 (Sunday belongs to the week that started the prior Monday).
  const daysSinceMonday = (parts.weekday + 6) % 7;
  const mondayLabel = shiftDateLabel(parts.dateLabel, -daysSinceMonday);
  return usEasternTradingDayUtcRange(mondayLabel).dayStart;
}
