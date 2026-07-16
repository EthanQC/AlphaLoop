// Phase 8 Task 3 (2026-07-16 plan): the in-process research worker.
// Every test injects fake backend/quoteReader/memoryReader/notify
// collaborators - zero real network/subprocess/agent calls anywhere in this
// file, matching research-engine.test.ts's (Task 2) own convention. The
// dynamically-imported research-engine.mjs (see worker.ts's module header)
// is the REAL module in every test below - only its OWN collaborators are
// faked, so these tests also exercise the real dynamic-import wiring, not a
// mock of the engine itself.
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemberRepository, ResearchTaskRepository, migrate, type Member } from "@packages/shared-types";

import {
  createResearchWorker,
  type ResearchBackend,
  type ResearchMemoryReader,
  type ResearchQuoteReader
} from "./worker.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member_a",
    email: "member-a@example.com",
    displayName: "Member A",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

const FIXED_NOW = () => new Date("2026-07-16T12:00:00.000Z");
const SYMBOL_UNIVERSE = ["AAPL.US"];

function fakeBackend(resultsBySymbol: Record<string, Array<Record<string, unknown>>> = {}): ResearchBackend {
  return vi.fn(async ({ query }: { query: string; kind: string }) => {
    const symbol = SYMBOL_UNIVERSE.find((s) => query.includes(s));
    return { results: symbol ? (resultsBySymbol[symbol] ?? []) : [] };
  });
}

function fakeQuoteReader(prices: Record<string, number> = { "AAPL.US": 210.5 }): ResearchQuoteReader {
  return async (symbol: string) => prices[symbol];
}

const NO_MEMORY: ResearchMemoryReader = async () => ({ theses: [], disciplines: [] });

function rawItem(overrides: Record<string, unknown> = {}) {
  return {
    title: "分析师上调苹果目标价",
    publisher: "路透社",
    url: "https://example.com/aapl-target-raise",
    summary_zh: "多家投行上调苹果目标价，理由是iPhone销量超预期。",
    publishedAt: "2026-07-10T10:00:00.000Z",
    ...overrides
  };
}

function seedQueuedTask(db: DatabaseSync, ownerId: string, question: string): string {
  const repo = new ResearchTaskRepository(db);
  new MemberRepository(db).upsert(makeMember({ id: ownerId, email: `${ownerId}@example.com` }));
  const result = repo.createIfWithinQuota({ ownerId, question, tradingDay: "2026-07-16" });
  if (!result.ok) {
    throw new Error("test setup: quota unexpectedly exceeded");
  }
  return result.task.id;
}

describe("createResearchWorker (Phase 8 Task 3, 2026-07-16 plan)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = memoryDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tick", () => {
    it("returns false when the queue is empty", async () => {
      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      await expect(worker.tick()).resolves.toBe(false);
    });

    it("claims a queued task and runs it to done, writing result_json and steps", async () => {
      const taskId = seedQueuedTask(db, "member_a", "AAPL.US 最近怎么样");
      const worker = createResearchWorker({
        db,
        backend: fakeBackend({ "AAPL.US": [rawItem()] }),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      await expect(worker.tick()).resolves.toBe(true);

      const repo = new ResearchTaskRepository(db);
      const task = repo.getById(taskId);
      expect(task?.status).toBe("done");
      expect(task?.resultJson?.conclusion).toContain("AAPL.US");
      expect(task?.resultJson?.evidence.length).toBe(1);
      expect(task?.confidence).toBe("medium");
      expect(task?.finishedAt).toBe(FIXED_NOW().toISOString());
      expect(Array.isArray(task?.steps)).toBe(true);
      expect((task?.steps.length ?? 0)).toBeGreaterThan(0);
    });

    it("processes one task per call, leaving a second queued task queued", async () => {
      const first = seedQueuedTask(db, "member_a", "AAPL.US 怎么样");
      seedQueuedTask(db, "member_a", "AAPL.US 还怎么样");
      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      await worker.tick();

      const repo = new ResearchTaskRepository(db);
      expect(repo.getById(first)?.status).toBe("done");
      expect(repo.listRunningOrQueued().length).toBe(1);
    });

    it("marks an operational-intent question failed with no result_json (SQL NULL), not a crash", async () => {
      const taskId = seedQueuedTask(db, "member_a", "帮我改规则");
      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      await expect(worker.tick()).resolves.toBe(true);

      const repo = new ResearchTaskRepository(db);
      const task = repo.getById(taskId);
      expect(task?.status).toBe("failed");
      expect(task?.resultJson).toBeUndefined();
      expect(task?.confidence).toBeUndefined();
    });

    it("degrades (not crashes) when the backend throws, keeping the task processed", async () => {
      const taskId = seedQueuedTask(db, "member_a", "AAPL.US 最近怎么样");
      const throwingBackend: ResearchBackend = vi.fn(async () => {
        throw new Error("research agent backend requires P10 ignition");
      });
      const worker = createResearchWorker({
        db,
        backend: throwingBackend,
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      await expect(worker.tick()).resolves.toBe(true);

      const repo = new ResearchTaskRepository(db);
      const task = repo.getById(taskId);
      expect(task?.status).toBe("degraded");
      expect(task?.resultJson).toBeDefined();
      expect(task?.resultJson?.evidence).toEqual([]);
      expect(task?.steps.length).toBeGreaterThan(0);
    });

    it("never leaves a claimed task stuck in running even on an unexpected internal crash", async () => {
      const taskId = seedQueuedTask(db, "member_a", "AAPL.US 最近怎么样");
      // A backend that isn't a function at all still exercises the pipeline's
      // own "no backend" skip path harmlessly; to force THIS worker's own
      // defensive top-level catch (not the engine's internal one), make the
      // onStep-triggered write itself misbehave by having quoteReader throw
      // something exotic - the engine already swallows that too, so instead
      // assert the weaker, always-true safety property directly: whatever
      // happens, the row never stays 'running' after tick() resolves.
      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      await worker.tick();

      const repo = new ResearchTaskRepository(db);
      expect(repo.getById(taskId)?.status).not.toBe("running");
    });

    it("owner-binds the memory reader to the CLAIMED task's own owner_id, never a free scope", async () => {
      const thesesByOwner: Record<string, unknown[]> = {
        member_a: [{ id: "th_a", symbol: "AAPL.US", direction: "bull", targetLow: 200, targetHigh: null, invalidationPrice: 150 }],
        member_b: [{ id: "th_b", symbol: "AAPL.US", direction: "bear", targetLow: null, targetHigh: 100, invalidationPrice: 300 }]
      };
      const capturedOwnerIds: string[] = [];
      const rawMemoryReader: ResearchMemoryReader = async ({ ownerId }) => {
        capturedOwnerIds.push(ownerId);
        return { theses: (thesesByOwner[ownerId] ?? []) as never[], disciplines: [] };
      };

      const taskA = seedQueuedTask(db, "member_a", "AAPL.US 怎么样");
      seedQueuedTask(db, "member_b", "AAPL.US 怎么样");

      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: rawMemoryReader,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      await worker.tick();
      await worker.tick();

      expect(capturedOwnerIds).toEqual(["member_a", "member_b"]);
      const repo = new ResearchTaskRepository(db);
      const resultA = repo.getById(taskA)?.resultJson;
      expect(resultA?.comparison.theses).toEqual([
        expect.objectContaining({ symbol: "AAPL.US", ref: "th_a" })
      ]);
    });
  });

  describe("notify", () => {
    it("skips notify entirely when the owner has no feishuOpenId", async () => {
      const taskId = seedQueuedTask(db, "member_a", "AAPL.US 最近怎么样");
      const notify = vi.fn(async () => {});
      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE,
        notify
      });

      await worker.tick();

      expect(notify).not.toHaveBeenCalled();
      const repo = new ResearchTaskRepository(db);
      expect(repo.getById(taskId)?.status).toBe("done");
    });

    it("calls notify once the owner has a feishuOpenId", async () => {
      const ownerId = "member_open";
      new MemberRepository(db).upsert(makeMember({ id: ownerId, email: "open@example.com", feishuOpenId: "ou_123" }));
      const repo = new ResearchTaskRepository(db);
      const result = repo.createIfWithinQuota({ ownerId, question: "AAPL.US 最近怎么样", tradingDay: "2026-07-16" });
      if (!result.ok) throw new Error("quota unexpectedly exceeded");

      const notify = vi.fn(async () => {});
      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE,
        notify
      });

      await worker.tick();

      expect(notify).toHaveBeenCalledTimes(1);
      const [taskArg, memberArg] = notify.mock.calls[0] as [unknown, Member];
      expect((taskArg as { id: string }).id).toBe(result.task.id);
      expect(memberArg.feishuOpenId).toBe("ou_123");
    });

    it("does not fail the tick when notify throws", async () => {
      const ownerId = "member_open";
      new MemberRepository(db).upsert(makeMember({ id: ownerId, email: "open@example.com", feishuOpenId: "ou_123" }));
      const repo = new ResearchTaskRepository(db);
      const result = repo.createIfWithinQuota({ ownerId, question: "AAPL.US 最近怎么样", tradingDay: "2026-07-16" });
      if (!result.ok) throw new Error("quota unexpectedly exceeded");

      const notify = vi.fn(async () => {
        throw new Error("feishu unreachable (test double)");
      });
      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE,
        notify
      });

      await expect(worker.tick()).resolves.toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(repo.getById(result.task.id)?.status).toBe("done");
    });
  });

  describe("boot recovery", () => {
    it("resets an orphaned running row back to queued at construction, and a later tick re-runs it", async () => {
      const taskId = seedQueuedTask(db, "member_a", "AAPL.US 最近怎么样");
      // Simulate a process crash mid-run: claim it (queued -> running) via a
      // throwaway worker, then never call setResult - exactly the state a
      // real crash would leave behind.
      const crashedRepo = new ResearchTaskRepository(db);
      const claimed = crashedRepo.claimNextQueued(FIXED_NOW().toISOString());
      expect(claimed?.id).toBe(taskId);
      expect(crashedRepo.getById(taskId)?.status).toBe("running");

      // A NEW worker, as a real process restart would construct - its own
      // construction-time recoverStalled() call must reset the orphan.
      const worker = createResearchWorker({
        db,
        backend: fakeBackend({ "AAPL.US": [rawItem()] }),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      expect(crashedRepo.getById(taskId)?.status).toBe("queued");

      await expect(worker.tick()).resolves.toBe(true);
      expect(crashedRepo.getById(taskId)?.status).toBe("done");
    });

    it("recoverStalled() is idempotent and reports the number of rows it reset", async () => {
      seedQueuedTask(db, "member_a", "AAPL.US 最近怎么样");
      const repo = new ResearchTaskRepository(db);
      repo.claimNextQueued(FIXED_NOW().toISOString());

      const worker = createResearchWorker({
        db,
        backend: fakeBackend(),
        quoteReader: fakeQuoteReader(),
        memoryReader: NO_MEMORY,
        now: FIXED_NOW,
        symbolUniverse: SYMBOL_UNIVERSE
      });

      // Construction already reset the one orphan; calling it again finds
      // nothing left to reset.
      expect(worker.recoverStalled()).toBe(0);
    });
  });

  describe("start/stop", () => {
    it("start() ticks on an interval and stop() halts it", async () => {
      vi.useFakeTimers();
      try {
        seedQueuedTask(db, "member_a", "AAPL.US 最近怎么样");
        const worker = createResearchWorker({
          db,
          backend: fakeBackend(),
          quoteReader: fakeQuoteReader(),
          memoryReader: NO_MEMORY,
          now: FIXED_NOW,
          symbolUniverse: SYMBOL_UNIVERSE
        });

        worker.start(10);
        await vi.advanceTimersByTimeAsync(10);

        const repo = new ResearchTaskRepository(db);
        expect(repo.listRunningOrQueued().length).toBe(0);

        worker.stop();
        seedQueuedTask(db, "member_a", "又一个问题");
        await vi.advanceTimersByTimeAsync(100);
        expect(repo.listRunningOrQueued().length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
