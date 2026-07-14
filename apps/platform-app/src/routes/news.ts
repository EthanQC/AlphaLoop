/**
 * News page (Task 5): `GET /news`. Identity-gated like every route past
 * Task 3. This is P4's shell only - the plan explicitly scopes event
 * clustering/real news content OUT of this task ("明确不做: 新闻引擎/事件
 * 聚类（P4）"). The page renders an honest, full-page placeholder card plus
 * the layout skeleton (disabled filter chips row + an empty card grid) so
 * P4 only has to fill CONTENT into an already-real structure, not build the
 * structure itself.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { html, joinHtml, type Html } from "../render/html.js";
import { renderPage } from "../render/layout.js";

export interface NewsRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

// Disabled placeholder chips - the eventual filter row's shape (per-category
// news filters), not yet backed by any real filtering logic. Mirrors the
// disabled-chip convention already established by routes/reports.ts's
// DISABLED_TYPE_CHIPS for the same "structure real, content not yet" idea.
const DISABLED_FILTER_CHIPS: readonly string[] = ["全部", "持仓相关", "宏观", "个股"];

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: NewsRouteDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function requireIdentity(req: IncomingMessage, res: ServerResponse, db: DatabaseSync, nonce: string): Member | null {
  const member = resolveIdentity(req, db);
  if (!member) {
    sendHtml(res, 401, renderUnauthorizedPage(nonce));
    return null;
  }
  return member;
}

function renderDisabledFilterChip(label: string): Html {
  return html`<span aria-disabled="true" style="display:inline-flex;align-items:center;border:1px dashed var(--line);border-radius:999px;padding:6px 14px;font-size:13px;margin:0 8px 8px 0;color:var(--sub);opacity:.6;cursor:not-allowed">${label}</span>`;
}

function renderNewsBody(): Html {
  const chips = joinHtml(DISABLED_FILTER_CHIPS.map(renderDisabledFilterChip));

  return html`<div class="bento">
      <section class="card w2 dt-w4">
        <h2>筛选</h2>
        <div>${chips}</div>
      </section>
    </div>
    <div class="bento" style="margin-top:10px">
      <section class="card w2 dt-w4">
        <h2>新闻引擎 <span class="pill warn">P4 上线</span></h2>
        <p style="font-size:13px;color:var(--sub)">新闻引擎 P4 上线——届时事件聚类一事一卡</p>
      </section>
    </div>
    <div class="bento" style="margin-top:10px" aria-label="新闻卡片网格（P4 前恒为空）">
    </div>`;
}

export function renderNewsPage(res: ServerResponse, deps: NewsRouteDeps, member: Member, nonce: string): void {
  const now = currentNow(deps);
  const page = renderPage({
    title: "新闻",
    nav: "news",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: renderNewsBody(),
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

/**
 * Routes `GET /news`. Returns `true` if the request was handled (including
 * the 401/405 cases), `false` if the path isn't `/news` so the caller can
 * keep trying other routes.
 */
export function handleNewsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: NewsRouteDeps,
  nonce: string
): boolean {
  if (url.pathname !== "/news") {
    return false;
  }

  if (req.method !== "GET") {
    methodNotAllowed(res);
    return true;
  }

  const member = requireIdentity(req, res, deps.db, nonce);
  if (!member) {
    return true;
  }

  renderNewsPage(res, deps, member, nonce);
  return true;
}
