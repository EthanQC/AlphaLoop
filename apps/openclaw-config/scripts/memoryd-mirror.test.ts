// Phase 7 Task 2 (2026-07-15 plan): memoryd 镜像后端. Every test here injects
// a fake `backend` - zero real network/HTTP calls anywhere in this file,
// matching narrative-engine.test.ts / news-agent-search.test.ts's "every
// test injects a fake" convention for the same injectable-backend shape.
import { afterEach, describe, expect, it, vi } from "vitest";

const memorydMirror = await import("./memoryd-mirror.mjs");

// ===========================================================================
// scopeForOwner: deterministic per-owner scope derivation
// ===========================================================================

describe("scopeForOwner", () => {
  it("derives a deterministic scope string from an ownerId", () => {
    expect(memorydMirror.scopeForOwner("member_abc123")).toBe("alphaloop-member-member_abc123");
  });

  it("returns the SAME scope for the same ownerId across repeated calls", () => {
    const first = memorydMirror.scopeForOwner("owner_1");
    const second = memorydMirror.scopeForOwner("owner_1");
    expect(first).toBe(second);
  });

  it("derives DIFFERENT scopes for different owners (no cross-owner collision)", () => {
    const a = memorydMirror.scopeForOwner("owner_1");
    const b = memorydMirror.scopeForOwner("owner_2");
    expect(a).not.toBe(b);
  });
});

// ===========================================================================
// MEMORYD_TYPE_BY_RECORD: record type -> memoryd mem_save type mapping
// ===========================================================================

describe("MEMORYD_TYPE_BY_RECORD", () => {
  it("maps strategy_card -> playbook, discipline_rule -> warning, thesis/thesis_judgment/monthly_review -> decision", () => {
    expect(memorydMirror.MEMORYD_TYPE_BY_RECORD).toEqual({
      strategy_card: "playbook",
      discipline_rule: "warning",
      thesis: "decision",
      thesis_judgment: "decision",
      monthly_review: "decision"
    });
  });
});

// ===========================================================================
// mirrorRecord: type mapping (via the tags/backend call it drives)
// ===========================================================================

describe("mirrorRecord: type mapping", () => {
  function captureBackend() {
    const calls: unknown[] = [];
    const backend = vi.fn(async (args: unknown) => {
      calls.push(args);
      return { ok: true, memoryId: "mem_1" };
    });
    return { backend, calls };
  }

  it.each([
    ["strategy_card", "playbook"],
    ["discipline_rule", "warning"],
    ["thesis", "decision"],
    ["thesis_judgment", "decision"]
  ])("maps recordType=%s to memoryd type=%s", async (recordType, expectedType) => {
    const { backend, calls } = captureBackend();
    await memorydMirror.mirrorRecord(backend, {
      ownerId: "owner_1",
      recordType,
      title: "title",
      content: "content",
      visibility: "system"
    });
    expect((calls[0] as { type: string }).type).toBe(expectedType);
  });

  it("falls back to 'fact' for an unknown/unrecognized record type (never throws)", async () => {
    const { backend, calls } = captureBackend();
    await expect(
      memorydMirror.mirrorRecord(backend, {
        ownerId: "owner_1",
        recordType: "some_future_record_type",
        title: "title",
        content: "content",
        visibility: "system"
      })
    ).resolves.toBeDefined();
    expect((calls[0] as { type: string }).type).toBe("fact");
  });
});

// ===========================================================================
// mirrorRecord: tags carry visibility + record type
// ===========================================================================

describe("mirrorRecord: tags", () => {
  it("includes visibility:<v> and record:<recordType> in the tags passed to the backend", async () => {
    const calls: unknown[] = [];
    const backend = vi.fn(async (args: unknown) => {
      calls.push(args);
      return { ok: true, memoryId: "mem_1" };
    });

    await memorydMirror.mirrorRecord(backend, {
      ownerId: "owner_1",
      recordType: "strategy_card",
      title: "趋势跟随",
      content: "场景...",
      visibility: "public"
    });

    const { tags } = calls[0] as { tags: string[] };
    expect(tags).toContain("visibility:public");
    expect(tags).toContain("record:strategy_card");
  });

  it("scopes the backend call to the owner via scopeForOwner", async () => {
    const calls: unknown[] = [];
    const backend = vi.fn(async (args: unknown) => {
      calls.push(args);
      return { ok: true, memoryId: "mem_1" };
    });

    await memorydMirror.mirrorRecord(backend, {
      ownerId: "owner_9",
      recordType: "thesis",
      title: "t",
      content: "c",
      visibility: "system"
    });

    const { scope } = calls[0] as { scope: string };
    expect(scope).toBe(memorydMirror.scopeForOwner("owner_9"));
  });
});

// ===========================================================================
// mirrorRecord: fire-and-forget contract - NEVER throws
// ===========================================================================

describe("mirrorRecord: fire-and-forget contract", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    warnSpy.mockClear();
  });

  it("a backend that THROWS -> mirrorRecord resolves {mirrored:false} and does NOT throw/reject", async () => {
    const backend = vi.fn(async () => {
      throw new Error("memoryd unreachable (ECONNREFUSED)");
    });

    let threw = false;
    let result: unknown;
    try {
      result = await memorydMirror.mirrorRecord(backend, {
        ownerId: "owner_1",
        recordType: "thesis",
        title: "t",
        content: "c",
        visibility: "system"
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toMatchObject({ mirrored: false });
    expect((result as { reason: string }).reason).toMatch(/memoryd unreachable/);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("a backend that SYNCHRONOUSLY throws (not even a promise) -> still does not throw", async () => {
    const backend = () => {
      throw new Error("synchronous boom");
    };

    let threw = false;
    let result: unknown;
    try {
      // @ts-expect-error - deliberately not async, exercising the sync-throw path
      result = await memorydMirror.mirrorRecord(backend, {
        ownerId: "owner_1",
        recordType: "thesis",
        title: "t",
        content: "c",
        visibility: "system"
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toMatchObject({ mirrored: false });
  });

  it("a backend returning {ok:false} -> {mirrored:false, reason} (no throw)", async () => {
    const backend = vi.fn(async () => ({ ok: false, reason: "memoryd 磁盘写满" }));

    const result = await memorydMirror.mirrorRecord(backend, {
      ownerId: "owner_1",
      recordType: "discipline_rule",
      title: "t",
      content: "c",
      visibility: "system"
    });

    expect(result).toEqual({ mirrored: false, reason: "memoryd 磁盘写满" });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("a well-behaved fake backend -> {mirrored:true, memoryId}", async () => {
    const backend = vi.fn(async () => ({ ok: true, memoryId: "mem_42" }));

    const result = await memorydMirror.mirrorRecord(backend, {
      ownerId: "owner_1",
      recordType: "strategy_card",
      title: "t",
      content: "c",
      visibility: "public"
    });

    expect(result).toEqual({ mirrored: true, memoryId: "mem_42" });
  });
});

// ===========================================================================
// createMemorydBackend: documented P10 wiring point
// ===========================================================================

describe("createMemorydBackend", () => {
  it("returns a function that always throws/rejects with the documented P10-gate message", async () => {
    const backend = memorydMirror.createMemorydBackend();
    await expect(
      backend({ scope: "alphaloop-member-owner_1", type: "fact", title: "t", content: "c", tags: [] })
    ).rejects.toThrow(
      "memoryd backend requires P10 ignition (dedicated MEMORYD_DATA_ROOT instance, loopback HTTP API, per-owner scope)"
    );
  });

  it("the real backend, when injected into mirrorRecord, degrades to {mirrored:false} rather than throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = memorydMirror.createMemorydBackend();

    const result = await memorydMirror.mirrorRecord(backend, {
      ownerId: "owner_1",
      recordType: "thesis",
      title: "t",
      content: "c",
      visibility: "system"
    });

    expect(result.mirrored).toBe(false);
    expect(result.reason).toMatch(/P10 ignition/);
    warnSpy.mockRestore();
  });
});
