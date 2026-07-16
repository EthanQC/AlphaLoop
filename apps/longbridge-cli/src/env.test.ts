import { describe, expect, it } from "vitest";

import {
  CredentialsError,
  endpointsForRegion,
  resolveCredentials,
  resolveRegion,
  type FsLike
} from "./env.js";

function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): FsLike {
  return {
    readTextFile: (path: string) => files[path],
    listDir: (path: string) => dirs[path]
  };
}

const EMPTY_FS = fakeFs({});

describe("resolveCredentials", () => {
  it("prefers LONGBRIDGE_* over LONGPORT_* when both are set", () => {
    const creds = resolveCredentials({
      LONGBRIDGE_APP_KEY: "lb-key",
      LONGBRIDGE_APP_SECRET: "lb-secret",
      LONGBRIDGE_ACCESS_TOKEN: "lb-token",
      LONGPORT_APP_KEY: "lp-key",
      LONGPORT_APP_SECRET: "lp-secret",
      LONGPORT_ACCESS_TOKEN: "lp-token"
    }, EMPTY_FS);
    expect(creds).toMatchObject({ appKey: "lb-key", appSecret: "lb-secret", accessToken: "lb-token", tokenSource: "env" });
  });

  it("falls back to legacy LONGPORT_* names", () => {
    const creds = resolveCredentials({
      LONGPORT_APP_KEY: "lp-key",
      LONGPORT_APP_SECRET: "lp-secret",
      LONGPORT_ACCESS_TOKEN: "lp-token"
    }, EMPTY_FS);
    expect(creds).toMatchObject({ appKey: "lp-key", appSecret: "lp-secret", accessToken: "lp-token" });
  });

  it("reads the token from LONGBRIDGE_OPENAPI_TOKEN_PATH when env tokens are absent", () => {
    const creds = resolveCredentials({
      LONGBRIDGE_APP_KEY: "k",
      LONGBRIDGE_APP_SECRET: "s",
      LONGBRIDGE_OPENAPI_TOKEN_PATH: "/tokens/current"
    }, fakeFs({ "/tokens/current": "file-token\n" }));
    expect(creds).toMatchObject({ accessToken: "file-token", tokenSource: "file" });
  });

  it("falls back to the first non-dot entry of $HOME/.longbridge/openapi/tokens", () => {
    const creds = resolveCredentials({
      LONGBRIDGE_APP_KEY: "k",
      LONGBRIDGE_APP_SECRET: "s",
      HOME: "/home/u"
    }, fakeFs(
      { "/home/u/.longbridge/openapi/tokens/aaa": "dir-token" },
      { "/home/u/.longbridge/openapi/tokens": [".DS_Store", "bbb", "aaa"] }
    ));
    expect(creds).toMatchObject({ accessToken: "dir-token", tokenSource: "file" });
  });

  it("parses JSON token files", () => {
    const creds = resolveCredentials({
      LONGBRIDGE_APP_KEY: "k",
      LONGBRIDGE_APP_SECRET: "s",
      LONGBRIDGE_OPENAPI_TOKEN_PATH: "/tokens/current"
    }, fakeFs({ "/tokens/current": JSON.stringify({ access_token: "json-token" }) }));
    expect(creds.accessToken).toBe("json-token");
  });

  it("treats whitespace-only env values as missing", () => {
    expect(() => resolveCredentials({
      LONGBRIDGE_APP_KEY: "  ",
      LONGBRIDGE_APP_SECRET: "s",
      LONGBRIDGE_ACCESS_TOKEN: "t"
    }, EMPTY_FS)).toThrow(CredentialsError);
  });

  it("names the missing variables without leaking values", () => {
    try {
      resolveCredentials({ LONGBRIDGE_APP_KEY: "visible-key-value" }, EMPTY_FS);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialsError);
      const message = (error as Error).message;
      expect(message).toContain("LONGBRIDGE_APP_SECRET");
      expect(message).toContain("LONGBRIDGE_ACCESS_TOKEN");
      expect(message).not.toContain("visible-key-value");
    }
  });
});

describe("resolveRegion", () => {
  it("defaults to global when nothing is configured", () => {
    expect(resolveRegion({}, EMPTY_FS)).toEqual({ active: "global", cached: undefined, source: "default" });
  });

  it("reads the region-cache file under $HOME", () => {
    const fs = fakeFs({ "/home/u/.longbridge/openapi/region-cache": "cn" });
    expect(resolveRegion({ HOME: "/home/u" }, fs)).toEqual({ active: "cn", cached: "cn", source: "cache" });
  });

  it("lets LONGBRIDGE_REGION override the cache", () => {
    const fs = fakeFs({ "/home/u/.longbridge/openapi/region-cache": "global" });
    expect(resolveRegion({ HOME: "/home/u", LONGBRIDGE_REGION: "cn" }, fs))
      .toEqual({ active: "cn", cached: "global", source: "env" });
  });

  it("ignores invalid cache contents", () => {
    const fs = fakeFs({ "/home/u/.longbridge/openapi/region-cache": "mars" });
    expect(resolveRegion({ HOME: "/home/u" }, fs)).toEqual({ active: "global", cached: undefined, source: "default" });
  });
});

describe("endpointsForRegion", () => {
  it("returns the documented global endpoints", () => {
    expect(endpointsForRegion("global")).toEqual({
      httpUrl: "https://openapi.longportapp.com",
      quoteWsUrl: "wss://openapi-quote.longportapp.com/v2",
      tradeWsUrl: "wss://openapi-trade.longportapp.com/v2"
    });
  });

  it("returns the cn endpoints", () => {
    expect(endpointsForRegion("cn")).toEqual({
      httpUrl: "https://openapi.longportapp.cn",
      quoteWsUrl: "wss://openapi-quote.longportapp.cn/v2",
      tradeWsUrl: "wss://openapi-trade.longportapp.cn/v2"
    });
  });

  it("honors explicit LONGPORT_*_URL env overrides", () => {
    expect(endpointsForRegion("global", {
      LONGPORT_HTTP_URL: "https://example.test",
      LONGPORT_QUOTE_WS_URL: "wss://q.example.test",
      LONGPORT_TRADE_WS_URL: "wss://t.example.test"
    })).toEqual({
      httpUrl: "https://example.test",
      quoteWsUrl: "wss://q.example.test",
      tradeWsUrl: "wss://t.example.test"
    });
  });
});
