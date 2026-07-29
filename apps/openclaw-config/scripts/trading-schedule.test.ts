import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  // 2026-07-30 live regression. Every value below was READ OFF THE DEPLOYED
  // MAC MINI, not invented for this test:
  //   - runtime/stock-analysis-state.json held
  //     `"lastRunAt": "2026-07-27T16:35:02.483Z"` (the 07-27 batch's own
  //     generatedAt, also the created_at of stock_analysis_run_0bf5e0bb-... in
  //     stock_analysis_runs);
  //   - the OpenClaw cron job `openclaw-trading-stock-analysis` is registered
  //     `0 21 * * *` Asia/Shanghai, i.e. 13:00:00Z, and its run records
  //     (runtime/openclaw-cron-runner/1785243602998-stock-analysis.json and
  //     1785330030637-stock-analysis.json) show `openclawRunAtMs` 1785243600007
  //     and 1785330000009 - exactly 2026-07-28T13:00:00Z and 2026-07-29T13:00:00Z.
  //
  // Under the old wall-clock `>= 72h` rule those two slots measured 20.4h and
  // 44.4h, and 07-30's would have measured 68.4h - all three "not due", so the
  // 每 3 天 pipeline shipped nothing for three days while each of those run
  // records still recorded ok:true. The third day's slot MUST be due.
  it("runs on the third day's own 21:00 slot even though the previous batch finished after its slot", () => {
    const lastRunAt = "2026-07-27T16:35:02.483Z";

    expect(schedule.shouldRunStockAnalysis(new Date(1785243600007), lastRunAt, { cronTriggered: true })).toBe(false);
    expect(schedule.shouldRunStockAnalysis(new Date(1785330000009), lastRunAt, { cronTriggered: true })).toBe(false);
    // The slot that used to be lost: 2026-07-30T13:00:00Z, 68.4 wall-clock
    // hours after lastRunAt but three report-labelled days after 2026-07-27.
    expect(schedule.shouldRunStockAnalysis(new Date("2026-07-30T13:00:00.000Z"), lastRunAt, { cronTriggered: true })).toBe(true);
  });

  // The ratchet, in one sentence: batch N is stamped later in the day than
  // batch N-1 (slower fetch, a retry, a manual re-run), and under the old
  // wall-clock rule that pushed the next due slot out by a whole day - then
  // another, and another. Simulated here across 120 daily slots against
  // durations that bracket what the mini actually does: the observed 07-27
  // batch ran 13:00:27Z -> 15:52:23Z (2h52m of retries) and the successful
  // attempt itself took 18 minutes.
  //
  // Boundary, stated rather than hidden: the anchor is the batch's report
  // LABEL, and a batch stamped at 00:30Z carries the NEXT day's label (it also
  // writes reports/stock-analysis/<that day>.md and stock_facts rows under it -
  // the label is the batch's identity, so counting 3 days from it is correct,
  // not drift). Reaching that from a 13:00Z slot takes 11+ hours in one run,
  // which is itself a broken run; the freshness guard in
  // stock-analysis-freshness.mjs is what catches THAT.
  it("holds an exact 3-day cadence for every realistic run duration, with no ratchet", () => {
    for (const durationMinutes of [1, 18, 45, 172, 300, 600]) {
      let lastRunAt = "2026-07-01T13:00:00.000Z";
      const labels: string[] = [];
      for (let day = 2; day <= 121; day += 1) {
        const slot = new Date(Date.UTC(2026, 6, day, 13, 0, 0));
        if (schedule.shouldRunStockAnalysis(slot, lastRunAt, { cronTriggered: true })) {
          lastRunAt = new Date(slot.getTime() + durationMinutes * 60_000).toISOString();
          labels.push(schedule.stockAnalysisReportLabel(new Date(lastRunAt)));
        }
      }

      expect(labels.length, `duration ${durationMinutes}m produced too few batches`).toBe(40);
      const gaps = labels.slice(1).map((label, i) => (
        (Date.parse(`${label}T00:00:00Z`) - Date.parse(`${labels[i]}T00:00:00Z`)) / 86_400_000
      ));
      expect(new Set(gaps), `duration ${durationMinutes}m drifted off the 3-day cadence`).toEqual(new Set([3]));
    }
  });

  it("labels a batch by the same string stock-analysis.mjs uses for its report filename and stock_facts.trading_day", () => {
    // stock-analysis.mjs: `const label = generatedAt.slice(0, 10)`. The live
    // 07-27 batch generated at 2026-07-27T16:35:02.483Z wrote
    // reports/stock-analysis/2026-07-27.md and stock_facts rows with
    // trading_day = '2026-07-27' - both verified on the mini.
    expect(schedule.stockAnalysisReportLabel(new Date("2026-07-27T16:35:02.483Z"))).toBe("2026-07-27");
    expect(schedule.stockAnalysisDaysSinceLastRun(new Date("2026-07-30T13:00:00.000Z"), "2026-07-27T16:35:02.483Z")).toBe(3);
    expect(schedule.stockAnalysisDaysSinceLastRun(new Date("2026-07-30T13:00:00.000Z"), undefined)).toBeNull();
    expect(schedule.stockAnalysisDaysSinceLastRun(new Date("2026-07-30T13:00:00.000Z"), "not-a-date")).toBeNull();
    // Clock skew / a doctored state file reads as negative, never as "0 days".
    expect(schedule.stockAnalysisDaysSinceLastRun(new Date("2026-07-27T13:00:00.000Z"), "2026-07-30T13:00:00.000Z")).toBe(-3);
  });

  it("refuses to run on a future-dated lastRunAt instead of treating it as due", () => {
    expect(schedule.shouldRunStockAnalysis(
      new Date("2026-07-27T13:00:00.000Z"),
      "2026-07-30T16:35:02.483Z",
      { cronTriggered: true }
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

  // Phase 6 Task 2 (circuit breaker / discipline engine's shared week-boundary
  // helper): a mid-week Wednesday (EDT) resolves to that same week's Monday
  // and the Friday four calendar days later, and the Monday-midnight instant
  // is expressed in EDT (UTC-4: 2026-07-13 00:00 America/New_York == 04:00Z).
  it("currentUsEasternTradingWeek resolves a mid-week EDT instant to its Monday-Friday week", () => {
    const week = schedule.currentUsEasternTradingWeek(new Date("2026-07-15T18:00:00Z"));
    expect(week).toEqual({
      mondayDateLabel: "2026-07-13",
      fridayDateLabel: "2026-07-17",
      weekStartUtcIso: "2026-07-13T04:00:00.000Z"
    });
  });

  // Winter (EST, UTC-5) case: Monday-midnight is 05:00Z, not 04:00Z - pins
  // the DST branch currentUsEasternTradingDay's own winter test above covers
  // for THIS function too, since nyMidnightUtcIso re-derives the offset
  // independently rather than reusing a cached EDT assumption.
  it("currentUsEasternTradingWeek resolves a mid-week EST instant to its Monday-Friday week", () => {
    const week = schedule.currentUsEasternTradingWeek(new Date("2026-01-14T18:00:00Z"));
    expect(week).toEqual({
      mondayDateLabel: "2026-01-12",
      fridayDateLabel: "2026-01-16",
      weekStartUtcIso: "2026-01-12T05:00:00.000Z"
    });
  });

  // A Sunday instant belongs to the PRECEDING Monday's week (the week that is
  // about to end), not the week that starts the next day - pins the
  // daysSinceMonday formula's Sunday=6-days-since-Monday branch.
  it("currentUsEasternTradingWeek resolves a Sunday instant to the week that just ended", () => {
    const week = schedule.currentUsEasternTradingWeek(new Date("2026-07-19T15:00:00Z"));
    expect(week.mondayDateLabel).toBe("2026-07-13");
    expect(week.fridayDateLabel).toBe("2026-07-17");
  });

  // The two DST-transition weekends themselves (spring-forward 2026-03-08,
  // fall-back 2026-11-01): the FOLLOWING Monday must report the NEW offset in
  // its weekStartUtcIso, not the one carried over from the prior week.
  it("currentUsEasternTradingWeek reports the correct offset for the Monday right after each DST transition", () => {
    expect(schedule.currentUsEasternTradingWeek(new Date("2026-03-10T12:00:00Z")).weekStartUtcIso).toBe(
      "2026-03-09T04:00:00.000Z"
    );
    expect(schedule.currentUsEasternTradingWeek(new Date("2026-11-03T12:00:00Z")).weekStartUtcIso).toBe(
      "2026-11-02T05:00:00.000Z"
    );
  });

  // FIX 4 (DST off-by-one): nyMidnightUtcIso previously sampled the NY UTC
  // offset at NOON UTC of the target date, but local midnight (00:00) can be
  // on the OTHER side of a DST transition than noon (2026-03-08 spring
  // -forward, 2026-11-01 fall-back). This file's only exported wrapper around
  // nyMidnightUtcIso is currentUsEasternTradingWeek's weekStartUtcIso, keyed
  // off a week's MONDAY date label - and neither transition date in 2026
  // falls on a Monday, so this file's public surface cannot directly exercise
  // the exact broken instant (the sibling copy's usEasternTradingDayUtcRange,
  // which takes a raw date label, pins that instant in database.test.ts).
  // What this file's exports CAN execute for the transition dates themselves
  // is pinned below; the "both copies stay in sync" requirement is enforced
  // by the source-parity describe block at the bottom of this file, not by
  // comments alone.

  // Spring-forward Sunday 2026-03-08 (02:00 EST -> 03:00 EDT == 07:00Z): the
  // US/Eastern calendar-date label must flip at 05:00Z (the EST midnight)
  // and stay on 03-08 across the transition instant, then flip to 03-09 at
  // 04:00Z (the first EDT midnight).
  it("currentUsEasternTradingDay is DST-correct across the 2026-03-08 spring-forward transition", () => {
    expect(schedule.currentUsEasternTradingDay(new Date("2026-03-08T04:59:00Z"))).toBe("2026-03-07");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-03-08T06:59:00Z"))).toBe("2026-03-08");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-03-08T07:01:00Z"))).toBe("2026-03-08");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-03-09T03:59:00Z"))).toBe("2026-03-08");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-03-09T04:00:00Z"))).toBe("2026-03-09");
  });

  // Fall-back Sunday 2026-11-01 (02:00 EDT -> 01:00 EST == 06:00Z): the
  // label reaches 11-01 at 04:00Z (the last EDT midnight), holds through the
  // repeated 1-o'clock hour on both sides of the transition, and doesn't
  // reach 11-02 until 05:00Z the next day (the first EST midnight).
  it("currentUsEasternTradingDay is DST-correct across the 2026-11-01 fall-back transition", () => {
    expect(schedule.currentUsEasternTradingDay(new Date("2026-11-01T03:59:00Z"))).toBe("2026-10-31");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-11-01T04:00:00Z"))).toBe("2026-11-01");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-01");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-11-01T06:30:00Z"))).toBe("2026-11-01");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-11-02T04:59:00Z"))).toBe("2026-11-01");
    expect(schedule.currentUsEasternTradingDay(new Date("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
  });

  // Both 2026 transition dates are Sundays, so an instant ON the transition
  // date belongs to the week that STARTED under the outgoing offset - the
  // weekStartUtcIso must report that prior Monday's midnight under the OLD
  // offset (EST before spring-forward, EDT before fall-back), whether the
  // instant sampled is before or after the transition moment itself.
  it("currentUsEasternTradingWeek keeps the outgoing offset for instants on each 2026 transition date", () => {
    // 06:00Z == 01:00 EST, still pre-transition; 12:00Z == 08:00 EDT, post.
    for (const instant of ["2026-03-08T06:00:00Z", "2026-03-08T12:00:00Z"]) {
      expect(schedule.currentUsEasternTradingWeek(new Date(instant))).toEqual({
        mondayDateLabel: "2026-03-02",
        fridayDateLabel: "2026-03-06",
        weekStartUtcIso: "2026-03-02T05:00:00.000Z"
      });
    }
    // 05:00Z == 01:00 EDT, still pre-transition; 12:00Z == 07:00 EST, post.
    for (const instant of ["2026-11-01T05:00:00Z", "2026-11-01T12:00:00Z"]) {
      expect(schedule.currentUsEasternTradingWeek(new Date(instant))).toEqual({
        mondayDateLabel: "2026-10-26",
        fridayDateLabel: "2026-10-30",
        weekStartUtcIso: "2026-10-26T04:00:00.000Z"
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Source parity: trading-schedule.mjs vs packages/shared-types/src/database.ts
//
// nyMidnightUtcIso (and its nyUtcOffsetMinutes dependency) exists in TWO
// hand-mirrored copies - this .mjs and database.ts (which cannot import it:
// packages/shared-types is a dependency OF apps, not the reverse - see that
// file's own header). Both files' comments promise the copies stay
// byte-identical, but until now nothing executable enforced it (the FIX 4
// DST correction had to be applied to each copy by hand). Same read-the-
// source-text assertion precedent as openclaw-cron-runner.test.ts and the
// same two-implementations-must-not-drift rationale as strategy-write-
// parity.test.ts: extract each function's text from both files and compare
// them normalized (TS type annotations stripped, whitespace collapsed - the
// only differences a faithful .mjs->.ts port is allowed to have). If either
// side is edited alone, this fails.
// ---------------------------------------------------------------------------

const PARITY_FUNCTION_NAMES = ["nyUtcOffsetMinutes", "nyMidnightUtcIso"] as const;

const MJS_PATH = join(process.cwd(), "apps/openclaw-config/scripts/trading-schedule.mjs");
const DATABASE_TS_PATH = join(process.cwd(), "packages/shared-types/src/database.ts");

/** Extracts `function <name>(...) {...}` by brace counting from the
 * declaration to its balanced closing brace. Template-literal placeholders
 * (`${...}`) inside the bodies contribute balanced brace pairs, so the count
 * still closes at the real function end. */
function extractFunctionText(source: string, name: string, file: string): string {
  const startIndex = source.indexOf(`function ${name}(`);
  if (startIndex < 0) {
    throw new Error(`function ${name} not found in ${file}`);
  }
  let depth = 0;
  for (let i = source.indexOf("{", startIndex); i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces extracting ${name} from ${file}`);
}

/** The ONLY differences tolerated between the .mjs and its .ts port: the
 * port's type annotations and incidental whitespace. Everything else -
 * including comments inside the function body - must match. */
function normalizeFunctionText(text: string): string {
  return text
    .replace(/: (?:string|number|Date)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("nyMidnightUtcIso source parity: trading-schedule.mjs vs database.ts", () => {
  const mjsSource = readFileSync(MJS_PATH, "utf8");
  const databaseTsSource = readFileSync(DATABASE_TS_PATH, "utf8");

  it.each([...PARITY_FUNCTION_NAMES])("%s stays identical in both copies (modulo TS annotations)", (name) => {
    const mjsText = normalizeFunctionText(extractFunctionText(mjsSource, name, "trading-schedule.mjs"));
    const tsText = normalizeFunctionText(extractFunctionText(databaseTsSource, name, "database.ts"));
    expect(tsText).toBe(mjsText);
  });
});

// ===========================================================================
// Task 21 (2026-07-28 spec-drift plan): scheduled-job calendar predicates
// ===========================================================================

describe("isFirstWeekendOfMonth (monthly review's real first-weekend rule)", () => {
  it("matches the month's first Saturday and first Sunday, on the Beijing calendar", () => {
    // 2026-08-01 Sat and 2026-08-02 Sun, at the job's own 10:00 Beijing slot.
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-08-01T02:00:00.000Z"))).toBe(true);
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-08-02T02:00:00.000Z"))).toBe(true);
  });

  it("rejects the SECOND weekend - the half `0 10 * * 6,0` cannot express", () => {
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-08-08T02:00:00.000Z"))).toBe(false);
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-08-09T02:00:00.000Z"))).toBe(false);
  });

  it("rejects weekdays inside days 1-7 - the half the old `1-7` day-of-month field wrongly allowed", () => {
    for (const day of ["03", "04", "05", "06", "07"]) {
      expect(schedule.isFirstWeekendOfMonth(new Date(`2026-08-${day}T02:00:00.000Z`))).toBe(false);
    }
  });

  it("reads the Beijing calendar, not UTC: 2026-08-01 16:00Z is already Sunday the 2nd in Beijing", () => {
    // Saturday 2026-08-01 16:00Z = Sunday 2026-08-02 00:00 Beijing. Both are
    // first-weekend days, so a same-answer pair proves nothing - use the month
    // boundary instead: 2026-07-31 16:00Z is Friday in UTC but Saturday
    // 2026-08-01 in Beijing, i.e. August's first weekend.
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-07-31T16:00:00.000Z"))).toBe(true);
    // And the mirror: 2026-08-08 15:00Z is Saturday in UTC, but already Sunday
    // 2026-08-09 in Beijing - the second weekend either way.
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-08-08T15:00:00.000Z"))).toBe(false);
  });

  it("matches twice in a month whose 1st is a Sunday, and that is intended", () => {
    // 2026-11-01 is a Sunday; 2026-11-07 is the following Saturday. Both are
    // day <= 7 and both are the first of their weekday in November.
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-11-01T02:00:00.000Z"))).toBe(true);
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-11-07T02:00:00.000Z"))).toBe(true);
    expect(schedule.isFirstWeekendOfMonth(new Date("2026-11-08T02:00:00.000Z"))).toBe(false);
  });
});

describe("isUsRegularTradingDate (report holiday guard's calendar half)", () => {
  it("is false on a full NYSE close", () => {
    expect(schedule.isUsRegularTradingDate("2026-11-26")).toBe(false); // Thanksgiving
    expect(schedule.isUsRegularTradingDate("2026-07-03")).toBe(false); // Independence Day observed
    expect(schedule.isUsRegularTradingDate("2026-12-25")).toBe(false);
  });

  it("is TRUE on an early-close day - a half session is still a session", () => {
    expect(schedule.isUsRegularTradingDate("2026-11-27")).toBe(true);
    expect(schedule.isUsRegularTradingDate("2026-12-24")).toBe(true);
  });

  it("is false on weekends and true on ordinary weekdays", () => {
    expect(schedule.isUsRegularTradingDate("2026-07-25")).toBe(false); // Saturday
    expect(schedule.isUsRegularTradingDate("2026-07-26")).toBe(false); // Sunday
    expect(schedule.isUsRegularTradingDate("2026-07-29")).toBe(true);
  });

  it("answers null - never false - for a year the holiday table does not cover", () => {
    // The table only carries 2026. A 2027 date must read as "cannot tell", so
    // an un-updated calendar can never silently cancel a year of reports.
    expect(schedule.CALENDAR_COVERED_YEARS).toEqual([2026]);
    expect(schedule.isUsRegularTradingDate("2027-01-04")).toBeNull();
    expect(schedule.isUsRegularTradingDate("2027-01-01")).toBeNull();
    expect(schedule.isUsRegularTradingDate("not-a-date")).toBeNull();
  });
});
