/**
 * Paper-trading page (Task 6): `GET /paper`. Identity-gated like every route
 * past Task 3.
 *
 * Default view = the viewer's own paper account. `?member=<id>` switches
 * whose account is shown, restricted to the member-switcher chips
 * (`MemberRepository.listActive()`, with `__legacy_system__` explicitly
 * excluded even if its status were ever forced active - same defense-in-
 * depth guard as identity.ts's LEGACY_SYSTEM_MEMBER_ID check).
 *
 * PRIVACY (plan Task 6, req §1.6 - server-enforced, not a UI hint):
 *   Viewing another member whose `show_performance = 0` replaces their
 *   KPI/curve/holdings/bar/donut blocks with a single 「对方未公开战绩」 card,
 *   and - critically - their snapshot rows are NEVER QUERIED to produce that
 *   card. The gate runs BEFORE `loadLatestSnapshotForOwner`/
 *   `loadSnapshotSeriesForOwner` are called, not after (see
 *   `loadPaperViewData` below) - a caller inspecting every SQL bound
 *   parameter this route executes will never find the hidden member's id,
 *   not just "never find it in the rendered HTML".
 *
 * `?compare=1` overlays a second member's net-worth curve onto the viewer's
 * own curve in the SAME chart (final.html's mockup has a "对比 mashu →" link
 * for exactly this - comparing against another member, not a benchmark).
 * The rest of the page (KPI/holdings/bar/donut) always stays pinned to the
 * viewer's OWN data in compare mode - compare is "my dashboard with an
 * overlay added", not a second full page swap. The overlaid member is
 * chosen via the same `?member=<id>` parameter; if that member hides
 * performance, only the viewer's own curve is drawn, plus the 「对方未公开
 * 战绩」 note - same never-query gate as the non-compare path.
 *
 * Chart colors (net-worth compare overlay + position donut) follow the
 * `dataviz` skill's validated categorical palette (references/palette.md),
 * run through `scripts/validate_palette.js` for both this app's light
 * (#FFFFFF) and dark (#101627) card surfaces before use - see
 * PAPER_PAGE_STYLE below for the concrete hex steps. Interactive hover/
 * tooltip (the skill's step 5) is deliberately NOT implemented: the plan's
 * architecture is server-rendered HTML with exactly one inline `<script>`
 * (the theme toggle, render/layout.ts) and no SPA/client framework: a static
 * chart with a direct-labeled legend and value labels in the KPI/holdings
 * cards is the readable fallback within that constraint.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { MemberRepository, methodNotAllowed, type Member } from "@packages/shared-types";

import {
  computeMaxDrawdownSegment,
  computePaperKpis,
  loadLatestSnapshotForOwner,
  loadSnapshotSeriesForOwner,
  type DrawdownSegment,
  type OwnerSnapshot,
  type PaperKpis,
  type SnapshotPosition,
  type SnapshotSeriesPoint
} from "../data/snapshots.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { freshnessPillClass, renderPage, type Freshness } from "../render/layout.js";

export interface PaperRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

// v7 migration placeholder (packages/shared-types database.ts) - not a real
// person, must never appear as a switchable member. Mirrors identity.ts's
// LEGACY_SYSTEM_MEMBER_ID guard (re-declared, not imported, per that file's
// own documented "re-declare the literal, comment cross-references the
// source of truth" convention already used across this codebase).
const LEGACY_SYSTEM_MEMBER_ID = "__legacy_system__";

/** How many of the owner's most recent snapshots to pull for the KPI/curve
 * math. Generous on purpose: `computePaperKpis`'s 今日/累计/最大回撤 all need
 * enough history in the SAME series to find "yesterday" or "the start" -
 * too small a limit silently starves them into 数据不足 even when older rows
 * exist in the database. Cheap: it's one bounded SQL LIMIT. */
const SERIES_LIMIT = 500;

/** Same 90-minute freshness threshold as routes/home.ts's own
 * SNAPSHOT_FRESH_WINDOW_MS - each page owns its freshness rule (see that
 * file's comment); this is a separate constant, not a shared import, but is
 * intentionally the same value for a consistent "is this stale" feel. */
const SNAPSHOT_FRESH_WINDOW_MS = 90 * 60 * 1000;

const PRICE_SOURCE_LABELS: Record<string, string> = {
  cost: "按成本估值",
  zero: "按0估值"
};

// Categorical palette validated via the dataviz skill's
// scripts/validate_palette.js against this app's own card surfaces
// (light #FFFFFF, dark #101627) - ALL CHECKS PASS for both. Used for: (a)
// the compare-mode net-worth overlay (series-1 = self, series-5 = the other
// member - two arbitrary-but-fixed, maximally-separated slots from the
// validated set) and (b) the position-distribution donut (series-1..5, top
// 5 holdings by value). A 6th+ donut slice folds into "其他" using the
// palette's documented Muted role (#898781, identical in both themes) -
// never a synthesized 6th hue (skill: "a 9th series is never a generated
// hue - it folds into Other").
const SERIES_COLORS_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7"];
const SERIES_COLORS_DARK = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9"];
const OTHER_SLICE_COLOR = "#898781";

const PAPER_PAGE_STYLE = trustedHtml(`<style>
:root, :root[data-theme="light"]{ --series-1:${SERIES_COLORS_LIGHT[0]}; --series-2:${SERIES_COLORS_LIGHT[1]}; --series-3:${SERIES_COLORS_LIGHT[2]}; --series-4:${SERIES_COLORS_LIGHT[3]}; --series-5:${SERIES_COLORS_LIGHT[4]}; }
:root[data-theme="dark"]{ --series-1:${SERIES_COLORS_DARK[0]}; --series-2:${SERIES_COLORS_DARK[1]}; --series-3:${SERIES_COLORS_DARK[2]}; --series-4:${SERIES_COLORS_DARK[3]}; --series-5:${SERIES_COLORS_DARK[4]}; }
.member-chip{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;margin:0 8px 8px 0}
.member-chip.on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-border);font-weight:600}
.legend-row{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink)}
.swatch{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}
.positions-table th,.positions-table td{white-space:nowrap;padding:6px 8px;text-align:left}
.positions-table th{border-bottom:1px solid var(--line);color:var(--sub);font-weight:600}
.positions-table td{border-bottom:1px dashed var(--line)}
.positions-table td.num,.positions-table th.num{text-align:right}
tr.degraded td{background:var(--amber-bg)}
</style>`);

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: PaperRouteDeps): Date {
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

function listSwitchableMembers(db: DatabaseSync): Member[] {
  return new MemberRepository(db).listActive().filter((m) => m.id !== LEGACY_SYSTEM_MEMBER_ID);
}

function formatMoney(value: number): string {
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 美元`;
}

function formatOptionalNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
}

function formatSignedPercent(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Data loading (privacy gate lives HERE, before any snapshot query runs)
// ---------------------------------------------------------------------------

interface PaperViewData {
  visible: boolean;
  snapshot: OwnerSnapshot | null;
  series: SnapshotSeriesPoint[];
  kpis: PaperKpis;
  drawdown: DrawdownSegment | null;
}

/**
 * Loads the KPI/curve/holdings data for `target`, gated by
 * `canSeePerformance` - a caller who has ALREADY decided the viewer isn't
 * allowed to see `target`'s performance must pass `canSeePerformance: false`
 * and this function will not touch `official_paper_snapshots` for
 * `target.id` at all (returns the all-empty/all-null shape instead). This is
 * the one and only place either snapshot query for a NON-viewer target
 * happens, so the gate can never be accidentally bypassed by a second call
 * site forgetting to check first.
 */
function loadPaperViewData(db: DatabaseSync, target: Member, canSeePerformance: boolean): PaperViewData {
  if (!canSeePerformance) {
    return { visible: false, snapshot: null, series: [], kpis: computePaperKpis([]), drawdown: null };
  }
  const snapshot = loadLatestSnapshotForOwner(db, target.id);
  const series = loadSnapshotSeriesForOwner(db, target.id, SERIES_LIMIT);
  return {
    visible: true,
    snapshot,
    series,
    kpis: computePaperKpis(series),
    drawdown: computeMaxDrawdownSegment(series)
  };
}

// ---------------------------------------------------------------------------
// Member switcher
// ---------------------------------------------------------------------------

function renderMemberChip(member: Member, active: boolean): Html {
  const cls = active ? "member-chip on" : "member-chip";
  const href = `/paper?member=${encodeURIComponent(member.id)}`;
  return html`<a class="${cls}" href="${href}">${member.displayName}</a>`;
}

function renderMemberSwitcherCard(members: Member[], viewedId: string): Html {
  const chips = joinHtml(members.map((m) => renderMemberChip(m, m.id === viewedId)));
  return html`<section class="card w2 dt-w4">
    <h2>成员</h2>
    <div>${chips}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Hidden-performance placeholder (viewing another member, show_performance=0)
// ---------------------------------------------------------------------------

function renderHiddenPerformanceCard(target: Member): Html {
  return html`<section class="card w2 dt-w4">
    <h2>${target.displayName} 的模拟盘</h2>
    <p style="font-size:13px;color:var(--sub)">对方未公开战绩</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

function renderKpiRowCard(kpis: PaperKpis): Html {
  const netAssetsDisplay = kpis.netAssets === null ? "数据不足" : formatMoney(kpis.netAssets);
  const today =
    kpis.todayChangePct === null
      ? { display: "数据不足", cls: "" }
      : { display: formatSignedPercent(kpis.todayChangePct), cls: kpis.todayChangePct >= 0 ? "u" : "d" };
  const cumulative =
    kpis.cumulativeChangePct === null
      ? { display: "数据不足", cls: "" }
      : { display: formatSignedPercent(kpis.cumulativeChangePct), cls: kpis.cumulativeChangePct >= 0 ? "u" : "d" };
  const drawdown =
    kpis.maxDrawdownPct === null
      ? { display: "数据不足", cls: "" }
      : { display: `${kpis.maxDrawdownPct.toFixed(2)}%`, cls: kpis.maxDrawdownPct < 0 ? "d" : "" };

  return html`<section class="card w2 dt-w4">
    <h2>KPI</h2>
    <div class="kpirow">
      <div class="kpi-main"><div class="num mono">${netAssetsDisplay}</div><div class="lbl">净值</div></div>
      <div class="kpi"><div class="num mono ${today.cls}">${today.display}</div><div class="lbl">今日</div></div>
      <div class="kpi"><div class="num mono ${cumulative.cls}">${cumulative.display}</div><div class="lbl">累计</div></div>
      <div class="kpi"><div class="num mono ${drawdown.cls}">${drawdown.display}</div><div class="lbl">最大回撤</div></div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Net-worth curve (solo, or self+other overlay in compare mode)
// ---------------------------------------------------------------------------

const CURVE_VIEW_WIDTH = 280;
const CURVE_VIEW_HEIGHT = 64;
const CURVE_Y_PADDING = 6;

interface UsablePoint {
  index: number;
  value: number;
}

interface PlottedPoint extends UsablePoint {
  x: number;
  y: number;
}

function usablePoints(series: ReadonlyArray<SnapshotSeriesPoint>): UsablePoint[] {
  return series
    .map((p, index) => ({ index, value: p.netAssets }))
    .filter((p): p is UsablePoint => p.value !== null && Number.isFinite(p.value));
}

function plotPoints(points: ReadonlyArray<UsablePoint>, range: { min: number; max: number }): PlottedPoint[] {
  const span = range.max - range.min || 1;
  const innerHeight = CURVE_VIEW_HEIGHT - CURVE_Y_PADDING * 2;
  const stepX = points.length > 1 ? CURVE_VIEW_WIDTH / (points.length - 1) : 0;
  return points.map((p, i) => ({
    ...p,
    x: points.length > 1 ? i * stepX : CURVE_VIEW_WIDTH / 2,
    y: CURVE_Y_PADDING + innerHeight - ((p.value - range.min) / span) * innerHeight
  }));
}

function pointsToSvgString(points: ReadonlyArray<PlottedPoint>): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function renderDrawdownHighlight(points: ReadonlyArray<PlottedPoint>, drawdown: DrawdownSegment | null): Html {
  if (!drawdown || drawdown.peakIndex === drawdown.troughIndex) {
    return trustedHtml("");
  }
  const peak = points.find((p) => p.index === drawdown.peakIndex);
  const trough = points.find((p) => p.index === drawdown.troughIndex);
  if (!peak || !trough) {
    return trustedHtml("");
  }
  return html`<g data-role="drawdown-segment" aria-label="最大回撤区间">
    <line x1="${peak.x.toFixed(1)}" y1="${peak.y.toFixed(1)}" x2="${trough.x.toFixed(1)}" y2="${trough.y.toFixed(1)}" stroke="var(--down)" stroke-width="3" stroke-dasharray="3 2"/>
    <circle cx="${peak.x.toFixed(1)}" cy="${peak.y.toFixed(1)}" r="2.5" fill="var(--down)"/>
    <circle cx="${trough.x.toFixed(1)}" cy="${trough.y.toFixed(1)}" r="2.5" fill="var(--down)"/>
  </g>`;
}

/** `toIndexedReturns` rebases a series to "% change from its first usable
 * point" - the normalization the compare overlay needs so two members'
 * curves (which can be at wildly different absolute net-asset levels) are
 * visually comparable on one shared scale, the same way an "indexed to 100"
 * chart works. Solo (non-compare) curves plot raw netAssets instead - no
 * rebasing needed with only one series on the chart. */
function toIndexedReturns(series: ReadonlyArray<SnapshotSeriesPoint>): SnapshotSeriesPoint[] {
  const baseline = series.find((p) => p.netAssets !== null && p.netAssets !== 0)?.netAssets;
  if (baseline === undefined || baseline === null) {
    return series.map((p) => ({ ...p, netAssets: null }));
  }
  return series.map((p) => ({
    ...p,
    netAssets: p.netAssets === null ? null : ((p.netAssets - baseline) / baseline) * 100
  }));
}

function renderCurveCard(
  series: SnapshotSeriesPoint[],
  drawdown: DrawdownSegment | null,
  compare?: { otherSeries: SnapshotSeriesPoint[] | null; otherDisplayName: string; otherHidden: boolean }
): Html {
  if (series.length === 0) {
    return html`<section class="card w2 dt-w2">
      <h2>净值曲线</h2>
      <p style="font-size:13px;color:var(--sub)">暂无净值曲线数据——模拟盘接入后显示</p>
    </section>`;
  }

  const selfUsable = usablePoints(series);
  if (selfUsable.length < 2) {
    return html`<section class="card w2 dt-w2">
      <h2>净值曲线</h2>
      <p style="font-size:13px;color:var(--sub)">数据点不足，暂无法绘制曲线</p>
    </section>`;
  }

  const benchmarkNote = html`<div class="vs">基准对比（vs QQQ）：<span style="color:var(--sub)">基准对比 P6 完善</span></div>`;

  if (!compare) {
    const range = { min: Math.min(...selfUsable.map((p) => p.value)), max: Math.max(...selfUsable.map((p) => p.value)) };
    const points = plotPoints(selfUsable, range);
    return html`<section class="card w2 dt-w2">
      <h2>净值曲线</h2>
      <svg width="100%" height="${CURVE_VIEW_HEIGHT}" viewBox="0 0 ${CURVE_VIEW_WIDTH} ${CURVE_VIEW_HEIGHT}" preserveAspectRatio="none" aria-label="净值曲线" role="img">
        <polyline points="${pointsToSvgString(points)}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        ${renderDrawdownHighlight(points, drawdown)}
      </svg>
      ${benchmarkNote}
    </section>`;
  }

  // Compare mode: rebase both curves to indexed % returns so they share one scale.
  const selfIndexed = toIndexedReturns(series);
  const selfIndexedUsable = usablePoints(selfIndexed);

  if (compare.otherHidden || !compare.otherSeries) {
    const range = {
      min: Math.min(...selfIndexedUsable.map((p) => p.value)),
      max: Math.max(...selfIndexedUsable.map((p) => p.value))
    };
    const points = plotPoints(selfIndexedUsable, range);
    const hiddenNote = compare.otherHidden
      ? html`<div class="vs">对方未公开战绩</div>`
      : compare.otherDisplayName === ""
        ? html`<div class="vs">选择上方成员以对比净值曲线</div>`
        : trustedHtml("");
    return html`<section class="card w2 dt-w2">
      <h2>净值曲线对比</h2>
      <svg width="100%" height="${CURVE_VIEW_HEIGHT}" viewBox="0 0 ${CURVE_VIEW_WIDTH} ${CURVE_VIEW_HEIGHT}" preserveAspectRatio="none" aria-label="净值曲线（仅本人）" role="img">
        <polyline points="${pointsToSvgString(points)}" fill="none" stroke="var(--series-1)" stroke-width="2"/>
      </svg>
      ${hiddenNote}
      ${benchmarkNote}
    </section>`;
  }

  const otherIndexed = toIndexedReturns(compare.otherSeries);
  const otherIndexedUsable = usablePoints(otherIndexed);
  const allValues = [...selfIndexedUsable.map((p) => p.value), ...otherIndexedUsable.map((p) => p.value)];
  const range = { min: Math.min(...allValues), max: Math.max(...allValues) };
  const selfPoints = plotPoints(selfIndexedUsable, range);
  const otherPoints = plotPoints(otherIndexedUsable, range);

  return html`<section class="card w2 dt-w2">
    <h2>净值曲线对比</h2>
    <svg width="100%" height="${CURVE_VIEW_HEIGHT}" viewBox="0 0 ${CURVE_VIEW_WIDTH} ${CURVE_VIEW_HEIGHT}" preserveAspectRatio="none" aria-label="净值曲线对比（指数化收益率）" role="img">
      <polyline points="${pointsToSvgString(selfPoints)}" fill="none" stroke="var(--series-1)" stroke-width="2"/>
      <polyline points="${pointsToSvgString(otherPoints)}" fill="none" stroke="var(--series-5)" stroke-width="2" stroke-dasharray="4 3"/>
    </svg>
    <div class="legend-row"><span class="swatch" style="background:var(--series-1)"></span>我<span class="swatch" style="background:var(--series-5);margin-left:10px"></span>${compare.otherDisplayName}</div>
    ${benchmarkNote}
  </section>`;
}

// ---------------------------------------------------------------------------
// Holdings table
// ---------------------------------------------------------------------------

function renderPositionRow(position: SnapshotPosition): Html {
  const degradedLabel = position.priceSource ? PRICE_SOURCE_LABELS[position.priceSource] : undefined;
  const badge = degradedLabel
    ? html`<span class="pill warn">${degradedLabel}</span>`
    : html`<span class="pill ok">按行情估值</span>`;
  return html`<tr class="${degradedLabel ? "degraded" : ""}">
    <td class="mono">${position.symbol}</td>
    <td class="mono num">${formatOptionalNumber(position.quantity)}</td>
    <td class="mono num">${formatOptionalNumber(position.costPrice)}</td>
    <td class="mono num">${formatOptionalNumber(position.price)}</td>
    <td>${badge}</td>
  </tr>`;
}

function renderPositionsTableCard(snapshot: OwnerSnapshot | null): Html {
  if (!snapshot || snapshot.positions.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>持仓</h2>
      <p style="font-size:13px;color:var(--sub)">暂无持仓数据</p>
    </section>`;
  }

  return html`<section class="card w2 dt-w4">
    <h2>持仓</h2>
    <div style="overflow-x:auto">
      <table class="positions-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr>
          <th>代码</th><th class="num">数量</th><th class="num">成本价</th><th class="num">现价</th><th>估值来源</th>
        </tr></thead>
        <tbody>${joinHtml(snapshot.positions.map(renderPositionRow))}</tbody>
      </table>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// 持仓当日涨跌条形图 - honest placeholder (snapshots don't store prevClose)
// ---------------------------------------------------------------------------

function renderDailyMoveBarsCard(): Html {
  return html`<section class="card w2 dt-w2">
    <h2>持仓当日涨跌</h2>
    <p style="font-size:13px;color:var(--sub)">数据不足——当日涨跌需行情接入（P6）</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// 仓位分布环图
// ---------------------------------------------------------------------------

interface PositionShare {
  symbol: string;
  pct: number;
}

const MAX_DONUT_SLOTS = 5;

function computePositionShares(positions: readonly SnapshotPosition[]): PositionShare[] {
  const withValue = positions.map((p) => {
    const price =
      typeof p.price === "number" && Number.isFinite(p.price)
        ? p.price
        : typeof p.costPrice === "number" && Number.isFinite(p.costPrice)
          ? p.costPrice
          : 0;
    const qty = typeof p.quantity === "number" && Number.isFinite(p.quantity) ? p.quantity : 0;
    return { symbol: p.symbol, value: Math.max(0, price * qty) };
  });

  const total = withValue.reduce((sum, p) => sum + p.value, 0);
  if (total <= 0) {
    return [];
  }

  const shares = withValue
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((p) => ({ symbol: p.symbol, pct: (p.value / total) * 100 }));

  if (shares.length <= MAX_DONUT_SLOTS) {
    return shares;
  }
  const top = shares.slice(0, MAX_DONUT_SLOTS);
  const restPct = shares.slice(MAX_DONUT_SLOTS).reduce((sum, p) => sum + p.pct, 0);
  return [...top, { symbol: "其他", pct: restPct }];
}

function renderDonutSvg(shares: readonly PositionShare[]): Html {
  const r = 26;
  const circumference = 2 * Math.PI * r;
  const gap = 1.5; // small stroke-unit spacer between slices (dataviz skill: visible gap between adjacent fills)

  let offsetAccum = 0;
  const segments = shares.map((share, i) => {
    const color = share.symbol === "其他" ? OTHER_SLICE_COLOR : `var(--series-${i + 1})`;
    const rawDash = (share.pct / 100) * circumference;
    const dash = Math.max(0, rawDash - gap);
    const dashoffset = -offsetAccum;
    offsetAccum += rawDash;
    return html`<circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="12" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${dashoffset.toFixed(2)}" transform="rotate(-90 32 32)"/>`;
  });

  return html`<svg width="72" height="72" viewBox="0 0 64 64" aria-label="仓位分布环图" role="img">${joinHtml(segments)}</svg>`;
}

function renderDonutLegend(shares: readonly PositionShare[]): Html {
  const rows = shares.map((share, i) => {
    const color = share.symbol === "其他" ? OTHER_SLICE_COLOR : `var(--series-${i + 1})`;
    return html`<div class="legend-row"><span class="swatch" style="background:${color}"></span>${share.symbol} <span class="mono">${share.pct.toFixed(1)}%</span></div>`;
  });
  return html`<div style="display:flex;flex-direction:column;gap:4px">${joinHtml(rows)}</div>`;
}

function renderPositionDonutCard(snapshot: OwnerSnapshot | null): Html {
  const shares = snapshot ? computePositionShares(snapshot.positions) : [];
  if (shares.length === 0) {
    return html`<section class="card w2 dt-w2">
      <h2>仓位分布</h2>
      <p style="font-size:13px;color:var(--sub)">暂无仓位分布数据</p>
    </section>`;
  }
  return html`<section class="card w2 dt-w2">
    <h2>仓位分布</h2>
    <div style="display:flex;align-items:center;gap:16px">
      ${renderDonutSvg(shares)}
      ${renderDonutLegend(shares)}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// 提案与成交历史 - always P6 placeholder (no writes exist yet, regardless of
// whose account is being viewed - not a privacy gate, just "not built yet").
// ---------------------------------------------------------------------------

function renderProposalsHistoryCard(): Html {
  return html`<section class="card w2 dt-w4">
    <h2>提案与成交历史 <span class="pill warn">P6 上线</span></h2>
    <p style="font-size:13px;color:var(--sub)">提案与成交历史 P6 上线</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function computeSnapshotFreshness(snapshot: OwnerSnapshot | null, now: Date): Freshness {
  if (!snapshot) {
    return "部分缺失";
  }
  const ageMs = now.getTime() - new Date(snapshot.fetchedAt).getTime();
  return ageMs < SNAPSHOT_FRESH_WINDOW_MS ? "最新" : "延迟";
}

function degradedReasonText(snapshot: OwnerSnapshot): string {
  return snapshot.degradedReason ?? "快照数据降级（原因未知）";
}

function renderPaperPage(
  res: ServerResponse,
  deps: PaperRouteDeps,
  viewer: Member,
  url: URL,
  nonce: string
): void {
  const now = currentNow(deps);
  const members = listSwitchableMembers(deps.db);
  const memberParam = url.searchParams.get("member");
  const compareRequested = url.searchParams.get("compare") === "1";

  const requested = memberParam ? members.find((m) => m.id === memberParam) : undefined;

  let bodyHtml: Html;
  let freshnessSnapshot: OwnerSnapshot | null;

  if (compareRequested) {
    // Main content always pinned to the viewer's own account (see module doc).
    const self = loadPaperViewData(deps.db, viewer, true);
    freshnessSnapshot = self.snapshot;

    const other = requested && requested.id !== viewer.id ? requested : undefined;
    const otherVisible = other ? other.showPerformance : false;
    const otherData = other ? loadPaperViewData(deps.db, other, otherVisible) : null;

    const curveCard = renderCurveCard(self.series, self.drawdown, {
      otherSeries: other && otherVisible ? (otherData?.series ?? null) : null,
      otherDisplayName: other?.displayName ?? "",
      otherHidden: Boolean(other) && !otherVisible
    });

    bodyHtml = html`<div class="bento">${renderMemberSwitcherCard(members, viewer.id)}</div>
      <div class="bento" style="margin-top:10px">${renderKpiRowCard(self.kpis)}</div>
      <div class="bento" style="margin-top:10px">${curveCard}${renderDailyMoveBarsCard()}</div>
      <div class="bento" style="margin-top:10px">${renderPositionsTableCard(self.snapshot)}</div>
      <div class="bento" style="margin-top:10px">${renderPositionDonutCard(self.snapshot)}${renderProposalsHistoryCard()}</div>
      ${PAPER_PAGE_STYLE}`;
  } else {
    const viewed = requested ?? viewer;
    const viewingSelf = viewed.id === viewer.id;
    const canSeePerformance = viewingSelf || viewed.showPerformance;
    const data = loadPaperViewData(deps.db, viewed, canSeePerformance);
    freshnessSnapshot = data.snapshot;

    const contentHtml = canSeePerformance
      ? html`<div class="bento" style="margin-top:10px">${renderKpiRowCard(data.kpis)}</div>
        <div class="bento" style="margin-top:10px">${renderCurveCard(data.series, data.drawdown)}${renderDailyMoveBarsCard()}</div>
        <div class="bento" style="margin-top:10px">${renderPositionsTableCard(data.snapshot)}</div>
        <div class="bento" style="margin-top:10px">${renderPositionDonutCard(data.snapshot)}${renderProposalsHistoryCard()}</div>`
      : html`<div class="bento" style="margin-top:10px">${renderHiddenPerformanceCard(viewed)}</div>
        <div class="bento" style="margin-top:10px">${renderProposalsHistoryCard()}</div>`;

    bodyHtml = html`<div class="bento">${renderMemberSwitcherCard(members, viewed.id)}</div>
      ${contentHtml}
      ${PAPER_PAGE_STYLE}`;
  }

  const freshness = computeSnapshotFreshness(freshnessSnapshot, now);
  const degraded = freshnessSnapshot?.degraded ? [degradedReasonText(freshnessSnapshot)] : [];

  const page = renderPage({
    title: "模拟盘",
    nav: "paper",
    member: { displayName: viewer.displayName },
    freshness,
    degraded,
    bodyHtml,
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

/**
 * Routes `GET /paper`. Returns `true` if the request was handled (including
 * the 401/405 cases), `false` if the path isn't `/paper` so the caller can
 * keep trying other routes.
 */
export function handlePaperRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PaperRouteDeps,
  nonce: string
): boolean {
  if (url.pathname !== "/paper") {
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

  renderPaperPage(res, deps, member, url, nonce);
  return true;
}
