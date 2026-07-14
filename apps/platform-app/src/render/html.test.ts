import { describe, expect, it } from "vitest";

import { attr, escapeHtml, html, joinHtml, trustedHtml, type Html } from "./html.js";

describe("escapeHtml", () => {
  it("escapes all five reserved characters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("提醒 · 3")).toBe("提醒 · 3");
  });

  it("neutralizes a script-tag XSS probe", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  it("neutralizes an attribute-breakout probe", () => {
    expect(escapeHtml(`"><img src=x onerror=alert(1)>`)).not.toContain('">');
  });
});

describe("attr", () => {
  it("escapes the same reserved set as escapeHtml (for attribute contexts)", () => {
    expect(attr(`" onmouseover="alert(1)`)).toBe("&quot; onmouseover=&quot;alert(1)");
  });
});

describe("trustedHtml", () => {
  it("wraps a raw string as an opaque Html value carrying it verbatim", () => {
    const wrapped: Html = trustedHtml("<b>raw</b>");
    expect(wrapped.__html).toBe("<b>raw</b>");
  });
});

describe("html tagged template", () => {
  it("auto-escapes plain string interpolations", () => {
    const name = "<script>alert(1)</script>";
    const result = html`<span>${name}</span>`;
    expect(result.__html).toBe("<span>&lt;script&gt;alert(1)&lt;/script&gt;</span>");
  });

  it("splices Html interpolations raw, without double-escaping", () => {
    const inner = trustedHtml("<b>bold</b>");
    const result = html`<div>${inner}</div>`;
    expect(result.__html).toBe("<div><b>bold</b></div>");
  });

  it("escapes every string in an array interpolation and joins them", () => {
    const items = ["<x>", "y"];
    const result = html`<ul>${items}</ul>`;
    expect(result.__html).toBe("<ul>&lt;x&gt;y</ul>");
  });

  it("splices an array of Html values raw and joined", () => {
    const items = [trustedHtml("<li>a</li>"), trustedHtml("<li>b</li>")];
    const result = html`<ul>${items}</ul>`;
    expect(result.__html).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("renders numbers as-is and skips null/undefined/false", () => {
    const result = html`<span>${1}${null}${undefined}${false}</span>`;
    expect(result.__html).toBe("<span>1</span>");
  });

  it("composes nested html`` calls without double-escaping", () => {
    const inner = html`<b>${"<x>"}</b>`;
    const outer = html`<div>${inner}</div>`;
    expect(outer.__html).toBe("<div><b>&lt;x&gt;</b></div>");
  });
});

describe("joinHtml", () => {
  it("joins Html fragments with an optional separator, raw", () => {
    const parts = [trustedHtml("<a>1</a>"), trustedHtml("<a>2</a>")];
    expect(joinHtml(parts).__html).toBe("<a>1</a><a>2</a>");
    expect(joinHtml(parts, ",").__html).toBe("<a>1</a>,<a>2</a>");
  });

  it("returns an empty Html for an empty array", () => {
    expect(joinHtml([]).__html).toBe("");
  });
});
