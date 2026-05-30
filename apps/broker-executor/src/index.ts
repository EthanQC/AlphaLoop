import { createServer } from "node:http";

import {
  AuditLogRepository,
  ExecutionReportRepository,
  OfficialPaperOrderLifecycleRepository,
  PaperBookRepository,
  RuleRegistry,
  type ExecutionResult,
  type OrderTicket,
  assertOrderTicket,
  createId,
  loadLocalEnv,
  notFound,
  openTradingDatabase,
  readJsonBody,
  resolveLongbridgeAuthState,
  resolveRepoRoot,
  resolveRuntimePaths,
  sendJson,
  toJsonValue,
  type LongbridgeAuthState
} from "@packages/shared-types";

import {
  LIVE_EXECUTION_ENABLED,
  OPTION_AUTOMATION_ENABLED,
  rejectDisabledExecution
} from "./execution-guards.js";
import { executeLongbridgePaperOrder } from "./longbridge-paper.js";
import { PaperExecutionEngine } from "./paper-engine.js";
import { redactSensitiveJsonValue, redactSensitiveText } from "./redaction.js";
import { evaluateRisk } from "./risk.js";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
const { dbPath } = resolveRuntimePaths(repoRoot);
const db = openTradingDatabase(dbPath);
const audit = new AuditLogRepository(db);
const reports = new ExecutionReportRepository(db);
const officialPaperOrders = new OfficialPaperOrderLifecycleRepository(db);
const rules = new RuleRegistry(repoRoot);
const paperBook = new PaperBookRepository(db);
const paperEngine = new PaperExecutionEngine(paperBook);
const longbridgeAuth = resolveLongbridgeAuthState();

const port = Number(process.env.BROKER_EXECUTOR_PORT ?? 4312);
const configuredLiveExecutionRequested = process.env.ALLOW_LIVE_EXECUTION === "true";
const liveExecutionEnabled = LIVE_EXECUTION_ENABLED;
const optionAutomationEnabled = OPTION_AUTOMATION_ENABLED;
const officialPaperExecutionEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED === "true"
  && process.env.LONGBRIDGE_ACCOUNT_MODE === "paper"
  && !configuredLiveExecutionRequested;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const localPaperSimOpenPositions = paperBook.listOpenPositions().length;
      sendJson(res, 200, {
        ok: true,
        service: "broker-executor",
        liveExecutionEnabled,
        configuredLiveExecutionRequested,
        officialPaperExecutionEnabled,
        accountMode: process.env.LONGBRIDGE_ACCOUNT_MODE ?? "unset",
        optionAutomationEnabled,
        longbridgeAuth: sanitizeLongbridgeAuth(longbridgeAuth),
        paperPositionSource: "local-paper-sim",
        localPaperSimOpenPositions,
        paperOpenPositions: localPaperSimOpenPositions
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/paper/positions") {
      sendJson(res, 200, {
        source: "local-paper-sim",
        note: officialPaperExecutionEnabled
          ? "Official Longbridge paper positions are fetched directly by report/account snapshot scripts; this endpoint shows the local paper-sim history only."
          : "Local paper-sim positions.",
        positions: paperBook.listOpenPositions()
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/rules/active") {
      sendJson(res, 200, {
        live: rules.load("live"),
        paper: rules.load("paper")
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/tickets") {
      const body = await readJsonBody<{ ticket: unknown }>(req);
      assertOrderTicket(body.ticket);

      const scope = body.ticket.environment === "live" ? "live" : "paper";
      const activeRuleSet = rules.load(scope);
      const risk = evaluateRisk(body.ticket, activeRuleSet);

      let result: ExecutionResult;
      const boundaryRejection = rejectDisabledExecution(body.ticket);

      if (boundaryRejection) {
        result = boundaryRejection;
      } else if (risk.status === "block") {
        result = {
          ticketId: body.ticket.id,
          environment: body.ticket.environment,
          status: "rejected" as const,
          provider: "broker-executor" as const,
          reasons: risk.reasons
        };
      } else if (body.ticket.environment === "paper") {
        result = officialPaperExecutionEnabled
          ? executeLongbridgePaperOrder(body.ticket, longbridgeAuth)
          : paperEngine.execute(body.ticket);
      } else {
        result = {
          ticketId: body.ticket.id,
          environment: body.ticket.environment,
          status: "rejected" as const,
          provider: "broker-executor" as const,
          reasons: [
            "Unsupported execution path for this environment and asset class combination."
          ]
        };
      }

      const safeResult = sanitizeExecutionResult(result);
      const reportId = createId("report");
      reports.save({
        id: reportId,
        category: "trade",
        title: `Execution report for ${body.ticket.symbol}`,
        body: buildExecutionReportBody(body.ticket.id, safeResult),
        metadata: {
          ticketId: body.ticket.id,
          environment: body.ticket.environment,
          assetClass: body.ticket.assetClass,
          result: redactSensitiveJsonValue(toJsonValue(safeResult))
        },
        createdAt: new Date().toISOString()
      });

      saveOfficialPaperLifecycle(body.ticket, safeResult);

      audit.write("broker-executor", "ticket.processed", {
        ticketId: body.ticket.id,
        result: safeResult,
        reportId
      });

      sendJson(res, result.status === "rejected" ? 422 : 200, {
        ...safeResult,
        reportId,
        risk
      });
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`broker-executor listening on http://127.0.0.1:${port}`);
});

function sanitizeExecutionResult(result: ExecutionResult): ExecutionResult {
  return redactSensitiveJsonValue(toJsonValue(result)) as unknown as ExecutionResult;
}

function buildExecutionReportBody(ticketId: string, result: ExecutionResult): string {
  const lines = [
    `Ticket: ${redactSensitiveText(ticketId)}`,
    `Status: ${result.status}`,
    `Provider: ${result.provider}`
  ];

  if (result.externalOrderId) {
    lines.push(`External order id: ${redactSensitiveText(result.externalOrderId)}`);
  }
  if (result.brokerStatus) {
    lines.push(`Broker status: ${redactSensitiveText(result.brokerStatus)}`);
  }
  if (result.brokerOrderStage) {
    lines.push(`Lifecycle stage: ${result.brokerOrderStage}`);
  }
  if (typeof result.limitPrice === "number") {
    lines.push(`Limit price: ${result.limitPrice.toFixed(2)}`);
  }

  lines.push("", "Reasons:");
  for (const reason of result.reasons) {
    lines.push(`- ${redactSensitiveText(reason)}`);
  }
  return lines.join("\n");
}

function sanitizeLongbridgeAuth(state: LongbridgeAuthState): Omit<LongbridgeAuthState, "tokenPath"> {
  const { tokenPath: _tokenPath, ...safeState } = state;
  return safeState;
}

function saveOfficialPaperLifecycle(ticket: OrderTicket, result: ExecutionResult): void {
  if (
    result.provider !== "longbridge-paper" ||
    ticket.environment !== "paper" ||
    (ticket.assetClass !== "stock" && ticket.assetClass !== "etf") ||
    !result.externalOrderId
  ) {
    return;
  }

  const observedAt = result.observedAt ?? new Date().toISOString();
  officialPaperOrders.save({
    id: `lb_order_${result.externalOrderId}`,
    ticketId: ticket.id,
    externalOrderId: result.externalOrderId,
    provider: "longbridge-paper",
    environment: "paper",
    accountMode: "paper",
    symbol: ticket.symbol,
    assetClass: ticket.assetClass,
    side: ticket.side,
    quantity: ticket.quantity,
    ...(typeof result.limitPrice === "number" ? { limitPrice: result.limitPrice } : {}),
    brokerStatus: result.brokerStatus ?? "unknown",
    localStatus: result.status,
    lifecycleStage: result.brokerOrderStage ?? "unknown",
    submittedAt: result.submittedAt ?? ticket.submittedAt,
    lastObservedAt: observedAt,
    raw: result.rawBrokerPayload ?? toJsonValue(result),
    notes: result.reasons
  });
}
