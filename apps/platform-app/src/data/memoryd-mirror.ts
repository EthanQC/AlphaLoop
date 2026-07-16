/**
 * Platform-side TS port of apps/openclaw-config/scripts/memoryd-mirror.mjs
 * (Phase 7 Task 2) - NOT an import, for the same cross-app-boundary reason
 * documented in data/strategy-write.ts's header (and data/news.ts's). Any
 * change to the type-mapping / scope derivation / fire-and-forget semantics
 * here MUST be mirrored in memoryd-mirror.mjs (or vice versa).
 *
 * Architecture reminder (plan's Global Constraints): "SQL 是可见性与结构化
 * 数据的唯一真源；memoryd 只做全文镜像（fire-and-forget，不可用不影响任何 SQL
 * 路径与纪律硬检查）" - by the time mirrorRecord below runs, the caller's SQL
 * write (routes/api-strategy.ts, via data/strategy-write.ts) has ALREADY
 * COMMITTED. Every failure mode this module can observe (backend throws
 * synchronously, backend's returned promise rejects, backend resolves with
 * `{ok:false}`) degrades to a warned, honestly labeled
 * `{mirrored:false, reason}` instead of propagating - it never blocks or
 * unwinds the write it mirrors.
 */

// memoryd's mem_save tool accepts exactly six `type` values: session /
// decision / preference / fact / playbook / warning. This codebase's four
// mirrored record kinds map onto four of those six, per the plan's explicit
// mapping ("策略卡→playbook / 纪律→warning / 论点·判断→decision") - identical
// to memoryd-mirror.mjs's own MEMORYD_TYPE_BY_RECORD.
export const MEMORYD_TYPE_BY_RECORD: Record<string, string> = {
  strategy_card: "playbook",
  discipline_rule: "warning",
  thesis: "decision",
  thesis_judgment: "decision"
};

// Any record type NOT in the map above degrades to memoryd's generic 'fact'
// type rather than throwing - the fire-and-forget contract holds even for an
// unrecognized record type, not just for backend failures.
const DEFAULT_MEMORYD_TYPE = "fact";

function resolveMemorydType(recordType: string): string {
  return MEMORYD_TYPE_BY_RECORD[recordType] ?? DEFAULT_MEMORYD_TYPE;
}

/** Deterministic per-owner memoryd scope - same `ownerId` in always produces
 * the same scope out (a pure string template, no hashing/randomness), so a
 * later mirror call for the same owner lands in the same memoryd scope as
 * the first. Identical formula to memoryd-mirror.mjs's scopeForOwner. */
export function scopeForOwner(ownerId: string): string {
  return `alphaloop-member-${String(ownerId ?? "")}`;
}

export interface MemorydBackendArgs {
  scope: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
}

export interface MemorydBackendResult {
  ok: boolean;
  memoryId?: string;
  reason?: string;
}

/** Injected, never constructed by mirrorRecord itself - matches memoryd's own
 * mem_save tool shape (scope/type/title/content/tags), so a real P10 HTTP
 * backend is a thin wrapper with no shape translation. */
export type MemorydBackend = (args: MemorydBackendArgs) => Promise<MemorydBackendResult>;

export interface MirrorRecordInput {
  ownerId: string;
  recordType: string;
  title: string;
  content: string;
  visibility: string;
}

export type MirrorResult = { mirrored: true; memoryId: string | null } | { mirrored: false; reason: string };

/**
 * Mirrors ONE already-committed strategy-memory record into memoryd via the
 * injected `backend`. Never throws / never rejects - see module header.
 */
export async function mirrorRecord(backend: MemorydBackend, record: MirrorRecordInput): Promise<MirrorResult> {
  const { ownerId, recordType, title, content, visibility } = record;
  const scope = scopeForOwner(ownerId);
  const type = resolveMemorydType(recordType);
  // Tags carry the visibility tier and the source record type alongside the
  // full-text mirror ("可见性档位写进 memoryd tags（但读永远从 SQL，tags 只是
  // 镜像）") - never read back by any SQL-facing code path to make an
  // access-control decision.
  const tags = [`visibility:${visibility}`, `record:${recordType}`];

  try {
    const result = await backend({ scope, type, title, content, tags });

    if (result?.ok) {
      return { mirrored: true, memoryId: result.memoryId ?? null };
    }

    const reason = result?.reason ? String(result.reason) : "memoryd backend returned ok:false";
    console.warn(`memoryd mirror skipped (record=${recordType}, owner=${ownerId}): ${reason}`);
    return { mirrored: false, reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`memoryd mirror skipped (record=${recordType}, owner=${ownerId}): ${reason}`);
    return { mirrored: false, reason };
  }
}

/**
 * Real memoryd backend (a dedicated MEMORYD_DATA_ROOT instance reachable
 * over a loopback-only HTTP API, per-owner scope) is OUT OF SCOPE for this
 * task (plan's "明确不做": "memoryd 真实例/真 scope/向量层（P10）"). This
 * factory exists so callers (createPlatformServer's default deps) can
 * already wire in the SHAPE of the real backend today - the function it
 * returns simply throws until P10 stands up the real instance. Mirrors
 * memoryd-mirror.mjs's own createMemorydBackend exactly.
 */
export function createMemorydBackend(): MemorydBackend {
  return async function memorydBackend(): Promise<MemorydBackendResult> {
    throw new Error(
      "memoryd backend requires P10 ignition (dedicated MEMORYD_DATA_ROOT instance, loopback HTTP API, per-owner scope)"
    );
  };
}
