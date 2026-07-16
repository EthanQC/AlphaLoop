// Pure argv parsing for the longbridge CLI. No I/O, no SDK imports — every
// consumer in this repo invokes the binary via execFileSync with
// "--format json" appended as the final two argv entries (see
// apps/openclaw-config/scripts/_longbridge.mjs and
// apps/broker-executor/src/longbridge-paper.ts), so the parser accepts the
// global --format flag anywhere in argv.

export class UsageError extends Error {}

export type OrderSide = "buy" | "sell";

export interface OrderSubmitCommand {
  kind: "order-submit";
  side: OrderSide;
  symbol: string;
  quantity: string;
  price?: string | undefined;
  orderType: string;
  timeInForce: string;
  remark?: string | undefined;
  outsideRth?: string | undefined;
  yes: boolean;
}

export interface FinanceCalendarCommand {
  kind: "finance-calendar";
  category: string;
  stars: number[];
  market?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  count?: number | undefined;
}

export type Command =
  | { kind: "help" }
  | { kind: "check" }
  | { kind: "quote"; symbols: string[] }
  | { kind: "assets" }
  | { kind: "positions" }
  | { kind: "watchlist" }
  | { kind: "news"; symbol: string; count: number }
  | FinanceCalendarCommand
  | { kind: "order-list" }
  | { kind: "order-executions" }
  | { kind: "order-detail"; orderId: string }
  | OrderSubmitCommand;

export interface ParsedInvocation {
  format: "json";
  command: Command;
}

const VALUE_FLAGS = new Set([
  "--format",
  "--count",
  "--price",
  "--order-type",
  "--tif",
  "--remark",
  "--market",
  "--star",
  "--start",
  "--end",
  "--outside-rth"
]);

const BOOL_FLAGS = new Set(["--yes", "--help", "-h"]);

const CALENDAR_CATEGORIES = new Set([
  "report",
  "dividend",
  "split",
  "ipo",
  "macrodata",
  "closed",
  "meeting",
  "merge"
]);

const ORDER_TYPES = new Map<string, string>([
  ["lo", "LO"],
  ["elo", "ELO"],
  ["mo", "MO"],
  ["ao", "AO"],
  ["alo", "ALO"],
  ["odd", "ODD"],
  ["lit", "LIT"],
  ["mit", "MIT"],
  ["tslpamt", "TSLPAMT"],
  ["tslppct", "TSLPPCT"],
  ["tsmamt", "TSMAMT"],
  ["tsmpct", "TSMPCT"],
  ["slo", "SLO"]
]);

// Order types whose submission requires an explicit limit price.
const PRICE_REQUIRED_ORDER_TYPES = new Set(["LO", "ELO", "ALO", "ODD", "LIT", "SLO"]);

const TIME_IN_FORCE = new Map<string, string>([
  ["day", "Day"],
  ["gtc", "GoodTilCanceled"],
  ["goodtilcanceled", "GoodTilCanceled"],
  ["gtd", "GoodTilDate"],
  ["goodtildate", "GoodTilDate"]
]);

const OUTSIDE_RTH = new Map<string, string>([
  ["rthonly", "RTHOnly"],
  ["anytime", "AnyTime"],
  ["overnight", "Overnight"]
]);

interface TokenizedArgv {
  positionals: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

function tokenize(argv: string[]): TokenizedArgv {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (BOOL_FLAGS.has(token)) {
      booleans.add(token === "-h" ? "--help" : token);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new UsageError(`选项 ${token} 需要一个值`);
      }
      const list = flags.get(token) ?? [];
      list.push(value);
      flags.set(token, list);
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new UsageError(`未知选项: ${token}`);
    }
    positionals.push(token);
  }

  return { positionals, flags, booleans };
}

function lastFlag(tokens: TokenizedArgv, name: string): string | undefined {
  const values = tokens.flags.get(name);
  return values?.[values.length - 1];
}

function assertAllowedFlags(tokens: TokenizedArgv, allowedValueFlags: string[], allowedBoolFlags: string[] = []): void {
  const allowedValues = new Set(["--format", ...allowedValueFlags]);
  for (const name of tokens.flags.keys()) {
    if (!allowedValues.has(name)) {
      throw new UsageError(`该命令不支持选项 ${name}`);
    }
  }
  const allowedBools = new Set(["--help", ...allowedBoolFlags]);
  for (const name of tokens.booleans) {
    if (!allowedBools.has(name)) {
      throw new UsageError(`该命令不支持选项 ${name}`);
    }
  }
}

function parsePositiveInt(raw: string, label: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new UsageError(`${label} 必须是正整数，收到: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError(`${label} 必须是正整数，收到: ${raw}`);
  }
  return value;
}

function parseNonNegativeInt(raw: string, label: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new UsageError(`${label} 必须是非负整数，收到: ${raw}`);
  }
  return Number(raw);
}

function assertIsoDate(raw: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
    throw new UsageError(`${label} 必须是 YYYY-MM-DD 格式，收到: ${raw}`);
  }
  return raw;
}

function requirePositional(tokens: TokenizedArgv, index: number, label: string): string {
  const value = tokens.positionals[index];
  if (value === undefined || value === "") {
    throw new UsageError(`缺少必需参数: ${label}`);
  }
  return value;
}

function assertNoExtraPositionals(tokens: TokenizedArgv, maxCount: number): void {
  if (tokens.positionals.length > maxCount) {
    throw new UsageError(`收到多余的参数: ${tokens.positionals.slice(maxCount).join(" ")}`);
  }
}

function parseOrderCommand(tokens: TokenizedArgv): Command {
  const sub = tokens.positionals[1];

  if (sub === undefined) {
    assertAllowedFlags(tokens, []);
    return { kind: "order-list" };
  }

  if (sub === "executions") {
    assertAllowedFlags(tokens, []);
    assertNoExtraPositionals(tokens, 2);
    return { kind: "order-executions" };
  }

  if (sub === "detail") {
    assertAllowedFlags(tokens, []);
    const orderId = requirePositional(tokens, 2, "订单 ID");
    assertNoExtraPositionals(tokens, 3);
    return { kind: "order-detail", orderId };
  }

  if (sub === "buy" || sub === "sell") {
    assertAllowedFlags(
      tokens,
      ["--price", "--order-type", "--tif", "--remark", "--outside-rth"],
      ["--yes"]
    );
    const symbol = requirePositional(tokens, 2, "标的代码").toUpperCase();
    const quantityRaw = requirePositional(tokens, 3, "数量");
    assertNoExtraPositionals(tokens, 4);

    const quantity = Number(quantityRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new UsageError(`数量必须是正数，收到: ${quantityRaw}`);
    }

    const orderTypeRaw = lastFlag(tokens, "--order-type") ?? "LO";
    const orderType = ORDER_TYPES.get(orderTypeRaw.toLowerCase());
    if (!orderType) {
      throw new UsageError(`不支持的订单类型: ${orderTypeRaw}`);
    }

    const tifRaw = lastFlag(tokens, "--tif") ?? "Day";
    const timeInForce = TIME_IN_FORCE.get(tifRaw.toLowerCase());
    if (!timeInForce) {
      throw new UsageError(`不支持的有效期类型: ${tifRaw}`);
    }

    const priceRaw = lastFlag(tokens, "--price");
    if (priceRaw !== undefined) {
      const price = Number(priceRaw);
      if (!Number.isFinite(price) || price <= 0) {
        throw new UsageError(`价格必须是正数，收到: ${priceRaw}`);
      }
    } else if (PRICE_REQUIRED_ORDER_TYPES.has(orderType)) {
      throw new UsageError(`订单类型 ${orderType} 需要 --price 指定限价`);
    }

    const outsideRthRaw = lastFlag(tokens, "--outside-rth");
    let outsideRth: string | undefined;
    if (outsideRthRaw !== undefined) {
      outsideRth = OUTSIDE_RTH.get(outsideRthRaw.toLowerCase());
      if (!outsideRth) {
        throw new UsageError(`不支持的盘前盘后设置: ${outsideRthRaw}`);
      }
    }

    if (!tokens.booleans.has("--yes")) {
      throw new UsageError("下单需要显式传入 --yes（本 CLI 不做交互确认）");
    }

    const remark = lastFlag(tokens, "--remark");
    return {
      kind: "order-submit",
      side: sub,
      symbol,
      quantity: quantityRaw,
      ...(priceRaw !== undefined ? { price: priceRaw } : {}),
      orderType,
      timeInForce,
      ...(remark !== undefined ? { remark } : {}),
      ...(outsideRth !== undefined ? { outsideRth } : {}),
      yes: true
    };
  }

  throw new UsageError(`未知的 order 子命令: ${sub}`);
}

export function parseArgv(argv: string[]): ParsedInvocation {
  const tokens = tokenize(argv);

  const format = lastFlag(tokens, "--format") ?? "json";
  if (format !== "json") {
    throw new UsageError(`只支持 --format json，收到: ${format}`);
  }

  if (tokens.booleans.has("--help") || tokens.positionals[0] === "help") {
    return { format: "json", command: { kind: "help" } };
  }

  const name = tokens.positionals[0];
  if (name === undefined) {
    throw new UsageError("缺少命令。可用命令: check / quote / assets / positions / watchlist / news / finance-calendar / order");
  }

  switch (name) {
    case "check": {
      assertAllowedFlags(tokens, []);
      assertNoExtraPositionals(tokens, 1);
      return { format: "json", command: { kind: "check" } };
    }
    case "quote": {
      assertAllowedFlags(tokens, []);
      const symbols = tokens.positionals.slice(1).map((symbol) => symbol.toUpperCase());
      if (symbols.length === 0) {
        throw new UsageError("quote 需要至少一个标的代码，例如: longbridge quote QQQ.US --format json");
      }
      return { format: "json", command: { kind: "quote", symbols } };
    }
    case "assets": {
      assertAllowedFlags(tokens, []);
      assertNoExtraPositionals(tokens, 1);
      return { format: "json", command: { kind: "assets" } };
    }
    case "positions": {
      assertAllowedFlags(tokens, []);
      assertNoExtraPositionals(tokens, 1);
      return { format: "json", command: { kind: "positions" } };
    }
    case "watchlist": {
      assertAllowedFlags(tokens, []);
      assertNoExtraPositionals(tokens, 1);
      return { format: "json", command: { kind: "watchlist" } };
    }
    case "news": {
      assertAllowedFlags(tokens, ["--count"]);
      const symbol = requirePositional(tokens, 1, "标的代码").toUpperCase();
      assertNoExtraPositionals(tokens, 2);
      const countRaw = lastFlag(tokens, "--count");
      const count = countRaw === undefined ? 10 : parsePositiveInt(countRaw, "--count");
      return { format: "json", command: { kind: "news", symbol, count } };
    }
    case "finance-calendar": {
      assertAllowedFlags(tokens, ["--market", "--star", "--start", "--end", "--count"]);
      const category = requirePositional(tokens, 1, "日历类别").toLowerCase();
      assertNoExtraPositionals(tokens, 2);
      if (!CALENDAR_CATEGORIES.has(category)) {
        throw new UsageError(`未知的日历类别: ${category}（支持: ${[...CALENDAR_CATEGORIES].join(" / ")}）`);
      }
      const stars = (tokens.flags.get("--star") ?? []).map((raw) => parseNonNegativeInt(raw, "--star"));
      const market = lastFlag(tokens, "--market");
      const startRaw = lastFlag(tokens, "--start");
      const endRaw = lastFlag(tokens, "--end");
      const countRaw = lastFlag(tokens, "--count");
      return {
        format: "json",
        command: {
          kind: "finance-calendar",
          category,
          stars,
          ...(market !== undefined ? { market } : {}),
          ...(startRaw !== undefined ? { start: assertIsoDate(startRaw, "--start") } : {}),
          ...(endRaw !== undefined ? { end: assertIsoDate(endRaw, "--end") } : {}),
          ...(countRaw !== undefined ? { count: parsePositiveInt(countRaw, "--count") } : {})
        }
      };
    }
    case "order":
      return { format: "json", command: parseOrderCommand(tokens) };
    default:
      throw new UsageError(`未知命令: ${name}`);
  }
}

export const HELP_TEXT = `longbridge — Longbridge/LongPort OpenAPI 命令行（AlphaLoop 自建实现）

用法: longbridge <命令> [参数] --format json

命令:
  check                                   连通性 / 令牌检查（同时探测 global 与 cn 两个区域）
  quote <SYMBOL> [<SYMBOL>...]            实时行情（symbol 需带市场后缀，如 QQQ.US、700.HK）
  assets                                  账户资产（TradeContext.accountBalance）
  positions                               股票持仓（TradeContext.stockPositions，按渠道拍平）
  watchlist                               自选股分组（QuoteContext.watchlist）
  news <SYMBOL> [--count N]               个股新闻（默认 10 条）
  finance-calendar <类别> [--market US] [--star N ...] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--count N]
                                          财经日历（类别: report/dividend/split/ipo/macrodata/closed/meeting/merge）
  order                                   今日订单列表（TradeContext.todayOrders）
  order executions                        今日成交列表（TradeContext.todayExecutions）
  order detail <ORDER_ID>                 订单详情（TradeContext.orderDetail）
  order <buy|sell> <SYMBOL> <QTY> --price <X.XX> [--order-type LO] [--tif Day]
        [--remark <文本>] [--outside-rth RTHOnly|AnyTime|Overnight] --yes
                                          下单（必须显式 --yes，本 CLI 不做交互确认；remark 超过 64 字符会被截断，
                                          这是 LongPort OpenAPI 的上限）

输出:
  --format json（默认且唯一支持的格式）：stdout 恰好输出一份 JSON 文档；
  出错时 stdout 为空、stderr 输出人类可读信息并以非零码退出。

凭据（环境变量，LONGBRIDGE_* 优先于 LONGPORT_*）:
  LONGBRIDGE_APP_KEY / LONGBRIDGE_APP_SECRET / LONGBRIDGE_ACCESS_TOKEN
  LONGPORT_APP_KEY / LONGPORT_APP_SECRET / LONGPORT_ACCESS_TOKEN
  Access token 缺失时回退读取 LONGBRIDGE_OPENAPI_TOKEN_PATH 指向的文件，
  或 $HOME/.longbridge/openapi/tokens/ 目录下第一个非隐藏文件。
  模拟盘与实盘共用 App Key/Secret，用不同的 Access Token 区分（在长桥开发者中心分别签发）。

区域:
  LONGBRIDGE_REGION=global|cn 显式指定；否则读取 $HOME/.longbridge/openapi/region-cache；
  默认 global。check 会同时探测两个区域并如实报告各自的 ok 状态。

说明:
  * news 数据来自 LongPort 资讯流（OpenAPI ContentContext.news），不是交易所公告或监管披露，
    OpenAPI 没有公告/披露接口；安静新闻日返回空数组是正常结果，本 CLI 不会编造新闻。
  * finance-calendar 数据来自 OpenAPI CalendarContext.financeCalendar。
`;
