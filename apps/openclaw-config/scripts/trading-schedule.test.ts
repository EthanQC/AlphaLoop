import { describe, expect, it } from "vitest";

const schedule = await import("./trading-schedule.mjs");

describe("trading schedule policy", () => {
  it("delivers daily reports Tuesday through Saturday at 20:00 Asia/Shanghai for each US trading day", () => {
    expect(schedule.shouldRunReportDelivery("daily", new Date("2026-06-02T12:00:00.000Z"))).toBe(true);
    expect(schedule.shouldRunReportDelivery("daily", new Date("2026-06-06T12:00:00.000Z"))).toBe(true);
    expect(schedule.shouldRunReportDelivery("daily", new Date("2026-06-01T12:00:00.000Z"))).toBe(false);
    expect(schedule.shouldRunReportDelivery("daily", new Date("2026-06-02T11:59:00.000Z"))).toBe(false);
  });

  it("delivers weekly reports on Monday at 20:00 Asia/Shanghai", () => {
    expect(schedule.shouldRunReportDelivery("weekly", new Date("2026-06-01T12:00:00.000Z"))).toBe(true);
    expect(schedule.shouldRunReportDelivery("weekly", new Date("2026-06-02T12:00:00.000Z"))).toBe(false);
  });

  it("runs stock analysis every third day at 21:00 Asia/Shanghai", () => {
    expect(schedule.shouldRunStockAnalysis(new Date("2026-06-01T13:00:00.000Z"), undefined)).toBe(true);
    expect(schedule.shouldRunStockAnalysis(
      new Date("2026-06-03T13:00:00.000Z"),
      "2026-06-01T13:00:00.000Z"
    )).toBe(false);
    expect(schedule.shouldRunStockAnalysis(
      new Date("2026-06-04T13:00:00.000Z"),
      "2026-06-01T13:00:00.000Z"
    )).toBe(true);
  });

  it("allows OpenClaw-owned cron triggers to run stock analysis when the interval is due", () => {
    expect(schedule.shouldRunStockAnalysis(
      new Date("2026-06-14T11:45:00.000Z"),
      "2026-05-31T11:05:07.180Z",
      { cronTriggered: true }
    )).toBe(true);
    expect(schedule.shouldRunStockAnalysis(
      new Date("2026-06-03T11:45:00.000Z"),
      "2026-06-01T13:00:00.000Z",
      { cronTriggered: true }
    )).toBe(false);
    expect(schedule.shouldRunStockAnalysis(
      new Date("2026-06-14T11:45:00.000Z"),
      "2026-05-31T11:05:07.180Z"
    )).toBe(false);
  });

  it("recognizes US regular market hours across daylight saving time", () => {
    expect(schedule.isUsRegularMarketHours(new Date("2026-07-01T14:00:00.000Z"))).toBe(true);
    expect(schedule.isUsRegularMarketHours(new Date("2026-01-05T15:00:00.000Z"))).toBe(true);
    expect(schedule.isUsRegularMarketHours(new Date("2026-07-01T13:29:00.000Z"))).toBe(false);
    expect(schedule.isUsRegularMarketHours(new Date("2026-07-03T14:00:00.000Z"))).toBe(false);
    expect(schedule.isUsRegularMarketHours(new Date("2026-11-27T18:30:00.000Z"))).toBe(false);
  });

  it("runs the official paper P&L report thirty minutes after US open across DST", () => {
    expect(schedule.shouldRunOfficialPaperPnlReport(new Date("2026-07-01T14:00:00.000Z"))).toBe(true);
    expect(schedule.shouldRunOfficialPaperPnlReport(new Date("2026-01-05T15:00:00.000Z"))).toBe(true);
    expect(schedule.shouldRunOfficialPaperPnlReport(new Date("2026-07-01T14:30:00.000Z"))).toBe(false);
    expect(schedule.shouldRunOfficialPaperPnlReport(new Date("2026-12-25T15:00:00.000Z"))).toBe(false);
  });

  it("derives CALENDAR_COVERED_YEARS from the NYSE close date tables", () => {
    expect(schedule.CALENDAR_COVERED_YEARS).toContain(2026);
    expect(schedule.CALENDAR_COVERED_YEARS).not.toContain(2027);
  });

  it("fails loud when a date's year has no trading calendar data", () => {
    expect(() => schedule.assertCalendarCoverage(new Date("2027-01-01T15:00:00.000Z"))).toThrow(
      /trading calendar has no data for year 2027/
    );
    expect(() => schedule.assertCalendarCoverage(new Date("2027-01-01T15:00:00.000Z"))).toThrow(
      /update NYSE_FULL_CLOSE_DATES\/NYSE_EARLY_CLOSE_DATES for year 2027 in trading-schedule\.mjs/
    );
    expect(() => schedule.assertCalendarCoverage(new Date("2026-06-01T12:00:00.000Z"))).not.toThrow();
  });

  it("propagates the calendar-coverage guard from isUsRegularMarketHours for out-of-range years", () => {
    expect(() => schedule.isUsRegularMarketHours(new Date("2027-01-01T15:00:00.000Z"))).toThrow(
      /trading calendar has no data for year 2027/
    );
    expect(() => schedule.isUsRegularMarketHours(new Date("2026-07-01T14:00:00.000Z"))).not.toThrow();
  });

  it("computes the current US Eastern trading day, crossing midnight from Beijing time", () => {
    expect(schedule.currentUsEasternTradingDay(new Date("2026-07-13T04:00:00+08:00"))).toBe("2026-07-12");
  });

  // Item 5 (task P2.5 Task 6): the sample above is a July (EDT, UTC-4) date -
  // every existing test of currentUsEasternTradingDay in this file only ever
  // exercised the daylight-saving offset. This pins the same
  // crosses-midnight-from-Beijing-time behavior in winter (EST, UTC-5,
  // January 2026 - outside any DST window per NYSE_FULL_CLOSE_DATES), so a
  // future regression that only breaks the standard-time branch of
  // getZonedParts' timezone math has a test to catch it.
  it("computes the current US Eastern trading day in winter (EST, UTC-5), crossing midnight from Beijing time", () => {
    expect(schedule.currentUsEasternTradingDay(new Date("2026-01-15T08:00:00+08:00"))).toBe("2026-01-14");
  });
});
