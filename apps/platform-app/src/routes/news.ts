/**
 * News page (Phase 4 Task 7): `GET /news`. Identity-gated like every route
 * past Task 3 - identity here is a pure LOGIN gate, not an ownership filter:
 * news_events/news_event_sources have no owner_id column at all (schema v8),
 * because news is a public asset shared across the whole circle (see
 * data/news.ts's header comment). This replaces P4's honest placeholder
 * (disabled filter chips + an always-empty card grid) with real content: one
 * card per clustered event, backed by the SAME rows the daily/weekly report
 * pipeline writes (apps/openclaw-config/scripts/scheduled-report.mjs's
 * news-engine.mjs/news-store.mjs chain) - single writer, two render faces.
 *
 * Filter chips (全部/宏观/each tracked symbol) are plain `<a href>` links
 * carrying `?symbol=`/`?topic=`, mirroring routes/reports.ts's
 * renderTypeChip convention - no client-side JS, a real navigation per
 * click, active state driven by the resolved query string alone.
 *
 * Relative/absolute time ("3 小时前", expandable to the exact Beijing-time
 * timestamp) is a `<details>/<summary>` pair - pure HTML/CSS, no new inline
 * script beyond render/layout.ts's existing theme-toggle one.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { listFilterSymbols, listNewsEvents, type ImpactDirection, type NewsEventRow, type NewsEventSourceRow } from "../data/news.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { html, joinHtml, type Html } from "../render/html.js";
import { formatBeijingGeneratedAt, renderPage, type Freshness } from "../render/layout.js";

export interface NewsRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

// Plan Task 7, req: "近 7 天窗" - the same window listEventsInWindow/
// listNewsEvents take a computed sinceIso cutoff for.
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Freshness thresholds (plan Task 7, req): <6h since the most recent
// clustered event's last_published_at -> "最新"; <48h -> "延迟"; older, or no
// dated event at all -> "部分缺失".
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const DELAYED_WINDOW_MS = 48 * 60 * 60 * 1000;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

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

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

function computeFreshness(events: readonly NewsEventRow[], now: Date): Freshness {
  const latestIso = events.reduce<string | null>((latest, event) => {
    if (!event.lastPublishedAt) {
      return latest;
    }
    if (!latest || event.lastPublishedAt > latest) {
      return event.lastPublishedAt;
    }
    return latest;
  }, null);

  if (!latestIso) {
    return "部分缺失";
  }
  const ageMs = now.getTime() - new Date(latestIso).getTime();
  if (ageMs < FRESH_WINDOW_MS) {
    return "最新";
  }
  if (ageMs < DELAYED_WINDOW_MS) {
    return "延迟";
  }
  return "部分缺失";
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

function renderFilterChip(label: string, href: string, active: boolean): Html {
  const extraStyle = active
    ? "background:var(--accent-soft);color:var(--accent);border-color:var(--accent-border);font-weight:600"
    : "background:var(--card);color:var(--ink);border-color:var(--line)";
  return html`<a href="${href}" style="display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;margin:0 8px 8px 0;${extraStyle}">${label}</a>`;
}

function renderFilterChipsCard(symbols: readonly string[], activeSymbol: string | null, activeTopic: string | null): Html {
  const isAll = !activeSymbol && !activeTopic;
  const chips = [
    renderFilterChip("全部", "/news", isAll),
    renderFilterChip("宏观", "/news?topic=宏观", activeTopic === "宏观"),
    ...symbols.map((symbol) => renderFilterChip(symbol, `/news?symbol=${encodeURIComponent(symbol)}`, activeSymbol === symbol))
  ];
  return html`<section class="card w2 dt-w4">
    <h2>筛选</h2>
    <div>${joinHtml(chips)}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Event cards
// ---------------------------------------------------------------------------

const DIRECTION_LABELS: Record<Exclude<ImpactDirection, null>, string> = {
  bullish: "利好",
  bearish: "利空",
  neutral: "中性",
  unknown: "待验证"
};

// Direction color per plan ("direction color .u/.d/neutral"): bullish->up
// (green, .u), bearish->down (red, .d), neutral/unknown-> amber (.a) - all
// three are STRUCTURAL_CSS text-color classes (tokens.ts), applied to a
// `border:1px solid currentColor` pill so the badge stays theme-aware without
// needing a new background token per direction.
function directionClass(direction: ImpactDirection): "u" | "d" | "a" {
  if (direction === "bullish") {
    return "u";
  }
  if (direction === "bearish") {
    return "d";
  }
  return "a";
}

function renderImpactBadge(event: NewsEventRow): Html {
  const cls = directionClass(event.impactDirection);
  const label = DIRECTION_LABELS[event.impactDirection ?? "unknown"];
  return html`<span class="${cls}" style="display:inline-flex;align-items:center;border:1px solid currentColor;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600">${label}</span>`;
}

function renderAffectedChips(affected: readonly string[]): Html {
  if (affected.length === 0) {
    return html`<span style="font-size:11px;color:var(--sub)">大盘/宏观</span>`;
  }
  const chips = affected.map(
    (symbol) => html`<span class="mono" style="display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--ink);margin:0 4px 4px 0">${symbol}</span>`
  );
  return joinHtml(chips);
}

// Relative time bucket ("3 小时前" etc.) - the visible summary of the
// `<details>` disclosure; the exact Beijing time is the disclosure's body,
// revealed on click/tap with no JS involved.
function formatRelativeTime(iso: string, now: Date): string {
  const ageMs = now.getTime() - new Date(iso).getTime();
  if (ageMs < 0) {
    return "刚刚";
  }
  if (ageMs < MS_PER_MINUTE) {
    return "刚刚";
  }
  if (ageMs < MS_PER_HOUR) {
    return `${Math.floor(ageMs / MS_PER_MINUTE)} 分钟前`;
  }
  if (ageMs < MS_PER_DAY) {
    return `${Math.floor(ageMs / MS_PER_HOUR)} 小时前`;
  }
  return `${Math.floor(ageMs / MS_PER_DAY)} 天前`;
}

function renderSourceLine(source: NewsEventSourceRow, now: Date): Html {
  const link = source.url
    ? html`<a href="${source.url}" rel="noreferrer" target="_blank" style="color:var(--accent)">原文</a>`
    : html`<span style="color:var(--sub)">原文链接未提供</span>`;

  if (!source.publishedAt) {
    return html`<div class="alert"><time>时间未知</time><span><b>${source.publisher}</b> · ${link}</span></div>`;
  }

  const relative = formatRelativeTime(source.publishedAt, now);
  const absolute = formatBeijingGeneratedAt(new Date(source.publishedAt));
  return html`<div class="alert">
    <details style="flex:none">
      <summary style="cursor:pointer;font-size:11px;color:var(--sub);list-style:none">${relative}</summary>
      <div class="mono" style="font-size:10.5px;color:var(--sub);margin-top:2px">${absolute}（北京时间）</div>
    </details>
    <span><b>${source.publisher}</b> · ${link}</span>
  </div>`;
}

function renderEventCard(event: NewsEventRow, now: Date): Html {
  const sources = joinHtml(event.sources.map((source) => renderSourceLine(source, now)));
  return html`<section class="card w2 dt-w2">
    <h2>${event.titleZh}${renderImpactBadge(event)}</h2>
    <div style="margin-bottom:8px">${renderAffectedChips(event.impactAffected)}</div>
    ${event.impactReason ? html`<p style="font-size:12.5px;color:var(--sub);margin-bottom:8px">${event.impactReason}</p>` : ""}
    ${event.summaryZh ? html`<p style="font-size:13px;color:var(--ink);white-space:pre-line;margin-bottom:10px">${event.summaryZh}</p>` : ""}
    <div>${sources}</div>
  </section>`;
}

function renderEmptyStateCard(): Html {
  return html`<section class="card w2 dt-w4">
    <p style="font-size:13px;color:var(--sub)">近 7 天暂无聚类事件——新闻引擎随日报生成积累</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function renderNewsBody(events: readonly NewsEventRow[], symbols: readonly string[], activeSymbol: string | null, activeTopic: string | null, now: Date): Html {
  const cards = events.length > 0
    ? joinHtml(events.map((event) => renderEventCard(event, now)))
    : renderEmptyStateCard();

  return html`<div class="bento">${renderFilterChipsCard(symbols, activeSymbol, activeTopic)}</div>
    <div class="bento" style="margin-top:10px">${cards}</div>`;
}

export function renderNewsPage(
  res: ServerResponse,
  deps: NewsRouteDeps,
  member: Member,
  url: URL,
  nonce: string
): void {
  const now = currentNow(deps);
  const activeSymbol = url.searchParams.get("symbol");
  const activeTopic = url.searchParams.get("topic");

  const sinceIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const events = listNewsEvents(deps.db, {
    sinceIso,
    ...(activeSymbol ? { symbol: activeSymbol } : {}),
    ...(activeTopic ? { topic: activeTopic } : {})
  });
  const symbols = listFilterSymbols(deps.db);

  const page = renderPage({
    title: "新闻",
    nav: "news",
    member: { displayName: member.displayName },
    freshness: computeFreshness(events, now),
    degraded: [],
    bodyHtml: renderNewsBody(events, symbols, activeSymbol, activeTopic, now),
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

  renderNewsPage(res, deps, member, url, nonce);
  return true;
}
