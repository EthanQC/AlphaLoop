/**
 * Owner-only personal page routes (Task 6, 2026-07-28 spec-drift
 * remediation): `GET /daily/<date>/me` and `GET /weekly/<date>/me`.
 *
 * Requirements §3.2 ("个人页（每人一份，随日报生成）") took the owner's account,
 * holdings and strategy content OUT of the public daily/weekly body and put
 * it here. The markdown itself is produced and stored by
 * apps/openclaw-config/scripts/personal-page.mjs (Task 5) into `personal_pages`
 * (schema v16, UNIQUE(owner_id, kind, date)); this module only reads that row
 * back and renders it. Nothing here computes, summarizes or regenerates
 * anything - if the row is missing, the page says so with the reason rather
 * than inventing a page on the fly.
 *
 * THE URL CARRIES NO OWNER, EVER
 * ------------------------------
 * `/me` is the entire owner selector: the row is looked up with
 * `owner_id = resolveIdentity(...).id` and nothing else. There is deliberately
 * no `/daily/<date>/<ownerId>` route and no `?owner=` parameter - §3.2 is
 * explicit that a personal page is "只有本人可见——「系统可用」档策略绝不泄露给其他
 * 成员", and the safest way to honor that is to make another member's page
 * unaddressable rather than addressable-but-checked.
 *
 * Because of that, an incoming `?owner=` is treated as an ATTEMPT, not as
 * input: the request is refused with 403 whenever the parameter is present at
 * all - including when its value happens to be the caller's own id. Silently
 * ignoring it would be safe for this handler today but would teach callers
 * (and future code) that the parameter is a supported, merely-redundant way
 * to name an owner; refusing it keeps "identity comes from resolveIdentity,
 * never from a request-supplied ownerId" observable from the outside.
 *
 * STATUS CODES: 401 no identity -> 403 an `?owner=` attempt -> 404 malformed
 * date / no page generated for this owner+kind+date. Note that a non-owner
 * asking for a date where only somebody ELSE has a page gets the ordinary
 * 404, identical to the one they get for a date where nobody has a page:
 * this route cannot distinguish those, and must not - "there is no page here
 * for YOU" is all a member is ever told about another member's page.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { renderMarkdown } from "../reports/markdown.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderForbiddenPage } from "../render/forbidden.js";
import { renderPage, type Freshness } from "../render/layout.js";
import { REPORT_BODY_STYLE, formatBeijingDate } from "./reports.js";

export interface PersonalRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

/** The two report kinds `personal_pages.kind` allows (v16 CHECK constraint).
 * `/stock-analysis/<date>/me` and `/official-paper/<date>/me` are therefore
 * not routes at all - those report types never generate a personal page. */
const PERSONAL_KINDS = { daily: "日报", weekly: "周报" } as const;

type PersonalKind = keyof typeof PERSONAL_KINDS;

const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** The one path segment that means "whoever is logged in". */
const SELF_SEGMENT = "me";

interface PersonalPageRow {
  markdown: string;
  createdAt: string;
}

/** Every response this module sends is owner-private, INCLUDING the 401/403/404
 * shells - they are still per-viewer answers about a private resource, and a
 * cached "here is your page" for one member must never be replayed to another.
 * The `cache-control: private, no-store` + `vary` headers that say so are now
 * part of the server-wide baseline (security.ts's applySecurityHeaders, defect
 * N1), so this deliberately sets no cache header of its own - one source of
 * truth, and no writeHead key here can override the baseline. */
function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: PersonalRouteDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/**
 * Routes `GET /daily/<date>/me` and `GET /weekly/<date>/me`. Returns `true`
 * if the request was handled (including 401/403/404/405), `false` if the path
 * doesn't belong to this module so the caller can keep trying other routes.
 */
export function handlePersonalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PersonalRouteDeps,
  nonce: string
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 3 || segments[2] !== SELF_SEGMENT) {
    return false;
  }
  const kind = segments[0] as string;
  if (!Object.hasOwn(PERSONAL_KINDS, kind)) {
    return false;
  }

  if (req.method !== "GET") {
    methodNotAllowed(res);
    return true;
  }

  const member = resolveIdentity(req, deps.db);
  if (!member) {
    sendHtml(res, 401, renderUnauthorizedPage(nonce));
    return true;
  }

  const now = currentNow(deps);

  // An `?owner=` attempt is refused outright - see the module header. Checked
  // BEFORE the date/lookup so no combination of parameters can ever reach the
  // query below with anything but the resolved viewer's own id.
  if (url.searchParams.has("owner")) {
    sendHtml(res, 403, renderForbiddenPage(member, "reports", nonce, now));
    return true;
  }

  const dateParam = segments[1] as string;
  if (!DATE_PARAM_RE.test(dateParam)) {
    sendHtml(res, 404, renderMissingPage(member, kind as PersonalKind, dateParam, nonce, now, "date-invalid"));
    return true;
  }

  const row = loadPersonalPage(deps.db, member.id, kind as PersonalKind, dateParam);
  if (!row) {
    sendHtml(res, 404, renderMissingPage(member, kind as PersonalKind, dateParam, nonce, now, "not-generated"));
    return true;
  }

  sendHtml(res, 200, renderPersonalPageHtml(member, kind as PersonalKind, dateParam, row, nonce, now));
  return true;
}

/** Owner-scoped by construction: `owner_id` is always the resolved viewer's
 * own id, never a request-supplied value (module header). */
function loadPersonalPage(
  db: DatabaseSync,
  ownerId: string,
  kind: PersonalKind,
  date: string
): PersonalPageRow | null {
  const row = db
    .prepare(`SELECT markdown, created_at FROM personal_pages WHERE owner_id = ? AND kind = ? AND date = ?`)
    .get(ownerId, kind, date) as { markdown?: unknown; created_at?: unknown } | undefined;
  if (!row || typeof row.markdown !== "string") {
    return null;
  }
  return { markdown: row.markdown, createdAt: typeof row.created_at === "string" ? row.created_at : "" };
}

/** Honest empty state: names the reason the page is not there instead of
 * rendering an empty shell that reads like "you have no holdings". */
function renderMissingPage(
  member: Member,
  kind: PersonalKind,
  dateParam: string,
  nonce: string,
  now: Date,
  reason: "date-invalid" | "not-generated"
): string {
  const kindLabel = PERSONAL_KINDS[kind];
  const detail =
    reason === "date-invalid"
      ? html`<p style="font-size:13px;color:var(--sub)">日期格式不正确，个人页地址应形如 <span class="mono">/${kind}/YYYY-MM-DD/me</span>。</p>`
      : html`<p style="font-size:13px;color:var(--sub)">
          该日期（<span class="mono">${dateParam}</span>）尚未生成属于你的${kindLabel}个人页。个人页在${kindLabel}生成时按成员逐份写入，若当日${kindLabel}尚未产出、或你当时还不是活跃成员，这里就没有对应记录——这不代表你当天没有持仓或提醒。
        </p>`;

  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>个人页尚未生成</h2>
      ${detail}
    </section>
  </div>`;

  return renderPage({
    title: "个人页尚未生成",
    nav: "reports",
    member: { displayName: member.displayName },
    freshness: "部分缺失",
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

function renderVisibilityNote(kindLabel: string): Html {
  return html`<section class="card w2 dt-w4">
    <h2>仅本人可见</h2>
    <p style="font-size:13px;color:var(--sub)">
      本页只有你自己能打开：内容按登录身份读取，地址里不带成员参数，也不会进入公共${kindLabel}正文或发到群里。
    </p>
  </section>`;
}

function renderPersonalPageHtml(
  member: Member,
  kind: PersonalKind,
  date: string,
  row: PersonalPageRow,
  nonce: string,
  now: Date
): string {
  const kindLabel = PERSONAL_KINDS[kind];
  const rendered = renderMarkdown(row.markdown);
  const freshness: Freshness = date === formatBeijingDate(now) ? "最新" : "延迟";

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

  const backLink = html`<div class="bento" style="margin-top:10px">
    <section class="card w2 dt-w4">
      <a href="/${kind}/${date}" style="color:var(--accent);font-size:13px">← 回到公共${kindLabel}</a>
    </section>
  </div>`;

  const body = html`<div class="bento">${renderVisibilityNote(kindLabel)}</div>
    <div class="bento" style="margin-top:10px">
      <section class="card w2 dt-w4">
        ${tocSection}
        <div class="report-body" style="margin-top:10px">${rendered.html}</div>
      </section>
    </div>
    ${backLink}
    ${REPORT_BODY_STYLE}`;

  return renderPage({
    title: `我的个人页 · ${kindLabel} ${date}`,
    nav: "reports",
    member: { displayName: member.displayName },
    freshness,
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}
