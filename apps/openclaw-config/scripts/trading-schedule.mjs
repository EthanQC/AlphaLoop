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
