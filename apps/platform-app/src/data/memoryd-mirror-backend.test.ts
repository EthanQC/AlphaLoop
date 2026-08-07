import { describe, expect, it, vi } from "vitest";

import { createMemorydBackend } from "./memoryd-mirror.js";

function sse(payload: unknown, sessionId = "session-ts") {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "mcp-session-id": sessionId
    }
  });
}

describe("platform memoryd MCP backend", () => {
  it("uses the real mem_save Streamable HTTP exchange", async () => {
    const requests: Array<{ method: string; protocolVersion: string | null }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({
        method: String(init.method),
        protocolVersion: new Headers(init.headers).get("mcp-protocol-version")
      });
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      if (body?.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "memoryd" } }
        });
      }
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      return sse({
        jsonrpc: "2.0",
        id: 2,
        result: { structuredContent: { ok: true, memory_id: "mem-ts-1" }, isError: false }
      });
    });
    const backend = createMemorydBackend({ fetchImpl });

    await expect(backend({
      scope: "alphaloop-member-1",
      type: "decision",
      title: "title",
      content: "content",
      tags: ["record:thesis"]
    })).resolves.toEqual({ ok: true, memoryId: "mem-ts-1" });
    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(requests.slice(1).every(({ protocolVersion }) => protocolVersion === "2025-06-18")).toBe(true);
  });

  it("bounds an initialize response whose headers arrive but body never completes", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
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
    const backend = createMemorydBackend({ fetchImpl, timeoutMs: 25 });

    const outcome = await Promise.race([
      backend({ scope: "scope", type: "fact", title: "title", content: "content", tags: [] })
        .then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 250))
    ]);

    expect(outcome).toBe("rejected");
  });

  it("rejects non-loopback URLs", () => {
    expect(() => createMemorydBackend({ url: "http://10.0.0.8:8766/mcp" })).toThrow(/loopback/);
  });
});
