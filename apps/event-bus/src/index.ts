import { createServer } from "node:http";

import {
  AuditLogRepository,
  EventStoreRepository,
  QueueRepository,
  assertEvent,
  loadLocalEnv,
  notFound,
  openTradingDatabase,
  readJsonBody,
  resolveRepoRoot,
  resolveRuntimePaths,
  sendJson
} from "@packages/shared-types";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
const { dbPath } = resolveRuntimePaths(repoRoot);
const db = openTradingDatabase(dbPath);
const eventStore = new EventStoreRepository(db);
const queue = new QueueRepository(db);
const audit = new AuditLogRepository(db);

const port = Number(process.env.EVENT_BUS_PORT ?? 4310);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "event-bus",
        dbPath
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/events") {
      const body = await readJsonBody<{
        topic?: string;
        topics?: string[];
        event: unknown;
      }>(req);

      assertEvent(body.event);
      eventStore.upsert(body.event);
      const topics = Array.from(
        new Set(
          body.topics?.filter((entry) => typeof entry === "string" && entry.length > 0) ??
            (body.topic ? [body.topic] : ["market-events", "paper-events", "live-events"])
        )
      );

      for (const topic of topics) {
        queue.append(topic, body.event, `${topic}:${body.event.dedupeKey}`);
      }

      audit.write("event-bus", "event.appended", {
        topics,
        eventId: body.event.id,
        dedupeKey: body.event.dedupeKey
      });

      sendJson(res, 202, {
        accepted: true,
        topics,
        eventId: body.event.id
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/queue/claim") {
      const body = await readJsonBody<{
        topic: string;
        consumer: string;
        leaseMs?: number;
        limit?: number;
      }>(req);

      const records = queue.claim(body.topic, body.consumer, body.leaseMs ?? 30_000, body.limit ?? 20);
      sendJson(res, 200, { records });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/queue/dead-letter") {
      const topic = url.searchParams.get("topic") ?? undefined;
      sendJson(res, 200, {
        records: queue.listDeadLetters(topic)
      });
      return;
    }

    const ackMatch = req.method === "POST" ? url.pathname.match(/^\/v1\/queue\/(\d+)\/ack$/) : null;
    if (ackMatch) {
      queue.acknowledge(Number(ackMatch[1] ?? "0"));
      sendJson(res, 200, { ok: true });
      return;
    }

    const retryMatch = req.method === "POST" ? url.pathname.match(/^\/v1\/queue\/(\d+)\/retry$/) : null;
    if (retryMatch) {
      const body = await readJsonBody<{ delayMs?: number; reason?: string }>(req);
      queue.retry(Number(retryMatch[1] ?? "0"), body.delayMs ?? 5_000, body.reason);
      sendJson(res, 200, { ok: true });
      return;
    }

    const deadMatch = req.method === "POST" ? url.pathname.match(/^\/v1\/queue\/(\d+)\/dead-letter$/) : null;
    if (deadMatch) {
      const body = await readJsonBody<{ reason: string }>(req);
      queue.deadLetter(Number(deadMatch[1] ?? "0"), body.reason);
      sendJson(res, 200, { ok: true });
      return;
    }

    const replayMatch = req.method === "POST" ? url.pathname.match(/^\/v1\/queue\/(\d+)\/replay$/) : null;
    if (replayMatch) {
      queue.replayDeadLetter(Number(replayMatch[1] ?? "0"));
      sendJson(res, 200, { ok: true });
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, {
      error: (error as Error).message
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`event-bus listening on http://127.0.0.1:${port}`);
});
