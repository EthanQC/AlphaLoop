#!/usr/bin/env node
// Proposal lifecycle CLI (Phase 6 Task 3, 2026-07-15 plan): create / approve /
// approve-half / reject / list / sweep. Conventions follow members.mjs
// EXACTLY (task brief): a single `buildCliResult` JSON envelope wrapping
// argv-parsing through dispatch, per-command flag allowlists (H6 pattern -
// a flag real for a DIFFERENT subcommand fails loud with "未知参数" instead
// of silently parsing and never being read), Chinese error messages, a
// non-zero exit on error, and a `PROPOSALS_DB_PATH` env override mirroring
// members.mjs's `MEMBERS_DB_PATH` (unset in normal operation - the real
// runtime/trading.sqlite is used; lets a live/manual verification run this
// exact binary against a disposable temp db).
//
// Unlike members.mjs, several commands here are genuinely async (Feishu card
// delivery/update, the broker-executor HTTP call) - `withDb` and every
// exported run* function are therefore async throughout, and buildCliResult
// awaits the whole pre-dispatch-through-dispatch path in one try/catch, same
// shape as members.mjs's version just made async.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AuditLogRepository,
  MemberRepository,
  ProposalRepository,
  nowIso,
  openTradingDatabase,
  resolveRuntimePaths,
  updateInteractiveCard
} from "../../../packages/shared-types/dist/index.js";

import { assertProposalAllowed } from "./circuit-breaker.mjs";
import { evaluateDiscipline } from "./discipline-engine.mjs";
import { loadLatestSnapshotForOwner } from "./market-alerts-store.mjs";
import { composeDecisionUpdate, composeProposalCard, deliverProposalCard } from "./proposal-cards.mjs";
import { computeExposure } from "./portfolio-exposure.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// Sentinel `decidedBy` for the expiry sweep (a cron job, not a member click) -
// mirrors the shape of database.ts's `__legacy_system__` migration sentinel:
// a value that can never collide with a real `member_...` id, so a future
// per-owner audit trail can tell "the owner decided" apart from "the sweep
// timed it out" at a glance.
const SWEEP_SYSTEM_ACTOR = "__system_sweep__";

const STATUS_VALUES = new Set([
  "pending",
  "approved",
  "approved_half",
  "rejected",
  "expired",
  "executed",
  "failed"
]);

// This CLI's only boolean/no-value flag: `--no-execute` (approve/approve-half
// only) skips the broker-executor POST entirely, e.g. for tests/manual
// queueing per the task brief - every other flag always expects a value.
const BOOLEAN_FLAGS = new Set(["no-execute"]);

// Per-command flag allowlist (H6 pattern, members.mjs/market-alerts.mjs):
// scoped PER SUBCOMMAND so a flag real for a different subcommand fails loud
// with "未知参数" instead of parsing fine and then silently never being read.
const COMMAND_FLAGS = {
  create: new Set([
    "owner",
    "symbol",
    "side",
    "quantity",
    "limit-price",
    "reason",
    "strategy",
    "invalidation",
    "stop-loss",
    "confidence"
  ]),
  approve: new Set(["token", "actor", "no-execute"]),
  "approve-half": new Set(["token", "actor", "no-execute"]),
  reject: new Set(["token", "actor"]),
  list: new Set(["owner", "status"]),
  sweep: new Set([])
};

/**
 * Parses `--flag value` pairs from an argv slice (after the subcommand).
 * Mirrors members.mjs's parseFlags exactly.
 *
 * @param {string[]} argv
 * @param {string} [command]
 */
export function parseFlags(argv, command) {
  const allowedFlags = COMMAND_FLAGS[command] ?? new Set();
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    if (!allowedFlags.has(name)) {
      throw new Error(`未知参数：--${name}。`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = "";
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

export function resolveCommand(argv) {
  return argv[0] ?? "";
}

function requireFlag(flags, name) {
  const value = String(flags[name] ?? "").trim();
  if (!value) {
    throw new Error(`缺少 --${name} 参数。`);
  }
  return value;
}

async function withDb(options, fn) {
  const db = openTradingDatabase(options.dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

// Per-owner budget preview for the proposal being drafted: current exposure
// (from the owner's latest snapshot, via market-alerts-store.mjs's shared
// loadLatestSnapshotForOwner - the SAME own-row-else-shared-fallback
// precedence rule circuit-breaker.mjs/snapshots.ts already use) plus THIS
// draft order's own notional as a percent of net assets.
//
// A missing snapshot, missing --limit-price (nothing to size a market order's
// notional from without a quote lookup this CLI does not perform), or a
// missing/non-positive net_assets each degrade to a `note` explaining why
// budgetImpactPct could not be computed - per the plan's Global Constraint,
// this is NEVER a block at proposal-creation time ("NOT a block at create
// time — executor is the hard gate"), only a caveat carried into the
// proposal's warnings/card.
function computeBudgetPreview(db, ownerId, draft) {
  const snapshotRow = loadLatestSnapshotForOwner(db, ownerId);
  if (!snapshotRow) {
    return { note: "预算无法核算（无快照）" };
  }

  const netAssets = snapshotRow.net_assets === null || snapshotRow.net_assets === undefined
    ? null
    : Number(snapshotRow.net_assets);
  const marketValue = Number(snapshotRow.market_value ?? 0);
  let positions = [];
  try {
    positions = JSON.parse(snapshotRow.positions ?? "[]");
  } catch {
    positions = [];
  }

  const exposure = computeExposure({ netAssets, marketValue, positions });
  const currentExposurePct = exposure.exposureRatio === null ? undefined : exposure.exposureRatio * 100;

  if (draft.limitPrice === undefined) {
    return {
      ...(currentExposurePct !== undefined ? { currentExposurePct } : {}),
      note: "预算无法核算（未提供 --limit-price，无法估算金额）"
    };
  }
  if (netAssets === null || netAssets <= 0) {
    return {
      ...(currentExposurePct !== undefined ? { currentExposurePct } : {}),
      note: "预算无法核算（净资产缺失或为零）"
    };
  }

  const notional = draft.quantity * draft.limitPrice;
  const budgetImpactPct = (notional / netAssets) * 100;
  return {
    budgetImpactPct,
    ...(currentExposurePct !== undefined ? { currentExposurePct } : {})
  };
}

// POSTs the approved/approved_half proposal to broker-executor's /v1/tickets.
// Task 4 (not yet built as of this task) is what makes the endpoint actually
// ENFORCE proposalId/sharedSecret - this call is written forward-compatible
// with that contract (plan: "POST executor /v1/tickets {proposalId,
// sharedSecret from env}") but today's executor may not validate either yet.
// An unreachable executor (ECONNREFUSED, DNS failure, non-2xx response) is
// NOT escalated to a thrown error: the caller (runDecision) turns a
// `{ok:false}` here into a warning while the proposal stays approved - see
// that function's own doc comment for the no-rollback rationale.
async function submitToExecutor(proposal, options = {}) {
  const executorUrl = options.executorUrl ?? process.env.BROKER_EXECUTOR_URL ?? "http://127.0.0.1:4312";
  const sharedSecret = process.env.BROKER_EXECUTOR_SHARED_SECRET ?? "";

  try {
    const response = await fetch(`${executorUrl}/v1/tickets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-AlphaLoop-Broker-Secret": sharedSecret
      },
      body: JSON.stringify({
        proposalId: proposal.id,
        sharedSecret,
        ownerId: proposal.ownerId,
        symbol: proposal.symbol,
        side: proposal.side,
        quantity: proposal.quantity,
        ...(proposal.limitPrice !== undefined ? { limitPrice: proposal.limitPrice } : {})
      })
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      return { ok: false, error: `执行器拒绝：${reason}` };
    }
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `create`: assertProposalAllowed (circuit breaker) -> budget preview ->
 * evaluateDiscipline (hard violations block, writing NO row) ->
 * ProposalRepository.create (expires_at = now+24h) -> compose+deliver card ->
 * audit. See computeBudgetPreview/submitToExecutor doc comments above for
 * the budget-preview and (approve-time-only) executor-call rationale.
 */
export async function runCreate(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const symbol = requireFlag(flags, "symbol");
  const side = requireFlag(flags, "side");
  if (side !== "buy" && side !== "sell") {
    throw new Error(`--side 必须是 buy 或 sell，收到：${side}。`);
  }

  const quantityRaw = requireFlag(flags, "quantity");
  const quantity = Number(quantityRaw);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`--quantity 必须是正数，收到：${quantityRaw}。`);
  }

  const reason = requireFlag(flags, "reason");

  let limitPrice;
  if (flags["limit-price"] !== undefined) {
    limitPrice = Number(flags["limit-price"]);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      throw new Error(`--limit-price 必须是正数，收到：${flags["limit-price"]}。`);
    }
  }

  let stopLoss;
  if (flags["stop-loss"] !== undefined) {
    stopLoss = Number(flags["stop-loss"]);
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
      throw new Error(`--stop-loss 必须是正数，收到：${flags["stop-loss"]}。`);
    }
  }

  const strategyRef = flags.strategy ? String(flags.strategy) : undefined;
  const invalidation = flags.invalidation ? String(flags.invalidation) : undefined;

  const confidence = flags.confidence ? String(flags.confidence) : undefined;
  if (confidence !== undefined && !["low", "medium", "high"].includes(confidence)) {
    throw new Error(`--confidence 必须是 low/medium/high 之一，收到：${confidence}。`);
  }

  return withDb(options, async (db) => {
    const member = new MemberRepository(db).getById(ownerId);
    if (!member) {
      throw new Error(`成员不存在：${ownerId}。`);
    }
    if (member.status !== "active") {
      throw new Error(`成员已被吊销，无法创建提案：${ownerId}。`);
    }

    // Circuit breaker FIRST, per the plan's Global Constraint ordering -
    // throws a Chinese error (with the recovery time) while paused.
    assertProposalAllowed(db, ownerId);

    const budgetPreview = computeBudgetPreview(db, ownerId, { quantity, limitPrice });

    const draft = {
      symbol,
      side,
      quantity,
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      ...(budgetPreview.budgetImpactPct !== undefined ? { budgetImpactPct: budgetPreview.budgetImpactPct } : {}),
      ...(budgetPreview.currentExposurePct !== undefined ? { currentExposurePct: budgetPreview.currentExposurePct } : {})
    };

    const { hardViolations, report } = evaluateDiscipline(db, ownerId, draft);
    if (hardViolations.length > 0) {
      // Single-line JSON error listing every hard violation - NO row is
      // written (the ProposalRepository.create call below never runs).
      throw new Error(`纪律硬检查未通过，提案未生成：${JSON.stringify({ hardViolations })}`);
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const proposals = new ProposalRepository(db);
    const proposal = proposals.create({
      ownerId,
      symbol,
      side,
      quantity,
      orderType: limitPrice !== undefined ? "limit" : "market",
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      reason,
      ...(strategyRef !== undefined ? { strategyRef } : {}),
      disciplineReport: report,
      ...(invalidation !== undefined ? { invalidation } : {}),
      ...(stopLoss !== undefined ? { stopLoss } : {}),
      ...(budgetPreview.budgetImpactPct !== undefined ? { budgetImpact: budgetPreview.budgetImpactPct } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      expiresAt
    });

    const card = composeProposalCard(proposal, report);
    // A card-send failure must never roll back the just-created proposal -
    // the proposal stands, the failure surfaces as a warning (see the
    // task brief: "发送失败 → proposal stands, warning in output").
    const deliverResult = await deliverProposalCard(db, proposal, card, options.transport);

    new AuditLogRepository(db).write("proposals", "create", {
      proposalId: proposal.id,
      ownerId,
      symbol,
      side,
      quantity,
      deliver: deliverResult
    });

    const warnings = [];
    if (budgetPreview.note) {
      warnings.push(budgetPreview.note);
    }
    if (deliverResult.skipped) {
      warnings.push(`飞书卡片未发送：${deliverResult.skipped}`);
    } else if (deliverResult.ok === false) {
      warnings.push(`飞书卡片发送失败：${deliverResult.error}`);
    }

    return {
      ok: true,
      proposal,
      card,
      deliver: deliverResult,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  });
}

/**
 * Shared implementation for `approve` / `approve-half` / `reject`. Ownership
 * (`actor === proposal.ownerId`) is checked BEFORE consumeApproval - a
 * non-owner's attempt must never consume the token (the real owner must
 * still be able to act on it afterward), so this order is load-bearing, not
 * cosmetic. `consumeApproval` (ProposalRepository, Task 1) is the ONLY
 * writer allowed to move a proposal's status - this function never sets
 * `status`/`consumed_at` directly.
 *
 * On `approved_half`, the proposal's `quantity` column is REWRITTEN to
 * `Math.max(1, Math.floor(quantity/2))` (plan Global Constraint: qty=1 halves
 * to 1) - from this point on `quantity` means "what will actually be sent to
 * the executor", not "originally requested"; the pre-halving quantity
 * remains recoverable only via this function's own audit_log `create`-time
 * row (written by runCreate) plus this decision's audit row.
 *
 * The broker-executor call (approved/approved_half only, unless
 * `--no-execute`) NEVER rolls back the consume on failure: an unreachable
 * executor leaves the proposal `approved`/`approved_half` with a warning -
 * "宁可人工补执行，不可重复审批" (better a human retries execution than risk
 * a second approval consuming a fresh token for the same trade).
 */
async function runDecision(decision, flags, options = {}) {
  const token = requireFlag(flags, "token");
  const actor = requireFlag(flags, "actor");
  const noExecute = Boolean(flags["no-execute"]);

  return withDb(options, async (db) => {
    const proposals = new ProposalRepository(db);
    const proposal = proposals.getByToken(token);
    if (!proposal) {
      throw new Error(`提案不存在：token=${token}。`);
    }

    // THE negative test this CLI exists to pin down: only the proposal's own
    // owner may decide it. A non-owner's attempt is refused with a non-zero
    // exit BEFORE the token is ever touched.
    if (proposal.ownerId !== actor) {
      throw new Error(`非本人操作被拒：该提案属于 ${proposal.ownerId}，操作者 ${actor} 无权批准/减半批准/拒绝此提案。`);
    }

    const decidedAt = nowIso();
    const consumeResult = proposals.consumeApproval(token, { decision, decidedBy: actor, decidedAt });
    if (!consumeResult.consumed) {
      throw new Error("该提案已处理或已过期。");
    }

    let updated = consumeResult.proposal ?? proposals.getByToken(token);

    if (decision === "approved_half" && updated) {
      const halvedQuantity = Math.max(1, Math.floor(updated.quantity / 2));
      db.prepare(`UPDATE proposals SET quantity = ? WHERE id = ?`).run(halvedQuantity, updated.id);
      updated = { ...updated, quantity: halvedQuantity };
    }

    new AuditLogRepository(db).write("proposals", decision, {
      proposalId: updated?.id,
      actor,
      token
    });

    const warnings = [];

    if (updated?.cardMessageId) {
      const actingMember = new MemberRepository(db).getById(actor);
      const cardModel = { ...updated, decidedByDisplayName: actingMember ? actingMember.displayName : actor };
      const card = composeDecisionUpdate(cardModel);
      const updateResult = await updateInteractiveCard(updated.cardMessageId, card, options.transport);
      if (!updateResult.ok) {
        warnings.push(`飞书卡片回改失败：${updateResult.error}`);
      }
    }

    if ((decision === "approved" || decision === "approved_half") && !noExecute) {
      const executorResult = await submitToExecutor(updated, options);
      if (!executorResult.ok) {
        warnings.push("执行器不可达，提案保持已批准状态，可重试执行");
      }
    }

    return { ok: true, proposal: updated, ...(warnings.length > 0 ? { warnings } : {}) };
  });
}

export function runApprove(flags, options = {}) {
  return runDecision("approved", flags, options);
}

export function runApproveHalf(flags, options = {}) {
  return runDecision("approved_half", flags, options);
}

export function runReject(flags, options = {}) {
  return runDecision("rejected", flags, options);
}

export async function runList(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const status = flags.status ? String(flags.status) : undefined;
  if (status !== undefined && !STATUS_VALUES.has(status)) {
    throw new Error(`--status 不是合法状态：${status}。`);
  }

  return withDb(options, (db) => ({
    ok: true,
    proposals: new ProposalRepository(db).listByOwner(ownerId, status)
  }));
}

/**
 * `sweep`: listPendingExpired -> per row consumeApproval(decision:'expired')
 * -> card update. Races with a concurrent human click on the SAME token: T1's
 * atomic `consumeApproval` (the ONE status-transition channel) already
 * decides the winner - a row this sweep loses on is skipped gracefully
 * (`consumed: false`), never treated as an error that aborts the rest of the
 * batch.
 */
export async function runSweep(_flags, options = {}) {
  return withDb(options, async (db) => {
    const proposals = new ProposalRepository(db);
    const now = nowIso();
    const expiredRows = proposals.listPendingExpired(now);

    const results = [];
    for (const row of expiredRows) {
      const consumeResult = proposals.consumeApproval(row.approvalToken, {
        decision: "expired",
        decidedBy: SWEEP_SYSTEM_ACTOR,
        decidedAt: now
      });

      if (!consumeResult.consumed) {
        // Lost the race to a concurrent click (or an earlier sweep run) -
        // T1's atomicity already gave the token to that other caller.
        results.push({ proposalId: row.id, skipped: "already_consumed" });
        continue;
      }

      const updated = consumeResult.proposal;
      new AuditLogRepository(db).write("proposals", "expired", { proposalId: row.id });

      if (updated?.cardMessageId) {
        const card = composeDecisionUpdate({ ...updated, decidedByDisplayName: "系统（超时自动作废）" });
        await updateInteractiveCard(updated.cardMessageId, card, options.transport);
      }
      results.push({ proposalId: row.id, expired: true });
    }

    return {
      ok: true,
      swept: results.filter((r) => r.expired === true).length,
      results
    };
  });
}

const COMMANDS = {
  create: runCreate,
  approve: runApprove,
  "approve-half": runApproveHalf,
  reject: runReject,
  list: runList,
  sweep: runSweep
};

export async function runProposalsCommand(command, flags, options = {}) {
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`未知子命令：${command || "(空)"}，仅支持 ${Object.keys(COMMANDS).join("/")}。`);
  }
  return handler(flags, options);
}

// Same pre-dispatch-through-dispatch-in-one-try/catch shape as members.mjs's
// buildCliResult, made async to accommodate this CLI's genuinely async
// commands (card delivery/update, executor POST).
export async function buildCliResult(argv, options = {}) {
  try {
    const command = resolveCommand(argv);
    const rest = argv.slice(command ? 1 : 0);
    const flags = parseFlags(rest, command);
    // PROPOSALS_DB_PATH mirrors members.mjs's MEMBERS_DB_PATH: unset (and a
    // no-op) in normal operation, where the real runtime/trading.sqlite is
    // used; lets a live/manual verification run this exact binary against a
    // disposable temp db instead.
    const dbPath = options.dbPath ?? process.env.PROPOSALS_DB_PATH ?? resolveRuntimePaths(repoRoot).dbPath;
    return await runProposalsCommand(command, flags, { ...options, dbPath });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const result = await buildCliResult(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
