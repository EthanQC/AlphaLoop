import { describe, expect, it } from "vitest";

import {
  beijingDayAge,
  beijingInstantAge,
  describeDataDay,
  describeDataInstant,
  formatAlertValue,
  formatBeijingDateTime,
  formatBeijingDay,
  formatBeijingShortTime,
  formatBeijingWeekdayTime,
  formatInteger,
  formatLargeAmount,
  formatPercentUnits,
  formatPrice,
  formatRatioAsSignedPercent,
  formatRatioAsUnsignedPercent,
  MISSING_NUMBER_TEXT,
  STALE_AFTER_DAYS
} from "./format.js";

// The exact row the operator screenshotted on 2026-07-30, copied out of the
// live mini database (`runtime/trading.sqlite`):
//   daily_move | -0.0332390201626266 | 2026-07-29T14:40:10.879Z
const LIVE_RATIO = -0.0332390201626266;
const LIVE_INSTANT = "2026-07-29T14:40:10.879Z";

describe("instants", () => {
  it("renders a stored ISO instant as Beijing wall-clock", () => {
    expect(formatBeijingShortTime(LIVE_INSTANT)).toBe("07-29 22:40");
    expect(formatBeijingDateTime(LIVE_INSTANT)).toBe("2026-07-29 22:40");
  });

  it("crosses the day boundary correctly (a US close lands on the next Beijing day)", () => {
    // 2026-07-27T16:36:22Z is the live TSM.US quote's own data_time.
    expect(formatBeijingShortTime("2026-07-27T16:36:22.000Z")).toBe("07-28 00:36");
    expect(formatBeijingDay(new Date("2026-07-27T16:36:22.000Z"))).toBe("2026-07-28");
  });

  it("returns an unparseable instant VERBATIM rather than 'Invalid Date'", () => {
    expect(formatBeijingShortTime("not-a-date")).toBe("not-a-date");
    expect(formatBeijingDateTime("")).toBe("");
    expect(formatBeijingShortTime("not-a-date")).not.toContain("Invalid");
    expect(formatBeijingShortTime("not-a-date")).not.toContain("NaN");
  });

  it("formats the topbar's weekday form", () => {
    expect(formatBeijingWeekdayTime(new Date("2026-07-29T16:18:00.000Z"))).toBe("07-30 周四 00:18");
  });
});

describe("ratios and numbers", () => {
  it("renders the live alert ratio as a signed percentage, not a 17-digit float", () => {
    expect(formatRatioAsSignedPercent(LIVE_RATIO)).toBe("-3.32%");
    expect(formatRatioAsSignedPercent(0.03)).toBe("+3.00%");
    expect(formatRatioAsUnsignedPercent(0.104)).toBe("10.40%");
  });

  it("keeps the same MAGNITUDE the Feishu card renders from the same stored ratio", () => {
    // market-alerts-cards.mjs's formatSignedPercent is `ratio * 100` to 1dp.
    // The page uses 2dp on the same input - a different rounding of the same
    // number, never a different scale (the bug class this module ends).
    expect(formatRatioAsSignedPercent(LIVE_RATIO, 1)).toBe("-3.3%");
    expect(formatRatioAsSignedPercent(LIVE_RATIO)).toBe("-3.32%");
  });

  it("treats an ALREADY-percent value (stock_facts' quote.pct, unit='pct') as percent, not as a ratio", () => {
    // The live TSM.US row: value_num = -2.20247390991796, unit = 'pct'.
    expect(formatPercentUnits(-2.20247390991796)).toBe("-2.20%");
    // Passing it through the RATIO formatter would produce -220.25% - the
    // reason these are two separately-named exports.
    expect(formatRatioAsSignedPercent(-2.20247390991796)).toBe("-220.25%");
  });

  it("maps every alert rule type to the same signedness the Feishu card uses", () => {
    expect(formatAlertValue("daily_move", LIVE_RATIO)).toBe("-3.32%");
    expect(formatAlertValue("unrealized_pnl", 0.07)).toBe("+7.00%");
    expect(formatAlertValue("spike_5m", -0.025)).toBe("-2.50%");
    // exposure's ratio is one-sided (over-budget only) - unsigned, matching
    // market-alerts-cards.mjs's own exposure branch.
    expect(formatAlertValue("exposure", 0.104)).toBe("10.40%");
  });

  it("never renders NaN/Infinity as a number - an unknown value says so", () => {
    expect(formatRatioAsSignedPercent(Number.NaN)).toBe(MISSING_NUMBER_TEXT);
    expect(formatRatioAsUnsignedPercent(Number.POSITIVE_INFINITY)).toBe(MISSING_NUMBER_TEXT);
    expect(formatPercentUnits(Number.NaN)).toBe(MISSING_NUMBER_TEXT);
    expect(formatPrice(null)).toBe(MISSING_NUMBER_TEXT);
    expect(formatInteger(undefined)).toBe(MISSING_NUMBER_TEXT);
    expect(formatLargeAmount(Number.NaN)).toBe(MISSING_NUMBER_TEXT);
    // Deliberately not "0" or "-": both read as a measured value.
    expect(MISSING_NUMBER_TEXT).not.toBe("0");
    expect(MISSING_NUMBER_TEXT).not.toBe("—");
  });

  it("rounds prices honestly (the stored double, not a prettier number)", () => {
    // The live quote.last is 394.525, which as a double is
    // 394.52499999999997726 - so 2dp is 394.52, and pretending otherwise
    // would be inventing precision.
    expect(formatPrice(394.525)).toBe("394.52");
    expect(formatPrice(403.41)).toBe("403.41");
  });

  it("makes large amounts readable without losing scale", () => {
    expect(formatLargeAmount(60941068000000)).toBe("60.94 万亿美元");
    expect(formatLargeAmount(1.2e9)).toBe("12.00 亿美元");
    expect(formatInteger(8570295)).toBe("8,570,295");
  });
});

describe("staleness", () => {
  const NOW = new Date("2026-07-29T16:18:00.000Z"); // 07-30 00:18 Beijing

  it("counts whole Beijing days and words the gap", () => {
    expect(beijingDayAge("2026-07-30", NOW)).toEqual({ days: 0, ago: "今日", stale: false });
    expect(beijingDayAge("2026-07-29", NOW)).toEqual({ days: 1, ago: "昨天", stale: false });
    expect(beijingDayAge("2026-07-27", NOW)).toEqual({ days: 3, ago: "3 天前", stale: true });
  });

  it("marks data stale from STALE_AFTER_DAYS on", () => {
    expect(STALE_AFTER_DAYS).toBe(2);
    expect(beijingDayAge("2026-07-28", NOW)?.stale).toBe(true);
    expect(beijingDayAge("2026-07-29", NOW)?.stale).toBe(false);
  });

  it("says so instead of computing a fabricated 0 when the date is unusable", () => {
    expect(beijingDayAge("", NOW)).toBeNull();
    expect(beijingDayAge("07-27", NOW)).toBeNull();
    expect(beijingInstantAge("not-a-date", NOW)).toBeNull();
    // ...and the descriptor then makes NO age claim at all.
    expect(describeDataDay("unknown", NOW)).toBe("unknown");
  });

  it("flags a future-dated row rather than calling it 今日", () => {
    const future = beijingDayAge("2026-08-02", NOW);
    expect(future?.days).toBe(-3);
    expect(future?.ago).toContain("晚于今日");
  });

  it("describes a day and an instant for the topbar", () => {
    expect(describeDataDay("2026-07-27", NOW)).toBe("07-27（3 天前）");
    expect(describeDataInstant("2026-07-27T16:36:22.000Z", NOW)).toBe("07-28 00:36（2 天前）");
  });
});
