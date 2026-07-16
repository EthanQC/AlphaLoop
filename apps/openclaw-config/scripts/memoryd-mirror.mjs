// Phase 7 Task 2 (2026-07-15 plan): memoryd 镜像后端 (fire-and-forget,
// injectable) - the layer that mirrors a SQL-first strategy-memory write
// (strategy-store.mjs's theses / discipline_rules / strategy_cards, Task 1)
// into memoryd as a full-text memory, for later semantic recall.
//
// Architecture reminder (plan's Global Constraints): "SQL 是可见性与结构化
// 数据的唯一真源；memoryd 只做全文镜像（fire-and-forget，不可用不影响任何 SQL
// 路径与纪律硬检查）" - by the time mirrorRecord below is ever called, the
// caller's SQL write has ALREADY COMMITTED. memoryd being slow, unreachable,
// or altogether unconfigured must never surface as an error to that caller,
// never roll back anything, and never block/delay the response - hence
// every failure mode this module can observe (backend throw, backend
// rejection, backend returning {ok:false}) degrades to a warned, honestly
// labeled `{mirrored:false, reason}` instead of propagating.
//
// This follows the SAME injectable-backend/P10-gated-throw shape this
// codebase already established twice for exactly this "real integration is
// out of scope today, but callers can wire in the SHAPE now" situation:
//   - news-agent-search.mjs's createOpenclawSearchBackend (restricted-agent
//     search - P10 real gateway).
//   - narrative-engine.mjs's createNarrativeLlmBackend (LLM narrative
//     generation - P10 real runtime).
// Both real backends are documented, throwing placeholders; every test
// exercises a FAKE backend instead. This module's createMemorydBackend
// mirrors that exact pattern for memoryd (P10 real dedicated instance +
// loopback HTTP API).
//
// Backend interface (injected, never constructed by mirrorRecord itself):
//   async ({ scope, type, title, content, tags }) => { ok: boolean, memoryId?: string, reason?: string }
// matching memoryd's own mem_save tool shape (scope/type/title/content/tags),
// so a real P10 HTTP backend is a thin wrapper with no shape translation.

// ---------------------------------------------------------------------------
// Type mapping: strategy-memory record type -> memoryd mem_save `type`
// ---------------------------------------------------------------------------

// memoryd's mem_save tool accepts exactly six `type` values: session /
// decision / preference / fact / playbook / warning (memoryd fact sheet).
// This codebase's four mirrored record kinds map onto four of those six per
// the plan's explicit mapping ("策略卡→playbook / 纪律→warning /
// 论点·判断→decision"):
//   - strategy_card (a saved playbook: scene/entry/risk/exit)   -> playbook
//   - discipline_rule (a self-imposed trading constraint)        -> warning
//   - thesis (an initial bull/bear call on a symbol)              -> decision
//   - thesis_judgment (a later append-only note on that thesis)  -> decision
// Exported so callers (the future strategy.mjs CLI / bearer-gated API, Tasks
// 3-4) and this module's own tests share ONE literal mapping rather than
// each re-typing the four record-type strings independently.
export const MEMORYD_TYPE_BY_RECORD = {
  strategy_card: "playbook",
  discipline_rule: "warning",
  thesis: "decision",
  thesis_judgment: "decision"
};

// Any record type NOT in the map above (a future record kind not yet wired
// into this mapping, or a caller typo) degrades to memoryd's generic 'fact'
// type rather than throwing - mirrorRecord's fire-and-forget contract holds
// even for an UNRECOGNIZED record type, not just for backend failures.
const DEFAULT_MEMORYD_TYPE = "fact";

function resolveMemorydType(recordType) {
  return MEMORYD_TYPE_BY_RECORD[recordType] ?? DEFAULT_MEMORYD_TYPE;
}

// ---------------------------------------------------------------------------
// scopeForOwner: deterministic per-owner memoryd scope
// ---------------------------------------------------------------------------

// Derives a stable memoryd `scope` string for one AlphaLoop member, so every
// mirrored memory for owner X lands in a scope namespace that never
// collides with owner Y's (plan: "per-owner scope" - system-visible records
// must never leak across members even inside memoryd's own storage, not
// just at the SQL read layer). Deliberately a PURE string template over
// `ownerId` (no hashing/randomness) - same `ownerId` in must always produce
// the SAME scope out, forever, so a later mirror call for the same owner
// (e.g. a second thesis judgment) lands in the SAME memoryd scope as the
// first, and so tests can assert the exact literal without depending on
// this module's internals.
export function scopeForOwner(ownerId) {
  return `alphaloop-member-${String(ownerId ?? "")}`;
}

// ---------------------------------------------------------------------------
// mirrorRecord: the single entry point callers use (fire-and-forget)
// ---------------------------------------------------------------------------

// Mirrors ONE already-committed strategy-memory record into memoryd via the
// injected `backend`. This is deliberately the ONLY exported "do the mirror"
// function - there is no separate mirrorRecord/mirrorRecordSafe split. Every
// call site (strategy.mjs's CLI commands, the bearer-gated write API, Tasks
// 3-4) calls this SAME function with an already-injected backend; there is
// no lower-level "unsafe" variant that could throw and get called by mistake
// where the safe one was intended.
//
// Callers are expected to pass an explicitly-injected `backend` (a fake in
// every test in this repo today; createMemorydBackend()'s real, P10-gated
// placeholder in production). Because createMemorydBackend() always throws
// until P10 stands up a real memoryd HTTP endpoint, production callers that
// wire in that default backend will ALWAYS observe {mirrored:false} today -
// this is CORRECT and INTENDED (see this module's header): the SQL write
// this mirrors has already committed regardless, and memoryd is a
// best-effort full-text mirror on top, not a dependency of any SQL path or
// discipline hard-check.
//
// Never throws / never rejects - every failure mode below (backend throws
// synchronously, backend's returned promise rejects, backend resolves with
// `{ok:false}`) is caught here and converted into a warned, honest
// `{mirrored:false, reason}` return value instead of propagating to the
// caller.
//
// @param {(args: {scope:string, type:string, title:string, content:string, tags:string[]}) => Promise<{ok:boolean, memoryId?:string, reason?:string}>} backend
// @param {{ownerId:string, recordType:string, title:string, content:string, visibility:string}} record
// @returns {Promise<{mirrored:true, memoryId:string|null}|{mirrored:false, reason:string}>}
export async function mirrorRecord(backend, { ownerId, recordType, title, content, visibility }) {
  const scope = scopeForOwner(ownerId);
  const type = resolveMemorydType(recordType);
  // Tags carry the visibility tier and the source record type alongside the
  // full-text mirror - plan: "可见性档位写进 memoryd tags（但读永远从 SQL，
  // tags 只是镜像）". These tags are NEVER read back by any SQL-facing code
  // path to make an access-control decision; they exist purely so a human
  // (or a future memoryd search) can filter/recognize what a mirrored memory
  // is, while SQL alone remains the enforcement layer for who may see what.
  const tags = [`visibility:${visibility}`, `record:${recordType}`];

  try {
    // The backend call itself is INSIDE this try (not just the await) so a
    // backend that throws SYNCHRONOUSLY (never returns a promise at all,
    // e.g. a misconfigured/non-async fake) is caught exactly the same way as
    // one whose returned promise rejects - both are just "the backend call
    // failed" from this function's point of view.
    const result = await backend({ scope, type, title, content, tags });

    if (result?.ok) {
      return { mirrored: true, memoryId: result.memoryId ?? null };
    }

    const reason = result?.reason ? String(result.reason) : "memoryd backend returned ok:false";
    console.warn(`memoryd mirror skipped (record=${recordType}, owner=${ownerId}): ${reason}`);
    return { mirrored: false, reason };
  } catch (error) {
    const reason = String(error?.message ?? error);
    console.warn(`memoryd mirror skipped (record=${recordType}, owner=${ownerId}): ${reason}`);
    return { mirrored: false, reason };
  }
}

// ---------------------------------------------------------------------------
// P10 wiring point
// ---------------------------------------------------------------------------

// Real memoryd backend (a dedicated MEMORYD_DATA_ROOT instance reachable over
// a loopback-only HTTP API, per-owner scope) is OUT OF SCOPE for this task
// (plan's "明确不做": "memoryd 真实例/真 scope/向量层（P10）"). This factory
// exists so callers can already wire in the SHAPE of the real backend today
// - createMemorydBackend() returns a function matching the `backend`
// interface mirrorRecord accepts - while the function it returns simply
// throws until P10 stands up the real instance. Mirrors
// news-agent-search.mjs's createOpenclawSearchBackend / narrative-engine.mjs's
// createNarrativeLlmBackend exactly: every test in memoryd-mirror.test.ts
// instead injects a fake backend; this placeholder is never exercised by a
// passing test path other than asserting it throws (and asserting
// mirrorRecord correctly degrades because of it).
export function createMemorydBackend() {
  return async function memorydBackend() {
    throw new Error(
      "memoryd backend requires P10 ignition (dedicated MEMORYD_DATA_ROOT instance, loopback HTTP API, per-owner scope)"
    );
  };
}
