import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDeepLink, type DeepLinkKind } from "./deep-links.js";

const BASE_URL_ENV = "PLATFORM_PUBLIC_BASE_URL";
const PRODUCTION_BASE_URL = "https://reports.qingverse.com";

describe("buildDeepLink", () => {
  const previousBaseUrl = process.env[BASE_URL_ENV];

  beforeEach(() => {
    process.env[BASE_URL_ENV] = PRODUCTION_BASE_URL;
  });

  afterEach(() => {
    if (previousBaseUrl === undefined) {
      delete process.env[BASE_URL_ENV];
    } else {
      process.env[BASE_URL_ENV] = previousBaseUrl;
    }
  });

  it("builds an absolute daily report link", () => {
    expect(buildDeepLink("daily", "2026-07-28")).toBe("https://reports.qingverse.com/daily/2026-07-28");
  });

  it("builds an absolute proposal link", () => {
    expect(buildDeepLink("proposal", "prop_x")).toBe("https://reports.qingverse.com/proposal/prop_x");
  });

  it.each<[DeepLinkKind, string, string]>([
    ["daily", "2026-07-28", "/daily/2026-07-28"],
    ["weekly", "2026-07-26", "/weekly/2026-07-26"],
    ["stock-analysis", "rep_123", "/stock-analysis/rep_123"],
    ["stock", "700.HK", "/stock/700.HK"],
    ["proposal", "prop_x", "/proposal/prop_x"],
    ["research", "res_9", "/research/res_9"],
    ["review", "rev_2026-06", "/review/rev_2026-06"],
    ["member", "ethan", "/member/ethan"],
    ["personal-daily", "2026-07-28", "/daily/2026-07-28/me"],
    ["personal-weekly", "2026-07-26", "/weekly/2026-07-26/me"]
  ])("maps kind %s onto %s", (kind, id, expectedPath) => {
    expect(buildDeepLink(kind, id)).toBe(`${PRODUCTION_BASE_URL}${expectedPath}`);
  });

  it("returns null when the base url env is unset", () => {
    delete process.env[BASE_URL_ENV];
    expect(buildDeepLink("daily", "2026-07-28")).toBeNull();
  });

  it("returns null when the base url env is blank", () => {
    process.env[BASE_URL_ENV] = "   ";
    expect(buildDeepLink("daily", "2026-07-28")).toBeNull();
  });

  it("returns null when the base url is not an absolute http(s) url", () => {
    process.env[BASE_URL_ENV] = "reports.qingverse.com";
    expect(buildDeepLink("daily", "2026-07-28")).toBeNull();
  });

  it("does not emit a double slash when the base url has a trailing slash", () => {
    process.env[BASE_URL_ENV] = "https://reports.qingverse.com/";
    expect(buildDeepLink("daily", "2026-07-28")).toBe("https://reports.qingverse.com/daily/2026-07-28");
  });

  it("collapses repeated trailing slashes on the base url", () => {
    process.env[BASE_URL_ENV] = "https://reports.qingverse.com///";
    expect(buildDeepLink("weekly", "2026-07-26")).toBe("https://reports.qingverse.com/weekly/2026-07-26");
  });

  it("keeps a base url path prefix intact", () => {
    process.env[BASE_URL_ENV] = "https://qingverse.com/alphaloop/";
    expect(buildDeepLink("member", "ethan")).toBe("https://qingverse.com/alphaloop/member/ethan");
  });

  it("percent-encodes the id so it can never escape its path segment", () => {
    expect(buildDeepLink("member", "a/../b")).toBe("https://reports.qingverse.com/member/a%2F..%2Fb");
  });

  it("throws on an unknown kind", () => {
    expect(() => buildDeepLink("dashboard" as DeepLinkKind, "x")).toThrow(/unknown deep link kind/iu);
  });

  it("throws on a blank id instead of building a link to a listing page", () => {
    expect(() => buildDeepLink("daily", "  ")).toThrow(/deep link id/iu);
  });
});
