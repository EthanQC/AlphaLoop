// The thin injectable seam between the pure CLI core and the longport SDK.
// Adapter methods return plain JSON-safe primitives (decimals as strings,
// dates as ISO strings, enums as readable names) so output shaping stays
// pure and unit-testable without the native SDK.

export interface AdapterSessionQuote {
  last: string;
  timestamp?: string | undefined;
  prevClose?: string | undefined;
  high?: string | undefined;
  low?: string | undefined;
  volume?: number | undefined;
  turnover?: string | undefined;
}

export interface AdapterQuote {
  symbol: string;
  lastDone?: string | undefined;
  prevClose?: string | undefined;
  open?: string | undefined;
  high?: string | undefined;
  low?: string | undefined;
  volume?: number | undefined;
  turnover?: string | undefined;
  timestamp?: string | undefined;
  status?: string | undefined;
  preMarket?: AdapterSessionQuote | undefined;
  postMarket?: AdapterSessionQuote | undefined;
}

export interface AdapterCashInfo {
  currency?: string | undefined;
  availableCash?: string | undefined;
  withdrawCash?: string | undefined;
  frozenCash?: string | undefined;
  settlingCash?: string | undefined;
}

export interface AdapterAsset {
  netAssets?: string | undefined;
  totalCash?: string | undefined;
  currency?: string | undefined;
  buyPower?: string | undefined;
  riskLevel?: number | undefined;
  maxFinanceAmount?: string | undefined;
  remainingFinanceAmount?: string | undefined;
  marginCall?: string | undefined;
  initMargin?: string | undefined;
  maintenanceMargin?: string | undefined;
  cash?: AdapterCashInfo[] | undefined;
}

export interface AdapterPosition {
  symbol: string;
  name?: string | undefined;
  quantity?: string | undefined;
  available?: string | undefined;
  currency?: string | undefined;
  costPrice?: string | undefined;
  market?: string | undefined;
  accountChannel?: string | undefined;
  initQuantity?: string | undefined;
}

export interface AdapterNewsItem {
  id: string;
  title: string;
  description?: string | undefined;
  url?: string | undefined;
  publishedAtMs?: number | undefined;
  likesCount?: number | undefined;
  commentsCount?: number | undefined;
  sharesCount?: number | undefined;
}

export interface AdapterCalendarKv {
  key: string;
  type: string;
  value: string;
}

export interface AdapterCalendarEntry {
  id: string;
  content: string;
  market?: string | undefined;
  star?: number | undefined;
  /** Raw epoch value from the SDK (unix timestamp string, usually seconds). */
  datetime?: string | undefined;
  /** Time-of-day display label, e.g. "盘前". */
  timeLabel?: string | undefined;
  type?: string | undefined;
  symbol?: string | undefined;
  dataKv?: AdapterCalendarKv[] | undefined;
}

export interface AdapterCalendarGroup {
  date: string;
  infos: AdapterCalendarEntry[];
}

export interface AdapterOrder {
  orderId: string;
  symbol: string;
  side: string;
  status: string;
  quantity?: string | undefined;
  executedQuantity?: string | undefined;
  price?: string | undefined;
  executedPrice?: string | undefined;
  submittedAtIso?: string | undefined;
  updatedAtIso?: string | undefined;
  orderType?: string | undefined;
  timeInForce?: string | undefined;
  remark?: string | undefined;
  msg?: string | undefined;
  currency?: string | undefined;
  stockName?: string | undefined;
}

export interface AdapterExecution {
  orderId: string;
  tradeId?: string | undefined;
  symbol?: string | undefined;
  tradeDoneAtIso?: string | undefined;
  quantity?: string | undefined;
  price?: string | undefined;
}

export interface AdapterSubmitRequest {
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  price?: string | undefined;
  orderType: string;
  timeInForce: string;
  remark?: string | undefined;
  outsideRth?: string | undefined;
}

export interface FinanceCalendarRequest {
  category: string;
  start: string;
  end: string;
  market?: string | undefined;
}

export interface LongbridgeAdapter {
  /** Connectivity + auth probe against this adapter's region; throws on failure. */
  probe(): Promise<void>;
  getQuotes(symbols: string[]): Promise<AdapterQuote[]>;
  getAssets(): Promise<AdapterAsset[]>;
  getPositions(): Promise<AdapterPosition[]>;
  getWatchlist(): Promise<unknown>;
  getNews(symbol: string): Promise<AdapterNewsItem[]>;
  getFinanceCalendar(req: FinanceCalendarRequest): Promise<AdapterCalendarGroup[]>;
  getTodayOrders(): Promise<AdapterOrder[]>;
  getTodayExecutions(): Promise<AdapterExecution[]>;
  submitOrder(req: AdapterSubmitRequest): Promise<{ orderId: string }>;
  getOrderDetail(orderId: string): Promise<AdapterOrder>;
}
