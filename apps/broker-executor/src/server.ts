import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  AuditLogRepository,
  ExecutionReportRepository,
  OfficialPaperOrderLifecycleRepository,
  ProposalRepository,
  type ExecutionResult,
  type OrderTicket,
  type RuleSet,
  assertOrderTicket,
  createId,
  notFound,
  readJsonBody,
  resolveLongbridgeAuthState,
  sendJson,
  toJsonValue,
  type LongbridgeAuthState
} from "@packages/shared-types";

import {
  LIVE_EXECUTION_ENABLED,
  OPTION_AUTOMATION_ENABLED,
  rejectDisabledExecution
} from "./execution-guards.js";
import { executeLongbridgePaperOrder, type LongbridgeExecFn } from "./longbridge-paper.js";
import { redactSensitiveJsonValue, redactSensitiveText } from "./redaction.js";
import { evaluateRisk, type OfficialPaperRiskFacts } from "./risk.js";

const liveExecutionEnabled = LIVE_EXECUTION_ENABLED;
const optionAutomationEnabled = OPTION_AUTOMATION_ENABLED;

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

// Phase 6 Task 4 (2026-07-15 plan): every ticket the /v1/tickets endpoint now
// executes is derived from exactly one approved Proposal - this id is
// deterministic (pure function of proposalId, no DB read) so idempotency
// (Global Constraint ③) can be checked BEFORE the proposal is even looked up.
export function deriveTicketId(proposalId: string): string {
  return `ticket_prop_${proposalId}`;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export interface BrokerExecutorServerDeps {
  /** Trading database handle. */
  db: DatabaseSync;
  // Global Constraint ①: "env unset -> process refuses to START (fail-loud
  // constructor assert, tested)". The real entrypoint (index.ts) reads this
  // from `BROKER_EXECUTOR_SHARED_SECRET` via requireEnv (which already
  // throws on a missing/empty value) BEFORE calling this factory - the check
  // here is a second, cheaper line of defense so ANY caller of this factory
  // (present or future, real entrypoint or test) gets the same fail-loud
  // guarantee without having to remember to call requireEnv first.
  sharedSecret: string;
  /** Injectable longbridge CLI invoker; defaults to the real execFileSync (via longbridge-paper.ts's own default). Tests supply a fake so no real subprocess/CLI is ever spawned. */
  execFn?: LongbridgeExecFn;
  /** Injectable clock for deterministic "today" boundaries in tests; defaults to wall clock. */
  now?: () => Date;
}

/**
 * Builds the broker-executor HTTP server. This factory never calls `listen`
 * itself - callers (the real entrypoint in index.ts, or tests) decide the
 * port and host. Constructing it with a missing/empty `sharedSecret` throws
 * immediately (Global Constraint ①) rather than starting a server that would
 * accept requests with no way to ever authenticate them.
 */
export function createBrokerExecutorServer(deps: BrokerExecutorServerDeps): Server {
  if (!deps.sharedSecret || !deps.sharedSecret.trim()) {
    throw new Error(
      "BROKER_EXECUTOR_SHARED_SECRET is required and must be non-empty - broker-executor refuses to start without it."
    );
  }

  const db = deps.db;
  const audit = new AuditLogRepository(db);
  const reports = new ExecutionReportRepository(db);
  const officialPaperOrders = new OfficialPaperOrderLifecycleRepository(db);
  const proposals = new ProposalRepository(db);
  const longbridgeAuth = resolveLongbridgeAuthState();

  const configuredLiveExecutionRequested = process.env.ALLOW_LIVE_EXECUTION === "true";
  const officialPaperExecutionEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED === "true"
    && process.env.LONGBRIDGE_ACCOUNT_MODE === "paper"
    && process.env.ALLOW_LIVE_EXECUTION === "false";

  function nowDate(): Date {
    return deps.now ? deps.now() : new Date();
  }

  // Per-owner official-paper account facts (own-row-first, NULL-owner row as
  // fallback) - the SAME precedence rule market-alerts-store.mjs's
  // loadLatestSnapshotForOwner already establishes elsewhere in this
  // codebase, reimplemented here in TS against the same
  // official_paper_snapshots table (this app has no JS/TS boundary-crossing
  // import path to that .mjs module).
  // FIX 2: `symbol` is the ticket's own symbol - the caller reads the held
  // LONG quantity for THIS symbol out of the same snapshot row's `positions`
  // JSON, so risk.ts's paper-sell exemption can be gated on it (a sell up to
  // the held long is risk-reducing; any excess is a short-open, which must
  // count as risk-increasing notional). `positions` is a JSON array of
  // `{ symbol, quantity, ... }` (the same shape market-alerts-store.mjs's
  // isSymbolInPositions and portfolio-exposure.mjs already read out of this
  // exact column) - parsed defensively; any missing/malformed positions data
  // yields heldQuantityForSymbol: undefined, which risk.ts's own default
  // (unknown position -> 0 held, conservative) then applies.
  function readLatestOfficialPaperRiskFactsForOwner(ownerId: string, symbol: string): OfficialPaperRiskFacts | undefined {
    const ownRow = db
      .prepare(`
        SELECT fetched_at, net_assets, market_value, positions
        FROM official_paper_snapshots
        WHERE owner_id = ?
        ORDER BY fetched_at DESC
        LIMIT 1
      `)
      .get(ownerId) as Record<string, unknown> | undefined;

    const row = ownRow ?? (db
      .prepare(`
        SELECT fetched_at, net_assets, market_value, positions
        FROM official_paper_snapshots
        WHERE owner_id IS NULL
        ORDER BY fetched_at DESC
        LIMIT 1
      `)
      .get() as Record<string, unknown> | undefined);

    if (!row) {
      return undefined;
    }

    const accountNetLiq = Number(row.net_assets);
    const currentExposureUsd = Number(row.market_value);
    const fetchedAt = String(row.fetched_at ?? "");
    if (!Number.isFinite(accountNetLiq) || !Number.isFinite(currentExposureUsd)) {
      return undefined;
    }

    const heldQuantityForSymbol = extractHeldQuantity(row.positions, symbol);
    return {
      accountNetLiq,
      currentExposureUsd,
      fetchedAt,
      ...(heldQuantityForSymbol !== undefined ? { heldQuantityForSymbol } : {})
    };
  }

  function extractHeldQuantity(rawPositions: unknown, symbol: string): number | undefined {
    if (typeof rawPositions !== "string") {
      return undefined;
    }
    let positions: unknown;
    try {
      positions = JSON.parse(rawPositions);
    } catch {
      return undefined;
    }
    if (!Array.isArray(positions)) {
      return undefined;
    }
    const match = positions.find(
      (position) => String((position as Record<string, unknown>)?.symbol ?? "").toUpperCase() === symbol.toUpperCase()
    ) as Record<string, unknown> | undefined;
    if (!match) {
      return undefined;
    }
    const quantity = Number(match.quantity);
    return Number.isFinite(quantity) ? quantity : undefined;
  }

  return createServer(async (req, res) => {
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
        // ---- Global Constraint ①: shared-secret header ----
        const secretHeaderRaw = req.headers["x-alphaloop-broker-secret"];
        const providedSecret = Array.isArray(secretHeaderRaw) ? secretHeaderRaw[0] : secretHeaderRaw;
        if (!providedSecret || providedSecret !== deps.sharedSecret) {
          audit.write("broker-executor", "ticket.rejected.unauthorized", {
            reason: providedSecret ? "secret_mismatch" : "secret_missing"
          });
          sendJson(res, 401, { error: "共享密钥缺失或不正确（X-AlphaLoop-Broker-Secret）。" });
          return;
        }

        let rawBody: unknown;
        try {
          rawBody = await readJsonBody<unknown>(req);
        } catch (error) {
          sendJson(res, 400, { error: `请求体不是合法 JSON：${(error as Error).message}` });
          return;
        }
        const body = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};

        // ---- proposalId required (the old bare `{ ticket }` body shape -
        // submit-official-paper-equity-order.mjs's retired direct path - is
        // rejected here too: it never sends proposalId) ----
        const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : "";
        if (!proposalId) {
          sendJson(res, 403, {
            error: "缺少 proposalId：broker-executor 只接受已批准提案（通过 proposals.mjs create + approve）的执行请求。"
          });
          return;
        }

        const ticketId = deriveTicketId(proposalId);

        // ---- Global Constraint ③: idempotent replay, keyed by the
        // deterministic ticket id, checked BEFORE the proposal-status gate
        // below - a proposal that was already successfully executed has its
        // status moved to 'executed' by markExecuted, which would otherwise
        // fail the "must be approved/approved_half" check on every retry. ----
        const existingLifecycle = officialPaperOrders.getByTicketId(ticketId);
        if (existingLifecycle) {
          audit.write("broker-executor", "ticket.replay", { proposalId, ticketId });

          if (existingLifecycle.lifecycleStage === "submit_unconfirmed") {
            sendJson(res, 507, {
              ticketId,
              proposalId,
              error: "此前的提交未确认（可能已到达券商）；重放上次结果，不会重新下单。",
              unconfirmed: true,
              replay: true,
              reasons: existingLifecycle.notes
            });
            return;
          }

          sendJson(res, 200, {
            ticketId,
            proposalId,
            environment: "paper",
            status: existingLifecycle.localStatus,
            provider: "longbridge-paper",
            ...(existingLifecycle.externalOrderId ? { externalOrderId: existingLifecycle.externalOrderId } : {}),
            ...(existingLifecycle.limitPrice !== undefined ? { limitPrice: existingLifecycle.limitPrice } : {}),
            brokerStatus: existingLifecycle.brokerStatus,
            brokerOrderStage: existingLifecycle.lifecycleStage,
            reasons: existingLifecycle.notes,
            replay: true
          });
          return;
        }

        // ---- Global Constraint ②: proposal must exist, be
        // approved/approved_half, and not already carry a ticket ----
        const proposal = proposals.getById(proposalId);
        if (!proposal) {
          sendJson(res, 403, { error: `提案不存在：${proposalId}。` });
          return;
        }
        if (proposal.status !== "approved" && proposal.status !== "approved_half") {
          sendJson(res, 403, {
            error: `提案状态不允许执行：当前状态为 ${proposal.status}，需要 approved 或 approved_half。`
          });
          return;
        }
        if (proposal.ticketId) {
          sendJson(res, 403, { error: `提案已关联工单 ${proposal.ticketId}，拒绝重复执行。` });
          return;
        }
        if (proposal.limitPrice === undefined) {
          sendJson(res, 400, { error: "提案缺少限价（limit_price），无法核算风险，拒绝执行。" });
          return;
        }

        // Server-built ticket: symbol/side/quantity/limitPrice/ownerId ALWAYS
        // come from the authoritative proposal row, never from the request
        // body (plan: "metadata 风险参数不再信 body verbatim").
        const submittedAt = nowDate().toISOString();
        const notionalUsd = proposal.quantity * proposal.limitPrice;
        const ticket: OrderTicket = {
          id: ticketId,
          source: "proposals-cli",
          submittedAt,
          environment: "paper",
          assetClass: "stock",
          symbol: proposal.symbol,
          side: proposal.side,
          quantity: proposal.quantity,
          conviction: proposal.confidence === "high" ? "high" : "normal",
          notionalUsd,
          ownerId: proposal.ownerId,
          proposalId: proposal.id,
          // executeLongbridgePaperOrder derives its submission price from
          // marketSnapshot.ask/last (buy) or bid/last (sell) - this is a
          // limit order at the proposal's own limit_price, so that price is
          // supplied directly as bid/ask/last rather than sourced from a
          // live quote (which this hardened path deliberately does not
          // fetch - the price was already fixed at proposal-approval time).
          marketSnapshot: {
            bid: proposal.limitPrice,
            ask: proposal.limitPrice,
            last: proposal.limitPrice,
            timestamp: submittedAt
          }
        };
        assertOrderTicket(ticket);

        const boundaryRejection = rejectDisabledExecution(ticket);
        if (boundaryRejection) {
          sendJson(res, 400, { error: "执行被操作边界拒绝。", reasons: boundaryRejection.reasons });
          return;
        }

        // ---- Global Constraint ④: per-owner risk, budget includes this
        // owner's own OPEN (not yet filled/cancelled/rejected) orders ----
        const riskFacts = readLatestOfficialPaperRiskFactsForOwner(proposal.ownerId, proposal.symbol);
        const openOrdersNotionalUsd = officialPaperOrders.sumOpenNotionalForOwner(proposal.ownerId);
        const dayStartIso = startOfUtcDay(nowDate()).toISOString();
        const openIdeas = officialPaperOrders.countSubmittedTodayForOwner(proposal.ownerId, dayStartIso);
        // dailyNewRiskPercent approximates "risk already committed today" by
        // this owner's currently-open notional as a percent of account net
        // liq - the same figure the budget gate below uses, since in this
        // single-account paper-equity flow open orders are, in practice,
        // today's orders. Documented simplification: the plan only requires
        // this value be SERVER-computed (not caller-supplied), not a
        // particular formula.
        ticket.metadata = {
          currentOpenIdeas: openIdeas,
          dailyNewRiskPercent: riskFacts && riskFacts.accountNetLiq > 0
            ? (openOrdersNotionalUsd / riskFacts.accountNetLiq) * 100
            : 0
        };

        const risk = evaluateRisk(
          ticket,
          PAPER_RULES,
          riskFacts ? { ...riskFacts, openOrdersNotionalUsd } : undefined
        );

        if (risk.status === "block") {
          audit.write("broker-executor", "ticket.rejected.risk", { proposalId, ticketId, reasons: risk.reasons });
          sendJson(res, 400, { error: "风控拒绝。", reasons: risk.reasons, risk });
          return;
        }

        // ---- Global Constraint ⑤: record BEFORE execute ----
        officialPaperOrders.insertSubmitting({
          ticketId,
          ownerId: proposal.ownerId,
          symbol: proposal.symbol,
          assetClass: "stock",
          side: proposal.side,
          quantity: proposal.quantity,
          limitPrice: proposal.limitPrice,
          submittedAt
        });
        audit.write("broker-executor", "ticket.recorded", { proposalId, ticketId });

        // ---- Global Constraint ⑥: execute (throw/timeout -> submit_unconfirmed) ----
        let execResult: ExecutionResult;
        try {
          execResult = executeLongbridgePaperOrder(ticket, deps.execFn);
        } catch (execError) {
          // FIX 5: (execError as Error).message may carry execFileSync stderr
          // verbatim (a spawn failure/timeout can echo back CLI output),
          // which can contain secret-shaped tokens - route it through the
          // same redactSensitiveText the success path already uses before it
          // reaches the HTTP response, the lifecycle notes, or the proposal's
          // persisted outcome.
          const message = redactSensitiveText((execError as Error).message);
          const observedAt = new Date().toISOString();
          officialPaperOrders.markSubmitUnconfirmed(ticketId, [
            `长桥 CLI 调用失败或超时：${message}`,
            "订单可能已到达券商；由对账流程裁决，不视为下单失败重试。"
          ], observedAt);
          proposals.markFailed(proposal.id, `执行未确认（submit_unconfirmed）：${message}`);
          audit.write("broker-executor", "ticket.submit_unconfirmed", { proposalId, ticketId, error: message });
          sendJson(res, 507, {
            ticketId,
            proposalId,
            error: `长桥订单提交未确认，可能已到达券商：${message}`,
            unconfirmed: true
          });
          return;
        }

        const safeResult = sanitizeExecutionResult(execResult);
        const observedAt = safeResult.observedAt ?? new Date().toISOString();

        if (!safeResult.externalOrderId) {
          // The CLI call did not throw, but its output carried no parseable
          // order_id - we can neither confirm nor rule out that an order was
          // created broker-side, so this is treated the same as a
          // throw/timeout: submit_unconfirmed, not a silent "pending" success.
          officialPaperOrders.markSubmitUnconfirmed(ticketId, [
            "长桥 CLI 未抛出异常，但输出中没有可解析的 order_id。",
            ...safeResult.reasons
          ], observedAt);
          proposals.markFailed(proposal.id, "执行未确认（CLI 未返回 order_id）。");
          audit.write("broker-executor", "ticket.submit_unconfirmed", {
            proposalId,
            ticketId,
            reason: "missing_order_id"
          });
          sendJson(res, 507, {
            ticketId,
            proposalId,
            error: "长桥 CLI 未返回 order_id，无法确认订单状态。",
            unconfirmed: true
          });
          return;
        }

        // ---- Global Constraint ⑦: success - finalize lifecycle + report + markExecuted + audit ----
        officialPaperOrders.finalizeExecution(ticketId, {
          externalOrderId: safeResult.externalOrderId,
          brokerStatus: safeResult.brokerStatus ?? "unknown",
          localStatus: safeResult.status,
          lifecycleStage: safeResult.brokerOrderStage ?? "unknown",
          ...(safeResult.limitPrice !== undefined ? { limitPrice: safeResult.limitPrice } : {}),
          ...(safeResult.rawBrokerPayload !== undefined ? { raw: safeResult.rawBrokerPayload } : {}),
          notes: safeResult.reasons,
          observedAt
        });

        const reportId = createId("report");
        reports.save({
          id: reportId,
          category: "trade",
          title: `${ticket.symbol} 执行报告`,
          body: buildExecutionReportBody(ticket.id, safeResult),
          metadata: {
            ticketId: ticket.id,
            proposalId,
            environment: ticket.environment,
            assetClass: ticket.assetClass,
            result: redactSensitiveJsonValue(toJsonValue(safeResult))
          },
          createdAt: new Date().toISOString()
        });

        proposals.markExecuted(proposal.id, ticketId);
        audit.write("broker-executor", "ticket.executed", { proposalId, ticketId, result: safeResult, reportId });

        sendJson(res, 200, { ...safeResult, ticketId, proposalId, reportId, risk });
        return;
      }

      notFound(res);
    } catch (error) {
      // FIX 5: same redaction requirement as the throw/timeout path above -
      // an uncaught error surfacing here could, in principle, be wrapping
      // captured CLI stderr too (e.g. a rethrow further up the call chain),
      // so this outer boundary is not exempt from the same rule the success
      // path already follows.
      sendJson(res, 500, { error: redactSensitiveText((error as Error).message) });
    }
  });
}

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
    submitting: "记录中（尚未调用券商）",
    submitted: "已提交",
    accepted: "已受理",
    pending: "等待中",
    filled: "已成交",
    cancelled: "已取消",
    rejected: "已拒绝",
    submit_unconfirmed: "提交未确认",
    // Phase 6 Task 5 (2026-07-15 plan): reconcile-written stages - see
    // OfficialPaperOrderLifecycleStage's own doc comment in domain.ts.
    unknown_broker_status: "未知券商状态",
    failed: "失败（提交未确认，对账超时未见）",
    unknown: "未知"
  };
  return labels[stage] ?? stage;
}

function sanitizeLongbridgeAuth(state: LongbridgeAuthState): Omit<LongbridgeAuthState, "tokenPath"> {
  const { tokenPath: _tokenPath, ...safeState } = state;
  return safeState;
}
