/**
 * Stock drill-down page (Task 6): `GET /stock/<code>`. Identity-gated like
 * every route past Task 3.
 *
 * SYMBOL VALIDATION / PARITY (plan Task 6, req §1.9): `normalizeStockSymbol`
 * below re-implements report-data.mjs's `normalizeSymbol` (apps/openclaw-
 * config/scripts/report-data.mjs) - trim+uppercase; a symbol already shaped
 * like `<letters/digits/dots>.<2-4 letter exchange suffix>` (or starting
 * with `.`, e.g. an index like `.DJI`) passes through unchanged; a bare
 * 1-6 letter ticker gets `.US` appended (Longbridge's implicit default
 * market); anything else is returned as-is. ONE DELIBERATE DIVERGENCE from
 * the .mjs version: report-data.mjs's own regex charset is
 * `[A-Z0-9.-]` (permits a hyphen); this route's charset is narrower -
 * `[A-Z0-9.]` only (letters, digits, dots) - per this task's explicit brief
 * ("Validate code: uppercase alnum + dots"). Any input containing a
 * character outside that narrower set (before OR after normalization) is
 * rejected -> the route 404s. This also happens to be the path-traversal
 * guard: `/stock/<code>` only ever reaches this validator with a single URL
 * path segment (Node's URL parser already collapses `..`/`%2e%2e` dot-
 * segments before routing ever sees them - verified empirically), and any
 * residual encoded traversal attempt (e.g. a literal `%2f` byte sequence
 * that survives as text in the segment) contains a `%` character that this
 * charset rejects outright.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { scanReports, type ReportIndexEntry } from "../reports/scanner.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderPage, type Freshness } from "../render/layout.js";

export interface StockRouteDeps {
  db: DatabaseSync;
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

/** Only letters, digits, and dots - see module doc for why this is
 * DELIBERATELY narrower than report-data.mjs's own `[A-Z0-9.-]` charset. */
const SYMBOL_CHARSET_RE = /^[A-Z0-9.]+$/u;
const SUFFIXED_SYMBOL_RE = /^[A-Z0-9.]+\.[A-Z]{2,4}$/u;
const BARE_TICKER_RE = /^[A-Z]{1,6}$/u;

/**
 * Validates and normalizes a `/stock/<code>` path segment. Returns `null`
 * for anything that isn't a safe, well-formed symbol (empty, disallowed
 * characters, or - defensively - a path-traversal-shaped segment), which the
 * route turns into a 404. See module doc for the exact normalization rule
 * and its deliberate divergence from report-data.mjs's normalizeSymbol.
 */
export function normalizeStockSymbol(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed || !SYMBOL_CHARSET_RE.test(trimmed)) {
    return null;
  }

  let normalized: string;
  if (SUFFIXED_SYMBOL_RE.test(trimmed) || trimmed.startsWith(".")) {
    normalized = trimmed;
  } else if (BARE_TICKER_RE.test(trimmed)) {
    normalized = `${trimmed}.US`;
  } else {
    normalized = trimmed;
  }

  return SYMBOL_CHARSET_RE.test(normalized) ? normalized : null;
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: StockRouteDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/** `YYYY-MM-DD` for a given instant, in Asia/Shanghai (same construction as
 * routes/reports.ts's formatBeijingDate - Beijing has no DST, so a fixed
 * IANA zone is exact year-round). Not imported from reports.ts: each route
 * file owns its own small formatting helpers per this codebase's existing
 * per-page-freshness-rule convention (see routes/home.ts's own comment on
 * why it doesn't share reports.ts's freshness rule either). */
function formatBeijingDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

/**
 * Honest freshness for this page (Global Constraints: never silently render
 * stale/missing data as if current): no matching report at all -> 部分缺失
 * (the page's own body already says 暂无公共分析/暂无历史分析 - the pill must
 * agree, not show a green 最新); the newest matching report is dated today
 * (Beijing) -> 最新; anything older -> 延迟. Mirrors routes/reports.ts's
 * reading-page freshness rule (entry.date === today), applied to "newest
 * report that mentions this symbol" instead of "the one report this page is".
 */
function computeSymbolFreshness(latest: SymbolReportMatch | undefined, now: Date): Freshness {
  if (!latest) {
    return "部分缺失";
  }
  return latest.entry.date === formatBeijingDate(now) ? "最新" : "延迟";
}

function requireIdentity(req: IncomingMessage, res: ServerResponse, db: DatabaseSync, nonce: string): Member | null {
  const member = resolveIdentity(req, db);
  if (!member) {
    sendHtml(res, 401, renderUnauthorizedPage(nonce));
    return null;
  }
  return member;
}

function renderNotFoundPage(member: Member, nonce: string, now: Date): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>未找到</h2>
      <p style="font-size:13px;color:var(--sub)">该股票代码不存在，或格式不正确。</p>
    </section>
  </div>`;
  return renderPage({
    title: "未找到",
    nav: "paper",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

// ---------------------------------------------------------------------------
// Per-symbol section extraction from stock-analysis reports (Task 4 scanner)
// ---------------------------------------------------------------------------

/**
 * Finds the `## <SYMBOL>` section (report-data.mjs/stock-analysis.mjs's
 * per-symbol H2 heading convention - see reports/stock-analysis/*.md) inside
 * a report's raw markdown and returns its body (the lines between that
 * heading and the next H2, exclusive of both), or `null` if the report never
 * mentions this symbol as its own section.
 */
function findSymbolSection(md: string, symbol: string): string | null {
  const lines = md.replace(/\r\n/gu, "\n").split("\n");
  const heading = `## ${symbol}`;

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === heading) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/u.test((lines[i] ?? "").trim())) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
}

/**
 * Extracts a one-line summary from a symbol section's body: the first
 * non-empty line, skipping nested (`###`) headings, with any leading list
 * marker (`- `/`1. `) stripped. Stock-analysis reports are almost entirely
 * bullet lists (see reports/stock-analysis/*.md) rather than prose
 * paragraphs, so - unlike routes/reports.ts's extractFirstParagraph (which
 * deliberately SKIPS list items for daily/weekly reports' real prose) - the
 * first bullet line IS the meaningful content here.
 */
function extractSectionSummary(sectionBody: string): string {
  for (const rawLine of sectionBody.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^#{1,6}\s+/u.test(trimmed)) {
      continue;
    }
    return trimmed.replace(/^[-*]\s+/u, "").replace(/^\d+[.)]\s+/u, "");
  }
  return "（无摘要内容）";
}

interface SymbolReportMatch {
  entry: ReportIndexEntry;
  summary: string;
}

/** All stock-analysis reports (newest first, per scanReports' own ordering)
 * that mention this symbol as a per-symbol section, with that section's
 * summary already extracted - shared by both the "最新公共分析摘要" block
 * (takes index 0) and the "历史分析列表" block (uses the whole list). */
function loadSymbolReportMatches(repoRoot: string, symbol: string): SymbolReportMatch[] {
  const entries = scanReports(repoRoot).filter((entry) => entry.type === "stock-analysis");
  const matches: SymbolReportMatch[] = [];
  for (const entry of entries) {
    let md: string;
    try {
      md = readFileSync(entry.mdPath, "utf8");
    } catch {
      continue;
    }
    const section = findSymbolSection(md, symbol);
    if (section !== null) {
      matches.push({ entry, summary: extractSectionSummary(section) });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// 我的论点卡: theses owned by the viewer, plus other members' PUBLIC theses,
// on this symbol - grouped by owner. `visibility = 'system'` (the schema's
// non-public value, database.ts) is treated as "not visible to other
// members", matching the same rule Task 7's strategy/member-card pages use
// ("本人全见；他人仅 public"). Enforced in the WHERE clause itself, not
// filtered in JS after an unfiltered fetch.
// ---------------------------------------------------------------------------

export interface ThesisRow {
  id: string;
  ownerId: string;
  ownerDisplayName: string;
  direction: "bull" | "bear" | "neutral";
  targetLow: number | null;
  targetHigh: number | null;
  invalidationPrice: number | null;
  visibility: "system" | "public";
  status: "active" | "withdrawn" | "superseded";
  createdAt: string;
}

function loadThesesForSymbol(db: DatabaseSync, viewerId: string, symbol: string): ThesisRow[] {
  const rows = db
    .prepare(`
      SELECT t.id AS id, t.owner_id AS owner_id, m.display_name AS owner_display_name,
             t.direction AS direction, t.target_low AS target_low, t.target_high AS target_high,
             t.invalidation_price AS invalidation_price, t.visibility AS visibility,
             t.status AS status, t.created_at AS created_at
      FROM theses t
      JOIN members m ON m.id = t.owner_id
      WHERE t.symbol = ? AND (t.owner_id = ? OR t.visibility = 'public')
      ORDER BY (t.owner_id = ?) DESC, t.created_at DESC
    `)
    .all(symbol, viewerId, viewerId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerDisplayName: String(row.owner_display_name),
    direction: row.direction as ThesisRow["direction"],
    targetLow: row.target_low === null || row.target_low === undefined ? null : Number(row.target_low),
    targetHigh: row.target_high === null || row.target_high === undefined ? null : Number(row.target_high),
    invalidationPrice:
      row.invalidation_price === null || row.invalidation_price === undefined ? null : Number(row.invalidation_price),
    visibility: row.visibility as ThesisRow["visibility"],
    status: row.status as ThesisRow["status"],
    createdAt: String(row.created_at)
  }));
}

function groupThesesByOwner(theses: ThesisRow[]): Array<{ ownerId: string; ownerDisplayName: string; theses: ThesisRow[] }> {
  const order: string[] = [];
  const byOwner = new Map<string, { ownerId: string; ownerDisplayName: string; theses: ThesisRow[] }>();
  for (const thesis of theses) {
    let group = byOwner.get(thesis.ownerId);
    if (!group) {
      group = { ownerId: thesis.ownerId, ownerDisplayName: thesis.ownerDisplayName, theses: [] };
      byOwner.set(thesis.ownerId, group);
      order.push(thesis.ownerId);
    }
    group.theses.push(thesis);
  }
  return order.map((ownerId) => byOwner.get(ownerId) as { ownerId: string; ownerDisplayName: string; theses: ThesisRow[] });
}

// ---------------------------------------------------------------------------
// 我的该标的提醒历史: owner-scoped (viewer only) alert_events for this symbol.
// ---------------------------------------------------------------------------

export interface SymbolAlertEventRow {
  id: string;
  ruleType: string;
  triggeredAt: string;
  value: number;
}

const ALERT_HISTORY_LIMIT = 20;

const RULE_TYPE_LABELS: Record<string, string> = {
  daily_move: "日内波动",
  unrealized_pnl: "浮动盈亏",
  spike_5m: "5分钟异动",
  exposure: "敞口"
};

function loadAlertHistoryForSymbol(db: DatabaseSync, ownerId: string, symbol: string): SymbolAlertEventRow[] {
  const rows = db
    .prepare(`
      SELECT ae.id AS id, ar.rule_type AS rule_type, ae.triggered_at AS triggered_at, ae.value AS value
      FROM alert_events ae
      JOIN alert_rules ar ON ar.id = ae.rule_id
      WHERE ae.owner_id = ? AND ar.symbol = ?
      ORDER BY ae.triggered_at DESC
      LIMIT ?
    `)
    .all(ownerId, symbol, ALERT_HISTORY_LIMIT) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    ruleType: String(row.rule_type),
    triggeredAt: String(row.triggered_at),
    value: Number(row.value)
  }));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHeaderCard(symbol: string, latest: SymbolReportMatch | undefined): Html {
  const dataTime = latest ? latest.entry.date : "无历史分析数据";
  return html`<section class="card w2 dt-w4">
    <h2>${symbol}</h2>
    <p style="font-size:13px;color:var(--sub)">数据时间：<span class="mono">${dataTime}</span></p>
  </section>`;
}

function renderPublicSummaryCard(latest: SymbolReportMatch | undefined): Html {
  if (!latest) {
    return html`<section class="card w2 dt-w4">
      <h2>最新公共分析摘要</h2>
      <p style="font-size:13px;color:var(--sub)">暂无公共分析</p>
    </section>`;
  }
  return html`<section class="card w2 dt-w4">
    <h2>最新公共分析摘要 <span class="mono" style="font-size:11px;color:var(--sub)">${latest.entry.date}</span></h2>
    <p style="font-size:13.5px;line-height:1.7">${latest.summary}</p>
    <div style="margin-top:8px"><a href="/${latest.entry.type}/${latest.entry.date}" style="color:var(--accent);font-size:13px">阅读全文 →</a></div>
  </section>`;
}

const DIRECTION_LABELS: Record<string, string> = { bull: "看多", bear: "看空", neutral: "中性" };

function renderThesisRow(thesis: ThesisRow): Html {
  const label = DIRECTION_LABELS[thesis.direction] ?? thesis.direction;
  const range =
    thesis.targetLow !== null && thesis.targetHigh !== null
      ? html`目标区间 <span class="mono">${thesis.targetLow} - ${thesis.targetHigh}</span>`
      : html`目标区间未设定`;
  const invalidation =
    thesis.invalidationPrice !== null
      ? html` · 失效价 <span class="mono">${thesis.invalidationPrice}</span>`
      : trustedHtml("");
  return html`<div class="disc">${label} · ${range}${invalidation}</div>`;
}

function renderThesisCard(theses: ThesisRow[]): Html {
  if (theses.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>我的论点卡</h2>
      <p style="font-size:13px;color:var(--sub)">策略记忆 P7 上线</p>
    </section>`;
  }

  const groups = groupThesesByOwner(theses);
  const groupsHtml = joinHtml(
    groups.map(
      (group) =>
        html`<div style="margin-bottom:8px"><b style="font-size:12.5px">${group.ownerDisplayName}</b>${joinHtml(
          group.theses.map(renderThesisRow)
        )}</div>`
    )
  );

  return html`<section class="card w2 dt-w4">
    <h2>我的论点卡</h2>
    ${groupsHtml}
  </section>`;
}

function renderAlertHistoryRow(event: SymbolAlertEventRow): Html {
  const label = RULE_TYPE_LABELS[event.ruleType] ?? event.ruleType;
  return html`<div class="alert"><time class="mono">${event.triggeredAt}</time><span>${label} <b class="mono">${event.value}</b></span></div>`;
}

function renderAlertHistoryCard(events: SymbolAlertEventRow[]): Html {
  const body =
    events.length > 0
      ? joinHtml(events.map(renderAlertHistoryRow))
      : html`<p style="font-size:13px;color:var(--sub)">暂无提醒</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>我的该标的提醒历史</h2>
    ${body}
  </section>`;
}

function renderHistoryListCard(matches: SymbolReportMatch[]): Html {
  if (matches.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>历史分析列表</h2>
      <p style="font-size:13px;color:var(--sub)">暂无历史分析</p>
    </section>`;
  }
  const rows = joinHtml(
    matches.map(
      (match) =>
        html`<div class="alert"><time class="mono">${match.entry.date}</time><a href="/${match.entry.type}/${match.entry.date}" style="color:var(--accent)">${match.entry.title}</a></div>`
    )
  );
  return html`<section class="card w2 dt-w4">
    <h2>历史分析列表</h2>
    ${rows}
  </section>`;
}

function renderStockPage(
  res: ServerResponse,
  deps: StockRouteDeps,
  member: Member,
  symbol: string,
  nonce: string
): void {
  const now = currentNow(deps);
  const matches = loadSymbolReportMatches(deps.repoRoot, symbol);
  const latest = matches[0];
  const theses = loadThesesForSymbol(deps.db, member.id, symbol);
  const alertEvents = loadAlertHistoryForSymbol(deps.db, member.id, symbol);

  const bodyHtml = html`<div class="bento">${renderHeaderCard(symbol, latest)}</div>
    <div class="bento" style="margin-top:10px">${renderPublicSummaryCard(latest)}</div>
    <div class="bento" style="margin-top:10px">${renderThesisCard(theses)}</div>
    <div class="bento" style="margin-top:10px">${renderAlertHistoryCard(alertEvents)}</div>
    <div class="bento" style="margin-top:10px">${renderHistoryListCard(matches)}</div>`;

  const page = renderPage({
    title: symbol,
    nav: "paper",
    member: { displayName: member.displayName },
    freshness: computeSymbolFreshness(latest, now),
    degraded: [],
    bodyHtml,
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

/**
 * Routes `GET /stock/<code>`. Returns `true` if the request was handled
 * (including 401/404/405 responses), `false` if the path doesn't belong to
 * this module so the caller can keep trying other routes / fall through to
 * a generic 404.
 */
export function handleStockRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: StockRouteDeps,
  nonce: string
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== "stock") {
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

  const now = currentNow(deps);
  const symbol = normalizeStockSymbol(segments[1] as string);
  if (!symbol) {
    sendHtml(res, 404, renderNotFoundPage(member, nonce, now));
    return true;
  }

  renderStockPage(res, deps, member, symbol, nonce);
  return true;
}
