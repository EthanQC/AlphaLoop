/**
 * Bearer-gated JSON write API for strategy memory (Phase 7 Task 4 - see
 * docs/superpowers/plans/2026-07-15-phase7-strategy-memory.md). This is the
 * skill/machine-facing surface of strategy memory - the CLI (strategy.mjs,
 * Task 3) is the human/local-shell face, this module is the HTTP face a
 * member's own skill client calls.
 *
 * AUTHENTICATION IS BEARER-TOKEN ONLY (plan Task 4, load-bearing
 * requirement): every handler below resolves identity via
 * `resolveBearerIdentity` (identity.ts), NOT `resolveIdentity`. A request
 * carrying only the `Cf-Access-Authenticated-User-Email` header (no
 * `Authorization: Bearer`) gets 401 here even though the SAME header would
 * authenticate it for one of this app's GET/HTML pages - writes are the
 * skill/machine face and must never trust a header any local process on this
 * host could forge (see identity.ts's `verifyAccessJwt` TODO(P10) - the
 * Access header has no cryptographic proof today, which is precisely why the
 * write surface refuses to honor it at all).
 *
 * OWNERSHIP IS ALWAYS THE TOKEN'S MEMBER, NEVER A REQUEST FIELD: every write
 * uses `identity.id` (the resolved token owner) as the row's owner. A body
 * `ownerId` field is never read by any handler below - it is silently
 * IGNORED, not merely rejected, so a caller who tries to write on another
 * member's behalf via a spoofed `ownerId` field simply creates a row owned by
 * THEIR OWN token identity instead (see api-strategy.test.ts's negative
 * test). Mutations on an EXISTING row (append judgment / promote / disable)
 * additionally resolve the row FIRST, by id alone, then compare
 * `row.ownerId === identity.id` and 403 on mismatch (proposal.ts/research.ts's
 * "resolve row first, compare owner" discipline) - 404 if the row doesn't
 * exist at all, distinct from 403 for a real row owned by someone else.
 *
 * Response bodies are single JSON objects `{ ok, ... }` via the shared
 * `sendJson` helper (packages/shared-types/http.ts) - the SAME helper every
 * other JSON response in this app already uses (the `/health` endpoint,
 * `notFound`, `methodNotAllowed`), so this module does not invent a second
 * JSON-writing convention. Security headers (CSP/nosniff/Referrer-Policy) are
 * NOT re-applied here - server.ts already calls `applySecurityHeaders` once,
 * unconditionally, before ANY route dispatch (including this one), so every
 * response from this module already carries the platform-wide baseline.
 *
 * The memoryd mirror backend (T2, data/memoryd-mirror.ts) is injectable via
 * `ApiStrategyRouteDeps.memorydBackend`, threaded through from
 * `PlatformServerDeps` (server.ts) exactly like `now` is - defaults to
 * `createMemorydBackend()`'s P10-gated placeholder (always degrades to
 * `{mirrored:false}` today) when the real caller (index.ts) doesn't supply
 * one. A mirror failure NEVER fails the HTTP write - the SQL row has already
 * committed by the time `mirrorRecord` is even called (see that module's own
 * header).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, readJsonBody, sendJson, type Member } from "@packages/shared-types";

import { resolveBearerIdentity } from "../identity.js";
import { guardAsyncWrite } from "./async-guard.js";
import { createMemorydBackend, mirrorRecord, type MemorydBackend } from "../data/memoryd-mirror.js";
import {
  appendThesisJudgment,
  createCard,
  createRule,
  createThesis,
  disableRule,
  getRuleById,
  getThesisById,
  promoteThesisVisibilityToPublic,
  type CreateCardInput,
  type CreateRuleInput,
  type CreateThesisInput,
  type DisciplineEnforcement,
  type StrategyVisibility,
  type ThesisDirection
} from "../data/strategy-write.js";

export interface ApiStrategyRouteDeps {
  db: DatabaseSync;
  /** Injectable memoryd mirror backend (Task 2); defaults to
   * `createMemorydBackend()` (P10-gated, always degrades) when omitted. */
  memorydBackend?: MemorydBackend;
}

const DIRECTION_VALUES: ReadonlySet<string> = new Set<ThesisDirection>(["bull", "bear", "neutral"]);
const VISIBILITY_VALUES: ReadonlySet<string> = new Set<StrategyVisibility>(["system", "public"]);
const ENFORCEMENT_VALUES: ReadonlySet<string> = new Set<DisciplineEnforcement>(["hard", "proposal_check", "self"]);

/** Distinguishes "field absent" (`undefined`) from "field present but not a
 * finite number" (this sentinel) for optional numeric body fields, so a
 * caller can 400 with the right field name instead of silently coercing
 * `NaN` into the store. */
const INVALID = Symbol("invalid-field");

function resolveBackend(deps: ApiStrategyRouteDeps): MemorydBackend {
  return deps.memorydBackend ?? createMemorydBackend();
}

function requireBearerIdentity(req: IncomingMessage, res: ServerResponse, db: DatabaseSync): Member | null {
  const member = resolveBearerIdentity(req, db);
  if (!member) {
    sendJson(res, 401, { ok: false, error: "未获授权：需要有效的 Authorization: Bearer <token>" });
    return null;
  }
  return member;
}

function badRequest(res: ServerResponse, field: string, error: string): void {
  sendJson(res, 400, { ok: false, error, field });
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const body = await readJsonBody<unknown>(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "body", "请求体必须是一个 JSON 对象");
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    badRequest(res, "body", "请求体必须是合法 JSON");
    return null;
  }
}

function readRequiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(body: Record<string, unknown>, field: string): number | undefined | typeof INVALID {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : INVALID;
}

function readOptionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined | typeof INVALID {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return INVALID;
  }
  return value as string[];
}

function readOptionalEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>
): T | undefined | typeof INVALID {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.has(value)) {
    return INVALID;
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// POST /api/theses
// ---------------------------------------------------------------------------

async function handleCreateThesis(req: IncomingMessage, res: ServerResponse, deps: ApiStrategyRouteDeps): Promise<void> {
  const identity = requireBearerIdentity(req, res, deps.db);
  if (!identity) {
    return;
  }

  const body = await readBody(req, res);
  if (!body) {
    return;
  }

  const symbol = readRequiredString(body, "symbol");
  if (!symbol) {
    badRequest(res, "symbol", "缺少 symbol 字段");
    return;
  }

  const direction = readOptionalEnum<ThesisDirection>(body, "direction", DIRECTION_VALUES);
  if (direction === INVALID || direction === undefined) {
    badRequest(res, "direction", "direction 必须是 bull/bear/neutral 之一");
    return;
  }

  const visibility = readOptionalEnum<StrategyVisibility>(body, "visibility", VISIBILITY_VALUES);
  if (visibility === INVALID) {
    badRequest(res, "visibility", "visibility 必须是 system/public 之一");
    return;
  }

  const targetLow = readOptionalNumber(body, "targetLow");
  if (targetLow === INVALID) {
    badRequest(res, "targetLow", "targetLow 必须是数字");
    return;
  }
  const targetHigh = readOptionalNumber(body, "targetHigh");
  if (targetHigh === INVALID) {
    badRequest(res, "targetHigh", "targetHigh 必须是数字");
    return;
  }
  const invalidationPrice = readOptionalNumber(body, "invalidationPrice");
  if (invalidationPrice === INVALID) {
    badRequest(res, "invalidationPrice", "invalidationPrice 必须是数字");
    return;
  }
  const bullPoints = readOptionalStringArray(body, "bullPoints");
  if (bullPoints === INVALID) {
    badRequest(res, "bullPoints", "bullPoints 必须是字符串数组");
    return;
  }
  const bearPoints = readOptionalStringArray(body, "bearPoints");
  if (bearPoints === INVALID) {
    badRequest(res, "bearPoints", "bearPoints 必须是字符串数组");
    return;
  }

  // ownerId is NEVER read from the body - see module header. The owner is
  // ALWAYS the token's resolved member, full stop.
  const input: CreateThesisInput = {
    ownerId: identity.id,
    symbol,
    direction,
    ...(targetLow !== undefined ? { targetLow } : {}),
    ...(targetHigh !== undefined ? { targetHigh } : {}),
    ...(invalidationPrice !== undefined ? { invalidationPrice } : {}),
    bullPoints: bullPoints ?? [],
    bearPoints: bearPoints ?? [],
    ...(visibility !== undefined ? { visibility } : {})
  };

  const thesis = createThesis(deps.db, input);

  const mirror = await mirrorRecord(resolveBackend(deps), {
    ownerId: identity.id,
    recordType: "thesis",
    title: `${symbol} ${direction} 论点`,
    content: JSON.stringify({
      targetLow: thesis.targetLow,
      targetHigh: thesis.targetHigh,
      invalidationPrice: thesis.invalidationPrice,
      bullPoints: thesis.bullPoints,
      bearPoints: thesis.bearPoints
    }),
    visibility: thesis.visibility
  });

  sendJson(res, 201, { ok: true, thesis, mirror });
}

// ---------------------------------------------------------------------------
// POST /api/theses/:id/judgments
// ---------------------------------------------------------------------------

async function handleAppendJudgment(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiStrategyRouteDeps,
  thesisId: string
): Promise<void> {
  const identity = requireBearerIdentity(req, res, deps.db);
  if (!identity) {
    return;
  }

  const thesis = getThesisById(deps.db, thesisId);
  if (!thesis) {
    sendJson(res, 404, { ok: false, error: `未找到论点：${thesisId}` });
    return;
  }
  if (thesis.ownerId !== identity.id) {
    sendJson(res, 403, { ok: false, error: "无权操作：该论点属于其他成员" });
    return;
  }

  const body = await readBody(req, res);
  if (!body) {
    return;
  }

  const note = readRequiredString(body, "note");
  if (!note) {
    badRequest(res, "note", "缺少 note 字段");
    return;
  }
  const source = readOptionalString(body, "source") ?? "self";

  const judgment = appendThesisJudgment(deps.db, thesisId, { note, source });

  const mirror = await mirrorRecord(resolveBackend(deps), {
    ownerId: identity.id,
    recordType: "thesis_judgment",
    title: `${thesis.symbol} 判断更新`,
    content: note,
    visibility: thesis.visibility
  });

  sendJson(res, 201, { ok: true, judgment, mirror });
}

// ---------------------------------------------------------------------------
// POST /api/theses/:id/promote
// ---------------------------------------------------------------------------

async function handlePromoteThesis(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiStrategyRouteDeps,
  thesisId: string
): Promise<void> {
  const identity = requireBearerIdentity(req, res, deps.db);
  if (!identity) {
    return;
  }

  const thesis = getThesisById(deps.db, thesisId);
  if (!thesis) {
    sendJson(res, 404, { ok: false, error: `未找到论点：${thesisId}` });
    return;
  }
  if (thesis.ownerId !== identity.id) {
    sendJson(res, 403, { ok: false, error: "无权操作：该论点属于其他成员" });
    return;
  }

  const updated = promoteThesisVisibilityToPublic(deps.db, thesisId);
  sendJson(res, 200, { ok: true, thesis: updated });
}

// ---------------------------------------------------------------------------
// POST /api/rules
// ---------------------------------------------------------------------------

async function handleCreateRule(req: IncomingMessage, res: ServerResponse, deps: ApiStrategyRouteDeps): Promise<void> {
  const identity = requireBearerIdentity(req, res, deps.db);
  if (!identity) {
    return;
  }

  const body = await readBody(req, res);
  if (!body) {
    return;
  }

  const ruleText = readRequiredString(body, "ruleText");
  if (!ruleText) {
    badRequest(res, "ruleText", "缺少 ruleText 字段");
    return;
  }

  const enforcement = readOptionalEnum<DisciplineEnforcement>(body, "enforcement", ENFORCEMENT_VALUES);
  if (enforcement === INVALID || enforcement === undefined) {
    badRequest(res, "enforcement", "enforcement 必须是 hard/proposal_check/self 之一");
    return;
  }

  const linkedStrategy = readOptionalString(body, "linkedStrategy");

  const input: CreateRuleInput = {
    ownerId: identity.id,
    ruleText,
    enforcement,
    ...(linkedStrategy !== undefined ? { linkedStrategy } : {})
  };

  const rule = createRule(deps.db, input);

  // discipline_rules has no visibility tier of its own (always a personal/
  // self-enforcement record) - "system" is purely the memoryd tag label
  // here, matching strategy.mjs's CLI `rule create` exactly.
  const mirror = await mirrorRecord(resolveBackend(deps), {
    ownerId: identity.id,
    recordType: "discipline_rule",
    title: `纪律规则：${ruleText}`,
    content: JSON.stringify({ enforcement, linkedStrategy: rule.linkedStrategy }),
    visibility: "system"
  });

  sendJson(res, 201, { ok: true, rule, mirror });
}

// ---------------------------------------------------------------------------
// POST /api/rules/:id/disable
// ---------------------------------------------------------------------------

async function handleDisableRule(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiStrategyRouteDeps,
  ruleId: string
): Promise<void> {
  const identity = requireBearerIdentity(req, res, deps.db);
  if (!identity) {
    return;
  }

  const rule = getRuleById(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { ok: false, error: `未找到纪律规则：${ruleId}` });
    return;
  }
  if (rule.ownerId !== identity.id) {
    sendJson(res, 403, { ok: false, error: "无权操作：该纪律规则属于其他成员" });
    return;
  }

  const updated = disableRule(deps.db, ruleId);
  sendJson(res, 200, { ok: true, rule: updated });
}

// ---------------------------------------------------------------------------
// POST /api/cards
// ---------------------------------------------------------------------------

async function handleCreateCard(req: IncomingMessage, res: ServerResponse, deps: ApiStrategyRouteDeps): Promise<void> {
  const identity = requireBearerIdentity(req, res, deps.db);
  if (!identity) {
    return;
  }

  const body = await readBody(req, res);
  if (!body) {
    return;
  }

  const name = readRequiredString(body, "name");
  if (!name) {
    badRequest(res, "name", "缺少 name 字段");
    return;
  }

  const visibility = readOptionalEnum<StrategyVisibility>(body, "visibility", VISIBILITY_VALUES);
  if (visibility === INVALID) {
    badRequest(res, "visibility", "visibility 必须是 system/public 之一");
    return;
  }

  const scene = readOptionalString(body, "scene");
  const entryCondition = readOptionalString(body, "entryCondition");
  const riskControl = readOptionalString(body, "riskControl");
  const exitRule = readOptionalString(body, "exitRule");

  const input: CreateCardInput = {
    ownerId: identity.id,
    name,
    ...(scene !== undefined ? { scene } : {}),
    ...(entryCondition !== undefined ? { entryCondition } : {}),
    ...(riskControl !== undefined ? { riskControl } : {}),
    ...(exitRule !== undefined ? { exitRule } : {}),
    ...(visibility !== undefined ? { visibility } : {})
  };

  const card = createCard(deps.db, input);

  const mirror = await mirrorRecord(resolveBackend(deps), {
    ownerId: identity.id,
    recordType: "strategy_card",
    title: name,
    content: JSON.stringify({
      scene: card.scene,
      entry: card.entryCondition,
      risk: card.riskControl,
      exit: card.exitRule
    }),
    visibility: card.visibility
  });

  sendJson(res, 201, { ok: true, card, mirror });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Routes every `/api/*` write endpoint this module owns. Returns `true` if
 * the request was handled (including 401/400/403/404/405 responses), `false`
 * if the path doesn't belong to this module (including an unrecognized
 * `/api/...` path) so the caller falls through to server.ts's final
 * `notFound`. No `nonce` parameter - unlike every HTML route in this app,
 * these responses are JSON-only with no inline `<script>`, so there is
 * nothing for a CSP nonce to attach to.
 */
export function handleApiStrategyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApiStrategyRouteDeps
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments[0] !== "api") {
    return false;
  }

  if (segments.length === 2 && segments[1] === "theses") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    guardAsyncWrite(handleCreateThesis(req, res, deps), req, res, "api-strategy");
    return true;
  }

  if (segments.length === 4 && segments[1] === "theses" && segments[3] === "judgments") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    guardAsyncWrite(handleAppendJudgment(req, res, deps, segments[2] as string), req, res, "api-strategy");
    return true;
  }

  if (segments.length === 4 && segments[1] === "theses" && segments[3] === "promote") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    guardAsyncWrite(handlePromoteThesis(req, res, deps, segments[2] as string), req, res, "api-strategy");
    return true;
  }

  if (segments.length === 2 && segments[1] === "rules") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    guardAsyncWrite(handleCreateRule(req, res, deps), req, res, "api-strategy");
    return true;
  }

  if (segments.length === 4 && segments[1] === "rules" && segments[3] === "disable") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    guardAsyncWrite(handleDisableRule(req, res, deps, segments[2] as string), req, res, "api-strategy");
    return true;
  }

  if (segments.length === 2 && segments[1] === "cards") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    guardAsyncWrite(handleCreateCard(req, res, deps), req, res, "api-strategy");
    return true;
  }

  return false;
}
