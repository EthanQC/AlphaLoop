import { describe, expect, it } from "vitest";

import { trustedHtml } from "./html.js";
import { formatBeijingGeneratedAt, renderPage } from "./layout.js";

const SAMPLE_BODY = trustedHtml('<section class="card"><h2>示例</h2></section>');

function renderSample(overrides: Partial<Parameters<typeof renderPage>[0]> = {}) {
  return renderPage({
    title: "首页",
    nav: "home",
    member: { displayName: "圈主" },
    freshness: "最新",
    degraded: [],
    bodyHtml: SAMPLE_BODY,
    nonce: "test-nonce-abc",
    now: new Date("2026-07-14T12:05:00Z"),
    ...overrides
  });
}

describe("formatBeijingGeneratedAt", () => {
  it("renders a fixed UTC instant as Beijing time (UTC+8) with weekday", () => {
    // 2026-07-14T12:05:00Z is 2026-07-14 20:05 in Asia/Shanghai, a Tuesday.
    expect(formatBeijingGeneratedAt(new Date("2026-07-14T12:05:00Z"))).toBe("07-14 周二 20:05");
  });

  it("crosses the UTC day boundary correctly (UTC+8 offset)", () => {
    // 2026-07-13T17:30:00Z is 2026-07-14 01:30 in Asia/Shanghai.
    expect(formatBeijingGeneratedAt(new Date("2026-07-13T17:30:00Z"))).toBe("07-14 周二 01:30");
  });
});

describe("renderPage: document shape", () => {
  it("emits a full HTML document", () => {
    const out = renderSample();
    expect(out).toMatch(/^<!doctype html>/iu);
    expect(out).toContain("<html lang=\"zh-CN\">");
    expect(out).toContain("</html>");
  });

  it("inlines both theme blocks and the structural CSS in one <style> tag", () => {
    const out = renderSample();
    expect(out).toContain("--up:#12805C");
    expect(out).toContain("--up:#34D399");
    expect(out).toContain(".app{min-height:100dvh");
  });

  it("makes zero third-party requests: no http(s) URLs, no <script src>, no <link>", () => {
    const out = renderSample();
    expect(out).not.toMatch(/https?:\/\//iu);
    expect(out).not.toMatch(/<script[^>]+src=/iu);
    expect(out).not.toMatch(/<link[^>]+href=/iu);
  });

  it("splices the caller's bodyHtml verbatim", () => {
    const out = renderSample();
    expect(out).toContain('<section class="card"><h2>示例</h2></section>');
  });
});

describe("renderPage: theme script", () => {
  it("carries exactly one inline <script> tag, bearing the given nonce", () => {
    const out = renderSample({ nonce: "abc123nonce" });
    const scriptTags = out.match(/<script\b[^>]*>/gu) ?? [];
    expect(scriptTags).toHaveLength(1);
    expect(scriptTags[0]).toContain('nonce="abc123nonce"');
  });

  it("the nonce string appears nowhere else in the document", () => {
    const out = renderSample({ nonce: "unique-nonce-xyz" });
    const occurrences = out.split("unique-nonce-xyz").length - 1;
    expect(occurrences).toBe(1);
  });

  it("reads/writes localStorage under the 'alphaloop-theme' key", () => {
    const out = renderSample();
    expect(out).toContain("localStorage.getItem('alphaloop-theme')");
    expect(out).toContain("localStorage.setItem('alphaloop-theme', next)");
  });

  it("initializes theme from saved value or matchMedia, verbatim to final.html's logic", () => {
    const out = renderSample();
    expect(out).toContain("window.matchMedia('(prefers-color-scheme: dark)').matches");
    expect(out).toContain("document.documentElement.setAttribute('data-theme', theme)");
  });

  it("defines toggleTheme() flipping data-theme and persisting it", () => {
    const out = renderSample();
    expect(out).toContain("function toggleTheme(){");
    expect(out).toContain("document.documentElement.setAttribute('data-theme', next)");
  });

  it("wires both theme buttons via addEventListener from the nonce'd script, not inline onclick", () => {
    // A nonce-only CSP (script-src 'nonce-<n>', no 'unsafe-inline') does NOT
    // cover inline event handler attributes per the CSP3 spec - only
    // <script>/<style> elements. `onclick="toggleTheme()"` gets silently
    // blocked by the browser under this page's real CSP (confirmed live via
    // a Playwright console-error probe), so the buttons must never carry
    // onclick and must instead be wired up inside the nonce'd script.
    const out = renderSample();
    expect(out).not.toContain("onclick=");
    expect(out).toContain("querySelectorAll('.theme-btn')");
    expect(out).toContain("addEventListener('click', toggleTheme)");
  });
});

describe("renderPage: navigation", () => {
  it("renders both the sidenav and the mobile tabs", () => {
    const out = renderSample();
    expect(out).toContain('class="sidenav"');
    expect(out).toContain('class="tabs"');
  });

  it("renders all 5 nav destinations with their labels and hrefs, in both sidenav and tabs", () => {
    const out = renderSample();
    const expected: Array<[string, string]> = [
      ["/", "首页"],
      ["/reports", "报告"],
      ["/news", "新闻"],
      ["/paper", "模拟盘"],
      ["/strategy", "策略"]
    ];
    for (const [href, label] of expected) {
      const hrefCount = out.split(`href="${href}"`).length - 1;
      expect(hrefCount).toBeGreaterThanOrEqual(2); // sidenav + tabs
      expect(out).toContain(label);
    }
  });

  it("marks only the active nav item with the 'on' class, matching the given nav id", () => {
    const out = renderSample({ nav: "reports" });
    expect(out).toContain('class="nav-item on" href="/reports"');
    expect(out).toContain('class="tab on" href="/reports"');
    expect(out).not.toContain('class="nav-item on" href="/"');
    expect(out).not.toContain('class="tab on" href="/"');
  });
});

describe("renderPage: generated-at bar and freshness pill", () => {
  it("shows the member's display name and the Beijing generated-at timestamp", () => {
    const out = renderSample({ member: { displayName: "张三" } });
    expect(out).toContain("张三");
    expect(out).toContain("07-14 周二 20:05");
  });

  it("maps 最新 to pill.ok", () => {
    const out = renderSample({ freshness: "最新" });
    expect(out).toContain('class="pill ok">最新<');
  });

  it("maps 延迟 to pill.warn", () => {
    const out = renderSample({ freshness: "延迟" });
    expect(out).toContain('class="pill warn">延迟<');
  });

  it("maps 部分缺失 to pill.warn", () => {
    const out = renderSample({ freshness: "部分缺失" });
    expect(out).toContain('class="pill warn">部分缺失<');
  });
});

describe("renderPage: degradation banner", () => {
  it("is absent when degraded is empty", () => {
    const out = renderSample({ degraded: [] });
    expect(out).not.toContain("数据降级提示");
  });

  it("lists every reason when degraded is non-empty, in an amber card", () => {
    const out = renderSample({ degraded: ["日报磁盘缺失 2026-07-13", "快照延迟 15 分钟"] });
    expect(out).toContain("数据降级提示");
    expect(out).toContain("日报磁盘缺失 2026-07-13");
    expect(out).toContain("快照延迟 15 分钟");
    expect(out).toMatch(/class="card[^"]*amber[^"]*"/u);
  });
});

describe("renderPage: footer", () => {
  it("renders a footer element", () => {
    const out = renderSample();
    expect(out).toMatch(/<footer[^>]*>/u);
  });
});

describe("renderPage: XSS probes", () => {
  const PROBE = "<script>alert(1)</script>";

  it("escapes a malicious title", () => {
    const out = renderSample({ title: PROBE });
    expect(out).not.toContain(PROBE);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a malicious member display name", () => {
    const out = renderSample({ member: { displayName: PROBE } });
    expect(out).not.toContain(PROBE);
  });

  it("escapes malicious degraded reasons", () => {
    const out = renderSample({ degraded: [PROBE] });
    expect(out).not.toContain(PROBE);
  });

  it("escapes a malicious freshness value even if the type is bypassed", () => {
    const out = renderSample({ freshness: PROBE as unknown as "最新" });
    expect(out).not.toContain(PROBE);
  });

  it("escapes a nonce containing markup so it cannot break out of its attribute", () => {
    const out = renderSample({ nonce: '"><script>alert(2)</script>' });
    expect(out).not.toContain("<script>alert(2)</script>");
  });
});
