import { describe, expect, it } from "vitest";

import { parseArgv, UsageError } from "./cli.js";

describe("parseArgv", () => {
  it("parses `check --format json`", () => {
    const parsed = parseArgv(["check", "--format", "json"]);
    expect(parsed.command).toEqual({ kind: "check" });
    expect(parsed.format).toBe("json");
  });

  it("parses multi-symbol quote and uppercases symbols", () => {
    const parsed = parseArgv(["quote", "qqq.us", "AAPL.US", "--format", "json"]);
    expect(parsed.command).toEqual({ kind: "quote", symbols: ["QQQ.US", "AAPL.US"] });
  });

  it("rejects quote without symbols", () => {
    expect(() => parseArgv(["quote", "--format", "json"])).toThrow(UsageError);
  });

  it("parses assets / positions / watchlist", () => {
    expect(parseArgv(["assets", "--format", "json"]).command).toEqual({ kind: "assets" });
    expect(parseArgv(["positions", "--format", "json"]).command).toEqual({ kind: "positions" });
    expect(parseArgv(["watchlist", "--format", "json"]).command).toEqual({ kind: "watchlist" });
  });

  it("parses news with --count", () => {
    const parsed = parseArgv(["news", "QQQ.US", "--count", "8", "--format", "json"]);
    expect(parsed.command).toEqual({ kind: "news", symbol: "QQQ.US", count: 8 });
  });

  it("defaults news count to 10 and rejects non-positive counts", () => {
    expect(parseArgv(["news", "QQQ.US", "--format", "json"]).command).toEqual({
      kind: "news",
      symbol: "QQQ.US",
      count: 10
    });
    expect(() => parseArgv(["news", "QQQ.US", "--count", "0", "--format", "json"])).toThrow(UsageError);
    expect(() => parseArgv(["news", "QQQ.US", "--count", "abc", "--format", "json"])).toThrow(UsageError);
  });

  it("parses the exact finance-calendar contract argv with repeated --star", () => {
    const parsed = parseArgv([
      "finance-calendar", "macrodata",
      "--market", "US",
      "--star", "2", "--star", "3",
      "--start", "2026-07-16",
      "--end", "2026-07-30",
      "--count", "20",
      "--format", "json"
    ]);
    expect(parsed.command).toEqual({
      kind: "finance-calendar",
      category: "macrodata",
      market: "US",
      stars: [2, 3],
      start: "2026-07-16",
      end: "2026-07-30",
      count: 20
    });
  });

  it("rejects unknown finance-calendar categories and bad dates", () => {
    expect(() => parseArgv(["finance-calendar", "horoscope", "--format", "json"])).toThrow(UsageError);
    expect(() => parseArgv([
      "finance-calendar", "macrodata", "--start", "07/16/2026", "--format", "json"
    ])).toThrow(UsageError);
  });

  it("parses bare `order` as today's order list", () => {
    expect(parseArgv(["order", "--format", "json"]).command).toEqual({ kind: "order-list" });
  });

  it("parses `order executions`", () => {
    expect(parseArgv(["order", "executions", "--format", "json"]).command).toEqual({ kind: "order-executions" });
  });

  it("parses `order detail <id>` and rejects a missing id", () => {
    expect(parseArgv(["order", "detail", "1043998", "--format", "json"]).command).toEqual({
      kind: "order-detail",
      orderId: "1043998"
    });
    expect(() => parseArgv(["order", "detail", "--format", "json"])).toThrow(UsageError);
  });

  it("parses the exact broker-executor submit argv", () => {
    const parsed = parseArgv([
      "order", "buy", "QQQ.US", "1",
      "--price", "551.64",
      "--order-type", "LO",
      "--tif", "Day",
      "--remark", "OpenClaw paper ticket-123",
      "--yes",
      "--format", "json"
    ]);
    expect(parsed.command).toEqual({
      kind: "order-submit",
      side: "buy",
      symbol: "QQQ.US",
      quantity: "1",
      price: "551.64",
      orderType: "LO",
      timeInForce: "Day",
      remark: "OpenClaw paper ticket-123",
      yes: true
    });
  });

  it("parses sell submits", () => {
    const parsed = parseArgv([
      "order", "sell", "aapl.us", "2", "--price", "212.00", "--order-type", "LO", "--tif", "Day", "--yes",
      "--format", "json"
    ]);
    expect(parsed.command).toMatchObject({ kind: "order-submit", side: "sell", symbol: "AAPL.US", quantity: "2" });
  });

  it("refuses submits without --yes (non-interactive safety)", () => {
    expect(() => parseArgv([
      "order", "buy", "QQQ.US", "1", "--price", "551.64", "--format", "json"
    ])).toThrow(UsageError);
  });

  it("rejects invalid submit quantity or price", () => {
    expect(() => parseArgv(["order", "buy", "QQQ.US", "0", "--price", "1.00", "--yes", "--format", "json"]))
      .toThrow(UsageError);
    expect(() => parseArgv(["order", "buy", "QQQ.US", "1", "--price", "-3", "--yes", "--format", "json"]))
      .toThrow(UsageError);
    expect(() => parseArgv(["order", "buy", "QQQ.US", "1", "--yes", "--format", "json"]))
      .toThrow(UsageError); // LO orders require --price
  });

  it("rejects unknown order subcommands, commands and flags", () => {
    expect(() => parseArgv(["order", "cancel", "1", "--format", "json"])).toThrow(UsageError);
    expect(() => parseArgv(["frobnicate", "--format", "json"])).toThrow(UsageError);
    expect(() => parseArgv(["check", "--verbose", "--format", "json"])).toThrow(UsageError);
    expect(() => parseArgv([])).toThrow(UsageError);
  });

  it("only supports --format json", () => {
    expect(() => parseArgv(["check", "--format", "table"])).toThrow(UsageError);
    expect(parseArgv(["check"]).format).toBe("json");
  });

  it("parses help", () => {
    expect(parseArgv(["--help"]).command).toEqual({ kind: "help" });
    expect(parseArgv(["help"]).command).toEqual({ kind: "help" });
  });
});
