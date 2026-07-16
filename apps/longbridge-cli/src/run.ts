// Command orchestration: pure besides the injected adapter(s). `check`
// probes BOTH regions honestly (a region we cannot reach is reported
// ok:false, never guessed) and fails the whole command when neither region
// answers — the wrappers treat a non-zero exit as a real failure and their
// stderr regex picks up the transient wording from the probe errors.

import type { LongbridgeAdapter } from "./adapter.js";
import type { Command } from "./cli.js";
import type { Region, RegionResolution } from "./env.js";
import {
  buildAssetsPayload,
  buildCalendarPayload,
  buildCheckPayload,
  buildExecutionsPayload,
  buildNewsPayload,
  buildOrderDetailPayload,
  buildOrderListPayload,
  buildPositionsPayload,
  buildQuoteRows,
  buildSubmitPayload,
  buildWatchlistPayload,
  type ProbeResult
} from "./shape.js";

// Marker class: main() prints check failures without the generic "命令执行
// 失败" prefix so the wrappers' stderr regexes see the probe wording as-is.
// It deliberately carries NO structured payload — the error contract keeps
// stdout empty on failure, so any payload here would be dead weight.
export class CheckFailedError extends Error {}

export interface RunDeps {
  adapterFor(region: Region): LongbridgeAdapter;
  regions: RegionResolution;
  probeTimeoutMs?: number | undefined;
  /** Today's date as YYYY-MM-DD (injectable for tests). */
  today?: (() => string) | undefined;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_CALENDAR_LOOKAHEAD_DAYS = 14;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function probeRegion(deps: RunDeps, region: Region, timeoutMs: number): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    await withTimeout(
      deps.adapterFor(region).probe(),
      timeoutMs,
      `region ${region} probe timeout after ${timeoutMs}ms`
    );
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runCheck(deps: RunDeps): Promise<unknown> {
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const [global, cn] = await Promise.all([
    probeRegion(deps, "global", timeoutMs),
    probeRegion(deps, "cn", timeoutMs)
  ]);
  if (!global.ok && !cn.ok) {
    throw new CheckFailedError(
      `Longbridge 连通性检查失败（无可用区域）。global: ${global.error ?? "unknown"}；cn: ${cn.error ?? "unknown"}`
    );
  }
  return buildCheckPayload({ resolution: deps.regions, probes: { global, cn } });
}

function isoToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export async function runCommand(command: Command, deps: RunDeps): Promise<unknown> {
  if (command.kind === "help") {
    throw new Error("help 由入口处理，不应该到达 runCommand");
  }
  if (command.kind === "check") {
    return runCheck(deps);
  }

  const adapter = deps.adapterFor(deps.regions.active);

  switch (command.kind) {
    case "quote":
      return buildQuoteRows(command.symbols, await adapter.getQuotes(command.symbols));
    case "assets":
      return buildAssetsPayload(await adapter.getAssets());
    case "positions":
      return buildPositionsPayload(await adapter.getPositions());
    case "watchlist":
      return buildWatchlistPayload(await adapter.getWatchlist());
    case "news":
      return buildNewsPayload(await adapter.getNews(command.symbol), command.count);
    case "finance-calendar": {
      const start = command.start ?? (deps.today ?? isoToday)();
      const end = command.end ?? addDays(start, DEFAULT_CALENDAR_LOOKAHEAD_DAYS);
      const groups = await adapter.getFinanceCalendar({
        category: command.category,
        start,
        end,
        ...(command.market !== undefined ? { market: command.market } : {})
      });
      return buildCalendarPayload(groups, { stars: command.stars, count: command.count });
    }
    case "order-list":
      return buildOrderListPayload(await adapter.getTodayOrders());
    case "order-executions":
      return buildExecutionsPayload(await adapter.getTodayExecutions());
    case "order-detail":
      return buildOrderDetailPayload(await adapter.getOrderDetail(command.orderId));
    case "order-submit": {
      const response = await adapter.submitOrder({
        symbol: command.symbol,
        side: command.side,
        quantity: command.quantity,
        orderType: command.orderType,
        timeInForce: command.timeInForce,
        ...(command.price !== undefined ? { price: command.price } : {}),
        ...(command.remark !== undefined ? { remark: command.remark } : {}),
        ...(command.outsideRth !== undefined ? { outsideRth: command.outsideRth } : {})
      });
      // Contract: exit 0 means one honest JSON document carrying a real
      // broker order id. An adapter that "succeeds" without one (empty
      // string, or undefined despite the type) must fail the command.
      if (typeof response.orderId !== "string" || response.orderId === "") {
        throw new Error("下单响应缺少有效的 order_id，结果未确认：请用 order / order detail 人工核对");
      }
      return buildSubmitPayload(response, command);
    }
    default: {
      const exhausted: never = command;
      throw new Error(`未实现的命令: ${JSON.stringify(exhausted)}`);
    }
  }
}
