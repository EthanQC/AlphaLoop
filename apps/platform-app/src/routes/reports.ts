/**
 * Report library routes (Task 4): the list page (`GET /reports`) and the
 * per-type reading pages (`GET /daily/<date>`, `/weekly/<date>`,
 * `/stock-analysis/<date>`, `/official-paper/<date>`).
 *
 * Every route here is identity-gated (plan Task 4 note: "pages from this
 * task onward ARE identity-gated") - resolveIdentity runs first on every
 * request this module handles, and a null result renders the shared 401
 * page. There is no per-owner filtering needed for reports themselves
 * (report content isn't member-scoped data), but the login gate still
 * applies like every other page past Task 3.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { renderMarkdown, type MarkdownRenderResult } from "../reports/markdown.js";
import { scanReports, type ReportIndexEntry, type ReportType } from "../reports/scanner.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderPage, type Freshness } from "../render/layout.js";

export interface ReportsRouteDeps {
  db: DatabaseSync;
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

// Chinese labels for the four scannable report types. `official-paper`'s
// disk name doesn't match its user-facing label - the files under
// reports/official-paper/ are the official paper-trading account snapshot
// reports ("OpenClaw 模拟盘收支变化"), which the plan's chip list calls
// "模拟盘快照".
const TYPE_LABELS: Record<ReportType, string> = {
  daily: "日报",
  weekly: "周报",
  "stock-analysis": "个股分析",
  "official-paper": "模拟盘快照"
};

const TYPE_ORDER: readonly ReportType[] = ["daily", "weekly", "stock-analysis", "official-paper"];

// Chips for report kinds that don't exist yet (plan Task 4: "研判/复盘筛选片
// 存在但空态标注「P8/P9 上线」"). These are not ReportType values - there is
// nothing to scan or filter for them, they exist purely so the filter row's
// shape matches the plan's eventual six-chip layout.
const DISABLED_TYPE_CHIPS: ReadonlyArray<{ label: string; note: string }> = [
  { label: "研判", note: "P8 上线" },
  { label: "复盘", note: "P9 上线" }
];

const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/u;

const READING_PATH_SEGMENTS: Record<string, ReportType> = {
  daily: "daily",
  weekly: "weekly",
  "stock-analysis": "stock-analysis",
  "official-paper": "official-paper"
};

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

/** `YYYY-MM-DD` for a given instant, in Asia/Shanghai (Beijing has no DST,
 * so a fixed IANA zone is exact year-round). Built from formatToParts (not
 * a locale's default separator/order) so the output shape doesn't depend on
 * ICU version/locale quirks. */
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
 * Routes `/reports` and the four reading-page paths. Returns `true` if the
 * request was handled (including 401/404/405 responses), `false` if the
 * path doesn't belong to this module so the caller can keep trying other
 * routes / fall through to a generic 404.
 */
export function handleReportsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ReportsRouteDeps,
  nonce: string
): boolean {
  if (url.pathname === "/reports") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return true;
    }
    const member = requireIdentity(req, res, deps.db, nonce);
    if (!member) {
      return true;
    }
    renderReportsListPage(res, deps, url, member, nonce);
    return true;
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 2) {
    const type = READING_PATH_SEGMENTS[segments[0] as string];
    if (type) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return true;
      }
      const member = requireIdentity(req, res, deps.db, nonce);
      if (!member) {
        return true;
      }
      renderReadingPage(res, deps, type, segments[1] as string, member, nonce);
      return true;
    }
  }

  return false;
}

function requireIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
  nonce: string
): Member | null {
  const member = resolveIdentity(req, db);
  if (!member) {
    sendHtml(res, 401, renderUnauthorizedPage(nonce));
    return null;
  }
  return member;
}

function currentNow(deps: ReportsRouteDeps): Date {
  return deps.now ? deps.now() : new Date();
}

// ---------------------------------------------------------------------------
// List page: GET /reports[?type=daily|weekly|stock-analysis|official-paper]
// ---------------------------------------------------------------------------

function renderReportsListPage(
  res: ServerResponse,
  deps: ReportsRouteDeps,
  url: URL,
  member: Member,
  nonce: string
): void {
  const now = currentNow(deps);
  const typeParam = url.searchParams.get("type");
  const entries = scanReports(deps.repoRoot);
  const filtered = typeParam ? entries.filter((entry) => entry.type === typeParam) : entries;

  const page = renderPage({
    title: "报告库",
    nav: "reports",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: renderReportsListBody(filtered, typeParam),
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

function renderTypeChip(type: ReportType, label: string, activeType: string | null): Html {
  const active = activeType === type;
  const extraStyle = active
    ? "background:var(--accent-soft);color:var(--accent);border-color:var(--accent-border);font-weight:600"
    : "background:var(--card);color:var(--ink);border-color:var(--line)";
  const href = active ? "/reports" : `/reports?type=${type}`;
  return html`<a href="${href}" style="display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;margin:0 8px 8px 0;${extraStyle}">${label}</a>`;
}

function renderDisabledChip(label: string, note: string): Html {
  return html`<span aria-disabled="true" style="display:inline-flex;align-items:center;gap:6px;border:1px dashed var(--line);border-radius:999px;padding:6px 14px;font-size:13px;margin:0 8px 8px 0;color:var(--sub);opacity:.6;cursor:not-allowed">${label}<small class="mono" style="font-size:10.5px">${note}</small></span>`;
}

function renderReportCard(entry: ReportIndexEntry): Html {
  const legacyPill = entry.legacy
    ? html`<span class="pill warn" style="margin-left:6px">历史存档</span>`
    : trustedHtml("");
  return html`<a class="card" href="/${entry.type}/${entry.date}" style="display:block">
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--sub)">
        <span class="pill" style="background:var(--accent-soft);color:var(--accent)">${TYPE_LABELS[entry.type]}</span>
        <span class="mono">${entry.date}</span>
        ${legacyPill}
      </div>
      <div style="margin-top:8px;font-size:14.5px;font-weight:650;color:var(--ink)">${entry.title}</div>
    </a>`;
}

function renderReportsListBody(entries: ReportIndexEntry[], activeType: string | null): Html {
  const chips = joinHtml([
    ...TYPE_ORDER.map((type) => renderTypeChip(type, TYPE_LABELS[type], activeType)),
    ...DISABLED_TYPE_CHIPS.map((chip) => renderDisabledChip(chip.label, chip.note))
  ]);

  const cards =
    entries.length > 0
      ? joinHtml(entries.map(renderReportCard))
      : html`<p style="padding:24px 4px;color:var(--sub);font-size:13px">暂无报告。</p>`;

  return html`<div class="bento">
      <section class="card w2 dt-w4">
        <h2>报告类型</h2>
        <div>${chips}</div>
      </section>
    </div>
    <div class="bento" style="margin-top:10px">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Reading pages: GET /<type>/<date>
// ---------------------------------------------------------------------------

function renderNotFoundPage(member: Member, nonce: string, now: Date): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>未找到</h2>
      <p style="font-size:13px;color:var(--sub)">该报告不存在，或日期格式不正确。</p>
    </section>
  </div>`;
  return renderPage({
    title: "未找到",
    nav: "reports",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

function renderLegacyBanner(): Html {
  return html`<div class="bento" style="padding-bottom:0">
    <section class="card w2 dt-w4 amber" role="alert" aria-label="历史存档提示">
      <h2 style="color:var(--amber)">历史存档</h2>
      <p style="margin:0;font-size:13px;color:var(--ink)">历史存档：旧版格式，含当时共享模拟盘账户内容。</p>
    </section>
  </div>`;
}

/** Heuristic "first paragraph" extraction for the summary card: the first
 * run of contiguous non-heading/non-list/non-table/non-fence lines. Plain
 * text (not markdown-rendered) - it's escaped like any other interpolated
 * string when spliced into the summary card. */
function extractFirstParagraph(md: string): string {
  const lines = md.replace(/\r\n/gu, "\n").split("\n");
  const collected: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed)) {
      continue;
    }
    if (/^[-*]\s+/u.test(trimmed)) {
      continue;
    }
    if (/^\d+[.)]\s+/u.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith("|") || trimmed.startsWith("```")) {
      continue;
    }
    collected.push(trimmed);
  }
  return collected.join(" ").trim() || "（无摘要内容）";
}

const REPORT_BODY_STYLE = trustedHtml(`<style>
.report-body h1{font-size:20px;margin:18px 0 10px}
.report-body h2{font-size:16px;margin:20px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.report-body h3{font-size:14px;margin:14px 0 6px}
.report-body p{margin:8px 0;font-size:13.5px;line-height:1.7}
.report-body ul,.report-body ol{margin:8px 0 10px 20px}
.report-body li{margin:4px 0}
.report-body table{border-collapse:collapse;width:100%;margin:10px 0 14px;font-size:12.5px}
.report-body th,.report-body td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.report-body th{background:var(--card2)}
.report-body pre{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:12px}
.report-body code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.report-body a{color:var(--accent);text-decoration:underline}
</style>`);

function renderReadingBody(entry: ReportIndexEntry, rawMd: string, rendered: MarkdownRenderResult): Html {
  const legacyNote = entry.legacy
    ? html`<p style="margin-top:6px;font-size:12px;color:var(--sub)">旧格式无置信度</p>`
    : trustedHtml("");

  const summarySection = html`<section class="card w2 dt-w4">
    <h2>摘要</h2>
    <p style="font-size:13.5px;line-height:1.7">${extractFirstParagraph(rawMd)}</p>
    ${legacyNote}
  </section>`;

  const tocSection =
    rendered.toc.length > 0
      ? html`<details>
          <summary style="cursor:pointer;font-size:13px;color:var(--sub);padding:4px 0">目录</summary>
          <ul style="margin:6px 0 0 18px;font-size:13px">
            ${joinHtml(
              rendered.toc.map(
                (item) => html`<li style="margin:4px 0"><a href="#${item.id}" style="color:var(--accent)">${item.text}</a></li>`
              )
            )}
          </ul>
        </details>`
      : trustedHtml("");

  const sourcesSection =
    rendered.sources.length > 0
      ? html`<section class="card w2 dt-w4" style="margin-top:10px">
          <h2>来源清单</h2>
          <ul style="margin:0;padding-left:18px;font-size:13px">
            ${joinHtml(
              rendered.sources.map(
                (source) =>
                  html`<li style="margin:4px 0"><a href="${source.url}" rel="noreferrer" target="_blank" style="color:var(--accent)">${source.text}</a></li>`
              )
            )}
          </ul>
        </section>`
      : trustedHtml("");

  return html`${entry.legacy ? renderLegacyBanner() : trustedHtml("")}
    <div class="bento">${summarySection}</div>
    <div class="bento" style="margin-top:10px">
      <section class="card w2 dt-w4">
        ${tocSection}
        <div class="report-body" style="margin-top:10px">${rendered.html}</div>
      </section>
    </div>
    <div class="bento" style="margin-top:10px">${sourcesSection}</div>
    ${REPORT_BODY_STYLE}`;
}

function renderReadingPage(
  res: ServerResponse,
  deps: ReportsRouteDeps,
  type: ReportType,
  dateParam: string,
  member: Member,
  nonce: string
): void {
  const now = currentNow(deps);

  // Validate BEFORE touching the filesystem at all (path traversal guard -
  // e.g. `/daily/../../etc/passwd` never reaches scanReports/readFileSync
  // because dateParam fails this check first).
  if (!DATE_PARAM_RE.test(dateParam)) {
    sendHtml(res, 404, renderNotFoundPage(member, nonce, now));
    return;
  }

  const entries = scanReports(deps.repoRoot);
  const entry = entries.find((candidate) => candidate.type === type && candidate.date === dateParam);
  if (!entry) {
    sendHtml(res, 404, renderNotFoundPage(member, nonce, now));
    return;
  }

  const rawMd = readFileSync(entry.mdPath, "utf8");
  const rendered = renderMarkdown(rawMd);
  const freshness: Freshness = entry.date === formatBeijingDate(now) ? "最新" : "延迟";

  const page = renderPage({
    title: entry.title,
    nav: "reports",
    member: { displayName: member.displayName },
    freshness,
    degraded: [],
    bodyHtml: renderReadingBody(entry, rawMd, rendered),
    nonce,
    now
  });
  sendHtml(res, 200, page);
}
