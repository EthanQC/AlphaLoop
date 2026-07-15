const SHANGHAI_TIMEZONE = "Asia/Shanghai";
const NEW_YORK_TIMEZONE = "America/New_York";
const WEEKDAY_INDEX = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6]
]);
const NYSE_FULL_CLOSE_DATES = new Set([
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
const NYSE_EARLY_CLOSE_DATES = new Set([
  "2026-11-27",
  "2026-12-24"
]);

export const CALENDAR_COVERED_YEARS = Array.from(
  new Set(
    [...NYSE_FULL_CLOSE_DATES, ...NYSE_EARLY_CLOSE_DATES].map((dateLabel) => Number(dateLabel.slice(0, 4)))
  )
).sort((a, b) => a - b);

export function assertCalendarCoverage(date) {
  const { year } = getZonedParts(date, NEW_YORK_TIMEZONE);
  if (!CALENDAR_COVERED_YEARS.includes(year)) {
    throw new Error(
      `trading calendar has no data for year ${year}: update NYSE_FULL_CLOSE_DATES/NYSE_EARLY_CLOSE_DATES for year ${year} in trading-schedule.mjs`
    );
  }
}

export function currentUsEasternTradingDay(date = new Date()) {
  return getZonedParts(date, NEW_YORK_TIMEZONE).dateLabel;
}

// Phase 6 Task 2 (2026-07-15 plan): the ONE shared computation of "which
// US/Eastern trading week (Monday-Friday) does this instant fall in", used by
// BOTH circuit-breaker.mjs (weekly-loss window: baseline = last snapshot
// before Monday 00:00 America/New_York) and discipline-engine.mjs (the
// 财报周 rule's "is the earnings date inside THIS week" check) - factored
// here rather than duplicated in each, so the DST-crossing arithmetic below
// has exactly one implementation to get right and test.
//
// DST handling: `getZonedParts` already gives an exact America/New_York
// weekday/date-label for any instant (Intl does the DST-aware zone math), so
// finding Monday's CALENDAR date is pure Gregorian day-arithmetic - done by
// anchoring at T12:00:00Z (noon UTC) before shifting days, which never lands
// on a different calendar date than intended in any zone within +/-12h of
// UTC (America/New_York is only -4/-5h), so this step is unaffected by DST.
// Converting that calendar date's LOCAL MIDNIGHT to a UTC instant, though, DOES
// depend on which side of a DST transition the date falls on (EST = UTC-5
// vs EDT = UTC-4) - `nyUtcOffsetMinutes` reads the real offset in effect at
// that date straight from Intl's `shortOffset` (e.g. "GMT-5"/"GMT-4") rather
// than hardcoding a fixed offset or the NYSE holiday-calendar's own DST
// assumptions, so this stays correct across every spring-forward/fall-back
// boundary without a lookup table. Both are pinned in
// trading-schedule.test.ts (an EDT Monday and an EST Monday).
function shiftDateLabel(dateLabel, days) {
  const anchor = new Date(`${dateLabel}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  const y = anchor.getUTCFullYear();
  const m = String(anchor.getUTCMonth() + 1).padStart(2, "0");
  const d = String(anchor.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function nyUtcOffsetMinutes(anchorDate) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIMEZONE,
    timeZoneName: "shortOffset"
  }).formatToParts(anchorDate);
  const offsetLabel = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
  const match = /GMT([+-])(\d+)(?::(\d+))?/.exec(offsetLabel);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  return sign * (hours * 60 + minutes);
}

// UTC instant for 00:00:00 America/New_York on `dateLabel` ('YYYY-MM-DD').
function nyMidnightUtcIso(dateLabel) {
  const offsetMinutes = nyUtcOffsetMinutes(new Date(`${dateLabel}T12:00:00Z`));
  const utcMillisIfOffsetWereZero = Date.parse(`${dateLabel}T00:00:00Z`);
  return new Date(utcMillisIfOffsetWereZero - offsetMinutes * 60000).toISOString();
}

/**
 * Returns the Monday-Friday US/Eastern trading week containing `date`:
 * `mondayDateLabel`/`fridayDateLabel` ('YYYY-MM-DD', America/New_York
 * calendar dates - NOT adjusted for market holidays, this is the calendar
 * week, matching the plan's literal "Monday 00:00 US/Eastern"), and
 * `weekStartUtcIso` (that Monday's 00:00:00 America/New_York instant,
 * expressed as a UTC ISO string, DST-correct - see `nyMidnightUtcIso` above).
 */
export function currentUsEasternTradingWeek(date = new Date()) {
  const parts = getZonedParts(date, NEW_YORK_TIMEZONE);
  // WEEKDAY_INDEX: Sun=0 .. Sat=6. Days since the most recent Monday: Mon=0,
  // Tue=1, ..., Sun=6 (Sunday "belongs to" the week that started the
  // preceding Monday).
  const daysSinceMonday = (parts.weekday - 1 + 7) % 7;
  const mondayDateLabel = shiftDateLabel(parts.dateLabel, -daysSinceMonday);
  const fridayDateLabel = shiftDateLabel(mondayDateLabel, 4);

  return {
    mondayDateLabel,
    fridayDateLabel,
    weekStartUtcIso: nyMidnightUtcIso(mondayDateLabel)
  };
}

export function shouldRunReportDelivery(kind, date = new Date()) {
  const parts = getZonedParts(date, SHANGHAI_TIMEZONE);
  if (parts.minute !== 0 || parts.hour !== 20) {
    return false;
  }

  if (kind === "daily") {
    return parts.weekday >= 2 && parts.weekday <= 6;
  }

  if (kind === "weekly") {
    return parts.weekday === 1;
  }

  throw new Error(`Unsupported report kind: ${kind}`);
}

export function shouldRunStockAnalysis(date = new Date(), lastRunAt, options = {}) {
  const parts = getZonedParts(date, SHANGHAI_TIMEZONE);
  if (!options.cronTriggered && (parts.hour !== 21 || parts.minute !== 0)) {
    return false;
  }

  if (!lastRunAt) {
    return true;
  }

  const lastRunMs = new Date(lastRunAt).getTime();
  if (!Number.isFinite(lastRunMs)) {
    return true;
  }

  return date.getTime() - lastRunMs >= 72 * 60 * 60 * 1000;
}

export function isUsRegularMarketHours(date = new Date()) {
  assertCalendarCoverage(date);
  const parts = getZonedParts(date, NEW_YORK_TIMEZONE);
  if (parts.weekday < 1 || parts.weekday > 5 || NYSE_FULL_CLOSE_DATES.has(parts.dateLabel)) {
    return false;
  }

  const minuteOfDay = parts.hour * 60 + parts.minute;
  const closeMinute = NYSE_EARLY_CLOSE_DATES.has(parts.dateLabel) ? 13 * 60 : 16 * 60;
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < closeMinute;
}

export function shouldRunOfficialPaperHourlyPoll(date = new Date()) {
  if (!isUsRegularMarketHours(date)) {
    return false;
  }

  const parts = getZonedParts(date, NEW_YORK_TIMEZONE);
  const minutesSinceOpen = parts.hour * 60 + parts.minute - (9 * 60 + 30);
  return minutesSinceOpen >= 0 && minutesSinceOpen % 60 === 0;
}

export function shouldRunOfficialPaperPnlReport(date = new Date()) {
  const parts = getZonedParts(date, NEW_YORK_TIMEZONE);
  return isUsRegularMarketHours(date) && parts.hour === 10 && parts.minute === 0;
}

export function getZonedParts(date, timeZone) {
  const entries = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value]);
  const parts = Object.fromEntries(entries);

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAY_INDEX.get(parts.weekday) ?? -1,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    dateLabel: `${parts.year}-${parts.month}-${parts.day}`
  };
}
