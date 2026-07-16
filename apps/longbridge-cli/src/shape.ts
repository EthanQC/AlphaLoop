// Pure output shaping: adapter data -> the exact JSON field names every repo
// consumer reads (see the contract notes in each builder). All builders strip
// undefined values so absent data is omitted rather than emitted as null —
// consumers (report-data.mjs normalizers, broker-executor's findStringValue)
// treat missing keys correctly but can choke on placeholder values.

import type {
  AdapterAsset,
  AdapterCalendarGroup,
  AdapterExecution,
  AdapterNewsItem,
  AdapterOrder,
  AdapterPosition,
  AdapterQuote,
  AdapterSessionQuote
} from "./adapter.js";
import type { OrderSubmitCommand } from "./cli.js";
import type { Region, RegionResolution } from "./env.js";

export type JsonRecord = Record<string, unknown>;

function compact(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

// --------------------------------------------------------------------------
// check — read by _longbridge.mjs healLongbridgeRegionCacheFromCheck
// (connectivity.<region>.ok strictly true; region.active preferred for the
// cache write) and report-data.mjs validateLongbridgeCheck (session.token
// must be "valid"; at least one connectivity entry ok === true).
// --------------------------------------------------------------------------

export interface ProbeResult {
  ok: boolean;
  latencyMs?: number | undefined;
  error?: string | undefined;
}

export interface CheckInput {
  resolution: RegionResolution;
  probes: Record<Region, ProbeResult>;
}

function connectivityEntry(probe: ProbeResult): JsonRecord {
  return probe.ok
    ? compact({ ok: true, latency_ms: probe.latencyMs })
    : compact({ ok: false, error: probe.error });
}

export function buildCheckPayload({ resolution, probes }: CheckInput): JsonRecord {
  const okRegions = (["global", "cn"] as const).filter((region) => probes[region].ok === true);
  const anyOk = okRegions.length > 0;
  const active = probes[resolution.active].ok ? resolution.active : okRegions[0] ?? resolution.active;

  return {
    session: { token: anyOk ? "valid" : "invalid" },
    connectivity: {
      global: connectivityEntry(probes.global),
      cn: connectivityEntry(probes.cn)
    },
    region: {
      active,
      cached: resolution.cached ?? resolution.active
    }
  };
}

// --------------------------------------------------------------------------
// quote — rows must round-trip the requested symbol exactly
// (report-data.mjs normalizeQuotePayload compares uppercased), expose
// last_done, and use { last, timestamp } inside pre/post market objects
// (scheduled-report.mjs renderQqqSection reads post.last / pre.last).
// --------------------------------------------------------------------------

function sessionQuotePayload(session: AdapterSessionQuote | undefined): JsonRecord | undefined {
  if (session === undefined) {
    return undefined;
  }
  return compact({
    last: session.last,
    timestamp: session.timestamp,
    prev_close: session.prevClose,
    high: session.high,
    low: session.low,
    volume: session.volume,
    turnover: session.turnover
  });
}

export function buildQuoteRows(requestedSymbols: string[], quotes: AdapterQuote[]): JsonRecord[] {
  const bySymbol = new Map(quotes.map((quote) => [quote.symbol.toUpperCase(), quote]));
  const rows: JsonRecord[] = [];
  for (const requested of requestedSymbols) {
    const upper = requested.toUpperCase();
    const quote = bySymbol.get(upper);
    if (quote === undefined) {
      continue;
    }
    rows.push(compact({
      symbol: upper,
      last_done: quote.lastDone,
      prev_close: quote.prevClose,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      volume: quote.volume,
      turnover: quote.turnover,
      timestamp: quote.timestamp,
      status: quote.status,
      pre_market_quote: sessionQuotePayload(quote.preMarket),
      post_market_quote: sessionQuotePayload(quote.postMarket)
    }));
  }
  return rows;
}

// --------------------------------------------------------------------------
// assets — rows[0] must expose net_assets / total_cash / currency
// (validateOfficialPrimaryAsset), plus buy_power / risk_level rendered by
// scheduled-report.mjs.
// --------------------------------------------------------------------------

export function buildAssetsPayload(assets: AdapterAsset[]): JsonRecord[] {
  return assets.map((asset) => compact({
    net_assets: asset.netAssets,
    total_cash: asset.totalCash,
    currency: asset.currency,
    buy_power: asset.buyPower,
    risk_level: asset.riskLevel,
    max_finance_amount: asset.maxFinanceAmount,
    remaining_finance_amount: asset.remainingFinanceAmount,
    margin_call: asset.marginCall,
    init_margin: asset.initMargin,
    maintenance_margin: asset.maintenanceMargin,
    cash_infos: asset.cash?.map((info) => compact({
      currency: info.currency,
      available_cash: info.availableCash,
      withdraw_cash: info.withdrawCash,
      frozen_cash: info.frozenCash,
      settling_cash: info.settlingCash
    }))
  }));
}

// --------------------------------------------------------------------------
// positions — normalizeOfficialPosition reads symbol / quantity / name /
// market / currency / available / cost_price. An empty name is omitted so
// the consumer defaults it to the symbol.
// --------------------------------------------------------------------------

export function buildPositionsPayload(positions: AdapterPosition[]): JsonRecord[] {
  return positions.map((position) => compact({
    symbol: position.symbol.toUpperCase(),
    name: nonEmpty(position.name),
    quantity: position.quantity,
    available: position.available,
    currency: position.currency,
    cost_price: position.costPrice,
    market: nonEmpty(position.market),
    account_channel: nonEmpty(position.accountChannel),
    init_quantity: position.initQuantity
  }));
}

// --------------------------------------------------------------------------
// watchlist — embedded verbatim by longbridge-account-snapshot.mjs; any
// valid JSON works, adapter already produces plain data.
// --------------------------------------------------------------------------

export function buildWatchlistPayload(groups: unknown): unknown {
  return groups;
}

// --------------------------------------------------------------------------
// news — normalizeNewsArticle reads id/title/url/published_at (epoch,
// s-vs-ms auto-detected)/likes_count/comments_count. Unknown timestamps are
// omitted, never fabricated (#31 audit rule).
// --------------------------------------------------------------------------

export function buildNewsPayload(items: AdapterNewsItem[], count: number): JsonRecord[] {
  return items.slice(0, count).map((item) => compact({
    id: item.id,
    title: item.title,
    description: nonEmpty(item.description),
    url: nonEmpty(item.url),
    published_at: item.publishedAtMs,
    likes_count: item.likesCount,
    comments_count: item.commentsCount,
    shares_count: item.sharesCount
  }));
}

// --------------------------------------------------------------------------
// finance-calendar — normalizeMacroCalendarPayload expects [{ date, infos }]
// groups; normalizeMacroCalendarEntry reads content/id/datetime (epoch s or
// ms)/date (time-of-day label)/market/star/type/data_kv[{key,type,value}].
// --------------------------------------------------------------------------

export interface CalendarFilter {
  stars: number[];
  count?: number | undefined;
}

export function buildCalendarPayload(groups: AdapterCalendarGroup[], filter: CalendarFilter): JsonRecord[] {
  const starSet = new Set(filter.stars);
  let remaining = filter.count ?? Number.POSITIVE_INFINITY;
  const payload: JsonRecord[] = [];

  for (const group of groups) {
    if (remaining <= 0) {
      break;
    }
    const infos: JsonRecord[] = [];
    for (const info of group.infos) {
      if (remaining <= 0) {
        break;
      }
      if (starSet.size > 0 && !starSet.has(info.star ?? 0)) {
        continue;
      }
      remaining -= 1;
      const datetime = Number(info.datetime);
      infos.push(compact({
        id: info.id,
        content: info.content,
        market: nonEmpty(info.market),
        star: info.star,
        datetime: Number.isFinite(datetime) && datetime > 0 ? datetime : undefined,
        date: nonEmpty(info.timeLabel),
        type: nonEmpty(info.type),
        symbol: nonEmpty(info.symbol),
        data_kv: info.dataKv?.map((kv) => ({ key: kv.key, type: kv.type, value: kv.value }))
      }));
    }
    if (infos.length > 0) {
      payload.push({ date: group.date, infos });
    }
  }

  return payload;
}

// --------------------------------------------------------------------------
// orders — reconcile-official-paper-orders.mjs reads order_id / symbol /
// side / quantity / price / status (raw broker enum name, mapped through
// broker-status-map.mjs) / created_at. broker-executor's deep search reads
// status and executed_price from the detail payload.
// --------------------------------------------------------------------------

function orderRecord(order: AdapterOrder): JsonRecord {
  return compact({
    order_id: order.orderId,
    symbol: order.symbol,
    side: order.side,
    status: order.status,
    quantity: order.quantity,
    executed_quantity: order.executedQuantity,
    price: order.price,
    executed_price: order.executedPrice,
    created_at: order.submittedAtIso,
    updated_at: order.updatedAtIso,
    order_type: order.orderType,
    time_in_force: order.timeInForce,
    remark: nonEmpty(order.remark),
    msg: nonEmpty(order.msg),
    currency: nonEmpty(order.currency),
    stock_name: nonEmpty(order.stockName)
  });
}

export function buildOrderListPayload(orders: AdapterOrder[]): JsonRecord[] {
  return orders.map(orderRecord);
}

export function buildExecutionsPayload(executions: AdapterExecution[]): JsonRecord[] {
  return executions.map((execution) => compact({
    order_id: execution.orderId,
    trade_id: execution.tradeId,
    symbol: execution.symbol,
    trade_done_at: execution.tradeDoneAtIso,
    quantity: execution.quantity,
    price: execution.price
  }));
}

// The submit payload deliberately carries NO status key: broker-executor's
// extractBrokerStatus deep-searches the payload, and a fabricated status here
// would masquerade as a broker-confirmed state. The follow-up
// `order detail <id>` call is the honest status source.
export function buildSubmitPayload(response: { orderId: string }, command: OrderSubmitCommand): JsonRecord {
  return compact({
    order_id: response.orderId,
    symbol: command.symbol,
    side: command.side,
    quantity: command.quantity,
    price: command.price,
    order_type: command.orderType,
    time_in_force: command.timeInForce,
    remark: command.remark,
    outside_rth: command.outsideRth
  });
}

export function buildOrderDetailPayload(detail: AdapterOrder): JsonRecord {
  const record = orderRecord(detail);
  return compact({
    ...record,
    submitted_at: record.created_at
  });
}
