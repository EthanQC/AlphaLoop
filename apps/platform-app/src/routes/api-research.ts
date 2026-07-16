/**
 * Phase 8 Task 3 (2026-07-16 plan): the submission/promotion JSON API behind
 * the in-site question box - `POST /api/research` (enqueue a new research
 * task, subject to the daily quota) and `POST /api/research/:id/promote`
 * (private -> public, owner-gated).
 *
 * IDENTITY CHAIN - deliberately `resolveIdentity`, NOT `resolveBearerIdentity`
 * (unlike routes/api-strategy.ts's bearer-only write surface): the plan is
 * explicit that this endpoint serves TWO different callers - "首页提问框走
 * Access" (a browser session behind Cloudflare Access, carrying only the
 * `Cf-Access-Authenticated-User-Email` header) AND "skill 走 bearer" (a
 * member's own skill client, carrying `Authorization: Bearer <token>`) - so
 * this module accepts either, with bearer winning if both are present
 * (identity.ts's own resolution order), exactly like every GET/HTML route in
 * this app already does. api-strategy.ts's bearer-only rule does NOT apply
 * here; that rule is specific to the machine-only strategy-memory WRITE
 * surface, not a blanket "no Access header on writes" policy for this whole
 * app.
 *
 * OWNERSHIP IS ALWAYS THE RESOLVED IDENTITY, NEVER A BODY FIELD: mirrors
 * api-strategy.ts's own module header - `identity.id` is the only source of
 * `ownerId` a submitted task is ever created with; a body `ownerId` field (if
 * present at all) is never read, so a caller attempting to submit "as"
 * another member via a spoofed body field simply creates a row owned by
 * THEIR OWN resolved identity instead (api-research.test.ts's negative test).
 *
 * QUOTA: `ResearchTaskRepository.createIfWithinQuota` (Task 1) already do the
 * atomic count-then-insert; this handler's only job is computing "today" as
 * a US/Eastern trading-day label (`currentUsEasternTradingDay` below) to pass
 * in, and translating a `{ok:false, reason:'quota_exceeded'}` result into the
 * plan's exact Chinese 429 message.
 *
 * WORKER KICK IS NON-BLOCKING: a successful submission returns
 * `{ok:true, taskId, redirect}` immediately - the response is never delayed
 * waiting for the (potentially many-second) research pipeline to run. The
 * injected `researchWorker.tick()` call (if a worker was supplied at all) is
 * deliberately NOT awaited by the HTTP response path; any rejection it
 * produces is caught and merely logged (worker.ts's own `tick()` already
 * guarantees it never rejects in the first place - this catch is pure
 * defense-in-depth against a future change to that contract).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  AuditLogRepository,
  ResearchTaskRepository,
  methodNotAllowed,
  readJsonBody,
  sendJson
} from "@packages/shared-types";

import { resolveIdentity } from "../identity.js";

/** Minimal shape this route needs from a research worker - matches
 * `ResearchWorker`'s own `tick` method (research/worker.ts) without importing
 * the whole worker module, so this route (and its tests) can inject a bare
 * `{tick: async () => ...}` fake with no dependency on how the real worker is
 * built. */
export interface ResearchWorkerLike {
  tick(): Promise<boolean>;
}

export interface ApiResearchRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
  /** In-process research worker (research/worker.ts) to kick, fire-and-
   * forget, after a successful submission. Omitted entirely in tests that
   * don't care about processing (the task stays `queued`, precisely like a
   * real submission an instant before the worker's next tick would look). */
  researchWorker?: ResearchWorkerLike;
}

const NEW_YORK_TIMEZONE = "America/New_York";

/**
 * TS port (NOT an import - see research/worker.ts's own module header for
 * the full "apps/openclaw-config/scripts is plain .mjs with no dist of its
 * own" rationale, which applies identically here) of trading-schedule.mjs's
 * `currentUsEasternTradingDay` - the exact same Intl-based zoned-date-label
 * computation as that file's `getZonedParts(date, 'America/New_York').
 * dateLabel`, trimmed to only the year/month/day fields this endpoint needs
 * (no weekday/hour/minute/second - this module has no use for them). Mirrors
 * database.test.ts's own `todayUsEasternTradingDay` test helper, which
 * documents the identical "not imported, for the same package-layering
 * reason" rule for the SAME computation. ANTI-DRIFT: any change to
 * trading-schedule.mjs's zoned-date-label algorithm must be mirrored here.
 */
function currentUsEasternTradingDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function currentNow(deps: ApiResearchRouteDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    ok: false,
    error: "未获授权：请通过圈内白名单邮箱登录，或提供有效的 Authorization: Bearer <token>"
  });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const parsed = await readJsonBody<unknown>(req);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// POST /api/research
// ---------------------------------------------------------------------------

async function handleSubmit(req: IncomingMessage, res: ServerResponse, deps: ApiResearchRouteDeps): Promise<void> {
  const identity = resolveIdentity(req, deps.db);
  if (!identity) {
    unauthorized(res);
    return;
  }

  const body = await readBody(req);

  // `question` is the ONLY body field this endpoint reads - see module
  // header: any `ownerId` field the caller sends is silently ignored, never
  // rejected, exactly like api-strategy.ts's own write endpoints.
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    sendJson(res, 400, { ok: false, error: "缺少 question 字段", field: "question" });
    return;
  }

  const now = currentNow(deps);
  const tradingDay = currentUsEasternTradingDay(now);
  const repo = new ResearchTaskRepository(deps.db);
  const result = repo.createIfWithinQuota({ ownerId: identity.id, question, tradingDay });

  if (!result.ok) {
    sendJson(res, 429, {
      ok: false,
      error: `今日研究配额已用完（${result.used}/${result.limit}），美东交易日切界后重置`,
      used: result.used,
      limit: result.limit
    });
    return;
  }

  if (deps.researchWorker) {
    // Fire-and-forget - see module header's "WORKER KICK IS NON-BLOCKING".
    deps.researchWorker.tick().catch((error: unknown) => {
      console.warn(
        `POST /api/research: kicked worker tick failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  sendJson(res, 201, { ok: true, taskId: result.task.id, redirect: `/research/${result.task.id}` });
}

// ---------------------------------------------------------------------------
// POST /api/research/:id/promote
// ---------------------------------------------------------------------------

async function handlePromote(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiResearchRouteDeps,
  taskId: string
): Promise<void> {
  const identity = resolveIdentity(req, deps.db);
  if (!identity) {
    unauthorized(res);
    return;
  }

  const repo = new ResearchTaskRepository(deps.db);
  const task = repo.getById(taskId);
  if (!task) {
    sendJson(res, 404, { ok: false, error: `未找到研究任务：${taskId}` });
    return;
  }
  // Resolve-row-first, compare-owner (proposal.ts/research.ts's own
  // discipline, cited by api-strategy.ts's module header) - 404 for a
  // nonexistent row is distinct from 403 for a real row owned by someone
  // else.
  if (task.ownerId !== identity.id) {
    sendJson(res, 403, { ok: false, error: "无权操作：该研究任务属于其他成员" });
    return;
  }

  // Capture the pre-promotion visibility BEFORE calling promoteVisibility:
  // that method is a no-op for an already-public task (returns the row
  // unchanged), so a retried/duplicate promote of an already-public task must
  // NOT append a second, misleading "research promote" audit entry for a state
  // change that didn't actually happen.
  const wasAlreadyPublic = task.visibility === "public";
  const updated = repo.promoteVisibility(taskId, identity.id);

  // Plan Task 3: "本阶段简化：仅 owner 校验 + 记 audit" - the reference-check
  // confirmation dialog (does the promoted verdict cite any 系统档 private
  // thesis/discipline text?) is explicitly out of scope here (front-end P10);
  // a REAL private->public transition is still audited, following strategy.mjs's
  // own `AuditLogRepository.write(category, "<noun> <verb>", payload)`
  // convention (e.g. its "thesis promote"/"card promote" entries).
  if (!wasAlreadyPublic) {
    new AuditLogRepository(deps.db).write("research", "research promote", { taskId, ownerId: identity.id });
  }

  sendJson(res, 200, { ok: true, task: updated });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Routes every `/api/research*` endpoint this module owns. Returns `true` if
 * the request was handled (including 401/400/403/404/405 responses), `false`
 * if the path doesn't belong here so the caller (server.ts) can keep trying
 * other routes/handlers.
 */
export function handleApiResearchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApiResearchRouteDeps
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2 || segments[0] !== "api" || segments[1] !== "research") {
    return false;
  }

  if (segments.length === 2) {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    void handleSubmit(req, res, deps);
    return true;
  }

  if (segments.length === 4 && segments[3] === "promote") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    void handlePromote(req, res, deps, segments[2] as string);
    return true;
  }

  return false;
}
