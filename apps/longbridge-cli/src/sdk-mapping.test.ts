import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  buildEnumNameMaps,
  calendarTimeLabel,
  reverseEnumMap,
  snakeCaseEnumMemberName,
  truncateRemark
} from "./sdk-mapping.js";

describe("reverseEnumMap", () => {
  it("builds a value -> name map from an enum-like object", () => {
    const map = reverseEnumMap({ Unknown: 0, Filled: 5, Rejected: 14 });
    expect(map.get(0)).toBe("Unknown");
    expect(map.get(5)).toBe("Filled");
    expect(map.get(14)).toBe("Rejected");
    expect(map.get(99)).toBeUndefined();
  });

  it("applies the name transform", () => {
    const map = reverseEnumMap({ Buy: 1, Sell: 2 }, (name) => name.toLowerCase());
    expect(map.get(1)).toBe("buy");
    expect(map.get(2)).toBe("sell");
  });

  it("skips non-numeric members and keeps the first name on duplicate values", () => {
    const map = reverseEnumMap({ toString: "junk", A: 1, AliasOfA: 1 } as unknown);
    expect(map.get(1)).toBe("A");
    expect(map.size).toBe(1);
  });

  it("reads non-enumerable own properties (napi enum objects hide theirs)", () => {
    const enumObject = {};
    Object.defineProperty(enumObject, "Hidden", { value: 3, enumerable: false });
    expect(reverseEnumMap(enumObject).get(3)).toBe("Hidden");
  });

  it("returns an empty map for null / undefined / non-object input", () => {
    expect(reverseEnumMap(undefined).size).toBe(0);
    expect(reverseEnumMap(null).size).toBe(0);
    expect(reverseEnumMap(42).size).toBe(0);
  });
});

describe("snakeCaseEnumMemberName", () => {
  it("converts PascalCase member names to the snake_case trade-status contract", () => {
    expect(snakeCaseEnumMemberName("Normal")).toBe("normal");
    expect(snakeCaseEnumMemberName("PrepareList")).toBe("prepare_list");
    expect(snakeCaseEnumMemberName("WarrantPrepareList")).toBe("warrant_prepare_list");
    expect(snakeCaseEnumMemberName("ToBeOpened")).toBe("to_be_opened");
    expect(snakeCaseEnumMemberName("SplitStockHalts")).toBe("split_stock_halts");
    expect(snakeCaseEnumMemberName("CodeMoved")).toBe("code_moved");
    expect(snakeCaseEnumMemberName("Fuse")).toBe("fuse");
  });
});

describe("buildEnumNameMaps against the installed longport SDK", () => {
  // Deliberately load the actual runtime module: these maps must track the
  // installed SDK's true name->value pairs, never a hand-pinned index order.
  const runtime = createRequire(import.meta.url)("longport") as Record<string, Record<string, number>>;
  const maps = buildEnumNameMaps(runtime);

  it("decodes order statuses by value, not by index position", () => {
    expect(maps.orderStatus.get(runtime.OrderStatus?.Filled as number)).toBe("Filled");
    expect(maps.orderStatus.get(runtime.OrderStatus?.Rejected as number)).toBe("Rejected");
    expect(maps.orderStatus.get(runtime.OrderStatus?.PartialWithdrawal as number)).toBe("PartialWithdrawal");
    expect(maps.orderStatus.get(runtime.OrderStatus?.Unknown as number)).toBe("Unknown");
  });

  it("keeps the consumer-facing name conventions for every table", () => {
    expect(maps.tradeStatus.get(runtime.TradeStatus?.Normal as number)).toBe("normal");
    expect(maps.tradeStatus.get(runtime.TradeStatus?.WarrantPrepareList as number)).toBe("warrant_prepare_list");
    expect(maps.orderSide.get(runtime.OrderSide?.Buy as number)).toBe("buy");
    expect(maps.orderSide.get(runtime.OrderSide?.Sell as number)).toBe("sell");
    expect(maps.orderType.get(runtime.OrderType?.LO as number)).toBe("LO");
    expect(maps.orderType.get(runtime.OrderType?.TSLPPCT as number)).toBe("TSLPPCT");
    expect(maps.timeInForce.get(runtime.TimeInForceType?.Day as number)).toBe("Day");
    expect(maps.timeInForce.get(runtime.TimeInForceType?.GoodTilCanceled as number)).toBe("GoodTilCanceled");
  });

  it("maps Market.Unknown to empty string so shape omits it", () => {
    expect(maps.market.get(runtime.Market?.Unknown as number)).toBe("");
    expect(maps.market.get(runtime.Market?.US as number)).toBe("US");
    expect(maps.market.get(runtime.Market?.HK as number)).toBe("HK");
  });

  it("tolerates a runtime module missing an enum (empty map, fallback path)", () => {
    const partial = buildEnumNameMaps({});
    expect(partial.orderStatus.size).toBe(0);
  });
});

describe("truncateRemark", () => {
  it("keeps remarks at or under the limit unchanged", () => {
    expect(truncateRemark("OpenClaw paper t-1", 64)).toBe("OpenClaw paper t-1");
    expect(truncateRemark("x".repeat(64), 64)).toBe("x".repeat(64));
  });

  it("keeps the TAIL when over the limit so the full ticket id survives", () => {
    // Production remark: "OpenClaw paper " (15) + deriveTicketId(createId("prop")) (53) = 68 chars.
    const ticketId = "ticket_prop_prop_0f8d2c4e-1111-2222-3333-444455556666";
    expect(ticketId).toHaveLength(53);
    const truncated = truncateRemark(`OpenClaw paper ${ticketId}`, 64);
    expect(truncated).toHaveLength(64);
    expect(truncated.endsWith(ticketId)).toBe(true);
  });
});

describe("calendarTimeLabel", () => {
  it("prefers dateType, then financialMarketTime", () => {
    expect(calendarTimeLabel("盘前", "09:30")).toBe("盘前");
    expect(calendarTimeLabel("", "09:30")).toBe("09:30");
  });

  it("returns undefined when both are empty (never the event's date string)", () => {
    expect(calendarTimeLabel("", "")).toBeUndefined();
    expect(calendarTimeLabel(undefined, undefined)).toBeUndefined();
  });
});
