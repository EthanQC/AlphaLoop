import { describe, expect, it } from "vitest";

import type { LongbridgeAdapter } from "./adapter.js";
import { main, type MainDeps } from "./main.js";

const CREDS_ENV = {
  LONGBRIDGE_APP_KEY: "test-app-key-value",
  LONGBRIDGE_APP_SECRET: "test-app-secret-value",
  LONGBRIDGE_ACCESS_TOKEN: "test-access-token-value"
};

function fakeAdapter(overrides: Partial<LongbridgeAdapter> = {}): LongbridgeAdapter {
  return {
    probe: async () => {},
    getQuotes: async (symbols) => symbols.map((symbol) => ({ symbol, lastDone: "1.00" })),
    getAssets: async () => [],
    getPositions: async () => [],
    getWatchlist: async () => [],
    getNews: async () => [],
    getFinanceCalendar: async () => [],
    getTodayOrders: async () => [],
    getTodayExecutions: async () => [],
    submitOrder: async () => ({ orderId: "1" }),
    getOrderDetail: async () => ({ orderId: "1", symbol: "X.US", side: "buy", status: "New" }),
    ...overrides
  };
}

function harness(adapter: LongbridgeAdapter, env: Record<string, string | undefined> = CREDS_ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: MainDeps = {
    env,
    fs: { readTextFile: () => undefined, listDir: () => undefined },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    createAdapterFactory: () => () => adapter
  };
  return { deps, out, err };
}

describe("main", () => {
  it("prints a single JSON document and exits 0 on success", async () => {
    const { deps, out, err } = harness(fakeAdapter());
    const code = await main(["quote", "QQQ.US", "--format", "json"], deps);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toEqual([{ symbol: "QQQ.US", last_done: "1.00" }]);
  });

  it("exits 2 with usage help on stderr for unknown commands, stdout stays empty", async () => {
    const { deps, out, err } = harness(fakeAdapter());
    const code = await main(["frobnicate", "--format", "json"], deps);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/frobnicate/);
  });

  it("exits 2 and names missing credential env vars without values", async () => {
    const { deps, out, err } = harness(fakeAdapter(), { LONGBRIDGE_APP_KEY: "only-key-here" });
    const code = await main(["assets", "--format", "json"], deps);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    const text = err.join("\n");
    expect(text).toContain("LONGBRIDGE_APP_SECRET");
    expect(text).not.toContain("only-key-here");
  });

  it("exits 1 with sanitized stderr when the SDK throws (secrets redacted)", async () => {
    const { deps, out, err } = harness(fakeAdapter({
      getAssets: async () => {
        throw new Error("openapi rejected token test-access-token-value via socket");
      }
    }));
    const code = await main(["assets", "--format", "json"], deps);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    const text = err.join("\n");
    expect(text).not.toContain("test-access-token-value");
    expect(text).toMatch(/socket/); // transient token survives for wrapper retries
  });

  it("runs the check flow end to end and reports both regions", async () => {
    const { deps, out } = harness(fakeAdapter());
    const code = await main(["check", "--format", "json"], deps);
    expect(code).toBe(0);
    const payload = JSON.parse(out[0] ?? "") as {
      session: { token: string };
      connectivity: { global: { ok: boolean }; cn: { ok: boolean } };
      region: { active: string; cached: string };
    };
    expect(payload.session.token).toBe("valid");
    expect(payload.connectivity.global.ok).toBe(true);
    expect(payload.connectivity.cn.ok).toBe(true);
    expect(["global", "cn"]).toContain(payload.region.active);
  });

  it("exits 1 when check finds no reachable region", async () => {
    const { deps, out, err } = harness(fakeAdapter({
      probe: async () => {
        throw new Error("connect timed out");
      }
    }));
    const code = await main(["check", "--format", "json"], deps);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/global/);
    expect(err.join("\n")).toMatch(/cn/);
  });

  it("prints help mentioning the news feed limitation and exits 0", async () => {
    const { deps, out } = harness(fakeAdapter());
    const code = await main(["--help"], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/news/);
    expect(out.join("\n")).toMatch(/资讯|content feed|LongPort/i);
  });

  it("prints the submit payload with the new order id", async () => {
    const { deps, out } = harness(fakeAdapter({ submitOrder: async () => ({ orderId: "1044001" }) }));
    const code = await main([
      "order", "buy", "QQQ.US", "1", "--price", "551.64", "--order-type", "LO", "--tif", "Day",
      "--remark", "OpenClaw paper t-1", "--yes", "--format", "json"
    ], deps);
    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ order_id: "1044001" });
  });
});
