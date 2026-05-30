import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { Event, loadLocalEnv, notFound, nowIso, readJsonBody, sendJson } from "@packages/shared-types";

import { CalendarAdapter } from "./adapters/calendar.js";
import { NewsAdapter } from "./adapters/news.js";
import { PriceAdapter } from "./adapters/price.js";
import { sanitizeLongbridgeError } from "./longbridge-cli.js";

loadLocalEnv(process.cwd());
const port = Number(process.env.EVENT_INGESTOR_PORT ?? 4311);
const eventBusUrl = process.env.EVENT_BUS_URL ?? "http://127.0.0.1:4310";
const pollingIntervalMs = Number(process.env.EVENT_INGESTOR_POLL_INTERVAL_MS ?? 60_000);

const adapters = [new NewsAdapter(), new PriceAdapter(), new CalendarAdapter()];
let lastPollAt: string | undefined;

async function emitEvent(event: Event): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${eventBusUrl}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topics: ["paper-events", "live-events"],
          event
        })
      });

      if (!response.ok) {
        throw new Error(`event-bus rejected event ${event.id}: ${response.status}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(500 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "event emit failed"));
}

async function runOnce(): Promise<{ emitted: number; adapterCount: number }> {
  let emitted = 0;

  for (const adapter of adapters) {
    const events = await pollAdapter(adapter, lastPollAt);
    for (const event of events) {
      await emitEvent(event);
      emitted += 1;
    }
  }

  lastPollAt = new Date().toISOString();
  return {
    emitted,
    adapterCount: adapters.length
  };
}

async function pollAdapter(adapter: { readonly name: string; poll(since?: string): Promise<Event[]> }, since?: string): Promise<Event[]> {
  try {
    return await adapter.poll(since);
  } catch (error) {
    const message = sanitizeLongbridgeError(error);
    console.error(`${adapter.name} polling failed`, message);
    return [
      {
        id: `event_adapter_error_${adapter.name.replace(/[^A-Za-z0-9_-]/gu, "_")}_${new Date().toISOString().slice(0, 16).replace(/[^A-Za-z0-9_-]/gu, "_")}`,
        type: "system_health",
        source: adapter.name,
        symbols: [],
        ts: nowIso(),
        payload: {
          status: "error",
          adapter: adapter.name,
          message
        },
        importance: 0.6,
        dedupeKey: `adapter-error:${adapter.name}:${new Date().toISOString().slice(0, 16)}`
      }
    ];
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "event-ingestor",
        eventBusUrl,
        adapters: adapters.map((adapter) => adapter.name),
        lastPollAt
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/run-once") {
      const result = await runOnce();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/events/manual") {
      const body = await readJsonBody<{ event: Event }>(req);
      await emitEvent(body.event);
      sendJson(res, 202, { accepted: true, eventId: body.event.id });
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`event-ingestor listening on http://127.0.0.1:${port}`);
});

setTimeout(() => {
  void runOnce().catch((error) => {
    console.error("event-ingestor initial poll failed", error);
  });
}, Number(process.env.EVENT_INGESTOR_INITIAL_POLL_DELAY_MS ?? 5_000));

setInterval(() => {
  void runOnce().catch((error) => {
    console.error("event-ingestor polling failed", error);
  });
}, pollingIntervalMs);
