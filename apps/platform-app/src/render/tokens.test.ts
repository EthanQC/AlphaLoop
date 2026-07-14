import { describe, expect, it } from "vitest";

import {
  COLOR_SCHEME_CSS,
  STRUCTURAL_CSS,
  THEME_DARK_CSS,
  THEME_LIGHT_CSS
} from "./tokens.js";

// Spot-check tokens copied VERBATIM from
// docs/superpowers/specs/ui-samples/final.html - the single source of truth.
// Do not "fix" a mismatch here by editing the constant; if these disagree
// with final.html, final.html changed and the constant must be re-copied.

describe("THEME_LIGHT_CSS", () => {
  it("selects both :root and :root[data-theme=light]", () => {
    expect(THEME_LIGHT_CSS).toContain(':root, :root[data-theme="light"]{');
  });

  it("carries the exact light-theme up/down colors (作战室 palette)", () => {
    expect(THEME_LIGHT_CSS).toContain("--up:#12805C");
    expect(THEME_LIGHT_CSS).toContain("--down:#D5342B");
  });

  it("carries the exact light-theme bg/ink/accent/card tokens", () => {
    expect(THEME_LIGHT_CSS).toContain("--bg:#F2F5FA");
    expect(THEME_LIGHT_CSS).toContain("--ink:#12233F");
    expect(THEME_LIGHT_CSS).toContain("--accent:#1E40AF");
    expect(THEME_LIGHT_CSS).toContain("--card:#FFFFFF");
  });

  it("carries the exact light-theme amber and line tokens", () => {
    expect(THEME_LIGHT_CSS).toContain("--amber:#B45309");
    expect(THEME_LIGHT_CSS).toContain("--line:#E1E8F2");
  });
});

describe("THEME_DARK_CSS", () => {
  it("selects :root[data-theme=dark]", () => {
    expect(THEME_DARK_CSS).toContain(':root[data-theme="dark"]{');
  });

  it("carries the exact dark-theme up/down colors (终端 palette)", () => {
    expect(THEME_DARK_CSS).toContain("--up:#34D399");
    expect(THEME_DARK_CSS).toContain("--down:#FF5C5C");
  });

  it("carries the exact dark-theme bg/ink/accent/card tokens", () => {
    expect(THEME_DARK_CSS).toContain("--bg:#0A0E1A");
    expect(THEME_DARK_CSS).toContain("--ink:#E8ECF5");
    expect(THEME_DARK_CSS).toContain("--accent:#38BDF8");
    expect(THEME_DARK_CSS).toContain("--card:#101627");
  });

  it("carries the exact dark-theme amber and line tokens", () => {
    expect(THEME_DARK_CSS).toContain("--amber:#F5B84B");
    expect(THEME_DARK_CSS).toContain("--line:#1E2740");
  });
});

describe("COLOR_SCHEME_CSS", () => {
  it("sets color-scheme:dark under prefers-color-scheme when no data-theme is set yet", () => {
    expect(COLOR_SCHEME_CSS).toContain("@media (prefers-color-scheme: dark)");
    expect(COLOR_SCHEME_CSS).toContain(":root:not([data-theme]){ color-scheme: dark; }");
  });

  it("sets color-scheme:dark once data-theme=dark is applied", () => {
    expect(COLOR_SCHEME_CSS).toContain(':root[data-theme="dark"]{ color-scheme: dark; }');
  });
});

describe("STRUCTURAL_CSS", () => {
  it("defines the .app flex shell capped at 1440px", () => {
    expect(STRUCTURAL_CSS).toContain(
      ".app{min-height:100dvh;background:var(--bg);max-width:1440px;margin:0 auto;display:flex}"
    );
  });

  it("hides .sidenav by default and reveals it at >=1024px as a sticky 212px column", () => {
    expect(STRUCTURAL_CSS).toContain(".sidenav{display:none}");
    expect(STRUCTURAL_CSS).toContain("@media (min-width:1024px){");
    expect(STRUCTURAL_CSS).toContain("width:212px");
    expect(STRUCTURAL_CSS).toContain("position:sticky;top:0;height:100dvh");
  });

  it("defines the fixed bottom 5-tab bar with blur and safe-area-inset", () => {
    expect(STRUCTURAL_CSS).toContain("position:fixed;bottom:0");
    expect(STRUCTURAL_CSS).toContain("backdrop-filter:blur(10px)");
    expect(STRUCTURAL_CSS).toContain("env(safe-area-inset-bottom)");
  });

  it("hides .tabs and switches .bento to 4 columns at desktop width", () => {
    expect(STRUCTURAL_CSS).toContain(".tabs{display:none}");
    expect(STRUCTURAL_CSS).toContain(".bento{grid-template-columns:repeat(4,1fr);gap:14px;padding:0}");
  });

  it("defines mobile .bento as a 2-column grid with w2 span helper", () => {
    expect(STRUCTURAL_CSS).toContain(".bento{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 12px}");
    expect(STRUCTURAL_CSS).toContain(".w2{grid-column:span 2}");
    expect(STRUCTURAL_CSS).toContain(".dt-w2{grid-column:span 2}");
    expect(STRUCTURAL_CSS).toContain(".dt-w4{grid-column:span 4}");
  });

  it("defines the .tape ticker with prefers-reduced-motion handling", () => {
    expect(STRUCTURAL_CSS).toContain("@keyframes tape{from{transform:translateX(0)}to{transform:translateX(-50%)}}");
    expect(STRUCTURAL_CSS).toContain("@media (prefers-reduced-motion:reduce){.tape-track{animation:none}}");
  });

  it("defines .dot, .pill.ok/.pill.warn, and the u/d/a color helpers", () => {
    expect(STRUCTURAL_CSS).toContain(".dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--up);margin-right:6px;box-shadow:0 0 6px var(--up)}");
    expect(STRUCTURAL_CSS).toContain(".pill.ok{background:var(--up-bg);color:var(--up)}");
    expect(STRUCTURAL_CSS).toContain(".pill.warn{background:var(--amber-bg);color:var(--amber)}");
    expect(STRUCTURAL_CSS).toContain(".u{color:var(--up)} .d{color:var(--down)} .a{color:var(--amber)}");
  });

  it("defines the focus-visible outline and font stacks with tabular-nums", () => {
    expect(STRUCTURAL_CSS).toContain(":focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:6px}");
    expect(STRUCTURAL_CSS).toContain('"PingFang SC"');
    expect(STRUCTURAL_CSS).toContain("font-variant-numeric:tabular-nums");
  });

  it("does not itself contain the theme variable blocks (kept separate)", () => {
    expect(STRUCTURAL_CSS).not.toContain('--up:#12805C');
    expect(STRUCTURAL_CSS).not.toContain('--up:#34D399');
  });
});
