import { html, joinHtml, trustedHtml, type Html } from "./html.js";
import { COLOR_SCHEME_CSS, STRUCTURAL_CSS, THEME_DARK_CSS, THEME_LIGHT_CSS } from "./tokens.js";

/** The five top-level destinations, per plan Task 3 (identical set in both
 * the desktop sidenav and the mobile bottom tab bar). */
export type NavId = "home" | "reports" | "news" | "paper" | "strategy";

/** Freshness enum for the generated-at bar's pill (plan Task 3). */
export type Freshness = "最新" | "延迟" | "部分缺失";

export interface RenderPageMember {
  displayName: string;
}

export interface RenderPageOptions {
  title: string;
  nav: NavId;
  member: RenderPageMember;
  freshness: Freshness;
  /** Non-empty => render the degradation banner (req §1.1: never silent). */
  degraded: string[];
  /** Page content. Must be pre-built `Html` - never a raw string - so every
   * template in the app is forced through the escaping/trustedHtml
   * discipline in ./html.ts. */
  bodyHtml: Html;
  /** Per-request CSP nonce; lands on this page's single inline `<script>`. */
  nonce: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: Date;
}

interface NavItemDef {
  id: NavId;
  href: string;
  label: string;
  icon: Html;
}

// Nav icons copied VERBATIM from final.html (both the sidenav .nav-item and
// mobile .tab reuse the same markup; final.html's CSS sizes them per
// context via `.nav-item svg` / `.tab svg`, not inline width/height).
const NAV_ITEMS: readonly NavItemDef[] = [
  {
    id: "home",
    href: "/",
    label: "首页",
    icon: trustedHtml(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>'
    )
  },
  {
    id: "reports",
    href: "/reports",
    label: "报告",
    icon: trustedHtml(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h6M9 16h6"/></svg>'
    )
  },
  {
    id: "news",
    href: "/news",
    label: "新闻",
    icon: trustedHtml(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M7 9h7M7 13h10M7 17h6"/></svg>'
    )
  },
  {
    id: "paper",
    href: "/paper",
    label: "模拟盘",
    icon: trustedHtml(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 3 6-7 3 3"/><path d="M3 21h18"/></svg>'
    )
  },
  {
    id: "strategy",
    href: "/strategy",
    label: "策略",
    icon: trustedHtml(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/></svg>'
    )
  }
];

// Sidenav's own theme toggle icon (distinct from the topbar's 🌓 emoji
// button) - copied verbatim from final.html's <button class="theme-btn">.
const THEME_TOGGLE_SIDENAV_ICON = trustedHtml(
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
);

// The inline theme-init/toggle script. The init IIFE and toggleTheme()'s
// body are copied VERBATIM from final.html's closing <script> block. This
// is the ONLY inline <script> this page emits; its `nonce` attribute must
// match the per-request CSP nonce.
//
// One deliberate deviation from final.html: the theme buttons there wire up
// via `onclick="toggleTheme()"` attributes, which final.html can do because
// it is a standalone mockup with no CSP. platform-app's real CSP is
// `script-src 'nonce-<nonce>'` (security.ts) with no `'unsafe-inline'`, and
// per the CSP3 spec a nonce-only script-src does NOT cover inline event
// handler attributes (only <script>/<style> elements) - browsers block
// onclick under that policy. Confirmed live: Chrome logs "Executing inline
// event handler violates... Content Security Policy" and the click is a
// no-op. So instead of onclick attributes, both theme buttons are wired up
// from inside this nonce'd script via addEventListener - same
// toggleTheme() logic, CSP-compliant invocation.
const THEME_SCRIPT_BODY = `(function(){
  var saved = localStorage.getItem('alphaloop-theme');
  var theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
})();
function toggleTheme(){
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('alphaloop-theme', next);
}
Array.prototype.forEach.call(document.querySelectorAll('.theme-btn'), function(btn){
  btn.addEventListener('click', toggleTheme);
});`;

const CN_WEEKDAY_BY_EN: Record<string, string> = {
  Sun: "日",
  Mon: "一",
  Tue: "二",
  Wed: "三",
  Thu: "四",
  Fri: "五",
  Sat: "六"
};

/**
 * Formats an instant as `MM-DD 周X HH:mm` in Asia/Shanghai (Beijing) time,
 * echoing the `<b>07-12 周日</b> ... 生成 20:05` style used in final.html's
 * topbar mock. Beijing time has no DST, so a fixed IANA zone is exact.
 */
export function formatBeijingGeneratedAt(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short"
  }).formatToParts(date);

  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const month = byType.get("month") ?? "??";
  const day = byType.get("day") ?? "??";
  const hour = byType.get("hour") ?? "??";
  const minute = byType.get("minute") ?? "??";
  const weekdayEn = byType.get("weekday") ?? "";
  const weekdayCn = CN_WEEKDAY_BY_EN[weekdayEn] ?? weekdayEn;

  return `${month}-${day} 周${weekdayCn} ${hour}:${minute}`;
}

/** Exported so other pages' own inline freshness pills (e.g. home.ts's
 * per-card "我的模拟盘概览" pill) map 最新/延迟/部分缺失 to the same
 * ok/warn color as this page's own topbar pill, instead of each carrying its
 * own copy that could silently drift out of sync with this one. */
export function freshnessPillClass(freshness: string): "ok" | "warn" {
  return freshness === "最新" ? "ok" : "warn";
}

function renderNavItem(item: NavItemDef, active: boolean, variant: "nav-item" | "tab"): Html {
  const className = active ? `${variant} on` : variant;
  return html`<a class="${className}" href="${item.href}">${item.icon}${item.label}</a>`;
}

function renderDegradedBanner(reasons: string[]): Html {
  if (reasons.length === 0) {
    return trustedHtml("");
  }
  const items = joinHtml(reasons.map((reason) => html`<li>${reason}</li>`));
  return html`<div class="bento" style="padding-bottom:0">
      <section class="card w2 dt-w4 amber" role="alert" aria-label="数据降级提示">
        <h2 style="color:var(--amber)">数据降级提示</h2>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:var(--ink)">${items}</ul>
      </section>
    </div>`;
}

/**
 * Renders a complete platform-app HTML document: theme tokens + init script,
 * sidenav (desktop) / bottom tabs (mobile), the generated-at + freshness
 * bar, an optional degradation banner, the caller's body content, and a
 * footer. Exactly one inline `<script>` (theme init/toggle) is emitted,
 * carrying `nonce` - callers must set the matching
 * `Content-Security-Policy: script-src 'nonce-<nonce>'` header themselves
 * (see security.ts); this function only renders the markup.
 */
export function renderPage(options: RenderPageOptions): string {
  const { title, nav, member, freshness, degraded, bodyHtml, nonce } = options;
  const now = options.now ?? new Date();
  const generatedAt = formatBeijingGeneratedAt(now);
  const pillClass = freshnessPillClass(freshness);

  const sidenavItems = joinHtml(
    NAV_ITEMS.map((item) => renderNavItem(item, item.id === nav, "nav-item"))
  );
  const tabItems = joinHtml(NAV_ITEMS.map((item) => renderNavItem(item, item.id === nav, "tab")));

  const page = html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · AlphaLoop</title>
<style>${trustedHtml(THEME_LIGHT_CSS)}
${trustedHtml(THEME_DARK_CSS)}
${trustedHtml(COLOR_SCHEME_CSS)}
${trustedHtml(STRUCTURAL_CSS)}</style>
</head>
<body>
<div class="app">
  <aside class="sidenav" aria-label="主导航">
    <div class="brand">Alpha<span>Loop</span></div>
    ${sidenavItems}
    <button class="theme-btn" type="button">${THEME_TOGGLE_SIDENAV_ICON}<span id="themeLabel2">切换主题</span></button>
  </aside>
  <div class="main">
    <div class="topbar">
      <span><b>${member.displayName}</b> · 生成于 ${generatedAt}</span>
      <span style="display:flex;gap:8px;align-items:center">
        <span class="pill ${pillClass}">${freshness}</span>
        <button class="theme-btn" type="button" aria-label="切换深浅主题"><span id="themeLabel">🌓</span></button>
      </span>
    </div>
    ${renderDegradedBanner(degraded)}
    ${bodyHtml}
    <nav class="tabs" aria-label="主导航">
      ${tabItems}
    </nav>
    <footer style="padding:20px 16px 96px;text-align:center;font-size:11px;color:var(--sub)">AlphaLoop 内部平台 · 仅圈内成员可见</footer>
  </div>
</div>
<script nonce="${nonce}">
${trustedHtml(THEME_SCRIPT_BODY)}
</script>
</body>
</html>
`;

  return page.__html;
}
