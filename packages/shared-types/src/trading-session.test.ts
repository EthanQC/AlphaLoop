import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NYSE_EARLY_CLOSE_DATES,
  NYSE_FULL_CLOSE_DATES,
  isUsTradingDay,
  latestUsTradingSession,
  usEasternWeekStartUtcIso
} from "./trading-session.js";

const TRADING_SCHEDULE_PATH = join(process.cwd(), "apps/openclaw-config/scripts/trading-schedule.mjs");

/**
 * Pulls a `const <name> = new Set([...])` literal out of source TEXT. Used to
 * read the scheduler's own calendar without importing the .mjs (which pulls in
 * its whole module graph) - the point is to compare the two SOURCES, so
 * reading the source is exactly right.
 */
function extractDateSet(source: string, name: string): Set<string> {
  const start = source.indexOf(`const ${name} = new Set([`);
  if (start < 0) {
    throw new Error(`${name} not found in trading-schedule.mjs`);
  }
  const end = source.indexOf("]);", start);
  const body = source.slice(source.indexOf("[", start) + 1, end);
  return new Set(Array.from(body.matchAll(/"(\d{4}-\d{2}-\d{2})"/gu)).map((match) => match[1] as string));
}

// ---------------------------------------------------------------------------
// The anti-drift guard this module's header promises.
// ---------------------------------------------------------------------------
//
// The NYSE calendar exists in two places for a real structural reason
// (apps/openclaw-config/scripts is not in platform-app's tsc project). Two
// copies of a holiday list is exactly the kind of thing that silently rots:
// someone adds 2027's holidays to the scheduler, the web page keeps calling
// 2027-01-01 a trading day, and nothing fails. This makes it fail.
describe("NYSE calendar parity with trading-schedule.mjs", () => {
  const source = readFileSync(TRADING_SCHEDULE_PATH, "utf8");

  it("has the same full-close dates as the scheduler", () => {
    expect([...NYSE_FULL_CLOSE_DATES].sort()).toEqual([...extractDateSet(source, "NYSE_FULL_CLOSE_DATES")].sort());
  });

  it("has the same early-close dates as the scheduler", () => {
    expect([...NYSE_EARLY_CLOSE_DATES].sort()).toEqual([...extractDateSet(source, "NYSE_EARLY_CLOSE_DATES")].sort());
  });

  it("actually read a non-empty calendar out of the scheduler (guards a silently-empty extraction)", () => {
    expect(extractDateSet(source, "NYSE_FULL_CLOSE_DATES").size).toBeGreaterThan(5);
  });
});

describe("isUsTradingDay", () => {
  it("is false on a weekend", () => {
    expect(isUsTradingDay("2026-07-25")).toBe(false); // Saturday
    expect(isUsTradingDay("2026-07-26")).toBe(false); // Sunday
  });

  it("is false on a full NYSE holiday even though it is a weekday", () => {
    expect(isUsTradingDay("2026-07-03")).toBe(false); // Friday, Independence Day observed
    expect(isUsTradingDay("2026-11-26")).toBe(false); // Thursday, Thanksgiving
  });

  it("is true on an ordinary weekday", () => {
    expect(isUsTradingDay("2026-07-30")).toBe(true); // Thursday
  });
});

describe("latestUsTradingSession", () => {
  it("returns today's session, in progress, during regular hours", () => {
    // 2026-07-30 14:00Z = 10:00 EDT, inside 09:30-16:00.
    const session = latestUsTradingSession(new Date("2026-07-30T14:00:00.000Z"));
    expect(session?.tradingDay).toBe("2026-07-30");
    expect(session?.inProgress).toBe(true);
    expect(session?.startUtcIso).toBe("2026-07-30T13:30:00.000Z");
    // A running session is bounded at NOW, never at a close that has not
    // happened yet - a window that reaches into the future would let the page
    // claim to cover time nobody has lived through.
    expect(session?.endUtcIso).toBe("2026-07-30T14:00:00.000Z");
  });

  it("returns today's completed session after the close", () => {
    const session = latestUsTradingSession(new Date("2026-07-30T21:00:00.000Z")); // 17:00 EDT
    expect(session?.tradingDay).toBe("2026-07-30");
    expect(session?.inProgress).toBe(false);
    expect(session?.endUtcIso).toBe("2026-07-30T20:00:00.000Z"); // 16:00 EDT
  });

  it("returns YESTERDAY's session before today's open", () => {
    // 2026-07-30 12:00Z = 08:00 EDT, before the 09:30 open.
    const session = latestUsTradingSession(new Date("2026-07-30T12:00:00.000Z"));
    expect(session?.tradingDay).toBe("2026-07-29");
    expect(session?.inProgress).toBe(false);
  });

  it("skips the weekend: Sunday resolves to Friday's session", () => {
    const session = latestUsTradingSession(new Date("2026-07-26T18:00:00.000Z")); // Sunday
    expect(session?.tradingDay).toBe("2026-07-24"); // Friday
  });

  it("skips a full-close holiday: 2026-07-03 resolves back to 07-02", () => {
    const session = latestUsTradingSession(new Date("2026-07-03T18:00:00.000Z"));
    expect(session?.tradingDay).toBe("2026-07-02");
  });

  it("uses the 13:00 ET close on an early-close date", () => {
    const session = latestUsTradingSession(new Date("2026-11-27T21:00:00.000Z")); // 16:00 EST
    expect(session?.tradingDay).toBe("2026-11-27");
    expect(session?.endUtcIso).toBe("2026-11-27T18:00:00.000Z"); // 13:00 EST
  });

  it("is DST-correct: a winter session opens at 14:30Z, a summer one at 13:30Z", () => {
    const winter = latestUsTradingSession(new Date("2026-12-15T20:00:00.000Z"));
    expect(winter?.startUtcIso).toBe("2026-12-15T14:30:00.000Z"); // EST = UTC-5
    const summer = latestUsTradingSession(new Date("2026-06-15T20:00:00.000Z"));
    expect(summer?.startUtcIso).toBe("2026-06-15T13:30:00.000Z"); // EDT = UTC-4
  });

  it("returns null - not a weekday guess - for a year the calendar does not cover", () => {
    expect(latestUsTradingSession(new Date("2031-05-14T18:00:00.000Z"))).toBeNull();
  });
});

describe("usEasternWeekStartUtcIso", () => {
  it("resolves mid-week to that week's Monday 00:00 America/New_York", () => {
    // Thursday 2026-07-30 -> Monday 2026-07-27 00:00 EDT = 04:00Z.
    expect(usEasternWeekStartUtcIso(new Date("2026-07-30T14:00:00.000Z"))).toBe("2026-07-27T04:00:00.000Z");
  });

  it("treats Sunday as belonging to the week that started the prior Monday", () => {
    expect(usEasternWeekStartUtcIso(new Date("2026-08-02T18:00:00.000Z"))).toBe("2026-07-27T04:00:00.000Z");
  });

  it("is DST-correct in winter (Monday 00:00 EST = 05:00Z)", () => {
    expect(usEasternWeekStartUtcIso(new Date("2026-12-16T18:00:00.000Z"))).toBe("2026-12-14T05:00:00.000Z");
  });
});
