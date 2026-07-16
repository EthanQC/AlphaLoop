import { describe, expect, it } from "vitest";

import { sanitizeErrorText } from "./sanitize.js";

describe("sanitizeErrorText", () => {
  it("redacts known secret values", () => {
    const out = sanitizeErrorText(
      "request failed for key abcdef-app-key with token xyz-token-value",
      ["abcdef-app-key", "xyz-token-value"]
    );
    expect(out).not.toContain("abcdef-app-key");
    expect(out).not.toContain("xyz-token-value");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts token/secret assignments and Bearer headers", () => {
    const out = sanitizeErrorText(
      'access_token="deadbeef123" app_secret=shhh Authorization: Bearer abc.def-ghi',
      []
    );
    expect(out).not.toContain("deadbeef123");
    expect(out).not.toContain("shhh");
    expect(out).not.toContain("abc.def-ghi");
  });

  it("keeps transient network wording intact so wrapper retries still trigger", () => {
    const message = "client error (Connect): connection timed out via socket";
    expect(sanitizeErrorText(message, [])).toBe(message);
  });

  it("ignores empty/short secrets and caps output length", () => {
    const out = sanitizeErrorText("x".repeat(5000), ["", "ab", undefined]);
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});
