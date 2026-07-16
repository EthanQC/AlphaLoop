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
 * market); anything else is returned as-is. CHARSET (Phase 5 Task 5,
 * 2026-07-15 plan): originally this route's charset was `[A-Z0-9.]` only
 * (letters, digits, dots) - deliberately narrower than report-data.mjs's own
 * `[A-Z0-9.-]` (which permits a hyphen), per Task 3's brief ("Validate code:
 * uppercase alnum + dots"). Task 5 widens it to `[A-Z0-9.-]` to align with
 * report-data.mjs's normalizeSymbol charset - a class-share ticker like
 * `BRK-B` (Yahoo's own hyphenated convention, see stock-analysis.mjs's
 * toYahooSymbol) no longer 404s outright. This route still VALIDATES and
 * rejects anything outside the (now slightly wider) charset -
 * report-data.mjs itself never rejects anything, it only transforms
 * best-effort - so that difference in behavior remains. Any input
 * containing a character outside the charset (before OR after
 * normalization) is rejected -> the route 404s. This also happens to be the
 * path-traversal guard: `/stock/<code>` only ever reaches this validator
 * with a single URL path segment (Node's URL parser already collapses
 * `..`/`%2e%2e` dot-segments before routing ever sees them - verified
 * empirically), and any residual encoded traversal attempt (e.g. a literal
 * `%2f` byte sequence that survives as text in the segment) contains a `%`
 * character that this charset rejects outright; a bare hyphen is harmless
 * and was never part of any traversal-shaped input this route needs to
 * reject.
 *
 * SUMMARY CARD (Phase 5 Task 5): `renderPublicSummaryCard` below parses the
 * newest matching report's own symbol section through
 * `../reports/conclusion-box.js`'s `parseConclusionBox` (a TS port of
 * apps/openclaw-config/scripts/conclusion-box.mjs - see that file's own doc
 * comment for the shared-fixture anti-drift test). A new-format report (one
 * whose symbol section contains a "### 结论框" block) renders the
 * structured 核心结论/置信度/合理价值区间/复盘日期; a legacy report (box is
 * `null`) falls back to the pre-Task-5 first-bullet summary, with an
 * explicit "旧格式无结论框" note so a viewer never mistakes the fallback for
 * a structured result that simply happens to be terse.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import {
  computeThesisOutcome,
  groupThesesByOwner,
  loadLatestPriceForSymbol,
  loadThesesForSymbol,
  loadThesisHistory,
  type ThesisEvidenceRow,
  type ThesisHistoryRow
} from "../data/strategy.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { CONFIDENCE_LABELS, parseConclusionBox } from "../reports/conclusion-box.js";
import { scanReports, type ReportIndexEntry } from "../reports/scanner.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderPage, type Freshness } from "../render/layout.js";

export interface StockRouteDeps {
  db: DatabaseSync;
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

/** Letters, digits, dots, and hyphens - see module doc's CHARSET section for
 * why this now matches report-data.mjs's own `[A-Z0-9.-]` charset (Phase 5
 * Task 5 widened it from an earlier, deliberately narrower `[A-Z0-9.]`). */
const SYMBOL_CHARSET_RE = /^[A-Z0-9.-]+$/u;
const SUFFIXED_SYMBOL_RE = /^[A-Z0-9.-]+\.[A-Z]{2,4}$/u;
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
  /** The full `## SYMBOL` section body (Phase 5 Task 5) - kept alongside the
   * already-extracted `summary` so renderPublicSummaryCard can additionally
   * run it through `parseConclusionBox` without re-reading/re-scanning the
   * report file a second time. */
  section: string;
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
      matches.push({ entry, summary: extractSectionSummary(section), section });
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
// filtered in JS after an unfiltered fetch. Reader/grouping logic lives in
// data/strategy.ts (Phase 7 Task 5) - shared with routes/strategy.ts and
// routes/member-card.ts now that bull_points/bear_points JSON parsing would
// otherwise be tripled across three separate route files.
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

// Phase 5 Task 5 (2026-07-15 plan): confidence -> pill class/style. 高 gets
// the same "ok" (up-color) pill freshness.ts/paper.ts already use for a
// healthy state; 中 gets "warn" (amber), same class home.ts/paper.ts use for
// a degraded-but-not-broken state; 低 has no existing CSS class for a
// muted/sub-colored pill, so it inline-styles with --card2/--sub, mirroring
// research.ts's own sub-muted inline-styled pill (see that file's
// visibilityLabel pill) rather than inventing a fourth global CSS class for
// a single call site.
const CONFIDENCE_PILL_HTML: Record<string, Html> = {
  high: html`<span class="pill ok">${CONFIDENCE_LABELS.high}</span>`,
  medium: html`<span class="pill warn">${CONFIDENCE_LABELS.medium}</span>`,
  low: html`<span class="pill" style="background:var(--card2);color:var(--sub)">${CONFIDENCE_LABELS.low}</span>`
};

function renderPublicSummaryCard(latest: SymbolReportMatch | undefined): Html {
  if (!latest) {
    return html`<section class="card w2 dt-w4">
      <h2>最新公共分析摘要</h2>
      <p style="font-size:13px;color:var(--sub)">暂无公共分析</p>
    </section>`;
  }

  const box = parseConclusionBox(latest.section);
  const bodyHtml = box
    ? html`<p style="font-size:13.5px;line-height:1.7">${box.coreConclusion} ${CONFIDENCE_PILL_HTML[box.confidence]}</p>
        <p style="font-size:12.5px;color:var(--sub)">合理价值区间：<span class="mono">${box.valueRange.low.toFixed(2)}–${box.valueRange.high.toFixed(2)}</span> 美元</p>
        <p style="font-size:12.5px;color:var(--sub)">复盘日期：<span class="mono">${box.reviewDate}</span></p>`
    : html`<p style="font-size:13.5px;line-height:1.7">${latest.summary}</p>
        <p style="font-size:11.5px;color:var(--sub)">旧格式无结论框</p>`;

  return html`<section class="card w2 dt-w4">
    <h2>最新公共分析摘要 <span class="mono" style="font-size:11px;color:var(--sub)">${latest.entry.date}</span></h2>
    ${bodyHtml}
    <div style="margin-top:8px"><a href="/${latest.entry.type}/${latest.entry.date}" style="color:var(--accent);font-size:13px">阅读全文 →</a></div>
  </section>`;
}

const DIRECTION_LABELS: Record<string, string> = { bull: "看多", bear: "看空", neutral: "中性" };
const VISIBILITY_LABELS: Record<string, string> = { system: "系统可用", public: "公开" };

function renderEvidencePoints(points: string[]): Html {
  if (points.length === 0) {
    return html`<p style="font-size:12px;color:var(--sub);margin:2px 0 0">暂无依据</p>`;
  }
  return joinHtml(points.map((point) => html`<li style="font-size:12.5px">${point}</li>`));
}

function renderJudgmentTimeline(history: ThesisHistoryRow[]): Html {
  if (history.length === 0) {
    return html`<p style="font-size:12px;color:var(--sub);margin-top:6px">暂无判断历史</p>`;
  }
  const rows = joinHtml(
    history.map(
      (entry) =>
        html`<div class="alert"><time class="mono">${entry.createdAt}</time><span>${entry.note} <span style="color:var(--sub)">· ${entry.source}</span></span></div>`
    )
  );
  return html`<div style="margin-top:6px">${rows}</div>`;
}

function renderOutcomeLine(hitRate: ReturnType<typeof computeThesisOutcome>["hitRate"]): Html {
  if (hitRate.sample === "insufficient") {
    return html`<p style="font-size:12px;color:var(--sub);margin-top:4px">样本不足（已判断 ${hitRate.n} 次）</p>`;
  }
  return html`<p style="font-size:12px;color:var(--sub);margin-top:4px">命中率 ${(hitRate.hitFraction * 100).toFixed(0)}%（${hitRate.hits} 命中 / ${hitRate.total} 共判断，样本 ${hitRate.n} 次）</p>`;
}

function renderThesisRow(thesis: ThesisEvidenceRow, history: ThesisHistoryRow[], latestPrice: number | null): Html {
  const label = DIRECTION_LABELS[thesis.direction] ?? thesis.direction;
  const visibilityLabel = VISIBILITY_LABELS[thesis.visibility] ?? thesis.visibility;
  const range =
    thesis.targetLow !== null && thesis.targetHigh !== null
      ? html`目标区间 <span class="mono">${thesis.targetLow} - ${thesis.targetHigh}</span>`
      : html`目标区间未设定`;
  const invalidation =
    thesis.invalidationPrice !== null
      ? html` · 失效价 <span class="mono">${thesis.invalidationPrice}</span>`
      : trustedHtml("");

  const outcome = computeThesisOutcome({
    thesis: { direction: thesis.direction, targetLow: thesis.targetLow, targetHigh: thesis.targetHigh, invalidationPrice: thesis.invalidationPrice },
    judgments: history.map((entry) => ({ id: entry.id })),
    latestPrice
  });

  return html`<div class="disc" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed var(--line)">
    ${label} · ${range}${invalidation}
    <span class="pill" style="margin-left:6px;background:var(--accent-soft);color:var(--accent)">${visibilityLabel}</span>
    <div style="display:flex;gap:16px;margin-top:8px">
      <div style="flex:1"><div style="font-size:12px;color:var(--sub)">看多依据</div><ul style="margin:4px 0 0;padding-left:16px">${renderEvidencePoints(thesis.bullPoints)}</ul></div>
      <div style="flex:1"><div style="font-size:12px;color:var(--sub)">看空依据</div><ul style="margin:4px 0 0;padding-left:16px">${renderEvidencePoints(thesis.bearPoints)}</ul></div>
    </div>
    ${renderJudgmentTimeline(history)}
    ${history.length > 0 ? renderOutcomeLine(outcome.hitRate) : trustedHtml("")}
  </div>`;
}

function renderThesisCard(
  theses: ThesisEvidenceRow[],
  historyByThesisId: Map<string, ThesisHistoryRow[]>,
  latestPrice: number | null
): Html {
  if (theses.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>我的论点卡</h2>
      <p style="font-size:13px;color:var(--sub)">暂无论点</p>
    </section>`;
  }

  const groups = groupThesesByOwner(theses);
  const groupsHtml = joinHtml(
    groups.map(
      (group) =>
        html`<div style="margin-bottom:8px"><b style="font-size:12.5px">${group.ownerDisplayName}</b>${joinHtml(
          group.theses.map((thesis) => renderThesisRow(thesis, historyByThesisId.get(thesis.id) ?? [], latestPrice))
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
  const historyByThesisId = new Map<string, ThesisHistoryRow[]>();
  for (const thesis of theses) {
    historyByThesisId.set(thesis.id, loadThesisHistory(deps.db, thesis.id));
  }
  const latestPrice = loadLatestPriceForSymbol(deps.db, symbol);
  const alertEvents = loadAlertHistoryForSymbol(deps.db, member.id, symbol);

  const bodyHtml = html`<div class="bento">${renderHeaderCard(symbol, latest)}</div>
    <div class="bento" style="margin-top:10px">${renderPublicSummaryCard(latest)}</div>
    <div class="bento" style="margin-top:10px">${renderThesisCard(theses, historyByThesisId, latestPrice)}</div>
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
