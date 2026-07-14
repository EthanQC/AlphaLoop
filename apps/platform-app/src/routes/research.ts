/**
 * Research task detail page (Task 7): `GET /research/<id>`. Identity-gated
 * like every route past Task 3, plus the SAME row-first ownership gate as
 * proposal.ts, with ONE deliberate exception (plan Task 7, req §1.9):
 * `visibility = 'public'` rows are viewable by ANY member, not just their
 * owner - a research task's owner can choose to publish it (mirrors theses'
 * own system/public visibility split), and a published one is meant to be
 * read by the circle.
 *
 * ACCESS ORDER (same discipline as proposal.ts):
 *   1. Resolve the row FIRST, by id alone.
 *   2. No row -> 404.
 *   3. Row exists AND `owner_id !== viewer.id` AND `visibility !== 'public'`
 *      -> 403 (render/forbidden.ts's shared page).
 *   4. Otherwise (owner, OR a public row viewed by anyone) -> render.
 *
 * `result_path` is never linked out as a real reading page today - P8
 * ("站内研究 worker") hasn't shipped the research-execution/result pipeline
 * yet, so the result-link block always shows the honest 「研究执行 P8 上线」
 * placeholder regardless of whether `result_path` happens to be set.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { html, joinHtml, type Html } from "../render/html.js";
import { renderForbiddenPage } from "../render/forbidden.js";
import { renderPage } from "../render/layout.js";

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
// Data loading
// ---------------------------------------------------------------------------

interface ResearchTaskDetailRow {
  id: string;
  ownerId: string;
  question: string;
  status: string;
  steps: unknown;
  resultPath: string | null;
  visibility: "private" | "public";
  createdAt: string;
  finishedAt: string | null;
}

/** Best-effort JSON parse for the `steps` TEXT column (`NOT NULL DEFAULT
 * '[]'` per schema) - malformed JSON renders as an empty step list rather
 * than throwing and 500ing the whole page. */
function parseSteps(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return [];
  }
}

function loadResearchTaskById(db: DatabaseSync, id: string): ResearchTaskDetailRow | null {
  const row = db.prepare(`SELECT * FROM research_tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    question: String(row.question),
    status: String(row.status),
    steps: parseSteps(row.steps),
    resultPath: row.result_path === null || row.result_path === undefined ? null : String(row.result_path),
    visibility: row.visibility as ResearchTaskDetailRow["visibility"],
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at)
  };
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
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHeaderCard(task: ResearchTaskDetailRow): Html {
  const label = STATUS_LABELS[task.status] ?? task.status;
  const visibilityLabel = task.visibility === "public" ? "公开" : "系统可用";
  return html`<section class="card w2 dt-w4">
    <h2>${task.question}</h2>
    <span class="pill" style="background:var(--accent-soft);color:var(--accent)">${label}</span>
    <span class="pill" style="margin-left:6px;background:var(--card2);color:var(--sub)">${visibilityLabel}</span>
  </section>`;
}

/** `steps` has no fixed shape yet (P8 hasn't shipped a writer) - each entry
 * renders as its `name`/`label`/`title` field if it's an object with one of
 * those, otherwise as its raw string form. This is deliberately permissive
 * rather than trusting one exact shape, since nothing in this codebase
 * writes this column yet to pin the shape down. */
function stepLine(step: unknown): string {
  if (typeof step === "string") {
    return step;
  }
  if (step && typeof step === "object") {
    const record = step as Record<string, unknown>;
    const name = record.name ?? record.label ?? record.title;
    if (typeof name === "string") {
      return name;
    }
  }
  return JSON.stringify(step);
}

function renderStepsTimelineCard(steps: unknown): Html {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>调研过程</h2>
      <p style="font-size:13px;color:var(--sub)">暂无步骤记录</p>
    </section>`;
  }
  const rows = joinHtml(list.map((step, index) => html`<div class="alert"><span class="mono">${index + 1}.</span><span>${stepLine(step)}</span></div>`));
  return html`<section class="card w2 dt-w4">
    <h2>调研过程</h2>
    ${rows}
  </section>`;
}

function renderResultLinkCard(): Html {
  return html`<section class="card w2 dt-w4">
    <h2>结果</h2>
    <p style="font-size:13px;color:var(--sub)">研究执行 P8 上线</p>
  </section>`;
}

function renderResearchPage(
  res: ServerResponse,
  deps: ResearchRouteDeps,
  member: Member,
  task: ResearchTaskDetailRow,
  nonce: string
): void {
  const now = currentNow(deps);

  const bodyHtml = html`<div class="bento">${renderHeaderCard(task)}</div>
    <div class="bento" style="margin-top:10px">${renderStepsTimelineCard(task.steps)}</div>
    <div class="bento" style="margin-top:10px">${renderResultLinkCard()}</div>`;

  const page = renderPage({
    title: task.question,
    nav: "home",
    member: { displayName: member.displayName },
    freshness: "最新",
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

  const task = loadResearchTaskById(deps.db, id);
  if (!task) {
    sendHtml(res, 404, renderNotFoundPage(member, nonce, now));
    return true;
  }

  const isOwner = task.ownerId === member.id;
  if (!isOwner && task.visibility !== "public") {
    sendHtml(res, 403, renderForbiddenPage(member, "home", nonce, now));
    return true;
  }

  renderResearchPage(res, deps, member, task, nonce);
  return true;
}
