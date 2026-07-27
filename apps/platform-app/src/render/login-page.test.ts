import { describe, expect, it } from "vitest";

import { renderLoginPage } from "./login-page.js";

describe("renderLoginPage", () => {
  it("renders the email step in Chinese, posting to /login", () => {
    const html = renderLoginPage({ nonce: "nonce-1", step: "email" });

    expect(html).toMatch(/^<!doctype html>/iu);
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain("登录 AlphaLoop");
    expect(html).toContain('method="post" action="/login"');
    expect(html).toContain('name="email"');
    expect(html).toContain("发送验证码");
    expect(html).toContain("nonce-1");
  });

  it("renders the code step posting to /login/verify, carrying the address forward", () => {
    const html = renderLoginPage({ nonce: "nonce-2", step: "code", email: "member@example.com" });

    expect(html).toContain('method="post" action="/login/verify"');
    expect(html).toContain('type="hidden" name="email" value="member@example.com"');
    expect(html).toContain('name="code"');
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain("6 位验证码");
  });

  it("escapes the echoed address so it cannot break out of the value attribute", () => {
    // login.ts's own looksLikeEmail check does NOT exclude quotes or angle
    // brackets (only whitespace and stray @), so this escaping is what stops a
    // crafted address from injecting markup - not the validation upstream.
    const html = renderLoginPage({
      nonce: "n",
      step: "code",
      email: 'a@b."><script>alert(1)</script>x'
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("escapes the nonce too", () => {
    const html = renderLoginPage({ nonce: '"><script>alert(1)</script>', step: "email" });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders both banners, with the error marked up as an alert", () => {
    const html = renderLoginPage({
      nonce: "n",
      step: "code",
      notice: "验证码已发送。",
      error: "验证码不正确。"
    });

    expect(html).toContain('class="auth-note warn" role="alert"');
    expect(html).toContain("验证码不正确。");
    expect(html).toContain('class="auth-note info"');
    expect(html).toContain("验证码已发送。");
  });

  it("omits a banner that was not supplied", () => {
    const html = renderLoginPage({ nonce: "n", step: "email" });
    // The class still exists in the stylesheet; what must be absent is the
    // element itself.
    expect(html).not.toContain('<p class="auth-note');
  });

  it("honors a heading override (the 401 page)", () => {
    const html = renderLoginPage({ nonce: "n", step: "email", heading: "未获授权" });
    expect(html).toContain("<title>未获授权 · AlphaLoop</title>");
    expect(html).toContain("<h1>未获授权</h1>");
  });

  it("makes no external request of any kind and emits no script", () => {
    const html = renderLoginPage({ nonce: "n", step: "code", email: "a@b.com" });

    expect(html).not.toMatch(/https?:\/\//iu);
    expect(html).not.toMatch(/<script/iu);
    expect(html).not.toMatch(/<link[^>]+href=/iu);
    expect(html).not.toMatch(/url\(/iu);
  });

  it("carries the shared design tokens, including a scriptless dark mode", () => {
    const html = renderLoginPage({ nonce: "n", step: "email" });

    // A token only the shared light/dark blocks define - proof the page is
    // styled from render/tokens.ts rather than its own private palette.
    expect(html).toContain("--accent:#1E40AF");
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    // The rewritten dark block: no data-theme attribute is ever stamped on
    // this page (it ships no script), so the OS-preference selector is the
    // only thing that can apply the dark palette.
    expect(html).toContain(":root:not([data-theme]){\n  --bg:#0A0E1A");
    expect(html).toContain("noindex, nofollow");
  });
});
