// The real SDK adapter: the ONLY module that touches the longport npm
// package. Everything it returns is plain JSON-safe data (Decimal -> string,
// Date -> ISO string, enum -> readable name) per the LongbridgeAdapter seam.
//
// Notes pinned against longport@4.3.3 (verified from the shipped index.d.ts):
//   - Config.fromApikey(appKey, appSecret, accessToken, extra) — v3's
//     Config.fromEnv() no longer exists; we always pass explicit values so
//     the LONGBRIDGE_*-first precedence is honored regardless of what the
//     SDK would read from the environment.
//   - Context factories (QuoteContext.new etc.) return synchronously and
//     connect lazily, so probe() must issue a real RPC (quoteLevel()).
//   - enablePrintQuotePackages MUST be false: its default (true) prints
//     connection info that would pollute the pure-JSON stdout contract.
//   - Enum decoding: the d.ts declares `const enum`s (member accesses are
//     compile-time inlined), but the napi runtime module exports real
//     name -> value objects. The value -> name maps are derived from those
//     at load time (see sdk-mapping.ts) so an SDK bump that inserts or
//     reorders enum members can never silently relabel a decoded status.

import { createRequire } from "node:module";

import {
  CalendarCategory,
  CalendarContext,
  Config,
  ContentContext,
  Decimal,
  OrderSide,
  OrderType,
  OutsideRTH,
  QuoteContext,
  TimeInForceType,
  TradeContext
} from "longport";
import type {
  AccountBalance,
  CalendarDateGroup,
  Execution,
  NewsItem,
  Order,
  OrderDetail,
  SecurityQuote,
  StockPositionsResponse,
  SubmitOrderOptions,
  WatchlistGroup
} from "longport";

import type {
  AdapterAsset,
  AdapterCalendarGroup,
  AdapterExecution,
  AdapterNewsItem,
  AdapterOrder,
  AdapterPosition,
  AdapterQuote,
  AdapterSessionQuote,
  AdapterSubmitRequest,
  FinanceCalendarRequest,
  LongbridgeAdapter
} from "./adapter.js";
import type { EnvLike, Region, RegionEndpoints, RegionResolution, ResolvedCredentials } from "./env.js";
import { endpointsForRegion } from "./env.js";
import type { AdapterFactory } from "./main.js";
import { buildEnumNameMaps, calendarTimeLabel, truncateRemark } from "./sdk-mapping.js";

// ---------------------------------------------------------------------------
// enum value -> name maps, derived from the installed SDK's runtime module
// (never index-positional; see sdk-mapping.ts for the rationale and tests)
// ---------------------------------------------------------------------------

const ENUM_MAPS = buildEnumNameMaps(
  createRequire(import.meta.url)("longport") as Record<string, unknown>
);

const ORDER_TYPE_VALUES: Record<string, OrderType> = {
  LO: OrderType.LO,
  ELO: OrderType.ELO,
  MO: OrderType.MO,
  AO: OrderType.AO,
  ALO: OrderType.ALO,
  ODD: OrderType.ODD,
  LIT: OrderType.LIT,
  MIT: OrderType.MIT,
  TSLPAMT: OrderType.TSLPAMT,
  TSLPPCT: OrderType.TSLPPCT,
  TSMAMT: OrderType.TSMAMT,
  TSMPCT: OrderType.TSMPCT,
  SLO: OrderType.SLO
};

const TIME_IN_FORCE_VALUES: Record<string, TimeInForceType> = {
  Day: TimeInForceType.Day,
  GoodTilCanceled: TimeInForceType.GoodTilCanceled,
  GoodTilDate: TimeInForceType.GoodTilDate
};

const OUTSIDE_RTH_VALUES: Record<string, OutsideRTH> = {
  RTHOnly: OutsideRTH.RTHOnly,
  AnyTime: OutsideRTH.AnyTime,
  Overnight: OutsideRTH.Overnight
};

const CALENDAR_CATEGORY_VALUES: Record<string, CalendarCategory> = {
  report: CalendarCategory.Report,
  dividend: CalendarCategory.Dividend,
  split: CalendarCategory.Split,
  ipo: CalendarCategory.Ipo,
  macrodata: CalendarCategory.MacroData,
  closed: CalendarCategory.Closed,
  meeting: CalendarCategory.Meeting,
  merge: CalendarCategory.Merge
};

// LongPort OpenAPI hard limit — a longer remark is rejected by the server,
// so truncating here keeps the order submittable (the repo-side caller
// already truncates to 255, which can still exceed the SDK's 64). The TAIL
// is kept because the production remark's discriminating content (the full
// 53-char ticket id) sits at the end; see truncateRemark in sdk-mapping.ts.
const MAX_REMARK_LENGTH = 64;

// ---------------------------------------------------------------------------
// primitive conversions
// ---------------------------------------------------------------------------

function dec(value: Decimal | null | undefined): string | undefined {
  return value == null ? undefined : value.toString();
}

function iso(value: Date | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const ms = value.getTime();
  return Number.isFinite(ms) ? value.toISOString() : undefined;
}

function enumName(names: Map<number, string>, value: number, fallback: string): string {
  return names.get(value) ?? fallback;
}

// ---------------------------------------------------------------------------
// SDK object -> adapter data mapping
// ---------------------------------------------------------------------------

function mapSessionQuote(
  session: { lastDone: Decimal; timestamp: Date; volume: number; turnover: Decimal; high: Decimal; low: Decimal; prevClose: Decimal } | null
): AdapterSessionQuote | undefined {
  if (session == null) {
    return undefined;
  }
  return {
    last: session.lastDone.toString(),
    timestamp: iso(session.timestamp),
    prevClose: dec(session.prevClose),
    high: dec(session.high),
    low: dec(session.low),
    volume: session.volume,
    turnover: dec(session.turnover)
  };
}

function mapQuote(quote: SecurityQuote): AdapterQuote {
  return {
    symbol: quote.symbol,
    lastDone: dec(quote.lastDone),
    prevClose: dec(quote.prevClose),
    open: dec(quote.open),
    high: dec(quote.high),
    low: dec(quote.low),
    volume: quote.volume,
    turnover: dec(quote.turnover),
    timestamp: iso(quote.timestamp),
    status: enumName(ENUM_MAPS.tradeStatus, quote.tradeStatus as number, `unknown_${String(quote.tradeStatus)}`),
    preMarket: mapSessionQuote(quote.preMarketQuote),
    postMarket: mapSessionQuote(quote.postMarketQuote)
  };
}

function mapBalance(balance: AccountBalance): AdapterAsset {
  return {
    netAssets: dec(balance.netAssets),
    totalCash: dec(balance.totalCash),
    currency: balance.currency,
    buyPower: dec(balance.buyPower),
    riskLevel: balance.riskLevel,
    maxFinanceAmount: dec(balance.maxFinanceAmount),
    remainingFinanceAmount: dec(balance.remainingFinanceAmount),
    marginCall: dec(balance.marginCall),
    initMargin: dec(balance.initMargin),
    maintenanceMargin: dec(balance.maintenanceMargin),
    cash: balance.cashInfos.map((info) => ({
      currency: info.currency,
      availableCash: dec(info.availableCash),
      withdrawCash: dec(info.withdrawCash),
      frozenCash: dec(info.frozenCash),
      settlingCash: dec(info.settlingCash)
    }))
  };
}

function mapPositions(response: StockPositionsResponse): AdapterPosition[] {
  return response.channels.flatMap((channel) =>
    channel.positions.map((position) => ({
      symbol: position.symbol,
      name: position.symbolName,
      quantity: dec(position.quantity),
      available: dec(position.availableQuantity),
      currency: position.currency,
      costPrice: dec(position.costPrice),
      market: enumName(ENUM_MAPS.market, position.market as number, String(position.market)),
      accountChannel: channel.accountChannel,
      initQuantity: dec(position.initQuantity)
    }))
  );
}

function mapWatchlist(groups: WatchlistGroup[]): unknown {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    securities: group.securities.map((security) => ({
      symbol: security.symbol,
      market: enumName(ENUM_MAPS.market, security.market as number, String(security.market)),
      name: security.name,
      watched_price: dec(security.watchedPrice) ?? null,
      watched_at: iso(security.watchedAt) ?? null,
      is_pinned: security.isPinned
    }))
  }));
}

function mapNews(item: NewsItem): AdapterNewsItem {
  const publishedAtMs = item.publishedAt?.getTime();
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    url: item.url,
    publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : undefined,
    likesCount: item.likesCount,
    commentsCount: item.commentsCount,
    sharesCount: item.sharesCount
  };
}

function mapCalendarGroup(group: CalendarDateGroup): AdapterCalendarGroup {
  return {
    date: group.date,
    infos: group.infos.map((info) => ({
      id: info.id,
      content: info.content || info.counterName,
      market: info.market,
      star: info.star,
      datetime: info.datetime,
      timeLabel: calendarTimeLabel(info.dateType, info.financialMarketTime),
      type: info.eventType,
      symbol: info.symbol,
      dataKv: info.dataKv.map((kv) => ({ key: kv.key, type: kv.valueType, value: kv.value }))
    }))
  };
}

function mapOrder(order: Order | OrderDetail): AdapterOrder {
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    side: enumName(ENUM_MAPS.orderSide, order.side as number, "unknown"),
    status: enumName(ENUM_MAPS.orderStatus, order.status as number, `Unknown(${String(order.status)})`),
    quantity: dec(order.quantity),
    executedQuantity: dec(order.executedQuantity),
    price: dec(order.price),
    executedPrice: dec(order.executedPrice),
    submittedAtIso: iso(order.submittedAt),
    updatedAtIso: iso(order.updatedAt),
    orderType: enumName(ENUM_MAPS.orderType, order.orderType as number, "Unknown"),
    timeInForce: enumName(ENUM_MAPS.timeInForce, order.timeInForce as number, "Unknown"),
    remark: order.remark,
    msg: order.msg,
    currency: order.currency,
    stockName: order.stockName
  };
}

function mapExecution(execution: Execution): AdapterExecution {
  return {
    orderId: execution.orderId,
    tradeId: execution.tradeId,
    symbol: execution.symbol,
    tradeDoneAtIso: iso(execution.tradeDoneAt),
    quantity: dec(execution.quantity),
    price: dec(execution.price)
  };
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

class LongportAdapter implements LongbridgeAdapter {
  private configInstance: Config | undefined;
  private quoteContext: QuoteContext | undefined;
  private tradeContext: TradeContext | undefined;

  constructor(
    private readonly creds: ResolvedCredentials,
    private readonly endpoints: RegionEndpoints
  ) {}

  private config(): Config {
    this.configInstance ??= Config.fromApikey(this.creds.appKey, this.creds.appSecret, this.creds.accessToken, {
      httpUrl: this.endpoints.httpUrl,
      quoteWsUrl: this.endpoints.quoteWsUrl,
      tradeWsUrl: this.endpoints.tradeWsUrl,
      enablePrintQuotePackages: false
    });
    return this.configInstance;
  }

  private quote(): QuoteContext {
    this.quoteContext ??= QuoteContext.new(this.config());
    return this.quoteContext;
  }

  private trade(): TradeContext {
    this.tradeContext ??= TradeContext.new(this.config());
    return this.tradeContext;
  }

  async probe(): Promise<void> {
    // Context construction is lazy in longport@4.3.3, so force a real
    // round-trip: quoteLevel() authenticates the websocket session.
    await this.quote().quoteLevel();
  }

  async getQuotes(symbols: string[]): Promise<AdapterQuote[]> {
    const quotes = await this.quote().quote(symbols);
    return quotes.map(mapQuote);
  }

  async getAssets(): Promise<AdapterAsset[]> {
    const balances = await this.trade().accountBalance();
    return balances.map(mapBalance);
  }

  async getPositions(): Promise<AdapterPosition[]> {
    return mapPositions(await this.trade().stockPositions());
  }

  async getWatchlist(): Promise<unknown> {
    return mapWatchlist(await this.quote().watchlist());
  }

  async getNews(symbol: string): Promise<AdapterNewsItem[]> {
    const items = await ContentContext.new(this.config()).news(symbol);
    return items.map(mapNews);
  }

  async getFinanceCalendar(req: FinanceCalendarRequest): Promise<AdapterCalendarGroup[]> {
    const category = CALENDAR_CATEGORY_VALUES[req.category];
    if (category === undefined) {
      throw new Error(`不支持的日历类别: ${req.category}`);
    }
    const response = await CalendarContext.new(this.config()).financeCalendar(
      category,
      req.start,
      req.end,
      req.market ?? null
    );
    return response.list.map(mapCalendarGroup);
  }

  async getTodayOrders(): Promise<AdapterOrder[]> {
    const orders = await this.trade().todayOrders();
    return orders.map(mapOrder);
  }

  async getTodayExecutions(): Promise<AdapterExecution[]> {
    const executions = await this.trade().todayExecutions();
    return executions.map(mapExecution);
  }

  async submitOrder(req: AdapterSubmitRequest): Promise<{ orderId: string }> {
    const orderType = ORDER_TYPE_VALUES[req.orderType];
    if (orderType === undefined) {
      throw new Error(`不支持的订单类型: ${req.orderType}`);
    }
    const timeInForce = TIME_IN_FORCE_VALUES[req.timeInForce];
    if (timeInForce === undefined) {
      throw new Error(`不支持的有效期类型: ${req.timeInForce}`);
    }
    const outsideRth = req.outsideRth === undefined ? undefined : OUTSIDE_RTH_VALUES[req.outsideRth];
    if (req.outsideRth !== undefined && outsideRth === undefined) {
      throw new Error(`不支持的盘前盘后设置: ${req.outsideRth}`);
    }

    const options: SubmitOrderOptions = {
      symbol: req.symbol,
      orderType,
      side: req.side === "sell" ? OrderSide.Sell : OrderSide.Buy,
      submittedQuantity: new Decimal(req.quantity),
      timeInForce,
      ...(req.price !== undefined ? { submittedPrice: new Decimal(req.price) } : {}),
      ...(req.remark !== undefined ? { remark: truncateRemark(req.remark, MAX_REMARK_LENGTH) } : {}),
      ...(outsideRth !== undefined ? { outsideRth } : {})
    };

    const response = await this.trade().submitOrder(options);
    // Exit 0 must mean "the broker confirmed an order id". An empty/missing
    // id from the SDK is an unconfirmed submit — surface it as a failure so
    // callers treat it as submit_unconfirmed instead of a success.
    if (!response.orderId) {
      throw new Error("券商响应缺少 order_id，下单结果未确认：请用 order / order detail 人工核对该订单是否已受理");
    }
    return { orderId: response.orderId };
  }

  async getOrderDetail(orderId: string): Promise<AdapterOrder> {
    return mapOrder(await this.trade().orderDetail(orderId));
  }
}

export function createLongportAdapterFactory(
  creds: ResolvedCredentials,
  env: EnvLike,
  regions: RegionResolution
): AdapterFactory {
  return (region: Region) => {
    // Explicit LONGPORT_*_URL overrides only apply to the resolved active
    // region; check probes the OTHER region against its canonical endpoints
    // so its ok/fail answer stays honest.
    const endpoints = endpointsForRegion(region, region === regions.active ? env : undefined);
    return new LongportAdapter(creds, endpoints);
  };
}
