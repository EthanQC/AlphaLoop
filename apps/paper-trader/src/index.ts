import { createServer } from "node:http";

import {
  AuditLogRepository,
  ExecutionReportRepository,
  PaperBookRepository,
  QueueRepository,
  RuleRegistry,
  assertEvent,
  createId,
  getNotificationReadiness,
  loadLocalEnv,
  notFound,
  openTradingDatabase,
  readJsonBody,
  resolveRepoRoot,
  resolveRuntimePaths,
  sendJson,
  sendNotification,
  type Event,
  type OrderTicket
} from "@packages/shared-types";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
const { dbPath } = resolveRuntimePaths(repoRoot);
const db = openTradingDatabase(dbPath);
const audit = new AuditLogRepository(db);
const reports = new ExecutionReportRepository(db);
const paperBook = new PaperBookRepository(db);
const queue = new QueueRepository(db);
const rules = new RuleRegistry(repoRoot);

const port = Number(process.env.PAPER_TRADER_PORT ?? 4315);
const eventBusUrl = process.env.EVENT_BUS_URL ?? "http://127.0.0.1:4310";
const brokerExecutorUrl = process.env.BROKER_EXECUTOR_URL ?? "http://127.0.0.1:4312";
const pollingIntervalMs = Number(process.env.PAPER_TRADER_POLL_INTERVAL_MS ?? 30_000);
const consumer = "paper-trader";

async function claimAndTrade(limit = 10): Promise<{ claimed: number; traded: number; skipped: number }> {
  const response = await fetch(`${eventBusUrl}/v1/queue/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: "paper-events",
      consumer,
      leaseMs: 30_000,
      limit
    })
  });

  if (!response.ok) {
    throw new Error(`queue claim failed: ${response.status}`);
  }

  const body = (await response.json()) as {
    records: Array<{ id: number; payload: Event; attempts: number }>;
  };

  let traded = 0;
  let skipped = 0;
  for (const record of body.records) {
    try {
      const ticket = buildTicket(record.payload);
      if (!ticket) {
        skipped += 1;
        await post(`${eventBusUrl}/v1/queue/${record.id}/ack`, {});
        audit.write("paper-trader", "event.skipped", {
          queueId: record.id,
          eventId: record.payload.id
        });
        continue;
      }

      const execution = await submitTicket(ticket);
      traded += 1;
      await post(`${eventBusUrl}/v1/queue/${record.id}/ack`, {});
      reports.save({
        id: createId("report"),
        category: "trade",
        title: `Paper trader summary for ${ticket.symbol}`,
        body: execution.reasons.join("\n"),
        metadata: {
          eventId: record.payload.id,
          ticketId: ticket.id,
          environment: ticket.environment
        },
        createdAt: new Date().toISOString()
      });
      await sendNotification({
        title: `[Paper Trade] ${ticket.side.toUpperCase()} ${ticket.symbol}`,
        body: execution.reasons.join("\n")
      }).catch((error) => {
        audit.write("paper-trader", "notification.failed", {
          ticketId: ticket.id,
          error: (error as Error).message
        });
      });
      audit.write("paper-trader", "event.executed", {
        queueId: record.id,
        eventId: record.payload.id,
        ticketId: ticket.id
      });
    } catch (error) {
      const reason = (error as Error).message;
      const retryPath =
        record.attempts >= 5
          ? `${eventBusUrl}/v1/queue/${record.id}/dead-letter`
          : `${eventBusUrl}/v1/queue/${record.id}/retry`;
      await post(retryPath, record.attempts >= 5 ? { reason } : { reason, delayMs: 30_000 });
      audit.write("paper-trader", "event.failed", {
        queueId: record.id,
        eventId: record.payload.id,
        error: reason
      });
    }
  }

  return {
    claimed: body.records.length,
    traded,
    skipped
  };
}

function buildTicket(event: Event): OrderTicket | null {
  if (event.symbols.length === 0 || !["news", "price_pulse", "manual_note"].includes(event.type)) {
    return null;
  }
  if (isOptionPayload(event.payload)) {
    return null;
  }

  const symbol = event.symbols[0]!;
  const direction = getString(event.payload, ["side", "direction", "sentiment"])?.toLowerCase();
  const openPosition = paperBook.getOpenPositionBySymbol(symbol);

  let side: OrderTicket["side"] | null = null;
  if (direction === "sell" || direction === "bearish" || direction === "negative") {
    side = openPosition ? "sell" : null;
  } else if (direction === "buy" || direction === "bullish" || direction === "positive") {
    side = "buy";
  } else if (event.type === "price_pulse") {
    const changePct = getNumeric(event.payload, ["changePct", "priceChangePct"]);
    if (typeof changePct === "number" && changePct <= -3) {
      side = "buy";
    } else if (typeof changePct === "number" && changePct >= 8 && openPosition) {
      side = "sell";
    }
  } else if (event.type === "news" && event.importance >= 0.7) {
    side = "buy";
  } else if (event.type === "manual_note") {
    side = openPosition ? "sell" : "buy";
  }

  if (!side) {
    return null;
  }

  const marketSnapshot = buildMarketSnapshot(event);
  if (!marketSnapshot) {
    return null;
  }

  const livePrice = marketSnapshot.last ?? marketSnapshot.ask ?? marketSnapshot.bid;
  if (typeof livePrice !== "number" || livePrice <= 0) {
    return null;
  }

  const paperRules = rules.load("paper");
  const accountNetLiq = getNumeric(event.payload, ["accountNetLiq"]) ?? 100_000;
  const conviction: OrderTicket["conviction"] =
    getString(event.payload, ["conviction"])?.toLowerCase() === "high" || event.importance >= 0.8
      ? "high"
      : "normal";
  const desiredNotional =
    getNumeric(event.payload, ["notionalUsd"]) ??
    accountNetLiq * ((conviction === "high" ? 0.08 : 0.05));
  const cappedNotional = Math.min(desiredNotional, accountNetLiq * (paperRules.maxIdeaExposurePercent / 100));
  const quantity =
    side === "sell" && openPosition
      ? openPosition.quantity
      : Math.max(1, Math.floor(cappedNotional / livePrice));

  if (side === "buy" && openPosition) {
    return null;
  }

  return {
    id: createId("ticket"),
    source: `paper-trader:${event.type}`,
    submittedAt: new Date().toISOString(),
    environment: "paper",
    assetClass: getAssetClass(event.payload),
    symbol,
    side,
    quantity,
    conviction,
    notionalUsd: roundCurrency(quantity * livePrice),
    marketSnapshot,
    metadata: {
      eventId: event.id,
      accountNetLiq,
      currentOpenIdeas: paperBook.listOpenPositions().length,
      currentHighConvictionIdeas: 0,
      dailyNewRiskPercent: 0
    }
  };
}

function buildAssetClassPayload(payload: unknown): "stock" | "etf" {
  const assetClass = getString(payload, ["assetClass"])?.toLowerCase();
  return assetClass === "etf" ? "etf" : "stock";
}

function getAssetClass(payload: unknown): "stock" | "etf" {
  return buildAssetClassPayload(payload);
}

function isOptionPayload(payload: unknown): boolean {
  return getString(payload, ["assetClass"])?.toLowerCase() === "option";
}

function buildMarketSnapshot(event: Event): OrderTicket["marketSnapshot"] | undefined {
  if (typeof event.payload !== "object" || event.payload === null) {
    return undefined;
  }

  const payload = event.payload as Record<string, unknown>;
  const nested = payload.marketSnapshot;
  if (typeof nested === "object" && nested !== null) {
    const snapshot = nested as Record<string, unknown>;
    return {
      ...(typeof snapshot.bid === "number" ? { bid: snapshot.bid } : {}),
      ...(typeof snapshot.ask === "number" ? { ask: snapshot.ask } : {}),
      ...(typeof snapshot.last === "number" ? { last: snapshot.last } : {}),
      ...(typeof snapshot.underlyingPrice === "number" ? { underlyingPrice: snapshot.underlyingPrice } : {}),
      timestamp: typeof snapshot.timestamp === "string" ? snapshot.timestamp : event.ts
    };
  }

  const bid = getNumeric(payload, ["bid"]);
  const ask = getNumeric(payload, ["ask"]);
  const last = getNumeric(payload, ["price", "last", "close"]);
  const underlyingPrice = getNumeric(payload, ["underlyingPrice"]);
  if ([bid, ask, last, underlyingPrice].every((entry) => typeof entry !== "number")) {
    return undefined;
  }

  return {
    ...(typeof bid === "number" ? { bid } : {}),
    ...(typeof ask === "number" ? { ask } : {}),
    ...(typeof last === "number" ? { last } : {}),
    ...(typeof underlyingPrice === "number" ? { underlyingPrice } : {}),
    timestamp: event.ts
  };
}

function getString(payload: unknown, keys: string[]): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function getNumeric(payload: unknown, keys: string[]): number | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

async function submitTicket(ticket: OrderTicket): Promise<{ reasons: string[] }> {
  const response = await fetch(`${brokerExecutorUrl}/v1/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket })
  });

  const body = (await response.json()) as { reasons?: string[]; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `broker-executor rejected ticket ${ticket.id}: ${response.status}`);
  }

  return {
    reasons: body.reasons ?? []
  };
}

async function post(url: string, payload: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status}`);
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const notification = getNotificationReadiness();
      sendJson(res, 200, {
        ok: true,
        service: "paper-trader",
        eventBusUrl,
        brokerExecutorUrl,
        openPositions: paperBook.listOpenPositions().length,
        deadLetters: queue.listDeadLetters("paper-events").length,
        notificationEnabled: notification.enabled,
        notificationTarget: notification.target,
        notificationReason: notification.reason
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/run-once") {
      sendJson(res, 200, await claimAndTrade());
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/events/preview-ticket") {
      const body = await readJsonBody<{ event: unknown }>(req);
      assertEvent(body.event);
      sendJson(res, 200, {
        ticket: buildTicket(body.event)
      });
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`paper-trader listening on http://127.0.0.1:${port}`);
});

void claimAndTrade().catch((error) => {
  console.error("paper-trader initial poll failed", error);
});

setInterval(() => {
  void claimAndTrade().catch((error) => {
    console.error("paper-trader poll failed", error);
  });
}, pollingIntervalMs);
