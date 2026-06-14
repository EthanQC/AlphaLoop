import { createServer } from "node:http";

import {
  AuditLogRepository,
  ExecutionReportRepository,
  OfficialPaperOrderLifecycleRepository,
  type ExecutionResult,
  type OrderTicket,
  type RuleSet,
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
import { redactSensitiveJsonValue, redactSensitiveText } from "./redaction.js";
import { evaluateRisk, type OfficialPaperRiskFacts } from "./risk.js";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
const { dbPath } = resolveRuntimePaths(repoRoot);
const db = openTradingDatabase(dbPath);
const audit = new AuditLogRepository(db);
const reports = new ExecutionReportRepository(db);
const officialPaperOrders = new OfficialPaperOrderLifecycleRepository(db);
const longbridgeAuth = resolveLongbridgeAuthState();

const port = Number(process.env.BROKER_EXECUTOR_PORT ?? 4312);
const configuredLiveExecutionRequested = process.env.ALLOW_LIVE_EXECUTION === "true";
const liveExecutionEnabled = LIVE_EXECUTION_ENABLED;
const optionAutomationEnabled = OPTION_AUTOMATION_ENABLED;
const officialPaperExecutionEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED === "true"
  && process.env.LONGBRIDGE_ACCOUNT_MODE === "paper"
  && process.env.ALLOW_LIVE_EXECUTION === "false";
const PAPER_RULES: RuleSet = {
  version: "v1.0.0",
  scope: "paper",
  maxIdeaExposurePercent: 10,
  maxHighConvictionExposurePercent: 10,
  maxConcurrentIdeas: 8,
  maxHighConvictionIdeas: 2,
  maxDailyNewRiskPercent: 10,
  allowedOptionStrategies: ["covered_call", "cash_secured_put", "long_call", "long_put"],
    notes: [
    "只允许长桥官方模拟盘。",
    "OpenClaw 最多使用总仓 10%；剩余 90% 必须不动。",
    "期权自动化禁用；允许策略名只用于人工分析文档。"
  ]
};
const LIVE_RULES: RuleSet = {
  ...PAPER_RULES,
  scope: "live",
  notes: [
    "实盘执行已被交易宪法禁用。",
    "真实资金流程只能停在结构化建议卡和人工复核。"
  ]
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "broker-executor",
        liveExecutionEnabled,
        configuredLiveExecutionRequested,
        officialPaperExecutionEnabled,
        accountMode: process.env.LONGBRIDGE_ACCOUNT_MODE ?? "unset",
        optionAutomationEnabled,
        longbridgeAuth: sanitizeLongbridgeAuth(longbridgeAuth),
        paperPositionSource: "longbridge-official-paper",
        paperOpenPositions: null
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/paper/positions") {
      sendJson(res, 200, {
        source: "longbridge-official-paper",
        note: "长桥官方模拟盘持仓由报告/账户快照脚本直接读取，避免通过 broker-executor 暴露券商凭据。",
        positions: []
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/rules/active") {
      sendJson(res, 200, {
        live: LIVE_RULES,
        paper: PAPER_RULES
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/tickets") {
      const body = await readJsonBody<{ ticket: unknown }>(req);
      assertOrderTicket(body.ticket);

      const scope = body.ticket.environment === "live" ? "live" : "paper";
      const activeRuleSet = scope === "paper" ? PAPER_RULES : LIVE_RULES;
      const risk = evaluateRisk(
        body.ticket,
        activeRuleSet,
        body.ticket.environment === "paper" ? readLatestOfficialPaperRiskFacts() : undefined
      );

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
        result = executeLongbridgePaperOrder(body.ticket);
      } else {
        result = {
          ticketId: body.ticket.id,
          environment: body.ticket.environment,
          status: "rejected" as const,
          provider: "broker-executor" as const,
          reasons: [
            "该环境和资产类别组合没有受支持的执行路径。"
          ]
        };
      }

      const safeResult = sanitizeExecutionResult(result);
      const reportId = createId("report");
      reports.save({
        id: reportId,
        category: "trade",
        title: `${body.ticket.symbol} 执行报告`,
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
    `工单：${redactSensitiveText(ticketId)}`,
    `状态：${translateExecutionStatus(result.status)}`,
    `执行方：${translateProvider(result.provider)}`
  ];

  if (result.externalOrderId) {
    lines.push(`外部订单号：${redactSensitiveText(result.externalOrderId)}`);
  }
  if (result.brokerStatus) {
    lines.push(`券商状态：${redactSensitiveText(result.brokerStatus)}`);
  }
  if (result.brokerOrderStage) {
    lines.push(`生命周期阶段：${translateLifecycleStage(result.brokerOrderStage)}`);
  }
  if (typeof result.limitPrice === "number") {
    lines.push(`限价：${result.limitPrice.toFixed(2)}`);
  }

  lines.push("", "原因：");
  for (const reason of result.reasons) {
    lines.push(`- ${redactSensitiveText(reason)}`);
  }
  return lines.join("\n");
}

function translateExecutionStatus(status: ExecutionResult["status"]): string {
  const labels: Record<ExecutionResult["status"], string> = {
    accepted: "已接受",
    rejected: "已拒绝",
    submitted: "已提交",
    pending: "等待中"
  };
  return labels[status] ?? status;
}

function translateProvider(provider: ExecutionResult["provider"]): string {
  return provider === "longbridge-paper" ? "长桥官方模拟盘" : "本地 broker-executor";
}

function translateLifecycleStage(stage: NonNullable<ExecutionResult["brokerOrderStage"]>): string {
  const labels: Record<NonNullable<ExecutionResult["brokerOrderStage"]>, string> = {
    submitted: "已提交",
    pending: "等待中",
    filled: "已成交",
    cancelled: "已取消",
    rejected: "已拒绝",
    unknown: "未知"
  };
  return labels[stage] ?? stage;
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

function readLatestOfficialPaperRiskFacts(): OfficialPaperRiskFacts | undefined {
  const row = db
    .prepare(`
      SELECT fetched_at, net_assets, market_value
      FROM official_paper_snapshots
      ORDER BY fetched_at DESC
      LIMIT 1
    `)
    .get() as Record<string, unknown> | undefined;

  if (!row) {
    return undefined;
  }

  const accountNetLiq = Number(row.net_assets);
  const currentExposureUsd = Number(row.market_value);
  const fetchedAt = String(row.fetched_at ?? "");
  if (!Number.isFinite(accountNetLiq) || !Number.isFinite(currentExposureUsd)) {
    return undefined;
  }

  return {
    accountNetLiq,
    currentExposureUsd,
    fetchedAt
  };
}
