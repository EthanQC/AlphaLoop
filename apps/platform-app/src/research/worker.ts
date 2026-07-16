/**
 * Phase 8 Task 3 (2026-07-16 plan): the in-process research worker sitting
 * between `research_tasks` (the queue/state-machine table, Task 1's
 * ResearchTaskRepository) and the deterministic 研判引擎 (Task 2's
 * research-engine.mjs `runResearchPipeline`). `createResearchWorker` returns
 * `{tick, start, stop, recoverStalled}`: `tick()` claims and fully runs ONE
 * queued task (or returns `false` if the queue is empty); `start()`/`stop()`
 * wrap that in a repeating timer for the real process (index.ts); tests
 * drive `tick()` by hand instead (plan: "测试手动 tick"). This is a single
 * in-process, single-writer worker - "mini-only" (plan: "in-process，单实
 * 例，单写者") - there is exactly one of these per running platform-app
 * process, matching `research_tasks`' own single-writer discipline
 * (ResearchTaskRepository.claimNextQueued's atomic UPDATE already assumes
 * this).
 *
 * IMPORTING THE ENGINE - research-engine.mjs LIVES IN apps/openclaw-config/
 * scripts, a plain-.mjs tree with NO tsc project/dist of its own (same
 * cross-app-boundary fact data/strategy.ts's header, data/memoryd-mirror.ts's
 * header, and data/strategy-write.ts's header all document for THEIR .mjs
 * counterparts). Every one of those precedents re-implements the algorithm
 * locally in TS rather than importing across the boundary - but
 * research-engine.mjs's `runResearchPipeline` is a large, actively-evolving,
 * intentionally-pure state machine (six ordered steps, numeric-honesty
 * checks, injection quarantine) that Task 2 already built and tested
 * end-to-end; re-typing a second copy of it here would both duplicate ~250
 * lines of carefully-reasoned logic AND create exactly the "two
 * independently-typed copies could silently drift apart" risk data/
 * strategy.ts's header warns against for its OWN (much smaller) ports. Task
 * 2's own module header already anticipates this module needing to consume
 * it, describing itself as "distinct from the 2026-07-16 plan's Task 2
 * sketch which also listed a `db` parameter" specifically because "the
 * WORKER's job" (this file) is to own persistence while the engine stays a
 * pure function of its inputs.
 *
 * So: this file DYNAMICALLY imports research-engine.mjs (`loadResearchEngine`
 * below) instead of either re-implementing it or statically importing it.
 * Two things make this the right choice over a static `import ... from
 * "../../../openclaw-config/scripts/research-engine.mjs"`:
 *   1. `apps/openclaw-config/scripts` has no `.d.ts`/tsc project - a STATIC
 *      import of a `.mjs` path from a `moduleResolution: NodeNext` project
 *      (this app's tsconfig) fails type resolution outright (TS2307) unless
 *      the target module can be resolved to real type information, which
 *      this sibling app deliberately doesn't provide (it is plain runtime
 *      JS, checked only by its own colocated `.test.ts` files under vitest,
 *      never under `tsc`).
 *   2. A DYNAMIC `import()` call is only resolved/type-checked by TypeScript
 *      when its argument is a STRING LITERAL (so bundlers/tsc can statically
 *      map it to a module); passing a `string`-typed local variable instead
 *      (`RESEARCH_ENGINE_SPECIFIER` below) makes the whole expression's type
 *      `Promise<any>` and skips that resolution step entirely - `tsc
 *      --noEmit` (this app's `typecheck` script) is happy, while real Node
 *      ESM at runtime (this file's own `dist/research/worker.js`, or vitest)
 *      still resolves the (perfectly ordinary, relative) path correctly,
 *      with zero involvement from tsc either way. The awaited result is
 *      explicitly cast back to `ResearchEngineModule` (defined below) so the
 *      REST of this file is fully typed despite that one boundary crossing.
 *      research-engine.test.ts (Task 2) already established that vitest can
 *      dynamically `await import("./research-engine.mjs")` from a `.ts` test
 *      file with no special config; this is the same trick, one directory
 *      further away, used from PRODUCTION code instead of a test.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  MemberRepository,
  ResearchTaskRepository,
  sendInteractiveCard,
  type InteractiveCard,
  type JsonValue,
  type Member,
  type ResearchConfidence,
  type ResearchResult,
  type ResearchTask,
  type ResearchTaskStatus
} from "@packages/shared-types";

import { CONFIDENCE_LABELS } from "../reports/conclusion-box.js";
import { loadAllDisciplineRulesForOwner } from "../data/overview.js";
import { computeComplianceStats, loadLatestPriceForSymbol, loadOwnTheses } from "../data/strategy.js";

// ---------------------------------------------------------------------------
// Collaborator shapes (mirror research-engine.mjs's own JSDoc `@param` shape
// for `runResearchPipeline` field-for-field - see that file's public entry
// point comment).
// ---------------------------------------------------------------------------

export interface ResearchBackendQuery {
  query: string;
  kind: string;
}

export interface ResearchBackendResponse {
  results: Array<Record<string, unknown>>;
}

export type ResearchBackend = (planned: ResearchBackendQuery) => Promise<ResearchBackendResponse>;

export type ResearchQuoteReader = (symbol: string) => Promise<number | undefined> | number | undefined;

/** The RAW (unbound) memory reader a caller injects at worker-construction
 * time - same `{ownerId, symbols} -> {theses, disciplines}` shape the engine
 * itself expects (research-engine.mjs's own `memoryReader` JSDoc), so a fake
 * used in a research-engine.test.ts-style unit test is trivially reusable
 * here. "Raw" only in the sense that nothing has bound `ownerId` for it yet -
 * see `bindMemoryReaderToOwner` below for why that binding is this worker's
 * job, never the caller's or the engine's. */
export interface ResearchMemoryReaderArgs {
  ownerId: string;
  symbols: string[];
}
export interface ResearchMemoryReaderResult {
  theses: JsonValue[];
  disciplines: JsonValue[];
}
export type ResearchMemoryReader = (
  args: ResearchMemoryReaderArgs
) => Promise<ResearchMemoryReaderResult> | ResearchMemoryReaderResult;

/** Fire-and-forget Feishu DM notifier - called only once a member's
 * `feishuOpenId` is already confirmed present (see `notifyOwner` below); a
 * missing openId never reaches this far, so implementations don't need to
 * re-check it. */
export type ResearchNotifier = (task: ResearchTask, member: Member) => Promise<void>;

interface ResearchPipelineStep {
  name: string;
  status: "done" | "skipped";
  detail: string;
  at: string;
}

interface ResearchPipelineResult {
  status: ResearchTaskStatus;
  resultJson: ResearchResult | null;
  confidence: ResearchConfidence | null;
  title: string;
  steps: ResearchPipelineStep[];
  skipped: Array<{ step: string; reason: string }>;
  budgetSpent: number;
}

interface ResearchPipelineArgs {
  question: string;
  ownerId: string;
  backend?: ResearchBackend;
  quoteReader?: ResearchQuoteReader;
  memoryReader?: (args: ResearchMemoryReaderArgs) => Promise<ResearchMemoryReaderResult>;
  budget?: number;
  symbolUniverse?: string[];
  now?: () => Date;
  onStep?: (step: ResearchPipelineStep) => void;
}

interface ResearchEngineModule {
  runResearchPipeline(args: ResearchPipelineArgs): Promise<ResearchPipelineResult>;
  createResearchBackend(): ResearchBackend;
}

// See module header §"IMPORTING THE ENGINE": kept as a plain `string`
// variable (never inlined as a literal into `import(...)`) so TypeScript
// treats the call below as a non-literal, unresolved dynamic import
// (`Promise<any>`) instead of attempting - and failing - to statically
// resolve apps/openclaw-config/scripts/research-engine.mjs's types.
const RESEARCH_ENGINE_SPECIFIER: string = "../../../openclaw-config/scripts/research-engine.mjs";

let cachedEnginePromise: Promise<ResearchEngineModule> | null = null;

function loadResearchEngine(): Promise<ResearchEngineModule> {
  if (!cachedEnginePromise) {
    const pending = import(RESEARCH_ENGINE_SPECIFIER) as Promise<ResearchEngineModule>;
    // Cache the in-flight/resolved import so repeated ticks share ONE module
    // load - but NEVER cache a REJECTED promise. A bare `cachedEnginePromise
    // ??= import(...)` would permanently poison the worker: because a rejected
    // promise is itself non-nullish, `??=` would keep handing every future
    // tick() back that same settled rejection, so one transient import failure
    // (an fs hiccup, a deploy-race where the .mjs is momentarily absent) would
    // fail EVERY subsequent research task until the process was manually
    // restarted. Instead, drop the cache entry if this import rejects, so the
    // next tick() retries a fresh import. (The `=== pending` guard makes the
    // reset safe against a later successful import having already replaced the
    // slot.)
    cachedEnginePromise = pending;
    pending.catch(() => {
      if (cachedEnginePromise === pending) {
        cachedEnginePromise = null;
      }
    });
  }
  return cachedEnginePromise;
}

// ---------------------------------------------------------------------------
// Default collaborators (production wiring point - index.ts constructs the
// real worker with these; tests inject fakes instead and never call these
// factories).
// ---------------------------------------------------------------------------

/** Mirrors data/memoryd-mirror.ts's `createMemorydBackend()` exactly: a
 * documented, P10-gated placeholder callers can already wire in the SHAPE of
 * today, which simply re-throws research-engine.mjs's own "P10 ignition"
 * error the first time it's actually invoked (i.e. the first news query a
 * real run attempts) - never at construction time. */
export function createDefaultResearchBackend(): ResearchBackend {
  return async (planned) => {
    const engine = await loadResearchEngine();
    return engine.createResearchBackend()(planned);
  };
}

/** stock_facts `quote.last`, latest across trading days - the SAME query
 * routes/strategy.ts already uses for computeThesisOutcome's own
 * `latestPrice` input (data/strategy.ts's loadLatestPriceForSymbol). Public,
 * owner-independent data (plan: "quoteReader (stock_facts quote.last，owner
 * 无关公共)") - no owner filter here, deliberately. */
export function createDefaultQuoteReader(db: DatabaseSync): ResearchQuoteReader {
  return (symbol: string): number | undefined => loadLatestPriceForSymbol(db, symbol) ?? undefined;
}

/** Composes the Phase 7 SQL readers (data/strategy.ts's `loadOwnTheses`/
 * `computeComplianceStats`, data/overview.ts's
 * `loadAllDisciplineRulesForOwner`) into the RAW `{ownerId, symbols} ->
 * {theses, disciplines}` shape this worker (and, through it, the engine)
 * expects. Each thesis/discipline row is reshaped to exactly the fields
 * research-engine.mjs's `compareThesis`/`compareDiscipline` read
 * (symbol/direction/id/targetLow/targetHigh/invalidationPrice and
 * ruleId/ruleText/stats respectively) - see that file's own comments next to
 * each compare function. `symbols` is accepted (matching the shape) but
 * unused: both underlying readers are already scoped by `ownerId` alone: a
 * member's full thesis/discipline set is small enough that "all of mine" is
 * simpler and no less correct than filtering to only the resolved symbols. */
export function createDefaultMemoryReader(
  db: DatabaseSync,
  now: () => Date = () => new Date()
): ResearchMemoryReader {
  return ({ ownerId }: ResearchMemoryReaderArgs): ResearchMemoryReaderResult => {
    const theses = loadOwnTheses(db, ownerId).map((thesis) => ({
      id: thesis.id,
      symbol: thesis.symbol,
      direction: thesis.direction,
      targetLow: thesis.targetLow,
      targetHigh: thesis.targetHigh,
      invalidationPrice: thesis.invalidationPrice
    }));
    const disciplines = loadAllDisciplineRulesForOwner(db, ownerId).map((rule) => ({
      ruleId: rule.id,
      ruleText: rule.ruleText,
      stats: computeComplianceStats(db, ownerId, rule.id, now())
    }));
    return { theses: theses as unknown as JsonValue[], disciplines: disciplines as unknown as JsonValue[] };
  };
}

/** Real Feishu DM notifier: one line of conclusion + a confidence badge
 * (CONFIDENCE_LABELS 高/中/低 - the SAME mapping reports/conclusion-box.ts
 * already uses for every other confidence field in this app), plus the
 * `/research/<id>` path as plain text (NOT a clickable `url` button: this
 * loopback-only service has no public base URL configured yet - P10's
 * Cloudflare Access domain - so a clickable link would silently 404/refuse
 * from inside the Feishu app; honestly-a-path-to-copy beats a broken button,
 * matching routes/research.ts's own "研究执行 P8 上线" honesty precedent for
 * an unshipped capability). `notifyOwner` below only ever calls this once a
 * `feishuOpenId` is already confirmed present, so no missing-openId guard is
 * needed here. */
export function createDefaultNotifier(): ResearchNotifier {
  return async (task: ResearchTask, member: Member): Promise<void> => {
    const openId = member.feishuOpenId;
    if (!openId) {
      return;
    }
    const confidenceLabel = task.confidence ? CONFIDENCE_LABELS[task.confidence] : "—";
    const conclusion = task.resultJson?.conclusion ?? "研判已完成，详情见站内研判页。";
    const card: InteractiveCard = {
      title: task.title ?? "研究完成",
      lines: [conclusion, `置信度：${confidenceLabel}`, `研判页：/research/${task.id}`]
    };
    // sendInteractiveCard NEVER throws (notifications.ts): a delivery failure
    // (expired/bad openId, MCP transport error, network failure) surfaces as
    // `{ok:false, error}`, not an exception - so notifyOwner's own try/catch
    // (which only fires on a thrown error) would never see it. Log it here so a
    // silently-undelivered result card is at least visible, while still
    // honoring the fire-and-forget contract (a failed DM never fails the task -
    // this returns normally either way).
    const result = await sendInteractiveCard(card, { openId });
    if (!result.ok) {
      console.warn(
        `research worker: feishu result card not delivered for task ${task.id}: ${result.error ?? "unknown error"}`
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface CreateResearchWorkerDeps {
  db: DatabaseSync;
  backend: ResearchBackend;
  quoteReader: ResearchQuoteReader;
  /** RAW (unbound) - see `ResearchMemoryReader`'s own doc comment and
   * `bindMemoryReaderToOwner` below. */
  memoryReader: ResearchMemoryReader;
  /** Injectable clock for deterministic tests; defaults to wall clock. Used
   * both as the pipeline's own `now` (its step timestamps) and as this
   * worker's `finished_at` stamp, so a test asserting on either sees the
   * exact same instant. */
  now?: () => Date;
  /** Fire-and-forget Feishu DM notifier; defaults to `createDefaultNotifier()`. */
  notify?: ResearchNotifier;
  /** Forwarded to the pipeline as-is; omitted entirely (not defaulted here)
   * when not supplied, so the engine's own default (8) applies - the plan's
   * "预算...固定" constant lives in exactly one place (research-engine.mjs),
   * not duplicated here. */
  budget?: number;
  /** Forwarded to the pipeline as-is; defaults to `[]` (matching the
   * engine's own default) purely for this worker's own safety/testability -
   * the REAL symbol universe (标的池并集 + 本人持仓) is resolved by whoever
   * constructs the production worker (index.ts), not by this file. */
  symbolUniverse?: string[];
}

export interface ResearchWorker {
  /** Claims and fully runs ONE queued task. Returns `true` if a task was
   * claimed and processed (regardless of whether it ended done/degraded/
   * failed), `false` if the queue was empty (nothing to do). Never rejects -
   * every failure mode this function can observe (a throwing backend, a
   * crashed pipeline, a notify failure) is caught and turned into either a
   * persisted `failed` task or a swallowed, logged warning; see `tick`'s own
   * comments below for exactly which. */
  tick(): Promise<boolean>;
  /** Starts a repeating `tick()` loop (real process only - index.ts). Runs
   * `recoverStalled()` once immediately (in addition to the one construction
   * already ran - idempotent, see `recoverStalled`'s own comment) before the
   * first timer fires. A second call while already started is a no-op. */
  start(intervalMs?: number): void;
  /** Stops the repeating loop started by `start()`. A no-op if never
   * started (or already stopped). */
  stop(): void;
  /** Boot-recovery sweep (plan: "worker...启动时重拾未完成行"): resets any
   * orphaned `running` row (a process restart interrupted it mid-pipeline)
   * back to `queued` so the next `tick()` re-runs it from scratch - re-
   * running is idempotent (`appendStep`/`setResult` simply overwrite the
   * previous, incomplete steps/result). Returns the number of rows reset.
   * Exposed as its own method (not merely an internal side effect of
   * construction) so a caller/test can re-run the sweep explicitly - e.g.
   * right before `start()`, mirroring how a real process restart would
   * observe an orphaned row long after this worker object was first built. */
  recoverStalled(): number;
}

/** See `ResearchMemoryReaderArgs`'s own doc comment: this is the "agent has
 * no free scope param" enforcement the plan's Global Constraints require
 * ("worker 记忆工具按任务 owner 预绑定 scope，agent 无自由 scope"). The
 * pipeline (research-engine.mjs) already forwards its OWN `ownerId` argument
 * faithfully to whatever `memoryReader` it's given (see that file's own
 * header - "this engine merely forwards `ownerId` as a plain argument") - but
 * this wrapper does not TRUST that forwarding to stay correct forever. It
 * deliberately IGNORES whatever `ownerId` value the pipeline call carries and
 * substitutes `claimedOwnerId` (the actual owner of the row THIS tick()
 * claimed) every time, so even a future bug/regression inside the pipeline
 * that somehow computed or forwarded a wrong/attacker-influenced `ownerId`
 * could never leak another member's theses/disciplines through this seam -
 * the worker, not the agent, is the sole source of truth for whose data a
 * claimed task's memory reads may ever touch. */
function bindMemoryReaderToOwner(
  rawMemoryReader: ResearchMemoryReader,
  claimedOwnerId: string
): (args: ResearchMemoryReaderArgs) => Promise<ResearchMemoryReaderResult> {
  return async ({ symbols }: ResearchMemoryReaderArgs): Promise<ResearchMemoryReaderResult> => {
    return rawMemoryReader({ ownerId: claimedOwnerId, symbols });
  };
}

export function createResearchWorker(deps: CreateResearchWorkerDeps): ResearchWorker {
  const { db, backend, quoteReader, memoryReader } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const notify = deps.notify ?? createDefaultNotifier();
  const symbolUniverse = deps.symbolUniverse ?? [];
  const repo = new ResearchTaskRepository(db);
  const members = new MemberRepository(db);

  let timer: ReturnType<typeof setInterval> | null = null;

  // See `ResearchWorker.recoverStalled`'s doc comment. Raw SQL against
  // `research_tasks` (not a ResearchTaskRepository method): Task 1 already
  // closed that class's interface exhaustively
  // (countTodayForOwner/createIfWithinQuota/claimNextQueued/appendStep/
  // setResult/getById/listForOwner/listRunningOrQueued/promoteVisibility) with
  // no "reset a running row back to queued" operation in it, and this task's
  // scope is the worker/API/notify layer, not re-opening Task 1's schema/
  // repository surface. Every other `data/*.ts` reader in this app already
  // runs its own scoped SQL directly against a shared-types-owned table
  // (data/strategy.ts, data/overview.ts) rather than requiring a repository
  // method for every possible query, so a single, narrowly-scoped UPDATE
  // here (guarded by `AND status = 'running'`, so it can only ever affect a
  // row that is STILL running at the moment this statement executes) follows
  // that same, already-established convention.
  function recoverStalled(): number {
    const orphaned = repo.listRunningOrQueued().filter((task) => task.status === "running");
    for (const task of orphaned) {
      db.prepare(`UPDATE research_tasks SET status = 'queued' WHERE id = ? AND status = 'running'`).run(task.id);
    }
    return orphaned.length;
  }

  // Fire-and-forget in the SAME sense data/memoryd-mirror.ts's mirrorRecord
  // is (that module's own header) - AWAITED by tick() below (so a test can
  // deterministically assert on its effects once tick() resolves), but
  // structurally incapable of failing the task it's notifying about: a
  // missing `feishuOpenId` skips the send entirely (never calls `notify`
  // with an empty openId), and any throw/rejection FROM `notify` is caught
  // here and only logged, never re-thrown.
  async function notifyOwner(task: ResearchTask): Promise<void> {
    const member = members.getById(task.ownerId);
    if (!member?.feishuOpenId) {
      return;
    }
    try {
      await notify(task, member);
    } catch (error) {
      console.warn(
        `research worker: notify failed for task ${task.id} (owner ${task.ownerId}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async function tick(): Promise<boolean> {
    const claimed = repo.claimNextQueued(now().toISOString());
    if (!claimed) {
      return false;
    }

    const boundMemoryReader = bindMemoryReaderToOwner(memoryReader, claimed.ownerId);

    // The engine itself never throws for a throwing `backend`/`quoteReader`/
    // `memoryReader` (research-engine.mjs's own header: every collaborator
    // call is wrapped in its own try/catch, a throwing backend degrades the
    // run rather than propagating) - this try/catch is defense-in-depth for
    // a genuinely unexpected crash (e.g. a bug in this worker's own `onStep`
    // callback, or the dynamic engine import itself failing), so THIS
    // worker's own contract ("tick() never rejects") holds even then. Either
    // way the claimed task must reach a terminal status - it must never be
    // silently abandoned mid-`running`.
    try {
      const engine = await loadResearchEngine();
      const pipelineResult = await engine.runResearchPipeline({
        question: claimed.question,
        ownerId: claimed.ownerId,
        backend,
        quoteReader,
        memoryReader: boundMemoryReader,
        ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
        symbolUniverse,
        now,
        onStep: (step) => {
          try {
            repo.appendStep(claimed.id, step as unknown as JsonValue);
          } catch (error) {
            console.warn(
              `research worker: appendStep failed for task ${claimed.id}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      });

      repo.setResult(claimed.id, {
        status: pipelineResult.status,
        ...(pipelineResult.resultJson !== null ? { resultJson: pipelineResult.resultJson } : {}),
        ...(pipelineResult.confidence !== null ? { confidence: pipelineResult.confidence } : {}),
        ...(pipelineResult.title ? { title: pipelineResult.title } : {}),
        ...(typeof pipelineResult.budgetSpent === "number" ? { budgetSpent: pipelineResult.budgetSpent } : {}),
        finishedAt: now().toISOString()
      });
    } catch (error) {
      console.warn(
        `research worker: pipeline crashed for task ${claimed.id} (owner ${claimed.ownerId}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      try {
        repo.appendStep(claimed.id, {
          name: "系统",
          status: "skipped",
          detail: `跳过：调研执行异常（${error instanceof Error ? error.message : String(error)}）`,
          at: now().toISOString()
        } as unknown as JsonValue);
      } catch {
        // Best-effort only - the setResult call below still runs regardless.
      }
      // The recovery write is ITSELF guarded: if this fallback setResult also
      // throws (e.g. SQLite momentarily busy, or the row was deleted out from
      // under us), that must not make tick() reject - its "never rejects"
      // contract has to hold even when the recovery path fails too. A row that
      // genuinely cannot be marked failed here stays 'running' and is picked up
      // by the next recoverStalled() sweep instead, which is the honest
      // fallback (better than crashing the whole tick loop).
      try {
        repo.setResult(claimed.id, { status: "failed", finishedAt: now().toISOString() });
      } catch (writeError) {
        console.warn(
          `research worker: could not mark task ${claimed.id} failed after a crash: ${
            writeError instanceof Error ? writeError.message : String(writeError)
          }`
        );
      }
    }

    // getById + notifyOwner sit OUTSIDE the try/catch above, so guard them too:
    // notifyOwner already swallows its own errors internally, but a throwing
    // getById (or any future addition here) must not defeat tick()'s
    // never-rejects contract either.
    try {
      const finishedTask = repo.getById(claimed.id);
      if (finishedTask) {
        await notifyOwner(finishedTask);
      }
    } catch (notifyError) {
      console.warn(
        `research worker: post-run notify step failed for task ${claimed.id}: ${
          notifyError instanceof Error ? notifyError.message : String(notifyError)
        }`
      );
    }

    return true;
  }

  function start(intervalMs = 3000): void {
    if (timer) {
      return;
    }
    recoverStalled();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Boot recovery (plan: "worker...启动时重拾未完成行") - runs once
  // immediately at construction so even a caller that constructs a worker and
  // drives `tick()` by hand (every test in worker.test.ts) without ever
  // calling `start()` still recovers an orphaned `running` row left over from
  // a prior crashed process before that first manual `tick()`.
  recoverStalled();

  return { tick, start, stop, recoverStalled };
}
