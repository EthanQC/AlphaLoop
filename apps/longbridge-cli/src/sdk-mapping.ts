// Pure helpers for decoding longport SDK values into the CLI's output
// vocabulary. No runtime SDK import lives here — the adapter feeds in the
// SDK's runtime enum objects — so every mapping rule stays unit-testable
// without loading the native module.
//
// Why runtime-derived maps: longport's index.d.ts declares its enums as
// `const enum`s, so member ACCESSES are inlined at compile time, but the
// napi runtime module still exports real name -> value objects (with
// non-enumerable own properties and no reverse mapping). Deriving the
// value -> name maps from those objects means an SDK upgrade that inserts
// or reorders enum members can never silently relabel a decoded status the
// way a hand-pinned index table could.

export function reverseEnumMap(
  enumObject: unknown,
  transform: (memberName: string) => string = (name) => name
): Map<number, string> {
  const map = new Map<number, string>();
  if (enumObject === null || typeof enumObject !== "object") {
    return map;
  }
  for (const memberName of Object.getOwnPropertyNames(enumObject)) {
    const value = (enumObject as Record<string, unknown>)[memberName];
    if (typeof value === "number" && !map.has(value)) {
      map.set(value, transform(memberName));
    }
  }
  return map;
}

/** "WarrantPrepareList" -> "warrant_prepare_list" (quote trade-status contract). */
export function snakeCaseEnumMemberName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

export interface EnumNameMaps {
  tradeStatus: Map<number, string>;
  orderStatus: Map<number, string>;
  orderSide: Map<number, string>;
  orderType: Map<number, string>;
  timeInForce: Map<number, string>;
  market: Map<number, string>;
}

/**
 * Build every value -> name table the adapter needs from the SDK's runtime
 * module object. Name transforms preserve the exact output contract the
 * repo's consumers already read (snake_case trade statuses, lowercase
 * sides, PascalCase order statuses, "" for Market.Unknown so shape.ts
 * omits the key).
 */
export function buildEnumNameMaps(runtimeEnums: Record<string, unknown>): EnumNameMaps {
  return {
    tradeStatus: reverseEnumMap(runtimeEnums.TradeStatus, snakeCaseEnumMemberName),
    orderStatus: reverseEnumMap(runtimeEnums.OrderStatus),
    orderSide: reverseEnumMap(runtimeEnums.OrderSide, (name) => name.toLowerCase()),
    orderType: reverseEnumMap(runtimeEnums.OrderType),
    timeInForce: reverseEnumMap(runtimeEnums.TimeInForceType),
    market: reverseEnumMap(runtimeEnums.Market, (name) => (name === "Unknown" ? "" : name))
  };
}

/**
 * Fit a remark into the LongPort OpenAPI hard limit by keeping the TAIL of
 * an over-long remark. The repo's production remark is
 * "OpenClaw paper <ticketId>" (68 chars for real proposal-derived tickets),
 * and the discriminating content — the full ticket id — sits at the end, so
 * tail-keeping preserves exact copy-paste traceability in the broker UI
 * while head-truncation would always cut the ticket id's last 4 chars.
 */
export function truncateRemark(remark: string, maxLength: number): string {
  return remark.length <= maxLength ? remark : remark.slice(remark.length - maxLength);
}

/**
 * Time-of-day label for a calendar entry: dateType ("盘前" etc.), else
 * financialMarketTime, else undefined. Never falls back to the event's own
 * date string — report-data.mjs renders this value as a time-of-day label
 * next to the group date, so a date here would show up twice.
 */
export function calendarTimeLabel(
  dateType: string | undefined,
  financialMarketTime: string | undefined
): string | undefined {
  const label = (dateType !== undefined && dateType !== "" ? dateType : financialMarketTime) ?? "";
  return label === "" ? undefined : label;
}
