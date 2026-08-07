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
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      methods.push(String(init.method));
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      if (body?.method === "initialize") {
        return sse({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "memoryd" } } });
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
    expect(methods).toEqual(["POST", "POST", "POST", "DELETE"]);
  });

  it("rejects non-loopback URLs", () => {
    expect(() => createMemorydBackend({ url: "http://10.0.0.8:8766/mcp" })).toThrow(/loopback/);
  });
});
