import { createServer, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, notFound, sendJson } from "@packages/shared-types";

import { applySecurityHeaders, createNonce } from "./security.js";
import { html, type Html } from "./render/html.js";
import { renderPage } from "./render/layout.js";

export interface PlatformServerDeps {
  /** Trading database handle. Unused by Task 1's routes but wired through
   * for the identity/report/data routes landing in later tasks. */
  db: DatabaseSync;
  /** Repo root, used by later tasks for on-disk report scanning. */
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

/**
 * Builds the platform-app HTTP server. This factory never calls `listen`
 * itself — callers (the real entrypoint or tests) decide the port and host,
 * so tests can bind to an ephemeral port instead of the production one.
 */
export function createPlatformServer(deps: PlatformServerDeps): Server {
  // Reserved for upcoming tasks (identity resolution, report scanning).
  void deps.db;
  void deps.repoRoot;
  const now = deps.now ?? (() => new Date());
  void now;

  return createServer((req, res) => {
    const nonce = createNonce();
    applySecurityHeaders(res, nonce);

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      sendJson(res, 200, { ok: true, service: "platform-app" });
      return;
    }

    // TODO remove when real pages land (Task 5) — this route exists purely
    // so Task 3's layout engine (render/layout.ts) can be exercised end to
    // end (curl'd and screenshotted) before any real route uses it. It is
    // intentionally NOT identity-gated: identity gating of real pages is
    // Task 5's wiring, and this route serves no real member data — every
    // value it renders is a hardcoded sample. Fine to leave open on
    // loopback in the interim.
    if (url.pathname === "/__preview") {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      renderPreview(res, url, nonce);
      return;
    }

    notFound(res);
  });
}

/**
 * Renders a sample page through the real `renderPage` layout engine so the
 * dual-theme/sidenav/tabs/bento chrome can be curl'd and screenshotted.
 * Every value below is a hardcoded sample, not real member/report data.
 *
 * Query params (test-only, not part of the platform's real routing):
 *   - `?degraded=1` — also renders the degradation banner with sample
 *     reasons, so it can be screenshotted too.
 *   - `?theme=dark` / `?theme=light` — forces the initial theme by writing
 *     to `localStorage` in an extra inline `<script>` BEFORE the page's own
 *     theme-init script runs (same nonce, so the existing CSP already
 *     allows it). This exists for headless screenshot tools that render a
 *     single page load and can't click the real toggle button themselves;
 *     Playwright-driven checks should instead click the toggle for real.
 */
function renderPreview(res: ServerResponse, url: URL, nonce: string): void {
  const degraded =
    url.searchParams.get("degraded") === "1"
      ? ["日报磁盘缺失 2026-07-13", "快照延迟 15 分钟"]
      : [];

  const bodyHtml = renderPreviewBody();

  let body = renderPage({
    title: "预览",
    nav: "home",
    member: { displayName: "预览成员" },
    freshness: degraded.length > 0 ? "部分缺失" : "最新",
    degraded,
    bodyHtml,
    nonce
  });

  const themeOverride = url.searchParams.get("theme");
  if (themeOverride === "dark" || themeOverride === "light") {
    body = body.replace(
      "<body>",
      `<body><script nonce="${nonce}">localStorage.setItem('alphaloop-theme', ${JSON.stringify(themeOverride)});</script>`
    );
  }

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function renderPreviewBody(): Html {
  return html`<div class="tape" aria-label="持仓行情纸带">
      <div class="tape-track mono">
        <span>NVDA<b class="u">+1.24%</b></span><span>TSLA<b class="d">-0.83%</b></span><span>QQQ<b class="u">+0.41%</b></span>
        <span>NVDA<b class="u">+1.24%</b></span><span>TSLA<b class="d">-0.83%</b></span><span>QQQ<b class="u">+0.41%</b></span>
      </div>
    </div>
    <div class="bento">
      <section class="card w2 dt-w4">
        <div class="ask" role="button" tabindex="0">问点什么…如「NVDA 财报前要减仓吗」</div>
        <div class="ask-hint">最近研判：<a href="#">NVDA 财报前风险研判 · 昨天 · 置信度 中</a></div>
      </section>
      <section class="card w2 dt-w2" style="display:grid;grid-template-columns:1.5fr 1fr;gap:12px">
        <div>
          <h2>我的模拟盘 <span class="pill ok">最新</span></h2>
          <div class="kpirow">
            <div class="kpi-main"><div class="num mono">1.0832</div><div class="lbl">净值</div></div>
            <div class="kpi"><div class="num mono u">+0.62%</div><div class="lbl">今日</div></div>
            <div class="kpi"><div class="num mono u">+8.32%</div><div class="lbl">累计</div></div>
          </div>
        </div>
        <div class="statcard">
          <h2>系统 <span class="pill ok">在线</span></h2>
          <div class="stat-line"><span>盯盘轮询</span><b class="mono u">正常</b></div>
          <div class="stat-line"><span>最大回撤</span><b class="mono d">-4.1%</b></div>
          <div class="stat-line"><span>敞口</span><b class="mono a">10.4%</b></div>
        </div>
      </section>
      <section class="card w2 dt-w2 amber">
        <h2 style="color:var(--amber)">待办 · 1 <span class="eta mono">23h 后失效</span></h2>
        <div class="todo">
          <div>
            <div class="t1">提案 P-124 · 买入 NVDA 2 股</div>
            <div class="t2 mono">限价 $845 · 纪律检查 3/3 通过</div>
          </div>
          <a class="go" href="#">去飞书审批</a>
        </div>
      </section>
      <section class="card dt-w2">
        <h2>提醒 · 3 <span class="pill ok">最新</span></h2>
        <div class="alert"><time class="mono">22:10</time><span>NVDA 日内 <b class="mono d">-4.3%</b>，触及 ±4% 阈值</span></div>
        <div class="alert"><time class="mono">23:05</time><span>TSLA 浮亏 <b class="mono d">-6.2%</b>，越过 -6% 线</span></div>
      </section>
      <section class="card dt-w2">
        <h2>纪律速览</h2>
        <div class="disc">财报周不加仓 <span style="color:var(--sub);font-size:12px">· NVDA 财报 7/28</span>
          <div><span class="days mono">已遵守 23 天</span></div>
        </div>
      </section>
      <section class="card w2 dt-w4 report">
        <h2>今日日报 <span class="pill ok">最新</span></h2>
        <h3>联储纪要偏鹰，半导体走弱；你的持仓两涨一跌</h3>
        <p>核心结论：中性偏谨慎（置信度 中）。多数官员支持维持利率更久。</p>
        <div class="report-links" style="max-width:420px">
          <a class="btn primary" href="#">阅读全文</a>
          <a class="btn" href="#">我的个人页</a>
        </div>
      </section>
    </div>`;
}
