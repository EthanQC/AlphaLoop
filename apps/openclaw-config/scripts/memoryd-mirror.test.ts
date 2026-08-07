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

  it("encodes path separators and unicode so an owner id cannot escape its scope directory", () => {
    expect(memorydMirror.scopeForOwner("team/../../别的成员"))
      .toBe("alphaloop-member-team%2F..%2F..%2F%E5%88%AB%E7%9A%84%E6%88%90%E5%91%98");
  });

  it("remains total for malformed imported Unicode instead of breaking the SQL-first path", () => {
    expect(() => memorydMirror.scopeForOwner("legacy-\uD800-owner")).not.toThrow();
    expect(memorydMirror.scopeForOwner("legacy-\uD800-owner"))
      .toBe("alphaloop-member-legacy-%EF%BF%BD-owner");
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
      // `backend` is deliberately not async, exercising the sync-throw path.
      // (mirrorRecord comes from plain .mjs, so its parameter is inferred and
      // accepts this - no @ts-expect-error to satisfy.)
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
// createMemorydBackend: real loopback MCP transport
// ===========================================================================

describe("createMemorydBackend", () => {
  function sse(payload: unknown, sessionId = "session-1") {
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "mcp-session-id": sessionId
      }
    });
  }

  it("initializes MCP, calls mem_save with the exact record, and closes the session", async () => {
    const requests: Array<{ method: string; body: any; sessionId: string | null; protocolVersion: string | null }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      requests.push({
        method: String(init.method),
        body,
        sessionId: new Headers(init.headers).get("mcp-session-id"),
        protocolVersion: new Headers(init.headers).get("mcp-protocol-version")
      });
      if (init.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      if (body?.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "memoryd", version: "3.3.1" } }
        });
      }
      if (body?.method === "notifications/initialized") {
        return new Response(null, { status: 202, headers: { "mcp-session-id": "session-1" } });
      }
      return sse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: "saved" }],
          structuredContent: { ok: true, memory_id: "mem-real-1" },
          isError: false
        }
      });
    });
    const backend = memorydMirror.createMemorydBackend({ fetchImpl });
    const input = {
      scope: "alphaloop-member-owner_1",
      type: "decision",
      title: "t",
      content: "c",
      tags: ["visibility:system"]
    };

    await expect(backend(input)).resolves.toEqual({ ok: true, memoryId: "mem-real-1" });
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(requests[2]).toMatchObject({
      sessionId: "session-1",
      protocolVersion: "2025-06-18",
      body: { method: "tools/call", params: { name: "mem_save", arguments: input } }
    });
    expect(requests.slice(1).every((request) => request.protocolVersion === "2025-06-18")).toBe(true);
  });

  it("rejects an initialize response that negotiates an unsupported protocol version", async () => {
    const backend = memorydMirror.createMemorydBackend({
      fetchImpl: vi.fn(async (_url: string, init: RequestInit = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        if (body?.method === "initialize") {
          return sse({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2024-11-05", serverInfo: { name: "memoryd" } }
          });
        }
        return new Response(null, { status: 200 });
      })
    });

    await expect(backend({ scope: "scope", type: "fact", title: "title", content: "content", tags: [] }))
      .rejects.toThrow(/initialize response was invalid/);
  });

  it("bounds an initialize response whose headers arrive but body never completes", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "mcp-session-id": "hanging-body" }),
        text: () => new Promise<string>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        })
      } as Response;
    });
    const backend = memorydMirror.createMemorydBackend({ fetchImpl, timeoutMs: 25 });

    const outcome = await Promise.race([
      backend({ scope: "scope", type: "fact", title: "title", content: "content", tags: [] })
        .then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 250))
    ]);

    expect(outcome).toBe("rejected");
  });

  it("refuses a non-loopback endpoint before making any request", async () => {
    const fetchImpl = vi.fn();
    expect(() => memorydMirror.createMemorydBackend({ url: "https://memory.example.com/mcp", fetchImpl }))
      .toThrow(/loopback/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a protocol failure still degrades through mirrorRecord without unwinding SQL", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = memorydMirror.createMemorydBackend({
      fetchImpl: vi.fn(async () => new Response("not an MCP event", { status: 200 }))
    });

    const result = await memorydMirror.mirrorRecord(backend, {
      ownerId: "owner_1",
      recordType: "thesis",
      title: "t",
      content: "c",
      visibility: "system"
    });

    expect(result.mirrored).toBe(false);
    expect(result.reason).toMatch(/MCP/);
    warnSpy.mockRestore();
  });
});
