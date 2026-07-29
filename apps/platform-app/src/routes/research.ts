/**
 * Research task detail page (Task 7, rebuilt by Phase 8 Task 4 - 2026-07-16
 * plan): `GET /research/<id>`. Identity-gated like every route past Task 3,
 * plus the SAME row-first ownership gate as proposal.ts, with ONE deliberate
 * exception (plan Task 7, req §1.9): `visibility = 'public'` rows are
 * viewable by ANY member, not just their owner - a research task's owner can
 * choose to publish it (mirrors theses' own system/public visibility
 * split), and a published one is meant to be read by the circle.
 *
 * ACCESS ORDER (same discipline as proposal.ts):
 *   1. Resolve the row FIRST, by id alone (via the shared
 *      `ResearchTaskRepository.getById`, Task 1 - not ad hoc SQL; this
 *      module used to hand-roll its own SELECT, but the repository is the
 *      single source of truth for the `research_tasks` row shape now that
 *      Task 3's worker and Task 1's repository both depend on it).
 *   2. No row -> 404.
 *   3. Row exists AND `owner_id !== viewer.id` AND `visibility !== 'public'`
 *      -> 403 (render/forbidden.ts's shared page).
 *   4. Otherwise (owner, OR a public row viewed by anyone) -> render, in one
 *      of three shapes keyed on `task.status`:
 *      - `queued`/`running` -> "进行中" page: an honest steps-so-far stream
 *        plus a SECOND nonce'd polling `<script>` (see below).
 *      - `done`/`degraded` -> "研判页": the full verdict rendered from
 *        `task.resultJson` (Task 2's research-engine.mjs output) - 核心结论
 *        -> 关键要点 -> 数据表 -> 与我的论点/纪律对照 -> 建议动作 -> 证据链
 *        -> 调研过程, in that fixed order (plan Task 4, req: binding
 *        section order). `degraded` additionally gets a top amber banner
 *        ("降级：已收集材料，研判未完成") - the verdict itself is still
 *        real, just built from an interrupted search run.
 *      - anything else (`failed`) -> a failure-reason card. `result_json` is
 *        always NULL for a failed task (ResearchTaskRepository.setResult is
 *        never called with one on that path) - the reason is derived from
 *        the LAST entry of the honest `steps` trace instead (e.g. "识别为
 *        操作类意图（命中关键词「买入」），不进入研究管线" for an
 *        operational-intent rejection, or "跳过：调研执行异常（...）" for a
 *        worker-level crash) - see `deriveFailureReason` below.
 *
 * SECOND NONCE'D SCRIPT (plan Task 4: "进行中页每 3 秒自动刷新...nonce'd
 * setTimeout"): security.ts's CSP is `script-src 'nonce-<nonce>'` - ONE nonce
 * VALUE per response, not a "one script per response" limit; any number of
 * inline `<script nonce="...">` tags carrying that SAME value are allowed by
 * the policy. So rather than threading a second nonce (or an `extraScript`
 * option) through render/layout.ts's `renderPage`, this route simply embeds
 * its own `<script nonce="${nonce}">` - using the EXACT SAME nonce this
 * route was already handed - directly inside the `bodyHtml` it hands to
 * `renderPage` (`renderInProgressBody` below). `renderPage` splices
 * `bodyHtml` verbatim into `<body>`, so the script lands there, matches the
 * response's one CSP header, and layout.ts needs no changes at all - the
 * minimal-diff option the plan explicitly allows ("OR the research route
 * composes the body+script"). This script is ONLY ever part of
 * `renderInProgressBody`'s output - the done/degraded/failed branches never
 * emit it, so a finished task's page never keeps auto-reloading.
 *
 * ARCHIVE ACTIONS (2026-07-30, plan Task 18 / req §1.3 step 4): the
 * done/degraded page ends with a 归档动作 card, rendered ONLY for the task's
 * owner - 设为公开 (via a `?promote=confirm` interstitial that lists what
 * promoting would expose) and 存为论点 (a form posting to
 * `/api/research/<id>/thesis`). A member reading someone else's PUBLIC verdict
 * gets the seven verdict sections and no controls at all. See
 * `collectPromotionExposure` below for what the confirmation counts and why it
 * does not claim the cited theses get promoted along with the page.
 *
 * LABEL FIX (plan Task 4: "visibility label 修正"): the header card's
 * visibility pill used to read a private row as "系统可用" (a copy-paste
 * leftover from theses'/strategy_cards' three-tier system/public
 * vocabulary, which research_tasks never had - it's only ever private or
 * public). Fixed to "仅本人可见" here.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  ResearchTaskRepository,
  methodNotAllowed,
  type Member,
  type ResearchConfidence,
  type ResearchDataTableRow,
  type ResearchEvidenceItem,
  type ResearchKeyPoint,
  type ResearchResult,
  type ResearchTask
} from "@packages/shared-types";

import { loadOwnThesesByIds, type ThesisEvidenceRow } from "../data/strategy.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { CONFIDENCE_LABELS } from "../reports/conclusion-box.js";
import { renderForbiddenPage } from "../render/forbidden.js";
import { renderEmptyState } from "../render/empty-state.js";
import { describeDataInstant, formatBeijingDateTime } from "../render/format.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderPage } from "../render/layout.js";

// Same pattern as reports/markdown.ts's HTTP_LINK_RE (defense in depth): an
// evidence item's URL comes from an LLM agent-search / external source and
// could be a javascript:/data: URL - only ever rendering an http(s) URL as
// a clickable <a> href closes that gap instead of relying on CSP alone.
const HTTP_LINK_RE = /^https?:\/\//iu;

export interface ResearchRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  degraded: "降级",
  failed: "失败"
};

/** Matches the worker's own tick loop cadence conceptually (research/worker.ts
 * defaults `start(intervalMs = 3000)`), and is the exact literal the plan
 * names ("每 3 秒自动刷新"). Not imported from worker.ts - that constant is
 * the worker's own polling *production* cadence (a different concern from
 * "how often does this page ask the browser to reload"); the two happening
 * to share a number is a reasonable UX choice, not a shared contract. */
const POLL_INTERVAL_MS = 3000;

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: ResearchRouteDeps): Date {
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
// 404 page
// ---------------------------------------------------------------------------

function renderNotFoundPage(member: Member, nonce: string, now: Date): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>未找到</h2>
      <p style="font-size:13px;color:var(--sub)">该研判不存在。</p>
    </section>
  </div>`;
  return renderPage({
    title: "未找到",
    nav: "home",
    member: { displayName: member.displayName },
    freshness: "最新",
    dataAsOf: null,
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

// ---------------------------------------------------------------------------
// Shared: header card + steps trace (both used by every status branch)
// ---------------------------------------------------------------------------

function renderHeaderCard(task: ResearchTask): Html {
  const label = STATUS_LABELS[task.status] ?? task.status;
  // Fixed by this task (see module header "LABEL FIX") - research_tasks only
  // has the two-tier private/public split (ResearchTaskRepository.
  // promoteVisibility's own comment), never theses'/strategy_cards' 'system'
  // tier, so "系统可用" here was always a copy-paste bug, not a real state.
  const visibilityLabel = task.visibility === "public" ? "公开" : "仅本人可见";
  // `title` is a derived, ≤40-char truncation of `question` (research-
  // engine.mjs's `deriveTitle`) - only worth its own line when it actually
  // differs from the full question (i.e. truncation happened, or a hand-
  // seeded row set a distinct title); otherwise showing both is redundant.
  const heading = task.title ?? task.question;
  const showQuestionLine = Boolean(task.title) && task.title !== task.question;
  return html`<section class="card w2 dt-w4">
    <h2>${heading}</h2>
    ${showQuestionLine ? html`<p style="font-size:12.5px;color:var(--sub);margin-top:-4px">${task.question}</p>` : trustedHtml("")}
    <span class="pill" style="background:var(--accent-soft);color:var(--accent)">${label}</span>
    <span class="pill" style="margin-left:6px;background:var(--card2);color:var(--sub)">${visibilityLabel}</span>
  </section>`;
}

interface StepEntryLike {
  name?: string;
  status?: string;
  detail?: string;
}

/** `steps` (the `research_tasks.steps` JSON column) is written exclusively by
 * ResearchTaskRepository.appendStep with the exact
 * `{name, status: 'done'|'skipped', detail, at}` shape research-engine.mjs's
 * `record()` produces - but this reader stays permissive (never throws on a
 * malformed/foreign shape) the same way the pre-Task-4 version of this file
 * was, since nothing here re-validates what was persisted. */
function normalizeStep(step: unknown): StepEntryLike {
  if (step && typeof step === "object" && !Array.isArray(step)) {
    return step as StepEntryLike;
  }
  return { detail: typeof step === "string" ? step : JSON.stringify(step) };
}

/** One row per step: name + a 完成/跳过 pill + the honest detail text
 * (plan: "each with skip markers rendered honestly「跳过：未找到 X」" - the
 * detail field IS that exact honest sentence, produced by research-
 * engine.mjs's own `record()` calls, e.g. `跳过：未找到 ${symbol} 行情`). */
function renderStepRow(step: unknown, index: number): Html {
  const entry = normalizeStep(step);
  const skipped = entry.status === "skipped";
  const statusPill = entry.status
    ? html`<span class="pill ${skipped ? "warn" : "ok"}" style="margin-left:6px">${skipped ? "跳过" : "完成"}</span>`
    : trustedHtml("");
  return html`<div class="alert">
    <span class="mono">${index + 1}.</span>
    <span><b>${entry.name ?? "步骤"}</b>${statusPill}${entry.detail ? html` <span style="color:var(--sub)">· ${entry.detail}</span>` : trustedHtml("")}</span>
  </div>`;
}

function renderStepsList(steps: unknown): Html {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) {
    return renderEmptyState(
      "这次调研还没有记录任何步骤。",
      "步骤流由研究引擎边跑边写（意图解析 → 拉取行情 → 检索新闻 → 读取你的论点与纪律 → 数字校验 → 生成研判）；刚提交时为空是正常的，页面会自动刷新。"
    );
  }
  return joinHtml(list.map((step, index) => renderStepRow(step, index)));
}

// ---------------------------------------------------------------------------
// 进行中 (queued/running)
// ---------------------------------------------------------------------------

/** The ONLY branch that ever emits the polling `<script>` - see module
 * header's "SECOND NONCE'D SCRIPT". */
function renderInProgressBody(task: ResearchTask, nonce: string): Html {
  return html`<div class="bento">${renderHeaderCard(task)}</div>
    <div class="bento" style="margin-top:10px">
      <section class="card w2 dt-w4">
        <h2>调研过程</h2>
        ${renderStepsList(task.steps)}
        <p style="margin-top:10px;font-size:12.5px;color:var(--sub)">调研进行中，本页每 3 秒自动刷新（可关闭页面，完成后飞书通知）</p>
      </section>
    </div>
    <script nonce="${nonce}">${trustedHtml(`setTimeout(function(){location.reload();},${POLL_INTERVAL_MS});`)}</script>`;
}

// ---------------------------------------------------------------------------
// 研判页 (done/degraded) - rendered from task.resultJson
// ---------------------------------------------------------------------------

function renderConfidenceBadge(confidence: ResearchConfidence | undefined): Html {
  if (!confidence) {
    return trustedHtml("");
  }
  const pillClass = confidence === "high" ? "ok" : confidence === "medium" ? "warn" : "";
  return html`<span class="pill ${pillClass}">${CONFIDENCE_LABELS[confidence]}</span>`;
}

function renderDegradedBanner(): Html {
  return html`<div class="bento" style="padding-bottom:0">
    <section class="card w2 dt-w4 amber" role="alert" aria-label="研判降级提示">
      <h2 style="color:var(--amber)">降级</h2>
      <p style="margin:0;font-size:13px;color:var(--ink)">降级：已收集材料，研判未完成。</p>
    </section>
  </div>`;
}

// ① 核心结论卡
function renderConclusionCard(result: ResearchResult, finishedAt: string | undefined): Html {
  const asOf = finishedAt ? formatBeijingDateTime(finishedAt) : "—";
  return html`<section class="card w2 dt-w4">
    <h2>核心结论 ${renderConfidenceBadge(result.confidence)}</h2>
    <p style="font-size:14px;line-height:1.7;color:var(--ink)">${result.conclusion}</p>
    <p style="margin-top:8px;font-size:12px;color:var(--sub)">截至 <span class="mono">${asOf}</span></p>
  </section>`;
}

// ② 关键要点
function renderKeyPointRow(point: ResearchKeyPoint): Html {
  const refs = Array.isArray(point.evidenceRefs) ? point.evidenceRefs : [];
  const badges =
    refs.length > 0
      ? joinHtml(
          refs.map(
            (ref) => html`<span class="pill" style="margin-left:4px;background:var(--card2);color:var(--sub)">${ref}</span>`
          )
        )
      : trustedHtml("");
  return html`<div class="alert"><span>${point.text}</span>${badges}</div>`;
}

function renderKeyPointsCard(points: ResearchKeyPoint[]): Html {
  const list = Array.isArray(points) ? points : [];
  const body =
    list.length > 0
      ? joinHtml(list.map(renderKeyPointRow))
      : renderEmptyState("这次研判没有列出关键要点。", "关键要点是 3-5 条带证据角标的结论支撑；研判降级（材料收齐但结论未完成）时这里会是空的。");
  return html`<section class="card w2 dt-w4">
    <h2>关键要点</h2>
    ${body}
  </section>`;
}

// ③ 数据表
function renderDataTableCard(rows: ResearchDataTableRow[]): Html {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>数据表</h2>
      ${renderEmptyState(
        "这次研判没有引用任何行情或指标数据。",
        "数据表只收录调研过程中真正取到的数字；取不到时研究引擎会在「调研过程」里显式记一条「跳过」，不会编造。"
      )}
    </section>`;
  }
  const body = joinHtml(
    list.map(
      (row) =>
        html`<div class="alert"><span>${row.label}</span><span class="mono">${row.value}</span><span style="color:var(--sub)">${row.source}</span></div>`
    )
  );
  return html`<section class="card w2 dt-w4">
    <h2>数据表</h2>
    ${body}
  </section>`;
}

// ④ 与我的论点/纪律对照 - comparison.theses/disciplines are loosely typed
// JsonValue[] (domain.ts's own comment: the per-item shape belongs to Task 2,
// not the Task 1 type) - research-engine.mjs's actual `compareThesis`/
// `compareDiscipline` output is `{..., verdict: '一致'|'冲突'|'无法判断', note}`,
// read here defensively rather than trusting the loose type.
function renderComparisonRow(entry: unknown): Html {
  const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const label =
    typeof record.symbol === "string"
      ? record.symbol
      : typeof record.ruleText === "string"
        ? record.ruleText
        : "—";
  const verdict = typeof record.verdict === "string" ? record.verdict : "无法判断";
  const note = typeof record.note === "string" ? record.note : "";
  const verdictClass = verdict === "冲突" ? "d" : verdict === "一致" ? "u" : "";
  return html`<div class="disc" style="margin-bottom:8px">
    <b>${label}</b> <span class="${verdictClass}" style="font-weight:600;margin-left:6px">${verdict}</span>
    ${note ? html`<div style="font-size:12px;color:var(--sub);margin-top:2px">${note}</div>` : trustedHtml("")}
  </div>`;
}

function renderComparisonCard(comparison: ResearchResult["comparison"] | undefined): Html {
  const theses = Array.isArray(comparison?.theses) ? comparison.theses : [];
  const disciplines = Array.isArray(comparison?.disciplines) ? comparison.disciplines : [];
  const rows = [...theses, ...disciplines];
  const body =
    rows.length > 0
      ? joinHtml(rows.map(renderComparisonRow))
      : renderEmptyState(
          "你在这次研判涉及的标的上没有可对照的论点或纪律。",
          "对照读的是你自己的「系统可用 + 公开」两档论点与纪律。在飞书单聊里记一条论点或纪律后，下次研判就会自动标出一致/冲突。"
        );
  return html`<section class="card w2 dt-w4">
    <h2>与我的论点/纪律对照</h2>
    ${body}
  </section>`;
}

// ⑤ 建议动作
function renderSuggestedActionCard(suggestedAction: string | undefined): Html {
  return html`<section class="card w2 dt-w4">
    <h2>建议动作</h2>
    <p style="font-size:13.5px;color:var(--ink)">${suggestedAction ?? "这次研判没有给出可执行的建议动作——研究引擎只在证据足够支撑一个具体动作（如止损位、仓位）时才写这一段。"}</p>
    <p style="margin-top:6px;font-size:12px;color:var(--sub)">不构成投资建议，模拟盘语境。</p>
  </section>`;
}

// ⑥ 证据链
function renderEvidenceRow(item: ResearchEvidenceItem): Html {
  const titleHtml = item.url && HTTP_LINK_RE.test(item.url)
    ? html`<a href="${item.url}" rel="noreferrer" target="_blank" style="color:var(--accent)">${item.title}</a>`
    : html`<span>${item.title}</span>`;
  return html`<div class="alert">
    <span class="mono">${item.ref}</span>
    <span>${titleHtml} <span style="color:var(--sub)">· ${item.publisher ?? "未知来源"}</span></span>
  </div>`;
}

function renderEvidenceCard(evidence: ResearchEvidenceItem[]): Html {
  const list = Array.isArray(evidence) ? evidence : [];
  const body =
    list.length > 0
      ? joinHtml(list.map(renderEvidenceRow))
      : renderEmptyState(
          "这次研判没有引用任何外部证据。",
          "证据链收录调研过程中真正读到的新闻与数据源；一次纯粹基于你自己持仓与论点的研判可以合法地没有外部证据。"
        );
  return html`<section class="card w2 dt-w4">
    <h2>证据链</h2>
    ${body}
  </section>`;
}

// ⑦ 调研过程 (collapsed steps + explicit skipped list)
function renderProcessDetailsCard(task: ResearchTask, skipped: ResearchResult["skipped"] | undefined): Html {
  const skippedList = Array.isArray(skipped) ? skipped : [];
  const skippedBody =
    skippedList.length > 0
      ? joinHtml(
          skippedList.map(
            (item) => html`<div class="alert"><span>${item.step}</span><span style="color:var(--sub)"> · ${item.reason}</span></div>`
          )
        )
      : html`<p style="font-size:13px;color:var(--sub)">无跳过项</p>`;
  return html`<section class="card w2 dt-w4">
    <details>
      <summary style="cursor:pointer;font-size:13px;color:var(--sub);padding:4px 0">调研过程</summary>
      <div style="margin-top:8px">${renderStepsList(task.steps)}</div>
      <h3 style="margin-top:12px;font-size:12.5px;color:var(--sub)">跳过项</h3>
      ${skippedBody}
    </details>
  </section>`;
}

// ---------------------------------------------------------------------------
// ⑧ 归档动作: 设为公开 / 存为论点 (req §1.3 step 4) - 2026-07-30, plan Task 18.
//
// The promote ENDPOINT has existed since P8 (routes/api-research.ts) but no
// surface could reach it, and 「存为论点」 had no control at all - the spec's
// two archive actions were both unreachable from the page they belong to.
//
// OWNER ONLY, and only on a finished verdict. A public research task is
// readable by any member (this route's own exception to the ownership gate),
// so these forms are gated on `isOwner`, never on "the page rendered".
//
// The confirmation is the spec's, and it states what promoting ACTUALLY does:
// `promoteVisibility` flips this task's row and nothing else, so the theses
// and rules keep their own tier - what changes is that their content, as
// quoted inside this verdict's 对照 block, becomes readable by the circle.
// Claiming the items get promoted too would be a claim the code does not make.
// ---------------------------------------------------------------------------

interface PromotionExposure {
  /** This owner's `system`-tier theses the verdict quotes. */
  theses: ThesisEvidenceRow[];
  /** Discipline rule texts the verdict quotes - rules have no public tier at
   * all (there is no `visibility` column on discipline_rules), so every one
   * of them is owner-private today and every one is newly exposed. */
  disciplineTexts: string[];
}

function readComparisonRecords(entries: unknown): Array<Record<string, unknown>> {
  return Array.isArray(entries)
    ? entries.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function collectPromotionExposure(db: DatabaseSync, task: ResearchTask): PromotionExposure {
  const comparison = task.resultJson?.comparison;
  const thesisRefs = readComparisonRecords(comparison?.theses)
    .map((record) => record.ref)
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  const disciplineTexts = readComparisonRecords(comparison?.disciplines)
    .map((record) => record.ruleText)
    .filter((text): text is string => typeof text === "string" && text.length > 0);

  const theses = loadOwnThesesByIds(db, task.ownerId, thesisRefs).filter((row) => row.visibility === "system");
  return { theses, disciplineTexts };
}

const THESIS_DIRECTION_LABELS: Record<string, string> = { bull: "看多", bear: "看空", neutral: "中性" };

function renderExposureList(exposure: PromotionExposure): Html {
  const items = [
    ...exposure.theses.map(
      (thesis) => html`<li style="margin:4px 0">论点 · <b>${thesis.symbol}</b>（${THESIS_DIRECTION_LABELS[thesis.direction] ?? thesis.direction}）</li>`
    ),
    ...exposure.disciplineTexts.map((text) => html`<li style="margin:4px 0">纪律 · ${text}</li>`)
  ];
  if (items.length === 0) {
    return html`<p style="font-size:13px;color:var(--ink)">这条研判没有引用你的任何论点或纪律，没有「系统可用」档内容会被连带暴露。</p>`;
  }
  return html`<p style="font-size:13px;color:var(--ink)">
      设为公开后，本页的「与我的论点/纪律对照」区块会<b>连带暴露以下 ${items.length} 条</b>「系统可用」档内容（这些论点/纪律本身的档位不变，改变的是它们在本页里的内容会被圈内成员读到）：
    </p>
    <ul style="margin:6px 0 0 18px;font-size:13px">${joinHtml(items)}</ul>`;
}

function renderPromoteConfirmCard(task: ResearchTask, exposure: PromotionExposure): Html {
  return html`<section class="card w2 dt-w4 amber" aria-label="设为公开确认">
    <h2 style="color:var(--amber)">设为公开前请确认</h2>
    ${renderExposureList(exposure)}
    <form method="post" action="/api/research/${task.id}/promote" style="margin-top:10px">
      <button class="btn primary" type="submit">确认设为公开</button>
      <a href="/research/${task.id}" style="margin-left:10px;font-size:13px;color:var(--sub)">取消</a>
    </form>
  </section>`;
}

function renderArchiveActionsCard(task: ResearchTask): Html {
  const visibilityRow =
    task.visibility === "public"
      ? html`<p style="font-size:13px;color:var(--sub);margin:0">这条研判<b>已公开</b>，会出现在你名片的「公开研判」区。</p>`
      : html`<p style="font-size:13px;color:var(--sub);margin:0 0 8px">
            这条研判目前仅你自己可见。公开后它会进入你名片的「公开研判」区。
          </p>
          <a class="btn" href="/research/${task.id}?promote=confirm">设为公开 →</a>`;

  return html`<section class="card w2 dt-w4">
    <h2>归档动作</h2>
    ${visibilityRow}
    <hr style="border:none;border-top:1px solid var(--line);margin:12px 0" />
    <p style="font-size:13px;color:var(--sub);margin:0 0 8px">
      把这次研判的核心结论存成一条论点，之后每次研判与个股分析都会拿它做对照。存下来的论点是「系统可用」档（仅系统与你可见），要公开另外操作。
    </p>
    <form method="post" action="/api/research/${task.id}/thesis" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input name="symbol" required placeholder="标的代码，如 NVDA.US" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px" />
      <select name="direction" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px">
        <option value="bull">看多</option>
        <option value="bear">看空</option>
        <option value="neutral">中性</option>
      </select>
      <button class="btn" type="submit">存为论点</button>
    </form>
  </section>`;
}

function renderVerdictBody(task: ResearchTask, archiveActions: Html): Html {
  const banner = task.status === "degraded" ? renderDegradedBanner() : trustedHtml("");
  const result = task.resultJson;

  // Defensive only: the real pipeline (worker.ts's tick()) always writes
  // result_json alongside a 'done'/'degraded' status - this branch exists so
  // a hand-seeded or corrupted row degrades to an honest empty state instead
  // of throwing and 500ing the whole page.
  if (!result) {
    return html`${banner}
      <div class="bento">${renderHeaderCard(task)}</div>
      <div class="bento" style="margin-top:10px">
        <section class="card w2 dt-w4">
          <h2>核心结论</h2>
          ${renderEmptyState(
            "这次任务没有产出研判结果。",
            "任务已结束但结果为空，通常意味着研究引擎在写回结果前中断了；可以在首页重新提问一次（每人每日 10 次配额）。"
          )}
        </section>
      </div>`;
  }

  return html`${banner}
    <div class="bento">${renderHeaderCard(task)}</div>
    <div class="bento" style="margin-top:10px">${renderConclusionCard(result, task.finishedAt)}</div>
    <div class="bento" style="margin-top:10px">${renderKeyPointsCard(result.keyPoints)}</div>
    <div class="bento" style="margin-top:10px">${renderDataTableCard(result.dataTable)}</div>
    <div class="bento" style="margin-top:10px">${renderComparisonCard(result.comparison)}</div>
    <div class="bento" style="margin-top:10px">${renderSuggestedActionCard(result.suggestedAction)}</div>
    <div class="bento" style="margin-top:10px">${renderEvidenceCard(result.evidence)}</div>
    <div class="bento" style="margin-top:10px">${renderProcessDetailsCard(task, result.skipped)}</div>
    ${archiveActions}`;
}

// ---------------------------------------------------------------------------
// 失败 (failed) - result_json is always null on this path; the reason comes
// from the honest steps trace instead.
// ---------------------------------------------------------------------------

function deriveFailureReason(steps: unknown): string {
  const list = Array.isArray(steps) ? steps : [];
  const last = list[list.length - 1];
  const entry = normalizeStep(last);
  return entry.detail && entry.detail.length > 0 ? entry.detail : "研究失败，未记录具体原因。";
}

function renderFailedBody(task: ResearchTask): Html {
  const reason = deriveFailureReason(task.steps);
  return html`<div class="bento">${renderHeaderCard(task)}</div>
    <div class="bento" style="margin-top:10px">
      <section class="card w2 dt-w4 amber" role="alert" aria-label="研究失败原因">
        <h2 style="color:var(--amber)">失败原因</h2>
        <p style="font-size:13.5px;color:var(--ink)">${reason}</p>
      </section>
    </div>
    <div class="bento" style="margin-top:10px">
      <section class="card w2 dt-w4">
        <h2>调研过程</h2>
        ${renderStepsList(task.steps)}
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function renderResearchPage(
  res: ServerResponse,
  deps: ResearchRouteDeps,
  member: Member,
  task: ResearchTask,
  isOwner: boolean,
  promoteConfirm: boolean,
  nonce: string
): void {
  const now = currentNow(deps);

  let bodyHtml: Html;
  if (task.status === "queued" || task.status === "running") {
    bodyHtml = renderInProgressBody(task, nonce);
  } else if (task.status === "done" || task.status === "degraded") {
    // Archive actions belong to the OWNER only - a member reading someone
    // else's public verdict gets the verdict and nothing they could act on.
    const archiveActions = !isOwner
      ? trustedHtml("")
      : promoteConfirm && task.visibility !== "public"
        ? html`<div class="bento" style="margin-top:10px">
            ${renderPromoteConfirmCard(task, collectPromotionExposure(deps.db, task))}
          </div>`
        : html`<div class="bento" style="margin-top:10px">${renderArchiveActionsCard(task)}</div>`;
    bodyHtml = renderVerdictBody(task, archiveActions);
  } else {
    bodyHtml = renderFailedBody(task);
  }

  const page = renderPage({
    title: task.title ?? task.question,
    nav: "home",
    member: { displayName: member.displayName },
    freshness: "最新",
    // U2: a verdict is a snapshot of the moment it finished; an in-progress
    // task legitimately has no data time yet.
    dataAsOf: task.finishedAt ? describeDataInstant(task.finishedAt, now) : null,
    degraded: [],
    bodyHtml,
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

/**
 * Routes `GET /research/<id>`. Returns `true` if the request was handled
 * (including 401/403/404/405 responses), `false` if the path doesn't belong
 * to this module so the caller can keep trying other routes.
 */
export function handleResearchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ResearchRouteDeps,
  nonce: string
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== "research") {
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
  const id = segments[1] as string;

  const task = new ResearchTaskRepository(deps.db).getById(id);
  if (!task) {
    sendHtml(res, 404, renderNotFoundPage(member, nonce, now));
    return true;
  }

  const isOwner = task.ownerId === member.id;
  if (!isOwner && task.visibility !== "public") {
    sendHtml(res, 403, renderForbiddenPage(member, "home", nonce, now));
    return true;
  }

  renderResearchPage(res, deps, member, task, isOwner, url.searchParams.get("promote") === "confirm", nonce);
  return true;
}
