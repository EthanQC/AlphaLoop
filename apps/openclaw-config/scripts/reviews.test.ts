// Phase 9 Task 3 (2026-07-16 plan, review flywheel): reviews.mjs CLI tests.
// Two things this suite exists to pin down beyond ordinary CLI plumbing:
//   1. `generate`'s runtime self-check is LOAD-BEARING, not decorative - when
//      the independent verifier (review-verifier.mjs) disagrees with the
//      primary engine (review-engine.mjs) on even one headline number, the
//      draft must NOT be saved, and the CLI must report every disagreement.
//   2. `confirm`'s memoryd mirror and Feishu single-chat notification are
//      both fire-and-forget - a throwing backend/notifier must never fail
//      the confirm itself (the SQL status change has already committed).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuditLogRepository,
  MemberRepository,
  MonthlyReviewRepository,
  createId,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";

// Wraps the REAL recomputeReviewMetrics (transparent to every other test in
// this file - `...actual` leaves compareReviewMetrics and every other export
// untouched) purely so ONE test below can force a disagreement between the
// primary engine and "the verifier" without hand-rolling a second db/engine
// pair - it substitutes a deliberately WRONG verifier answer for exactly one
// call, then asserts reviews.mjs's own compareReviewMetrics (the real one)
// catches it and refuses to save.
vi.mock("./review-verifier.mjs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, recomputeReviewMetrics: vi.fn(actual.recomputeReviewMetrics as (...args: unknown[]) => unknown) };
});

const cli = await import("./reviews.mjs");
const verifierModule = await import("./review-verifier.mjs");

const OWNER_A = "member_a";
const OWNER_B = "member_b";
const PERIOD = "2026-07";
const NOW = "2026-07-20T00:00:00.000Z";

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string; options: { dbPath: string } } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-reviews-cli-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath, options: { dbPath } };
}

afterEach(() => {
  vi.mocked(verifierModule.recomputeReviewMetrics).mockClear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id: string, status: "active" | "revoked" = "active"): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status,
    createdAt: "2026-01-01T00:00:00.000Z"
  });
}

function seedAlertTrigger(db: DatabaseSync, ownerId: string): void {
  const ruleId = createId("alert_rule");
  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, frequency, created_at)
    VALUES (?, ?, 'AAA.US', 'daily_move', 5, 'once_daily', '2026-01-01T00:00:00.000Z')
  `).run(ruleId, ownerId);
  db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value, feedback)
    VALUES (?, ?, ?, '2026-07-10T00:00:00.000Z', 1.0, '已核实')
  `).run(createId("alert_event"), ruleId, ownerId);
}

function auditRows(db: DatabaseSync, action?: string): Array<{ action: string; payload: string }> {
  const rows = action
    ? (db.prepare(`SELECT action, payload FROM audit_log WHERE category = 'monthly_review' AND action = ?`).all(action) as Array<{
        action: string;
        payload: string;
      }>)
    : (db.prepare(`SELECT action, payload FROM audit_log WHERE category = 'monthly_review'`).all() as Array<{
        action: string;
        payload: string;
      }>);
  return rows;
}

function fakeMemorydBackend(): {
  backend: (args: { scope: string; type: string; title: string; content: string; tags: string[] }) => Promise<{ ok: boolean; memoryId?: string }>;
  calls: Array<{ scope: string; type: string; title: string; content: string; tags: string[] }>;
} {
  const calls: Array<{ scope: string; type: string; title: string; content: string; tags: string[] }> = [];
  const backend = vi.fn(async (args: { scope: string; type: string; title: string; content: string; tags: string[] }) => {
    calls.push(args);
    return { ok: true, memoryId: "mem_1" };
  });
  return { backend, calls };
}

function throwingBackend(message: string): (args: unknown) => Promise<never> {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

// A deliberately WRONG "same shape" verifier result - every block reports an
// empty/no-data state, which will disagree with a real primary result on any
// fixture that actually has data in at least one block.
const EMPTY_VERIFIER_RESULT = {
  ownerId: OWNER_A,
  period: PERIOD,
  generatedAt: NOW,
  predictionReview: { selfThesisHitRate: { sample: "insufficient", n: 0 }, systemConfidenceCalibration: [] },
  decisionReview: {
    period: PERIOD,
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-08-01T00:00:00.000Z",
    benchmarkSymbol: "QQQ",
    executed: { sample: "none", n: 0, priced: 0, entries: [] },
    rejected: { sample: "none", n: 0, disclaimer: "未执行，仅口径参考", entries: [] }
  },
  disciplineReview: {
    complianceRate: { sample: "none" },
    complianceValue: { compliant: { sample: "none" }, violating: { sample: "none" }, deltaPct: null }
  },
  alertQuality: { sample: "none", triggeredCount: 0, misreportCount: 0, misreportRate: null }
};

// ===========================================================================
// generate
// ===========================================================================

describe("generate", () => {
  it("saves a draft when the verifier agrees with the primary engine", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);

    const result = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    expect(result.ok).toBe(true);
    expect(result.review.status).toBe("draft");
    expect(result.review.ownerId).toBe(OWNER_A);
    expect(result.review.period).toBe(PERIOD);
    expect(result.selfCheck).toEqual({ consistent: true, mismatches: [] });

    const saved = new MonthlyReviewRepository(db).getByOwnerPeriod(OWNER_A, PERIOD);
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe("draft");

    const rows = auditRows(db, "generate");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).selfCheck).toBe("consistent");
  });

  it("REFUSES to save and reports every disagreement when the verifier disagrees with the primary engine", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    seedAlertTrigger(db, OWNER_A); // gives the REAL primary a non-'none' alertQuality

    vi.mocked(verifierModule.recomputeReviewMetrics).mockReturnValueOnce(EMPTY_VERIFIER_RESULT);

    await expect(cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW })).rejects.toThrow(
      /独立验证器与主复盘引擎的头条数字不一致/
    );

    // Nothing was saved - the self-check refusal is a hard stop BEFORE
    // upsertDraft, not a warning alongside a save.
    expect(new MonthlyReviewRepository(db).getByOwnerPeriod(OWNER_A, PERIOD)).toBeNull();
    expect(auditRows(db, "generate")).toHaveLength(0);
  });

  it("includes the specific mismatched path(s) in the thrown error, not just a generic message", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    seedAlertTrigger(db, OWNER_A);

    vi.mocked(verifierModule.recomputeReviewMetrics).mockReturnValueOnce(EMPTY_VERIFIER_RESULT);

    try {
      await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });
      expect.unreachable("expected runGenerate to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("alertQuality");
    }
  });

  it("requires --owner", async () => {
    const { options } = makeDb();
    await expect(cli.runGenerate({ period: PERIOD }, options)).rejects.toThrow(/--owner/);
  });

  it("requires --period", async () => {
    const { options } = makeDb();
    await expect(cli.runGenerate({ owner: OWNER_A }, options)).rejects.toThrow(/--period/);
  });

  it("rejects a malformed --period", async () => {
    const { options } = makeDb();
    await expect(cli.runGenerate({ owner: OWNER_A, period: "2026/07" }, options)).rejects.toThrow(/YYYY-MM/);
  });

  it("rejects an unknown owner", async () => {
    const { options } = makeDb();
    await expect(cli.runGenerate({ owner: "member_ghost", period: PERIOD }, options)).rejects.toThrow(/成员不存在/);
  });

  it("rejects a revoked owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A, "revoked");
    await expect(cli.runGenerate({ owner: OWNER_A, period: PERIOD }, options)).rejects.toThrow(/已被吊销/);
  });

  it("re-generating the same owner/period overwrites the prior DRAFT (upsert, not a second row)", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);

    const first = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });
    const second = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    expect(second.review.id).toBe(first.review.id);
    expect(new MonthlyReviewRepository(db).listForOwner(OWNER_A)).toHaveLength(1);
  });
});

// ===========================================================================
// generate-all
// ===========================================================================

describe("generate-all", () => {
  it("generates a draft for every ACTIVE member, skipping revoked ones", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A, "active");
    seedMember(db, OWNER_B, "revoked");

    const result = await cli.runGenerateAll({ period: PERIOD }, { ...options, now: NOW });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.generated).toBe(1);
    expect(result.results).toEqual([{ ownerId: OWNER_A, ok: true, reviewId: expect.any(String) }]);
    expect(new MonthlyReviewRepository(db).getByOwnerPeriod(OWNER_A, PERIOD)).not.toBeNull();
    expect(new MonthlyReviewRepository(db).getByOwnerPeriod(OWNER_B, PERIOD)).toBeNull();
  });

  it("defaults to the PREVIOUS Beijing calendar month when --period is omitted", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);

    // 2026-08-02T01:00:00Z is 2026-08-02 09:00 Beijing time -> previous month is 2026-07.
    const result = await cli.runGenerateAll({}, { ...options, now: "2026-08-02T01:00:00.000Z" });

    expect(result.period).toBe("2026-07");
    expect(new MonthlyReviewRepository(db).getByOwnerPeriod(OWNER_A, "2026-07")).not.toBeNull();
  });

  it("one owner's failure does not abort the rest of the batch", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    seedMember(db, OWNER_B);

    // Pre-seed and CONFIRM owner B's review for this period - a later
    // generate-all attempt for the SAME (owner, period) must fail at
    // upsertDraft (confirmed reviews refuse a silent overwrite), while owner
    // A - untouched - must still succeed.
    const bDraft = new MonthlyReviewRepository(db).upsertDraft({ ownerId: OWNER_B, period: PERIOD, resultJson: {} });
    new MonthlyReviewRepository(db).confirm(bDraft.id, OWNER_B);

    const result = await cli.runGenerateAll({ period: PERIOD }, { ...options, now: NOW });

    expect(result.total).toBe(2);
    expect(result.generated).toBe(1);
    const byOwner = Object.fromEntries(result.results.map((r: { ownerId: string; ok: boolean }) => [r.ownerId, r.ok]));
    expect(byOwner[OWNER_A]).toBe(true);
    expect(byOwner[OWNER_B]).toBe(false);
    const failure = result.results.find((r: { ownerId: string }) => r.ownerId === OWNER_B);
    expect(failure.error).toMatch(/already confirmed/);
  });
});

// ===========================================================================
// confirm
// ===========================================================================

describe("confirm", () => {
  it("confirms a draft, mirrors to memoryd as type=decision, and notifies Feishu - all fire-and-forget", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    const generated = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });
    const { backend, calls } = fakeMemorydBackend();
    const feishuNotifier = vi.fn(async () => ({ ok: true, messageId: "om_1" }));

    const result = await cli.runConfirm(
      { owner: OWNER_A, review: generated.review.id },
      { ...options, memorydBackend: backend, feishuNotifier }
    );

    expect(result.ok).toBe(true);
    expect(result.review.status).toBe("confirmed");
    expect(result.review.confirmedAt).toBeDefined();
    expect(result.mirror.mirrored).toBe(true);
    expect(result.notify.delivered).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("decision"); // MEMORYD_TYPE_BY_RECORD.monthly_review -> decision
    expect(calls[0].tags).toContain("record:monthly_review");
    expect(calls[0].tags).toContain("visibility:private");

    expect(feishuNotifier).toHaveBeenCalledTimes(1);
    const notifierArgs = feishuNotifier.mock.calls[0][0];
    expect(notifierArgs.ownerId).toBe(OWNER_A);
    expect(notifierArgs.title).toContain(PERIOD);

    const persisted = new MonthlyReviewRepository(db).getById(generated.review.id);
    expect(persisted?.status).toBe("confirmed");

    const rows = auditRows(db, "confirm");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.mirrored).toBe(true);
    expect(payload.notified).toBe(true);
  });

  it("owner-gate: a non-owner confirm attempt is refused and the review stays draft", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    seedMember(db, OWNER_B);
    const generated = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    await expect(cli.runConfirm({ owner: OWNER_B, review: generated.review.id }, options)).rejects.toThrow(/not owned by/i);

    const persisted = new MonthlyReviewRepository(db).getById(generated.review.id);
    expect(persisted?.status).toBe("draft");
  });

  it("a throwing memoryd backend does NOT fail confirm - the status change stands regardless", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    const generated = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    const result = await cli.runConfirm(
      { owner: OWNER_A, review: generated.review.id },
      { ...options, memorydBackend: throwingBackend("memoryd unreachable (fake)"), feishuNotifier: vi.fn(async () => ({ ok: true })) }
    );

    expect(result.ok).toBe(true);
    expect(result.review.status).toBe("confirmed");
    expect(result.mirror.mirrored).toBe(false);
    expect(result.mirror.reason).toMatch(/memoryd unreachable/);

    const persisted = new MonthlyReviewRepository(db).getById(generated.review.id);
    expect(persisted?.status).toBe("confirmed");
  });

  it("a throwing Feishu notifier does NOT fail confirm either", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    const generated = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    const result = await cli.runConfirm(
      { owner: OWNER_A, review: generated.review.id },
      { ...options, memorydBackend: fakeMemorydBackend().backend, feishuNotifier: throwingBackend("feishu unreachable (fake)") }
    );

    expect(result.ok).toBe(true);
    expect(result.review.status).toBe("confirmed");
    expect(result.notify.delivered).toBe(false);
    expect(result.notify.reason).toMatch(/feishu unreachable/);
  });

  it("the PRODUCTION default (no memorydBackend/feishuNotifier injected) degrades gracefully too - both are P10-gated placeholders", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    const generated = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    const result = await cli.runConfirm({ owner: OWNER_A, review: generated.review.id }, options);

    expect(result.ok).toBe(true);
    expect(result.review.status).toBe("confirmed");
    expect(result.mirror.mirrored).toBe(false);
    expect(result.notify.delivered).toBe(false);
  });

  it("is idempotent: confirming an already-confirmed review a second time does not throw and stays confirmed", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    const generated = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    await cli.runConfirm({ owner: OWNER_A, review: generated.review.id }, options);
    const second = await cli.runConfirm({ owner: OWNER_A, review: generated.review.id }, options);

    expect(second.ok).toBe(true);
    expect(second.review.status).toBe("confirmed");
  });

  it("rejects an unknown review id", async () => {
    const { options } = makeDb();
    await expect(cli.runConfirm({ owner: OWNER_A, review: "monthly_review_ghost" }, options)).rejects.toThrow(/not found/);
  });
});

// ===========================================================================
// list / show
// ===========================================================================

describe("list", () => {
  it("returns only the requesting owner's own reviews", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    seedMember(db, OWNER_B);
    await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });
    await cli.runGenerate({ owner: OWNER_B, period: PERIOD }, { ...options, now: NOW });

    const result = await cli.runList({ owner: OWNER_A }, options);

    expect(result.ok).toBe(true);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].ownerId).toBe(OWNER_A);
  });
});

describe("show", () => {
  it("returns the review when the caller is its owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    const generated = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    const result = await cli.runShow({ owner: OWNER_A, review: generated.review.id }, options);

    expect(result.ok).toBe(true);
    expect(result.review.id).toBe(generated.review.id);
  });

  it("owner isolation: B cannot show A's review", async () => {
    const { db, options } = makeDb();
    seedMember(db, OWNER_A);
    seedMember(db, OWNER_B);
    const generated = await cli.runGenerate({ owner: OWNER_A, period: PERIOD }, { ...options, now: NOW });

    await expect(cli.runShow({ owner: OWNER_B, review: generated.review.id }, options)).rejects.toThrow(/非本人操作被拒/);
  });

  it("rejects an unknown review id", async () => {
    const { options } = makeDb();
    await expect(cli.runShow({ owner: OWNER_A, review: "monthly_review_ghost" }, options)).rejects.toThrow(/复盘不存在/);
  });
});

// ===========================================================================
// dispatch / flags
// ===========================================================================

describe("dispatch", () => {
  it("rejects an unknown subcommand", async () => {
    const { options } = makeDb();
    await expect(cli.runReviewsCommand("bogus", {}, options)).rejects.toThrow(/未知子命令/);
  });

  it("parseFlags rejects a flag not allowlisted for the given subcommand", () => {
    expect(() => cli.parseFlags(["--review", "x"], "generate")).toThrow(/未知参数/);
  });

  it("buildCliResult returns a single ok:false envelope (never a raw throw) for a bad command", async () => {
    const result = await cli.buildCliResult(["bogus"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });
});
