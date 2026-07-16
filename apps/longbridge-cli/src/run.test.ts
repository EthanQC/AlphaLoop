import { describe, expect, it } from "vitest";

import type { LongbridgeAdapter } from "./adapter.js";
import { CheckFailedError, runCommand } from "./run.js";

function fakeAdapter(overrides: Partial<LongbridgeAdapter> = {}): LongbridgeAdapter {
  return {
    probe: async () => {},
    getQuotes: async () => [],
    getAssets: async () => [],
    getPositions: async () => [],
    getWatchlist: async () => [],
    getNews: async () => [],
    getFinanceCalendar: async () => [],
    getTodayOrders: async () => [],
    getTodayExecutions: async () => [],
    submitOrder: async () => ({ orderId: "unset" }),
    getOrderDetail: async () => ({ orderId: "unset", symbol: "X.US", side: "buy", status: "New" }),
    ...overrides
  };
}

function deps(adapters: Partial<Record<"global" | "cn", LongbridgeAdapter>>, extra: Record<string, unknown> = {}) {
  return {
    adapterFor: (region: "global" | "cn") => {
      const adapter = adapters[region];
      if (!adapter) {
        throw new Error(`no adapter for ${region}`);
      }
      return adapter;
    },
    regions: { active: "global" as const, cached: "global" as const, source: "cache" as const },
    probeTimeoutMs: 200,
    today: () => "2026-07-16",
    ...extra
  };
}

describe("runCommand check", () => {
  it("probes both regions and reports both connectivity entries", async () => {
    const probed: string[] = [];
    const payload = await runCommand({ kind: "check" }, deps({
      global: fakeAdapter({ probe: async () => { probed.push("global"); } }),
      cn: fakeAdapter({ probe: async () => { probed.push("cn"); throw new Error("connect timed out"); } })
    })) as {
      session: { token: string };
      connectivity: { global: { ok: boolean }; cn: { ok: boolean; error?: string } };
      region: { active: string; cached: string };
    };

    expect(probed.sort()).toEqual(["cn", "global"]);
    expect(payload.session.token).toBe("valid");
    expect(payload.connectivity.global.ok).toBe(true);
    expect(payload.connectivity.cn.ok).toBe(false);
    expect(payload.region.active).toBe("global");
  });

  it("times out a hung probe instead of hanging the check", async () => {
    const payload = await runCommand({ kind: "check" }, deps({
      global: fakeAdapter(),
      cn: fakeAdapter({ probe: () => new Promise(() => {}) })
    })) as { connectivity: { cn: { ok: boolean; error?: string } } };
    expect(payload.connectivity.cn.ok).toBe(false);
    expect(payload.connectivity.cn.error).toMatch(/timeout/i);
  });

  it("throws CheckFailedError when no region is reachable", async () => {
    await expect(runCommand({ kind: "check" }, deps({
      global: fakeAdapter({ probe: async () => { throw new Error("socket closed"); } }),
      cn: fakeAdapter({ probe: async () => { throw new Error("connect timed out"); } })
    }))).rejects.toThrow(CheckFailedError);
  });
});

describe("runCommand data commands", () => {
  it("requests quotes with the parsed symbols against the active region", async () => {
    let requested: string[] = [];
    const payload = await runCommand(
      { kind: "quote", symbols: ["QQQ.US"] },
      deps({
        global: fakeAdapter({
          getQuotes: async (symbols) => {
            requested = symbols;
            return [{ symbol: "QQQ.US", lastDone: "551.64" }];
          }
        })
      })
    );
    expect(requested).toEqual(["QQQ.US"]);
    expect(payload).toEqual([{ symbol: "QQQ.US", last_done: "551.64" }]);
  });

  it("slices news to the requested count", async () => {
    const items = [1, 2, 3].map((n) => ({ id: `n-${n}`, title: `t${n}` }));
    const payload = await runCommand(
      { kind: "news", symbol: "QQQ.US", count: 2 },
      deps({ global: fakeAdapter({ getNews: async () => items }) })
    ) as unknown[];
    expect(payload).toHaveLength(2);
  });

  it("defaults the finance-calendar window to today + 14 days", async () => {
    let received: { start: string; end: string; market?: string; category: string } | undefined;
    await runCommand(
      { kind: "finance-calendar", category: "macrodata", stars: [], market: "US" },
      deps({
        global: fakeAdapter({
          getFinanceCalendar: async (req) => {
            received = req;
            return [];
          }
        })
      })
    );
    expect(received).toEqual({ category: "macrodata", start: "2026-07-16", end: "2026-07-30", market: "US" });
  });

  it("submits orders through the adapter and returns the order id payload", async () => {
    let submitted: unknown;
    const payload = await runCommand(
      {
        kind: "order-submit",
        side: "buy",
        symbol: "QQQ.US",
        quantity: "1",
        price: "551.64",
        orderType: "LO",
        timeInForce: "Day",
        remark: "OpenClaw paper t-1",
        yes: true
      },
      deps({
        global: fakeAdapter({
          submitOrder: async (req) => {
            submitted = req;
            return { orderId: "1044001" };
          }
        })
      })
    );
    expect(submitted).toMatchObject({ symbol: "QQQ.US", side: "buy", quantity: "1", price: "551.64" });
    expect(payload).toMatchObject({ order_id: "1044001" });
  });

  it("fails the submit when the adapter reports success without a usable order id", async () => {
    for (const orderId of ["", undefined]) {
      await expect(runCommand(
        {
          kind: "order-submit",
          side: "buy",
          symbol: "QQQ.US",
          quantity: "1",
          price: "551.64",
          orderType: "LO",
          timeInForce: "Day",
          yes: true
        },
        deps({
          global: fakeAdapter({
            submitOrder: async () => ({ orderId }) as unknown as { orderId: string }
          })
        })
      )).rejects.toThrow(/order_id/u);
    }
  });

  it("propagates adapter failures", async () => {
    await expect(runCommand(
      { kind: "assets" },
      deps({ global: fakeAdapter({ getAssets: async () => { throw new Error("boom"); } }) })
    )).rejects.toThrow("boom");
  });
});
