import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  AuditLogRepository,
  ExecutionReportRepository,
  MemberRepository,
  OfficialPaperOrderLifecycleRepository,
  ProposalRepository,
  type ExecutionResult,
  type JsonValue,
  type OrderTicket,
  type RuleSet,
  assertOrderTicket,
  normalizeSymbol,
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
import {
  resolveMemberExecutionContext,
  type MemberExecutionContext
} from "./member-execution-env.js";
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
  /** Resolve the exact owner-scoped account mode/environment passed to Longbridge. */
  executionContextResolver?: (ownerId: string) => MemberExecutionContext;
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
  const members = new MemberRepository(db);
  const longbridgeAuth = resolveLongbridgeAuthState();

  const configuredLiveExecutionRequested = process.env.ALLOW_LIVE_EXECUTION === "true";
  const officialPaperExecutionEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED === "true"
    && process.env.LONGBRIDGE_ACCOUNT_MODE === "paper"
    && process.env.ALLOW_LIVE_EXECUTION === "false";

  function nowDate(): Date {
    return deps.now ? deps.now() : new Date();
  }

  function buildTicketFromProposal(
    proposal: NonNullable<ReturnType<ProposalRepository["getById"]>>,
    ticketId: string,
    submittedAt: string
  ): OrderTicket {
    if (proposal.limitPrice === undefined) {
      throw new Error(`提案 ${proposal.id} 缺少限价，无法重建执行工单。`);
    }
    return {
      id: ticketId,
      source: "proposals-cli",
      submittedAt,
      environment: "paper",
      assetClass: "stock",
      symbol: normalizeSymbol(proposal.symbol),
      side: proposal.side,
      quantity: proposal.quantity,
      conviction: proposal.confidence === "high" ? "high" : "normal",
      notionalUsd: proposal.quantity * proposal.limitPrice,
      ownerId: proposal.ownerId,
      proposalId: proposal.id,
      marketSnapshot: {
        bid: proposal.limitPrice,
        ask: proposal.limitPrice,
        last: proposal.limitPrice,
        timestamp: submittedAt
      }
    };
  }

  function executionResultFromLifecycle(
    lifecycle: NonNullable<ReturnType<OfficialPaperOrderLifecycleRepository["getByTicketId"]>>
  ): ExecutionResult {
    const raw = lifecycle.raw && typeof lifecycle.raw === "object" && !Array.isArray(lifecycle.raw)
      ? lifecycle.raw as Record<string, JsonValue>
      : undefined;
    const recovery = raw?.recoveryExecutionResult
      && typeof raw.recoveryExecutionResult === "object"
      && !Array.isArray(raw.recoveryExecutionResult)
      ? raw.recoveryExecutionResult as Record<string, JsonValue>
      : undefined;
    const fillPrice = typeof recovery?.fillPrice === "number" && Number.isFinite(recovery.fillPrice)
      ? recovery.fillPrice
      : undefined;
    return sanitizeExecutionResult({
      ticketId: lifecycle.ticketId ?? lifecycle.id,
      environment: "paper",
      status: lifecycle.localStatus,
      provider: "longbridge-paper",
      ...(lifecycle.externalOrderId ? { externalOrderId: lifecycle.externalOrderId } : {}),
      ...(fillPrice === undefined ? {} : { fillPrice }),
      ...(lifecycle.limitPrice === undefined ? {} : { limitPrice: lifecycle.limitPrice }),
      brokerStatus: lifecycle.brokerStatus,
      brokerOrderStage: lifecycle.lifecycleStage,
      submittedAt: lifecycle.submittedAt,
      observedAt: lifecycle.lastObservedAt,
      ...(recovery?.rawBrokerPayload === undefined ? {} : { rawBrokerPayload: recovery.rawBrokerPayload }),
      reasons: lifecycle.notes
    });
  }

  function ensureExecutionCompletion(
    proposal: NonNullable<ReturnType<ProposalRepository["getById"]>>,
    ticket: OrderTicket,
    result: ExecutionResult
  ): string {
    const deterministicReportId = `report_exec_${proposal.id}`;
    const existingReport = db.prepare(`
      SELECT id FROM execution_reports
      WHERE category = 'trade' AND owner_id = ?
        AND (
          id = ?
          OR json_extract(metadata, '$.ticketId') = ?
          OR json_extract(metadata, '$.proposalId') = ?
        )
      ORDER BY created_at ASC
      LIMIT 1
    `).get(proposal.ownerId, deterministicReportId, ticket.id, proposal.id) as { id?: string } | undefined;
    const reportId = existingReport?.id ?? deterministicReportId;
    const proposalComplete = proposal.status === "executed" && proposal.ticketId === ticket.id;
    if (existingReport && proposalComplete) {
      return reportId;
    }

    // The broker write is already irreversible at this point. Keep the local
    // report + proposal transition atomic, while leaving the finalized
    // lifecycle row outside this transaction as the durable replay lease. A
    // failed local commit is therefore repaired on the next identical POST;
    // the broker command is never invoked again.
    db.exec("BEGIN IMMEDIATE;");
    try {
      if (!existingReport) {
        reports.save({
          id: reportId,
          category: "trade",
          ownerId: proposal.ownerId,
          title: `${ticket.symbol} 执行报告`,
          body: buildExecutionReportBody(ticket, result),
          metadata: buildExecutionReportMetadata(ticket, proposal.id, result),
          createdAt: nowDate().toISOString()
        });
      }
      proposals.markExecuted(proposal.id, ticket.id);
      audit.write("broker-executor", "ticket.executed", {
        proposalId: proposal.id,
        ticketId: ticket.id,
        result,
        reportId,
        repaired: Boolean(existingReport) || proposal.status !== "approved" && proposal.status !== "approved_half"
      });
      db.exec("COMMIT;");
      return reportId;
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the original local persistence error; a rollback failure
        // is still safe because the finalized lifecycle prevents re-submit.
      }
      throw error;
    }
  }

  // Per-owner official-paper account facts. A NULL-owner snapshot is a legacy
  // shared-account artifact and is only eligible when execution itself is in
  // the single-active-member legacy-global mode. Member-credential mode must
  // have the owner's own fresh row; mixing one account's snapshot with a
  // different account's execution environment would invalidate every budget
  // and covered-sell decision below.
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
  function readLatestOfficialPaperRiskFactsForOwner(
    ownerId: string,
    symbol: string,
    executionMode: MemberExecutionContext["mode"]
  ): OfficialPaperRiskFacts | undefined {
    const reasons = executionMode === "member"
      ? ["hourly_poll_per_member", "post_open_pnl_per_member"]
      : ["hourly_poll", "post_open_pnl"];
    const ownRow = db
      .prepare(`
        SELECT fetched_at, net_assets, market_value, positions, raw
        FROM official_paper_snapshots
        WHERE owner_id = ? AND reason IN (?, ?)
        ORDER BY fetched_at DESC
        LIMIT 1
      `)
      .get(ownerId, ...reasons) as Record<string, unknown> | undefined;

    const legacyRow = executionMode === "legacy-global" ? (db
      .prepare(`
        SELECT fetched_at, net_assets, market_value, positions, raw
        FROM official_paper_snapshots
        WHERE owner_id IS NULL AND reason IN (?, ?)
        ORDER BY fetched_at DESC
        LIMIT 1
      `)
      .get(...reasons) as Record<string, unknown> | undefined) : undefined;
    const row = ownRow ?? legacyRow;

    if (!row) {
      return undefined;
    }

    const reportedAccountNetLiq = Number(row.net_assets);
    const recordedExposureUsd = Number(row.market_value);
    const fetchedAt = String(row.fetched_at ?? "");
    if (!Number.isFinite(reportedAccountNetLiq) || !Number.isFinite(recordedExposureUsd)) {
      return undefined;
    }

    const heldQuantityForSymbol = extractHeldQuantity(row.positions, symbol);
    const positionValuation = readPositionValuation(row.positions);
    const accountNetLiqUsd = readAccountNetLiqUsd(row.raw, reportedAccountNetLiq, positionValuation);
    // A reliable position set lets old rows that stored signed/net
    // market_value participate safely. Long and short notionals add in
    // absolute terms; they never cancel for the 10% Constitution budget. Take
    // the larger of recorded and recomputed values so an empty position array
    // cannot lower already-recorded USD exposure. When valuation is degraded,
    // expose no invented USD number: valuationReliable=false blocks new risk,
    // while the independently parsed held quantity still permits a covered
    // sell to de-risk.
    const currentExposureUsd = positionValuation.reliable
      ? Math.max(recordedExposureUsd, positionValuation.grossExposureUsd)
      : 0;
    const valuationReliable = positionValuation.reliable && accountNetLiqUsd !== undefined;
    return {
      accountNetLiq: accountNetLiqUsd ?? 0,
      currentExposureUsd,
      fetchedAt,
      valuationReliable,
      ...(heldQuantityForSymbol !== undefined ? { heldQuantityForSymbol } : {})
    };
  }

  interface PositionValuationUsd {
    reliable: boolean;
    grossExposureUsd: number;
    netValueUsd: number;
  }

  function readPositionValuation(rawPositions: unknown): PositionValuationUsd {
    if (typeof rawPositions !== "string") {
      return { reliable: false, grossExposureUsd: 0, netValueUsd: 0 };
    }
    let positions: unknown;
    try {
      positions = JSON.parse(rawPositions);
    } catch {
      return { reliable: false, grossExposureUsd: 0, netValueUsd: 0 };
    }
    if (!Array.isArray(positions)) {
      return { reliable: false, grossExposureUsd: 0, netValueUsd: 0 };
    }
    let grossExposureUsd = 0;
    let netValueUsd = 0;
    for (const position of positions) {
      const row = position as Record<string, unknown>;
      const quantity = Number(row?.quantity);
      const price = Number(row?.price);
      const currency = normalizeCurrency(row?.currency);
      if (
        !Number.isFinite(quantity)
        || quantity === 0
        || currency !== "USD"
        || row?.priceSource !== "live"
        || !Number.isFinite(price)
        || price <= 0
      ) {
        return { reliable: false, grossExposureUsd: 0, netValueUsd: 0 };
      }
      grossExposureUsd += Math.abs(quantity * price);
      netValueUsd += quantity * price;
    }
    return { reliable: true, grossExposureUsd, netValueUsd };
  }

  // The real mini snapshot reports net_assets/total_cash in HKD while its
  // funded cash bucket and QQQ position are both explicitly USD. The raw blob
  // carries no broker FX quote. Never infer one from total_cash/cash_infos:
  // production history has already shown that implied ratio jump between
  // incompatible broker rate-table values. Instead either:
  //   1. trust net_assets only when its own reporting currency is USD; or
  //   2. rebuild an FX-free USD account value from explicitly USD
  //      available_cash buckets plus explicitly USD live-priced positions.
  // Any non-zero foreign bucket, missing bucket list, missing currency, or
  // degraded position makes the conversion unprovable and therefore blocks
  // new risk through valuationReliable=false.
  function readAccountNetLiqUsd(
    rawSnapshot: unknown,
    reportedAccountNetLiq: number,
    positions: PositionValuationUsd
  ): number | undefined {
    if (typeof rawSnapshot !== "string") {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSnapshot);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const primaryAsset = (parsed as Record<string, unknown>).primaryAsset;
    if (!primaryAsset || typeof primaryAsset !== "object" || Array.isArray(primaryAsset)) {
      return undefined;
    }
    const asset = primaryAsset as Record<string, unknown>;
    const reportingCurrency = normalizeCurrency(asset.currency);
    if (!reportingCurrency) {
      return undefined;
    }
    if (reportingCurrency === "USD") {
      return positions.reliable && reportedAccountNetLiq > 0 ? reportedAccountNetLiq : undefined;
    }
    if (!positions.reliable || !Array.isArray(asset.cash_infos)) {
      return undefined;
    }

    let usdCash = 0;
    let sawCashBucket = false;
    for (const value of asset.cash_infos) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      const cash = value as Record<string, unknown>;
      const currency = normalizeCurrency(cash.currency);
      const availableCash = readFiniteNumber(cash.available_cash);
      if (!currency || availableCash === undefined) {
        return undefined;
      }
      sawCashBucket = true;
      if (availableCash === 0) {
        continue;
      }
      if (currency !== "USD") {
        return undefined;
      }
      usdCash += availableCash;
    }
    if (!sawCashBucket) {
      return undefined;
    }
    const rebuilt = usdCash + positions.netValueUsd;
    return Number.isFinite(rebuilt) && rebuilt > 0 ? rebuilt : undefined;
  }

  function normalizeCurrency(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim().toUpperCase();
    return normalized || undefined;
  }

  function readFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
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
    // FIX 2: normalizeSymbol on BOTH sides, not plain uppercase equality -
    // snapshots store Longbridge-suffixed symbols ('AAPL.US') while a
    // proposal may carry a bare 'AAPL'; exact matching made a legitimately
    // held position invisible (held=undefined -> conservative 0), 400-blocking
    // a full de-risking sell.
    const targetSymbol = normalizeSymbol(symbol);
    let found = false;
    let sellableLongQuantity = 0;
    for (const position of positions) {
      const row = position as Record<string, unknown>;
      if (normalizeSymbol(String(row?.symbol ?? "")) !== targetSymbol) {
        continue;
      }
      found = true;
      const quantity = Number(row.quantity);
      if (!Number.isFinite(quantity)) {
        return undefined;
      }
      if (quantity <= 0) {
        continue;
      }
      const available = Number(row.available);
      if (!Number.isFinite(available)) {
        return undefined;
      }
      sellableLongQuantity += Math.min(quantity, Math.max(0, available));
      if (!Number.isFinite(sellableLongQuantity)) {
        return undefined;
      }
    }
    // Longbridge flattens account-channel position groups, so the same symbol
    // can appear more than once. Covered-sell capacity is the sum of each
    // row's proven available long quantity, capped by that row's total long;
    // frozen shares, shorts, and missing availability never create capacity.
    return found ? sellableLongQuantity : undefined;
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

          if (existingLifecycle.lifecycleStage === "submit_unconfirmed" || !existingLifecycle.externalOrderId) {
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

          const replayProposal = proposals.getById(proposalId);
          if (!replayProposal) {
            sendJson(res, 500, {
              ticketId,
              proposalId,
              error: "工单已存在但关联提案缺失；已拒绝重新下单，等待人工修复本地记录。",
              replay: true
            });
            return;
          }
          const replayTicket = buildTicketFromProposal(replayProposal, ticketId, existingLifecycle.submittedAt);
          const replayResult = executionResultFromLifecycle(existingLifecycle);
          const reportId = ensureExecutionCompletion(replayProposal, replayTicket, replayResult);

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
            reportId,
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
        // OrderTicket carries `notionalUsd`, but Proposal has no currency and
        // the persisted snapshots expose no trustworthy order-FX quote. A HK
        // limit price (for example 0700.HK at HKD 300) must therefore never be
        // relabelled as USD and sent into the 10% budget math. Keep automated
        // execution strictly on explicit Longbridge `.US` symbols until the
        // proposal/order contract carries currency plus a verified FX source.
        const executionSymbol = normalizeSymbol(proposal.symbol);
        if (!executionSymbol.endsWith(".US")) {
          audit.write("broker-executor", "ticket.rejected.currency", {
            proposalId,
            ticketId,
            ownerId: proposal.ownerId,
            symbol: executionSymbol || proposal.symbol,
            reason: "non_usd_order_notional_unconvertible"
          });
          sendJson(res, 400, {
            error: "自动执行仅接受显式 .US 美股代码；当前提案限价无法可靠换算为美元，已在创建执行记录和调用券商前拒绝。"
          });
          return;
        }

        // Server-built ticket: symbol/side/quantity/limitPrice/ownerId ALWAYS
        // come from the authoritative proposal row, never from the request
        // body (plan: "metadata 风险参数不再信 body verbatim").
        const submittedAt = nowDate().toISOString();
        const ticket = buildTicketFromProposal(proposal, ticketId, submittedAt);
        assertOrderTicket(ticket);

        const boundaryRejection = rejectDisabledExecution(ticket);
        if (boundaryRejection) {
          sendJson(res, 400, { error: "执行被操作边界拒绝。", reasons: boundaryRejection.reasons });
          return;
        }

        let executionContext: MemberExecutionContext;
        try {
          executionContext = deps.executionContextResolver
            ? deps.executionContextResolver(proposal.ownerId)
            : resolveMemberExecutionContext(proposal.ownerId, {
                activeMemberIds: members.listActive().map((member) => member.id)
              });
        } catch (credentialError) {
          const message = redactSensitiveText((credentialError as Error).message);
          audit.write("broker-executor", "ticket.rejected.credentials", {
            proposalId,
            ticketId,
            ownerId: proposal.ownerId,
            error: message
          });
          sendJson(res, 503, {
            error: `成员券商凭据不可用，已拒绝执行：${message}`
          });
          return;
        }

        // ---- Global Constraint ④: per-owner risk, budget includes this
        // owner's own OPEN (not yet filled/cancelled/rejected) orders ----
        let riskFacts = readLatestOfficialPaperRiskFactsForOwner(
          proposal.ownerId,
          ticket.symbol,
          executionContext.mode
        );
        // FIX 1 (order-splitting naked short): the snapshot's held quantity
        // does not see this owner's own RESTING sell orders yet - without
        // deducting them, hold 100 -> sell A 100 (exempt, resting) -> sell B
        // 100 still reads held=100 -> also exempt -> account net short 100
        // with zero risk flags. Deduct the owner's open sell quantity for
        // THIS symbol (floored at 0) before risk.ts applies the sell
        // exemption. Only meaningful for sells with a found position; a
        // missing position (heldQuantityForSymbol undefined) already counts
        // the whole sell as risk-increasing.
        if (proposal.side === "sell" && riskFacts?.heldQuantityForSymbol !== undefined) {
          const openSellQuantity = officialPaperOrders.sumOpenSellQuantityForOwnerSymbol(
            proposal.ownerId,
            ticket.symbol,
            riskFacts.fetchedAt
          );
          riskFacts = {
            ...riskFacts,
            heldQuantityForSymbol: Math.max(0, riskFacts.heldQuantityForSymbol - openSellQuantity)
          };
        }
        const openOrdersNotionalUsd = officialPaperOrders.sumOpenNotionalForOwner(
          proposal.ownerId,
          riskFacts?.fetchedAt
        );
        const dayStartIso = startOfUtcDay(nowDate()).toISOString();
        const openIdeas = officialPaperOrders.countSubmittedTodayForOwner(proposal.ownerId, dayStartIso);
        // dailyNewRiskPercent approximates "risk already committed today" by
        // this owner's currently-open notional as a percent of account net
        // liq - the same figure the budget gate below uses, since in this
        // per-owner paper-equity flow open orders are, in practice,
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
          symbol: ticket.symbol,
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
          execResult = executeLongbridgePaperOrder(ticket, deps.execFn, executionContext.env);
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
          raw: toJsonValue({
            brokerPayload: safeResult.rawBrokerPayload ?? null,
            recoveryExecutionResult: safeResult
          }),
          notes: safeResult.reasons,
          observedAt
        });

        const reportId = ensureExecutionCompletion(proposal, ticket, safeResult);

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

/**
 * R5 (2026-07-28 verifier): this used to take only the ticket ID, so the body
 * it produced named the WORKORDER but never the TRADE - no symbol, no side, no
 * quantity anywhere in it. The member's weekly
 * 「本周我的交易 vs 策略一致性回顾」 reads these rows, and against this body
 * every line degraded to 「无对照（读不出买卖方向）」 forever: the section had
 * nothing to compare a thesis against. It takes the whole ticket now, and the
 * three facts that define the trade are stated in the body a member actually
 * reads. Exported so the page's own test can seed with THIS function's output
 * instead of a hand-written string that happens to match the parser.
 */
export function buildExecutionReportBody(ticket: OrderTicket, result: ExecutionResult): string {
  const lines = [
    `工单：${redactSensitiveText(ticket.id)}`,
    `标的：${redactSensitiveText(ticket.symbol)}`,
    `方向：${translateSide(ticket.side)}`,
    `数量：${ticket.quantity}`,
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
  // The fill price was already carried on the result and never printed, so a
  // report of an executed order did not say at what price it executed.
  if (typeof result.fillPrice === "number") {
    lines.push(`成交价：${result.fillPrice.toFixed(2)}`);
  }

  lines.push("", "原因：");
  for (const reason of result.reasons) {
    lines.push(`- ${redactSensitiveText(reason)}`);
  }
  return lines.join("\n");
}

/**
 * R5: what the report row records ABOUT THE ORDER, structurally.
 *
 * symbol/side/quantity used to live only inside the prose body, so the weekly
 * 「本周我的交易 vs 策略一致性回顾」 had to regex them back out - and could
 * not, because the body never contained them. They are columns of the trade,
 * not decoration, so they are stored as data. `result` stays alongside as the
 * broker-side outcome (limitPrice/fillPrice/brokerStatus/stage).
 *
 * Exported next to buildExecutionReportBody so a downstream test seeds a row
 * with what this writer ACTUALLY writes rather than a shape invented to match
 * the reader.
 */
export function buildExecutionReportMetadata(
  ticket: OrderTicket,
  proposalId: string,
  result: ExecutionResult
): Record<string, JsonValue> {
  return {
    ticketId: ticket.id,
    proposalId,
    environment: ticket.environment,
    assetClass: ticket.assetClass,
    symbol: ticket.symbol,
    side: ticket.side,
    quantity: ticket.quantity,
    result: redactSensitiveJsonValue(toJsonValue(result))
  };
}

function translateSide(side: OrderTicket["side"]): string {
  return side === "buy" ? "买入" : "卖出";
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
