// P10 ignition: unit tests for the shared OpenClaw gateway client. Every test
// drives a fake `fetchImpl`/config — zero real network. Real-call smoke is the
// controller's job on the mini via each engine's `smoke` entrypoint.
import { describe, expect, it, vi } from "vitest";

const gateway = await import("./_openclaw-gateway.mjs");

// A minimal fake `Response` matching the subset the client reads.
function fakeResponse({ status = 200, json, text }: { status?: number; json?: unknown; text?: string }) {
  return {
    status,
    async json() {
      if (json === undefined) {
        throw new Error("not json");
      }
      return json;
    },
    async text() {
      return text ?? (json !== undefined ? JSON.stringify(json) : "");
    }
  };
}

function chatPayload(content: unknown) {
  return { choices: [{ message: { content } }] };
}

const TOKEN = "secret-tok-abc123";

function configWith(overrides: Record<string, unknown> = {}) {
  return { url: "http://127.0.0.1:18789", token: TOKEN, agent: "openclaw/default", model: null, ...overrides };
}

// ===========================================================================
// resolveGatewayConfig
// ===========================================================================

describe("resolveGatewayConfig", () => {
  it("prefers OPENCLAW_GATEWAY_TOKEN env over the config file and never reads the file", () => {
    const readFile = vi.fn(() => {
      throw new Error("should not be read");
    });
    const cfg = gateway.resolveGatewayConfig({ env: { OPENCLAW_GATEWAY_TOKEN: "env-token" }, readFile });
    expect(cfg.token).toBe("env-token");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back to gateway.auth.token in ~/.openclaw/openclaw.json when no env token", () => {
    const readFile = vi.fn(() => JSON.stringify({ gateway: { auth: { mode: "token", token: "file-token" } } }));
    const cfg = gateway.resolveGatewayConfig({ env: {}, readFile, configPath: "/fake/openclaw.json" });
    expect(cfg.token).toBe("file-token");
    expect(readFile).toHaveBeenCalledWith("/fake/openclaw.json", "utf8");
  });

  it("also accepts gateway.auth.password from the config file", () => {
    const readFile = vi.fn(() => JSON.stringify({ gateway: { auth: { mode: "password", password: "file-pw" } } }));
    const cfg = gateway.resolveGatewayConfig({ env: {}, readFile });
    expect(cfg.token).toBe("file-pw");
  });

  it("returns an empty token (not a throw) when the config file is missing/unparseable", () => {
    const readFile = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const cfg = gateway.resolveGatewayConfig({ env: {}, readFile });
    expect(cfg.token).toBe("");
  });

  it("strips a trailing slash from the url and honors agent/model overrides", () => {
    const cfg = gateway.resolveGatewayConfig({
      env: {
        OPENCLAW_GATEWAY_URL: "http://host:9999/",
        OPENCLAW_GATEWAY_TOKEN: "t",
        OPENCLAW_GATEWAY_AGENT: "openclaw/research",
        OPENCLAW_GATEWAY_MODEL: "codex/gpt-5.5"
      },
      readFile: () => "{}"
    });
    expect(cfg.url).toBe("http://host:9999");
    expect(cfg.agent).toBe("openclaw/research");
    expect(cfg.model).toBe("codex/gpt-5.5");
  });

  it("defaults url and agent to the loopback gateway and the stable default-agent alias", () => {
    const cfg = gateway.resolveGatewayConfig({ env: { OPENCLAW_GATEWAY_TOKEN: "t" }, readFile: () => "{}" });
    expect(cfg.url).toBe("http://127.0.0.1:18789");
    expect(cfg.agent).toBe("openclaw/default");
    expect(cfg.model).toBeNull();
  });
});

// ===========================================================================
// createGatewayClient.complete — request shaping
// ===========================================================================

describe("createGatewayClient.complete request shaping", () => {
  it("POSTs to /v1/chat/completions with bearer auth, a system+user message, and NO session/user field", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: chatPayload("hello") }));
    const client = gateway.createGatewayClient({ config: configWith(), fetchImpl });

    const out = await client.complete({ prompt: "hi", system: "be terse" });
    expect(out).toBe("hello");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:18789/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe("openclaw/default");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" }
    ]);
    // Statelessness = isolation from the control conversation: no `user`, no session key.
    expect(body.user).toBeUndefined();
    expect(init.headers["x-openclaw-session-key"]).toBeUndefined();
  });

  it("sends x-openclaw-model only when a model override is configured", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: chatPayload("ok") }));
    const client = gateway.createGatewayClient({ config: configWith({ model: "codex/gpt-5.5" }), fetchImpl });
    await client.complete({ prompt: "hi" });
    expect(fetchImpl.mock.calls[0][1].headers["x-openclaw-model"]).toBe("codex/gpt-5.5");
  });

  it("collapses OpenAI content-parts arrays into a single string", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: chatPayload([{ type: "text", text: "part-a " }, { type: "text", text: "part-b" }]) }));
    const client = gateway.createGatewayClient({ config: configWith(), fetchImpl });
    await expect(client.complete({ prompt: "hi" })).resolves.toBe("part-a part-b");
  });
});

// ===========================================================================
// createGatewayClient.complete — failure modes + token hygiene
// ===========================================================================

describe("createGatewayClient.complete failure modes", () => {
  it("throws a missing-token error (no network call) when no token is resolved", async () => {
    const fetchImpl = vi.fn();
    const client = gateway.createGatewayClient({ config: configWith({ token: "" }), fetchImpl });
    await expect(client.complete({ prompt: "hi" })).rejects.toThrow(/missing gateway token/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on an empty prompt", async () => {
    const client = gateway.createGatewayClient({ config: configWith(), fetchImpl: vi.fn() });
    await expect(client.complete({ prompt: "   " })).rejects.toThrow(/empty prompt/);
  });

  it("maps a non-2xx response to a sanitized error and NEVER leaks the token", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 500, text: `boom for Bearer ${TOKEN}` }));
    const client = gateway.createGatewayClient({ config: configWith(), fetchImpl });
    const err = await client.complete({ prompt: "hi" }).catch((e: Error) => e);
    expect(String(err.message)).toContain("HTTP 500");
    expect(String(err.message)).not.toContain(TOKEN);
    expect(String(err.message)).toContain("[REDACTED]");
  });

  it("maps an aborted/timed-out request to a timeout error", async () => {
    const fetchImpl = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const client = gateway.createGatewayClient({ config: configWith(), fetchImpl });
    await expect(client.complete({ prompt: "hi", timeoutMs: 15 })).rejects.toThrow(/timed out after 15ms/);
  });

  it("maps a transport error to a sanitized error and never leaks the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`ECONNREFUSED while using Bearer ${TOKEN}`);
    });
    const client = gateway.createGatewayClient({ config: configWith(), fetchImpl });
    const err = await client.complete({ prompt: "hi" }).catch((e: Error) => e);
    expect(String(err.message)).toContain("openclaw gateway");
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it("throws when the response body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 200 })); // json() throws
    const client = gateway.createGatewayClient({ config: configWith(), fetchImpl });
    await expect(client.complete({ prompt: "hi" })).rejects.toThrow(/not valid JSON/);
  });

  it("throws on an empty completion", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: chatPayload("   ") }));
    const client = gateway.createGatewayClient({ config: configWith(), fetchImpl });
    await expect(client.complete({ prompt: "hi" })).rejects.toThrow(/empty completion/);
  });
});

// ===========================================================================
// extractResultsArray
// ===========================================================================

describe("extractResultsArray", () => {
  it("parses a bare JSON array", () => {
    expect(gateway.extractResultsArray('[{"url":"u"}]')).toEqual([{ url: "u" }]);
  });

  it("parses a { results: [...] } envelope", () => {
    expect(gateway.extractResultsArray('{"results":[{"url":"u"}]}')).toEqual([{ url: "u" }]);
  });

  it("parses an empty array as an honest empty result (no throw)", () => {
    expect(gateway.extractResultsArray("[]")).toEqual([]);
  });

  it("strips a ```json code fence", () => {
    expect(gateway.extractResultsArray('```json\n[{"url":"u"}]\n```')).toEqual([{ url: "u" }]);
  });

  it("recovers an array embedded in explanatory prose", () => {
    expect(gateway.extractResultsArray('这是结果：[{"url":"u"}] 以上。')).toEqual([{ url: "u" }]);
  });

  it("throws when there is no JSON array at all (degrade trigger, never fabricate)", () => {
    expect(() => gateway.extractResultsArray("对不起，我无法完成检索。")).toThrow(/openclaw gateway/);
  });

  it("throws on empty/blank text", () => {
    expect(() => gateway.extractResultsArray("   ")).toThrow(/openclaw gateway/);
  });
});

// ===========================================================================
// parseSmokeArgs
// ===========================================================================

describe("parseSmokeArgs", () => {
  it("parses --flag value pairs and treats a valueless flag as true", () => {
    expect(gateway.parseSmokeArgs(["--query", "AAPL 最新", "--verbose"])).toEqual({ query: "AAPL 最新", verbose: true });
  });
});
