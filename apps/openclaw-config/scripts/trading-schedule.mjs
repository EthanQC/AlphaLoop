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
// vs EDT = UTC-4) - `nyUtcOffsetMinutes` reads the real offset from Intl's
// `shortOffset` (e.g. "GMT-5"/"GMT-4") rather than hardcoding a fixed offset
// or the NYSE holiday-calendar's own DST assumptions. FIX 4: it must be
// sampled at (an approximation of) the LOCAL-MIDNIGHT instant itself, not at
// noon UTC of the target date - noon and local midnight can be on OPPOSITE
// sides of a DST transition (e.g. 2026-03-08's 07:00Z spring-forward), so a
// noon sample used to give the wrong offset on transition days; see
// `nyMidnightUtcIso`'s own doc comment for the two-step correction. Correct
// behavior across every spring-forward/fall-back boundary, including the
// transition dates themselves, is pinned in trading-schedule.test.ts and
// database.test.ts's usEasternTradingDayUtcRange tests (the byte-identical
// sibling copy).
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
//
// FIX 4 (DST off-by-one): this used to sample the NY UTC offset at NOON UTC
// of the target date - but local midnight (00:00) can be on the OTHER side
// of a DST transition than noon is. E.g. 2026-03-08 (spring forward at 2am
// EST -> 3am EDT, i.e. 07:00Z): local 00:00 that day is still EST (-5) =
// 05:00Z, but noon UTC (12:00Z, already past the 07:00Z transition) samples
// EDT (-4), wrongly producing 04:00Z. Fixed by sampling the offset at (an
// approximation of) the LOCAL-MIDNIGHT instant itself instead: first guess
// using the offset read at "00:00 UTC" (never more than ~14h from the true
// answer, so it lands on the correct side of the transition in all but a
// vanishingly narrow sliver), then re-read the offset AT that first-guess
// instant and recompute if it disagrees - this second pass corrects the rare
// case where the initial guess itself crossed the transition boundary. Kept
// byte-identical to packages/shared-types/src/database.ts's own copy - see
// that file's own nyMidnightUtcIso doc comment.
function nyMidnightUtcIso(dateLabel) {
  const utcMillisIfOffsetWereZero = Date.parse(`${dateLabel}T00:00:00Z`);
  const firstGuessOffsetMinutes = nyUtcOffsetMinutes(new Date(utcMillisIfOffsetWereZero));
  const firstGuessMs = utcMillisIfOffsetWereZero - firstGuessOffsetMinutes * 60000;
  const refinedOffsetMinutes = nyUtcOffsetMinutes(new Date(firstGuessMs));
  const finalMs = refinedOffsetMinutes === firstGuessOffsetMinutes
    ? firstGuessMs
    : utcMillisIfOffsetWereZero - refinedOffsetMinutes * 60000;
  return new Date(finalMs).toISOString();
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

// Spec 3.4: 个股分析 runs 每 3 天. The cron slot itself is daily at 21:00
// Asia/Shanghai (= 13:00Z), and this gate decides which of those slots is
// actually the due one.
export const STOCK_ANALYSIS_INTERVAL_DAYS = 3;

/**
 * The report DATE LABEL a stock-analysis run generated at `instant` writes -
 * byte-identical to stock-analysis.mjs's `const label = generatedAt.slice(0, 10)`,
 * which is what names `reports/stock-analysis/<label>.md` and what goes into
 * every `stock_facts.trading_day` row for that batch. Kept here (rather than
 * inlined at each call site) because the cadence below and the staleness
 * threshold in stock-analysis-freshness.mjs must agree on what "one batch"
 * is identified by.
 */
export function stockAnalysisReportLabel(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  return value.toISOString().slice(0, 10);
}

/**
 * Whole calendar days between the last batch's report label and the label a
 * batch generated at `date` would carry. `null` when `lastRunAt` is absent or
 * unparseable (caller decides what that means). Negative when `lastRunAt` is
 * in the future (clock skew / a hand-edited state file) - deliberately NOT
 * clamped, so the caller sees the anomaly instead of it reading as "0 days".
 */
export function stockAnalysisDaysSinceLastRun(date = new Date(), lastRunAt) {
  if (!lastRunAt) {
    return null;
  }
  const lastRunMs = new Date(lastRunAt).getTime();
  if (!Number.isFinite(lastRunMs)) {
    return null;
  }
  const lastLabel = stockAnalysisReportLabel(new Date(lastRunMs));
  const nowLabel = stockAnalysisReportLabel(date);
  return Math.round((Date.parse(`${nowLabel}T00:00:00Z`) - Date.parse(`${lastLabel}T00:00:00Z`)) / 86_400_000);
}

// 2026-07-30, measured on the live mini: this gate used to be a wall-clock
// delta, `date.getTime() - lastRunMs >= 72 * 60 * 60 * 1000`. `lastRunAt` is
// stamped when a batch GENERATES - the slot instant plus however long the
// fetch/render took, or minutes-to-hours later if the slot's first attempts
// failed and a retry (or a manual re-run) is what finally succeeded. So it
// always lands AFTER the 21:00 slot, which leaves the THIRD day's own 21:00
// slot permanently short of 72h. That slot is skipped `not_due`, `lastRunAt`
// is not advanced (a skip writes nothing), and the cadence ratchets out one
// day - then another, every time a run again finishes past its slot.
//
// The live evidence: runtime/stock-analysis-state.json held
// `lastRunAt: 2026-07-27T16:35:02.483Z`, and the cron runner's own records
// (runtime/openclaw-cron-runner/*-stock-analysis.json) show the 2026-07-28
// and 2026-07-29 21:00 slots both printing
// `{"skipped":true,"reason":"not_due"}` at 20.4h and 44.4h - and 2026-07-30's
// slot would have printed it again at 68.4h. A pipeline specified to ship
// every 3 days had shipped nothing for three days while every one of those
// run records still recorded `ok: true`.
//
// The anchor is now the report label, so "每 3 天" means three calendar days
// between report DATES. How long a run took, and how late a retry landed,
// can no longer push the next slot out.
export function shouldRunStockAnalysis(date = new Date(), lastRunAt, options = {}) {
  const parts = getZonedParts(date, SHANGHAI_TIMEZONE);
  if (!options.cronTriggered && (parts.hour !== 21 || parts.minute !== 0)) {
    return false;
  }

  const elapsedDays = stockAnalysisDaysSinceLastRun(date, lastRunAt);
  if (elapsedDays === null) {
    return true;
  }

  return elapsedDays >= STOCK_ANALYSIS_INTERVAL_DAYS;
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
