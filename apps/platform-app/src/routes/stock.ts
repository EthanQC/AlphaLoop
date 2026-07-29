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
 *
 * 2026-07-30 SPEC-DRIFT REMEDIATION (U1/U2/U3 - the operator opened this
 * page for TSM.US and screenshotted all three):
 *   U1 - the 提醒历史 rows rendered `alert_events.triggered_at` and
 *        `alert_events.value` verbatim (`2026-07-29T14:40:10.879Z  日内波动
 *        -0.03323902016262659`). Both now go through render/format.ts; the
 *        thesis judgment timeline had the same raw-instant shape and was
 *        fixed with it. The stored values survive in `title=` tooltips.
 *   U2 - the topbar said 「生成于 <request time>」 on a page whose content was
 *        3 days old, and the summary card was headed 「最新公共分析摘要」
 *        while quoting a 398 support level against a ~375 market. The
 *        topbar now states the DATA's time and age (`dataAsOf`), the card
 *        is headed 公共分析摘要 with an age pill and - past
 *        format.ts's STALE_AFTER_DAYS - an in-card warning, and
 *        `buildStockDegradations` raises the layout banner above the fold.
 *   U3 - the page was a bare symbol, a date, one summary and two empty
 *        blocks. It now opens with the real quote (price/涨跌/报价数据时间/
 *        来源 + an explicit "not realtime" line), adds a 关键数据 card built
 *        from data/stock-facts.ts (报价/估值/技术/期权与持仓, each cell
 *        carrying its source and data time), and every empty block says
 *        what would fill it and how. There is deliberately NO company-name
 *        line - nothing in this system produces one (see renderHeaderCard).
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { loadLatestFactSheet, type StockFactRow, type SymbolFactSheet } from "../data/stock-facts.js";
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
import { renderEmptyState, renderInlineEmptyState } from "../render/empty-state.js";
import {
  beijingDayAge,
  beijingInstantAge,
  describeDataDay,
  describeDataInstant,
  formatAlertValue,
  formatBeijingDay,
  formatBeijingShortTime,
  formatInteger,
  formatLargeAmount,
  formatPercentUnits,
  formatPrice,
  formatRatioAsUnsignedPercent,
  MISSING_NUMBER_TEXT,
  type DataAge
} from "../render/format.js";
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

/** `YYYY-MM-DD` for a given instant, in Asia/Shanghai. Now a thin alias over
 * render/format.ts's shared implementation (2026-07-30): the app had five
 * near-identical private copies of this and they were free to drift. */
const formatBeijingDate = formatBeijingDay;

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
    // No data on this page at all - stating a data time would invent one.
    dataAsOf: null,
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
  /** The rule's configured threshold, also a decimal ratio - shown next to
   * the fired value so a reader can see WHY it fired, exactly as the Feishu
   * card does ("（阈值 ±4%）"). */
  threshold: number;
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
      SELECT ae.id AS id, ar.rule_type AS rule_type, ae.triggered_at AS triggered_at,
             ae.value AS value, ar.threshold AS threshold
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
    value: Number(row.value),
    threshold: Number(row.threshold)
  }));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Header + quote block (U3: the page opened with a bare symbol and a bare
// date; spec §1.9 wants 代码/名称/数据时间 and §0.4 wants every number stamped
// with its own data time).
//
// NAME: there is deliberately NO company-name line. Nothing in this system
// produces one - `stock_facts` has no name key, `stock_analysis_targets` is
// (symbol, owner) only, and the report markdown heads each section with the
// bare symbol. Rendering a name would mean inventing it. What IS derivable
// from the symbol honestly is its market (the dotted exchange suffix), so
// that is what the header shows next to the code.
// ---------------------------------------------------------------------------

const MARKET_LABELS: Record<string, string> = {
  US: "美股",
  HK: "港股",
  SH: "沪市",
  SZ: "深市"
};

/** `TSM.US` -> `美股`; an unknown/absent suffix yields null (no guess). */
function marketLabel(symbol: string): string | null {
  const suffix = /\.([A-Z]{2,4})$/u.exec(symbol)?.[1];
  return suffix ? (MARKET_LABELS[suffix] ?? suffix) : null;
}

/** Amber when the data is >= STALE_AFTER_DAYS old, plain otherwise. A null
 * age means we could not compute one - say so rather than imply freshness. */
function renderAgePill(age: DataAge | null): Html {
  if (!age) {
    return html`<span class="pill" style="background:var(--card2);color:var(--sub)">数据时间不可解析</span>`;
  }
  return age.stale
    ? html`<span class="pill warn">${age.ago}</span>`
    : html`<span class="pill ok">${age.ago}</span>`;
}

function renderHeaderCard(symbol: string, sheet: SymbolFactSheet | null, now: Date): Html {
  const market = marketLabel(symbol);
  const quote = sheet?.byKey.get("quote.last") ?? null;
  const pct = sheet?.byKey.get("quote.pct") ?? null;

  const quoteLine = quote
    ? html`<div style="display:flex;align-items:baseline;gap:10px;margin-top:6px">
          <span class="mono" style="font-size:26px;font-weight:600">${formatPrice(quote.valueNum)}</span>
          <span class="mono ${pct && pct.valueNum !== null && pct.valueNum < 0 ? "d" : "u"}" style="font-size:15px">${
            pct && pct.valueNum !== null ? formatPercentUnits(pct.valueNum) : MISSING_NUMBER_TEXT
          }</span>
          <span style="font-size:12px;color:var(--sub)">美元</span>
        </div>
        <p style="font-size:12px;color:var(--sub);margin:6px 0 0">
          报价数据时间 <span class="mono">${describeDataInstant(quote.dataTime, now)}</span> · 来源 ${quote.source}
        </p>
        <p style="font-size:11.5px;color:var(--sub);margin:4px 0 0;line-height:1.6">
          这不是实时行情（本平台不做实时看盘）。以上是平台最近一次抓取到的报价，交易请以券商 App 为准。
        </p>`
    : renderEmptyState(
        "尚未抓取到该标的的报价。",
        "报价随个股分析批次（每 3 天）与日报生产一并落库；该标的进入任一成员的标的池或持仓后即会开始抓取。"
      );

  return html`<section class="card w2 dt-w4">
    <h2>${symbol}${market ? html` <span class="pill" style="background:var(--card2);color:var(--sub)">${market}</span>` : trustedHtml("")}</h2>
    ${quoteLine}
  </section>`;
}

// ---------------------------------------------------------------------------
// 关键数据: the machine-checked stock_facts row set behind the analysis.
// ---------------------------------------------------------------------------

interface FactGroupDef {
  title: string;
  keys: ReadonlyArray<{ key: string; label: string }>;
}

const FACT_GROUPS: readonly FactGroupDef[] = [
  {
    title: "报价",
    keys: [
      { key: "quote.prevClose", label: "前收" },
      { key: "quote.open", label: "开盘" },
      { key: "quote.high", label: "最高" },
      { key: "quote.low", label: "最低" },
      { key: "quote.volume", label: "成交量" }
    ]
  },
  {
    title: "估值",
    keys: [
      { key: "valuation.pe", label: "市盈率 PE" },
      { key: "valuation.pb", label: "市净率 PB" },
      { key: "valuation.eps", label: "每股收益 EPS" },
      { key: "valuation.marketCap", label: "市值" },
      { key: "valuation.targetPrice", label: "分析师目标价" }
    ]
  },
  {
    title: "技术",
    keys: [
      { key: "history.ma20", label: "MA20" },
      { key: "history.ma60", label: "MA60" },
      { key: "history.maLong", label: "长周期均线" }
    ]
  },
  {
    title: "期权与持仓",
    keys: [
      { key: "options.callOi", label: "看涨未平仓" },
      { key: "options.putOi", label: "看跌未平仓" },
      { key: "options.nextExpiry", label: "下一到期日" },
      { key: "institutional.holdings", label: "机构持仓" },
      { key: "news.count", label: "近期新闻条数" }
    ]
  }
];

/**
 * Renders one fact's value with its unit. `value_text` wins when present -
 * it is producer-authored prose (including honest 不可得 disclosures) and is
 * shown verbatim. `unit` is free text (see data/stock-facts.ts): the four
 * numeric units the live table actually uses are formatted properly, and
 * anything else is appended after the number rather than dropped.
 */
function formatFactValue(fact: StockFactRow): string {
  if (fact.valueText !== null && fact.valueText !== "") {
    return fact.valueText;
  }
  if (fact.valueNum === null || !Number.isFinite(fact.valueNum)) {
    return MISSING_NUMBER_TEXT;
  }
  if (fact.factKey === "valuation.marketCap") {
    return formatLargeAmount(fact.valueNum);
  }
  switch (fact.unit) {
    case "USD":
      return `${formatPrice(fact.valueNum)} 美元`;
    case "pct":
      return formatPercentUnits(fact.valueNum);
    case "shares":
      return `${formatInteger(fact.valueNum)} 股`;
    case "contracts":
      return `${formatInteger(fact.valueNum)} 张`;
    case "count":
      return `${formatInteger(fact.valueNum)} 条`;
    case null:
    case "":
      return fact.valueNum.toFixed(2);
    default:
      return `${fact.valueNum.toFixed(2)}（${fact.unit}）`;
  }
}

function renderFactGroup(group: FactGroupDef, sheet: SymbolFactSheet): Html | null {
  const rows = group.keys
    .map(({ key, label }) => ({ label, fact: sheet.byKey.get(key) }))
    .filter((row): row is { label: string; fact: StockFactRow } => row.fact !== undefined);
  if (rows.length === 0) {
    return null;
  }
  const cells = joinHtml(
    rows.map(
      (row) =>
        html`<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0">
          <span style="font-size:12.5px;color:var(--sub)">${row.label}</span>
          <span class="mono" style="font-size:12.5px" title="来源 ${row.fact.source}｜数据时间 ${row.fact.dataTime}">${formatFactValue(row.fact)}</span>
        </div>`
    )
  );
  return html`<div style="margin-bottom:10px">
    <div style="font-size:12px;color:var(--sub);font-weight:600;margin-bottom:2px">${group.title}</div>
    ${cells}
  </div>`;
}

function renderFactSheetCard(sheet: SymbolFactSheet | null, now: Date): Html {
  if (!sheet) {
    return html`<section class="card w2 dt-w4">
      <h2>关键数据</h2>
      ${renderEmptyState(
        "还没有这只标的的机械核对数据（报价、估值、均线、期权持仓）。",
        "这些数字由个股分析生产流水线写入 stock_facts；把该标的加入自己的标的池后，下一轮个股分析（每 3 天一批）就会开始填充。"
      )}
    </section>`;
  }

  const groups = FACT_GROUPS.map((group) => renderFactGroup(group, sheet)).filter(
    (group): group is Html => group !== null
  );
  const age = beijingDayAge(sheet.tradingDay, now);

  return html`<section class="card w2 dt-w4">
    <h2>关键数据 <span class="mono" style="font-size:11px;color:var(--sub)">交易日 ${sheet.tradingDay}</span> ${renderAgePill(age)}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 22px">${joinHtml(groups)}</div>
    <p style="font-size:11.5px;color:var(--sub);margin:2px 0 0">每个数字的来源与数据时间在悬停提示中；同一张表内的数字都来自 ${sheet.tradingDay} 这一个交易日，不混用不同日期。</p>
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

/**
 * U2: this card used to be headed 「最新公共分析摘要」 with a bare date, and
 * that word 最新 was doing real damage - on 07-30 it introduced a 07-27
 * analysis quoting a 398 support level while the stock traded near 375, and
 * a reader takes 最新 at face value. The card is now headed 公共分析摘要
 * (a statement of what it is, not a freshness claim) with the report's date,
 * an age pill, and - once the analysis is STALE_AFTER_DAYS old - an explicit
 * in-card warning that the price levels inside it are that old. The page
 * additionally raises the layout's degradation banner (see renderStockPage),
 * so the warning is visible before the reader scrolls to this card.
 */
function renderPublicSummaryCard(latest: SymbolReportMatch | undefined, now: Date): Html {
  if (!latest) {
    return html`<section class="card w2 dt-w4">
      <h2>公共分析摘要</h2>
      ${renderEmptyState(
        "还没有公开发布过这只标的的个股分析。",
        "个股分析是公共资产，按「全体成员标的池并集 + 全体持仓」每 3 天批量生产一轮；把该标的加入自己的标的池，下一轮就会覆盖到它。"
      )}
    </section>`;
  }

  const age = beijingDayAge(latest.entry.date, now);
  const box = parseConclusionBox(latest.section);
  const staleNote =
    age?.stale === true
      ? html`<p class="a" style="font-size:12px;margin:0 0 8px;line-height:1.65">
          ⚠ 这份分析已是 ${age.ago}的结论。其中的价格、支撑位与估值区间来自 ${latest.entry.date} 的行情，可能与当前价格严重不符，不要当作当前判断使用。
        </p>`
      : trustedHtml("");

  const bodyHtml = box
    ? html`<p style="font-size:13.5px;line-height:1.7">${box.coreConclusion} ${CONFIDENCE_PILL_HTML[box.confidence]}</p>
        <p style="font-size:12.5px;color:var(--sub)">合理价值区间：<span class="mono">${box.valueRange.low.toFixed(2)}–${box.valueRange.high.toFixed(2)}</span> 美元（${latest.entry.date} 的判断）</p>
        <p style="font-size:12.5px;color:var(--sub)">复盘日期：<span class="mono">${box.reviewDate}</span></p>`
    : html`<p style="font-size:13.5px;line-height:1.7">${latest.summary}</p>
        <p style="font-size:11.5px;color:var(--sub)">旧格式无结论框</p>`;

  return html`<section class="card w2 dt-w4">
    <h2>公共分析摘要 <span class="mono" style="font-size:11px;color:var(--sub)">${latest.entry.date}</span> ${renderAgePill(age)}</h2>
    ${staleNote}
    ${bodyHtml}
    <div style="margin-top:8px"><a href="/${latest.entry.type}/${latest.entry.date}" style="color:var(--accent);font-size:13px">阅读全文 →</a></div>
  </section>`;
}

const DIRECTION_LABELS: Record<string, string> = { bull: "看多", bear: "看空", neutral: "中性" };
const VISIBILITY_LABELS: Record<string, string> = { system: "系统可用", public: "公开" };

function renderEvidencePoints(points: string[]): Html {
  if (points.length === 0) {
    return renderInlineEmptyState("暂无依据（可在飞书单聊补一句，会追加到这条论点上）");
  }
  return joinHtml(points.map((point) => html`<li style="font-size:12.5px">${point}</li>`));
}

function renderJudgmentTimeline(history: ThesisHistoryRow[]): Html {
  if (history.length === 0) {
    return renderInlineEmptyState("暂无判断历史——每次在飞书里对这只标的补一句判断，都会 append 一行到这里，不可删改");
  }
  const rows = joinHtml(
    history.map(
      // U1: `entry.createdAt` is a raw ISO instant in the column; a reader
      // gets Beijing wall-clock, with the exact stored value in `title`.
      (entry) =>
        html`<div class="alert"><time class="mono" title="${entry.createdAt}">${formatBeijingShortTime(entry.createdAt)}</time><span>${entry.note} <span style="color:var(--sub)">· ${entry.source}</span></span></div>`
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
  symbol: string,
  theses: ThesisEvidenceRow[],
  historyByThesisId: Map<string, ThesisHistoryRow[]>,
  latestPrice: number | null
): Html {
  if (theses.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>我的论点卡</h2>
      ${renderEmptyState(
        `你还没有记过 ${symbol} 的论点，圈内也没有人公开过这只标的的论点。`,
        `论点卡记的是「看多/看空 + 目标区间 + 失效价 + 依据」，系统会拿它做策略对照、按代码回算事后走势与命中率。在飞书单聊里说一句「记一条 ${symbol} 的看多论点，目标 x 到 y，跌破 z 失效」即可创建；默认「系统可用」档（只有你看得见），需要时再一键升为公开。`
      )}
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

/**
 * U1, the row the operator screenshotted. It used to render
 *
 *   <time>2026-07-29T14:40:10.879Z</time> 日内波动 <b>-0.03323902016262659</b>
 *
 * - the raw `triggered_at` column and the raw `value` column. `value` is a
 * decimal ratio for every rule type (contract verified against
 * market-alerts-engine.mjs; see render/format.ts's header), so it now reads
 * as a signed percentage, and the instant reads as Beijing wall-clock. The
 * exact stored values stay reachable in the `title` attributes rather than
 * being lost: this IS the audit trail for a fired alert.
 */
function renderAlertHistoryRow(event: SymbolAlertEventRow): Html {
  const label = RULE_TYPE_LABELS[event.ruleType] ?? event.ruleType;
  const cls = event.value < 0 ? "d" : "u";
  return html`<div class="alert">
    <time class="mono" title="${event.triggeredAt}">${formatBeijingShortTime(event.triggeredAt)}</time>
    <span>${label} <b class="mono ${cls}" title="原始值 ${String(event.value)}">${formatAlertValue(event.ruleType, event.value)}</b>
      <span style="color:var(--sub)">（阈值 ±${formatRatioAsUnsignedPercent(Math.abs(event.threshold))}）</span></span>
  </div>`;
}

function renderAlertHistoryCard(symbol: string, events: SymbolAlertEventRow[]): Html {
  const body =
    events.length > 0
      ? html`${joinHtml(events.map(renderAlertHistoryRow))}
          <p style="font-size:11.5px;color:var(--sub);margin:8px 0 0">时间为北京时间；百分比为该规则触发时的实际变动幅度，与飞书提醒卡上的同一次触发一一对应（卡片取 1 位小数，此处取 2 位）。</p>`
      : renderEmptyState(
          `你在 ${symbol} 上还没有触发过提醒。`,
          `提醒来自你自己的提醒规则（日内波动 / 浮动盈亏 / 5分钟异动 / 组合敞口）。在飞书单聊里说一句「给 ${symbol} 加一条跌 4% 提醒」即可建规则；规则的标的必须在你自己的标的池或持仓里。`
        );
  return html`<section class="card w2 dt-w4">
    <h2>我的该标的提醒历史</h2>
    ${body}
  </section>`;
}

function renderHistoryListCard(matches: SymbolReportMatch[], now: Date): Html {
  if (matches.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>历史分析列表</h2>
      ${renderEmptyState(
        "这只标的还没有任何一期个股分析。",
        "个股分析每 3 天批量生产一轮，覆盖「全体成员标的池并集 + 全体持仓」；此外站内研究若触发新的个股分析，也会并入公共分析库的正常节奏发布。"
      )}
    </section>`;
  }
  const rows = joinHtml(
    matches.map((match) => {
      const age = beijingDayAge(match.entry.date, now);
      return html`<div class="alert">
        <time class="mono">${match.entry.date}</time>
        <a href="/${match.entry.type}/${match.entry.date}" style="color:var(--accent)">${match.entry.title}</a>
        <span style="color:var(--sub);font-size:11px">${age ? age.ago : ""}</span>
      </div>`;
    })
  );
  return html`<section class="card w2 dt-w4">
    <h2>历史分析列表 <span class="pill" style="background:var(--card2);color:var(--sub)">${matches.length} 期</span></h2>
    ${rows}
  </section>`;
}

/**
 * The topbar's 数据时间 (U2). Prefers the quote sheet's own instant (the
 * freshest dated thing on the page), then its trading day, then the newest
 * analysis's date; null when the page genuinely has no dated content -
 * saying nothing beats stamping the page with the request's clock.
 */
function describeStockDataAsOf(
  sheet: SymbolFactSheet | null,
  latest: SymbolReportMatch | undefined,
  now: Date
): string | null {
  const quote = sheet?.byKey.get("quote.last");
  if (quote?.dataTime) {
    return describeDataInstant(quote.dataTime, now);
  }
  if (sheet) {
    return describeDataDay(sheet.tradingDay, now);
  }
  if (latest) {
    return describeDataDay(latest.entry.date, now);
  }
  return null;
}

/**
 * The layout's degradation banner entries - "绝不静默" (req §1.1). Stale
 * quotes and a stale analysis are reported SEPARATELY because they go stale
 * for different reasons and a reader needs to know which one is old: on
 * 2026-07-30 the operator saw a 07-27 analysis quoting a 398 support level
 * against a real price near 375, and the page said nothing about it.
 */
function buildStockDegradations(
  sheet: SymbolFactSheet | null,
  latest: SymbolReportMatch | undefined,
  now: Date
): string[] {
  const reasons: string[] = [];

  const quote = sheet?.byKey.get("quote.last");
  const quoteAge = quote?.dataTime ? beijingInstantAge(quote.dataTime, now) : null;
  if (quote && quoteAge?.stale === true) {
    reasons.push(
      `报价数据停在 ${formatBeijingShortTime(quote.dataTime)}（${quoteAge.ago}），页面上的价格不是当前价格。行情抓取可能已中断，请以券商 App 为准。`
    );
  } else if (!quote) {
    reasons.push("没有抓到这只标的的报价，本页不显示任何现价。");
  }

  const analysisAge = latest ? beijingDayAge(latest.entry.date, now) : null;
  if (latest && analysisAge?.stale === true) {
    reasons.push(
      `最近一期个股分析是 ${latest.entry.date} 的（${analysisAge.ago}），其中的支撑位、估值区间与结论均基于当时行情，不代表现在。`
    );
  }

  return reasons;
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
  const factSheet = loadLatestFactSheet(deps.db, symbol);

  const bodyHtml = html`<div class="bento">${renderHeaderCard(symbol, factSheet, now)}</div>
    <div class="bento" style="margin-top:10px">${renderPublicSummaryCard(latest, now)}</div>
    <div class="bento" style="margin-top:10px">${renderFactSheetCard(factSheet, now)}</div>
    <div class="bento" style="margin-top:10px">${renderThesisCard(symbol, theses, historyByThesisId, latestPrice)}</div>
    <div class="bento" style="margin-top:10px">${renderAlertHistoryCard(symbol, alertEvents)}</div>
    <div class="bento" style="margin-top:10px">${renderHistoryListCard(matches, now)}</div>`;

  const page = renderPage({
    title: symbol,
    nav: "paper",
    member: { displayName: member.displayName },
    freshness: computeSymbolFreshness(latest, now),
    // U2: the topbar states the DATA's time, not the request's. The quote
    // sheet is this page's freshest dated content, so it names the data
    // time; with no quotes at all we fall back to the newest analysis's
    // date, and with neither there is honestly no data time to state.
    dataAsOf: describeStockDataAsOf(factSheet, latest, now),
    degraded: buildStockDegradations(factSheet, latest, now),
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
