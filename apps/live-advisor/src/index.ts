import { createServer } from "node:http";

import {
  AdviceRepository,
  AuditLogRepository,
  ExecutionReportRepository,
  PreferenceRepository,
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
  type ApprovalEdit,
  type AdviceCard,
  type Event
} from "@packages/shared-types";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
const { dbPath } = resolveRuntimePaths(repoRoot);
const db = openTradingDatabase(dbPath);
const advice = new AdviceRepository(db);
const audit = new AuditLogRepository(db);
const reports = new ExecutionReportRepository(db);
const preferences = new PreferenceRepository(db);
const rules = new RuleRegistry(repoRoot);

const port = Number(process.env.LIVE_ADVISOR_PORT ?? 4314);
const eventBusUrl = process.env.EVENT_BUS_URL ?? "http://127.0.0.1:4310";
const pollingIntervalMs = Number(process.env.LIVE_ADVISOR_POLL_INTERVAL_MS ?? 30_000);
const consumer = "live-advisor";

async function claimAndProcess(limit = 10): Promise<{ claimed: number; adviceCreated: number }> {
  const response = await fetch(`${eventBusUrl}/v1/queue/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: "live-events",
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

  let adviceCreated = 0;
  for (const record of body.records) {
    try {
      const cards = buildAdviceCards(record.payload);
      for (const card of cards) {
        advice.saveAdvice(card);
        adviceCreated += 1;
        reports.save({
          id: createId("report"),
          category: "daily",
          title: `Advice card for ${card.symbol}`,
          body: `${card.thesis}\n\nEntry: ${card.entryCondition}\nExit: ${card.exitPlan}`,
          metadata: {
            adviceCardId: card.id,
            symbol: card.symbol,
            direction: card.direction
          },
          createdAt: new Date().toISOString()
        });
        await sendNotification({
          title: `[Live Advice] ${card.symbol} ${card.direction}`,
          body: `${card.thesis}\nEntry: ${card.entryCondition}\nRisk: ${card.riskNotes.join(" | ")}`
        }).catch((error) => {
          audit.write("live-advisor", "notification.failed", {
            adviceCardId: card.id,
            error: (error as Error).message
          });
        });
      }

      await post(`${eventBusUrl}/v1/queue/${record.id}/ack`, {});
      audit.write("live-advisor", "event.processed", {
        queueId: record.id,
        eventId: record.payload.id,
        adviceCreated: cards.length
      });
    } catch (error) {
      const reason = (error as Error).message;
      const retryPath =
        record.attempts >= 5
          ? `${eventBusUrl}/v1/queue/${record.id}/dead-letter`
          : `${eventBusUrl}/v1/queue/${record.id}/retry`;
      await post(retryPath, record.attempts >= 5 ? { reason } : { reason, delayMs: 30_000 });
      audit.write("live-advisor", "event.failed", {
        queueId: record.id,
        eventId: record.payload.id,
        error: reason
      });
    }
  }

  return {
    claimed: body.records.length,
    adviceCreated
  };
}

function buildAdviceCards(event: Event): AdviceCard[] {
  if (event.symbols.length === 0 || !["news", "price_pulse", "manual_note", "calendar"].includes(event.type)) {
    return [];
  }
  if (isOptionPayload(event.payload)) {
    return [];
  }

  const liveRules = rules.load("live");
  const preference = preferences.latest();
  const sentiment = normalizeSentiment(event.payload);
  const sizePercent = Math.min(
    liveRules.maxIdeaExposurePercent,
    sentiment === "bullish" || sentiment === "bearish"
      ? event.importance >= 0.8
        ? 8
        : 4
      : 2
  );

  return event.symbols.map((symbol) => {
    const latestPrice = getNumeric(event.payload, ["price", "last", "close"]);
    const thesis = getString(event.payload, ["thesis", "note", "headline"]) ??
      `${event.type} from ${event.source} suggests a ${sentiment} setup for ${symbol}.`;

    return {
      id: createId("advice"),
      createdAt: new Date().toISOString(),
      symbol,
      direction: sentiment,
      assetClass: getAssetClass(event.payload),
      thesis,
      entryCondition:
        typeof latestPrice === "number"
          ? `Watch ${symbol} near ${latestPrice.toFixed(2)} and only act if liquidity remains stable.`
          : `Wait for a clean confirmation in ${symbol} before entering.`,
      suggestedSizePercent: sizePercent,
      invalidation: "Invalidate the setup if the original event thesis is contradicted by follow-up price action or news.",
      exitPlan: "Scale out in strength, or cut quickly if the event thesis weakens.",
      riskNotes: [
        "Live lane is advice-only; no automated live execution is permitted.",
        "High-risk suggestions still require a second confirmation."
      ],
      preferenceAlignment: preference?.summary ?? "Preference profile not trained yet; using default risk-aware live rules."
    };
  });
}

function normalizeSentiment(payload: unknown): AdviceCard["direction"] {
  const side = getString(payload, ["direction", "sentiment", "side"])?.toLowerCase();
  if (side === "buy" || side === "bullish" || side === "positive") {
    return "bullish";
  }
  if (side === "sell" || side === "bearish" || side === "negative") {
    return "bearish";
  }
  return "neutral";
}

function getAssetClass(payload: unknown): AdviceCard["assetClass"] {
  const assetClass = getString(payload, ["assetClass"])?.toLowerCase();
  return assetClass === "etf" ? "etf" : "stock";
}

function isOptionPayload(payload: unknown): boolean {
  return getString(payload, ["assetClass"])?.toLowerCase() === "option";
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

function normalizeApprovalDiff(diff: unknown, card: AdviceCard): ApprovalEdit["diff"] {
  if (typeof diff === "object" && diff !== null) {
    return diff as ApprovalEdit["diff"];
  }

  return {
    symbol: card.symbol,
    assetClass: card.assetClass,
    direction: card.direction
  };
}

function buildPreferenceSnapshotFromApproval(
  card: AdviceCard,
  edit: ApprovalEdit,
  current: ReturnType<PreferenceRepository["latest"]>
) {
  const sourceText = `${edit.summary} ${JSON.stringify(edit.diff)} ${card.assetClass} ${card.direction}`.toLowerCase();
  const traits = new Set(current?.traits ?? []);

  for (const trait of deriveApprovalTraits(sourceText, card)) {
    traits.add(trait);
  }

  const stableTraits = Array.from(traits).slice(0, 8);
  const summary = stableTraits.length > 0
    ? `Approval history currently suggests: ${stableTraits.join("; ")}.`
    : "Preference profile is still sparse; continue collecting approval edits.";

  return {
    id: createId("preference"),
    createdAt: edit.createdAt,
    source: `approval:${edit.editor}`,
    summary,
    traits: stableTraits
  };
}

function deriveApprovalTraits(sourceText: string, card: AdviceCard): string[] {
  const traits = new Set<string>();

  if (containsAny(sourceText, ["smaller", "size down", "reduce size", "减仓", "仓位太大"])) {
    traits.add("prefers smaller initial sizing");
  }
  if (containsAny(sourceText, ["confirm", "confirmation", "wait", "breakout", "确认", "等待"])) {
    traits.add("prefers confirmation before entry");
  }
  if (containsAny(sourceText, ["stop", "cut", "invalid", "止损", "失效"])) {
    traits.add("cuts quickly when the thesis breaks");
  }
  if (containsAny(sourceText, ["reject", "skip", "不做", "放弃", "没把握"])) {
    traits.add("filters aggressively when certainty is weak");
  }
  if (containsAny(sourceText, ["macro", "news", "政策", "宏观", "消息"])) {
    traits.add("anchors decisions to macro and event context");
  }
  if (card.direction === "bullish") {
    traits.add("primarily hunts upside event-driven setups");
  }

  return Array.from(traits);
}

function containsAny(sourceText: string, patterns: string[]): boolean {
  return patterns.some((pattern) => sourceText.includes(pattern));
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const notification = getNotificationReadiness();
      sendJson(res, 200, {
        ok: true,
        service: "live-advisor",
        eventBusUrl,
        notificationEnabled: notification.enabled,
        notificationTarget: notification.target,
        notificationReason: notification.reason
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/advice/recent") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      sendJson(res, 200, {
        advice: advice.listRecent(limit)
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/advice/approvals") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      sendJson(res, 200, {
        approvals: advice.listApprovals(limit)
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/preferences/latest") {
      sendJson(res, 200, {
        preference: preferences.latest()
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/run-once") {
      sendJson(res, 200, await claimAndProcess());
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/events/evaluate") {
      const body = await readJsonBody<{ event: unknown }>(req);
      assertEvent(body.event);
      sendJson(res, 200, {
        cards: buildAdviceCards(body.event)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/advice/approvals") {
      const body = await readJsonBody<{
        adviceCardId: string;
        editor?: string;
        summary: string;
        diff?: unknown;
      }>(req);

      const card = advice.getAdvice(body.adviceCardId);
      if (!card) {
        sendJson(res, 404, { error: `Advice card not found: ${body.adviceCardId}` });
        return;
      }

      const approval: ApprovalEdit = {
        id: createId("approval"),
        adviceCardId: card.id,
        createdAt: new Date().toISOString(),
        editor: body.editor?.trim() || "local-user",
        summary: body.summary.trim(),
        diff: normalizeApprovalDiff(body.diff, card)
      };
      advice.saveApproval(approval);

      const nextPreference = buildPreferenceSnapshotFromApproval(card, approval, preferences.latest());
      preferences.save(nextPreference);

      reports.save({
        id: createId("report"),
        category: "daily",
        title: `Approval edit for ${card.symbol}`,
        body: [
          `Editor: ${approval.editor}`,
          `Summary: ${approval.summary}`,
          "",
          `Preference snapshot: ${nextPreference.summary}`
        ].join("\n"),
        metadata: {
          approvalId: approval.id,
          adviceCardId: card.id,
          symbol: card.symbol,
          preferenceSnapshotId: nextPreference.id
        },
        createdAt: approval.createdAt
      });

      audit.write("live-advisor", "advice.approved", {
        adviceCardId: card.id,
        approvalId: approval.id,
        preferenceSnapshotId: nextPreference.id
      });

      sendJson(res, 201, {
        approval,
        preference: nextPreference
      });
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`live-advisor listening on http://127.0.0.1:${port}`);
});

void claimAndProcess().catch((error) => {
  console.error("live-advisor initial poll failed", error);
});

setInterval(() => {
  void claimAndProcess().catch((error) => {
    console.error("live-advisor poll failed", error);
  });
}, pollingIntervalMs);
