// 个人页生成器 - requirements §3.2「个人页（每人一份，随日报生成）」.
//
// Task 4 took the owner's account, holdings and strategy content OUT of the
// public daily/weekly body (§3.1: "不含任何个人持仓与策略内容"). This module is
// where that content went: one markdown page per ACTIVE member per report,
// stored in `personal_pages` (schema v16) and rendered back by the owner-only
// platform route. §3.2 fixes the four sections, in this order:
//
//   1. 我的持仓速览   - official_paper_snapshots, owner-scoped
//   2. 我的策略对照   - theses + computeThesisOutcome (距失效线) + discipline_rules
//   3. 我的提醒回顾   - alert_events inside this report's window
//   4. 我的待办       - the owner's still-pending proposals
//
// ---------------------------------------------------------------------------
// Owner isolation
// ---------------------------------------------------------------------------
// §3.2: "个人页只有本人可见——「系统可用」档策略绝不泄露给其他成员". Every read
// below is parameterised on `ownerId` and NOTHING here ever reads a second
// member's rows - so two members' pages cannot share a private token even
// before the platform route's identity check runs. The single deliberate
// exception is documented at loadSnapshotScope(): a legacy `owner_id IS NULL`
// snapshot belongs to nobody in particular (it predates per-member accounts),
// and when it is used the page SAYS SO rather than presenting it as the
// member's own account.
//
// ---------------------------------------------------------------------------
// Why `helpers` is injected instead of imported
// ---------------------------------------------------------------------------
// The account view is rendered by scheduled-report.mjs's
// renderOfficialPaperSnapshot / summarizeOfficialAccount /
// summarizeOfficialPositions - Task 4 exported those three precisely so this
// page could reuse them instead of growing a second copy of the same format.
// But scheduled-report.mjs imports THIS module (it generates the pages right
// after it writes the report), so importing them back would make the two files
// a cycle. Injecting them keeps the dependency one-directional, the same
// pattern review-engine.mjs already uses for its cross-app helpers.
//
// This module deliberately does no IO beyond the database handle it is given:
// no network, no filesystem, no env - which is what lets the test suite render
// a full page against a temp database.

import { createId, MemberRepository } from "../../../packages/shared-types/dist/index.js";

import { computeThesisOutcome } from "./thesis-outcome.mjs";

const TIMEZONE = "Asia/Shanghai";

const SECTION_TITLES = {
  holdings: "我的持仓速览",
  strategy: "我的策略对照",
  alerts: "我的提醒回顾",
  todos: "我的待办",
  // C2 (2026-07-28 review): §3.3's weekly-only section. The weekly page used to
  // be byte-identical in structure to the daily one.
  consistency: "本周我的交易 vs 策略一致性回顾"
};

// §3.2 fixes these four, in this order, for BOTH kinds. `consistency` is
// appended for the weekly kind only (§3.3) - see SECTION_ORDER_BY_KIND.
const SECTION_ORDER = ["holdings", "strategy", "alerts", "todos"];

const SECTION_ORDER_BY_KIND = {
  daily: SECTION_ORDER,
  weekly: [...SECTION_ORDER, "consistency"]
};

const KIND_LABELS = { daily: "日报", weekly: "周报" };

const DIRECTION_LABELS = { bull: "看多", bear: "看空", neutral: "中性" };

const VERDICT_LABELS = {
  toward_target: "偏向目标",
  toward_invalidation: "偏向失效",
  neutral: "仍在区间内",
  insufficient: "判定不足（论点缺少方向所需的目标价/失效价）",
  no_price: "无最新价，无法判定"
};

const RULE_TYPE_LABELS = {
  daily_move: "日内涨跌",
  unrealized_pnl: "浮动盈亏",
  spike_5m: "5 分钟异动",
  exposure: "仓位暴露"
};

const RULE_DIRECTION_LABELS = { both: "双向", up: "向上", down: "向下" };

const ENFORCEMENT_LABELS = {
  hard: "硬约束",
  proposal_check: "提案检查",
  self: "自律"
};

const SIDE_LABELS = { buy: "买入", sell: "卖出" };

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
// Same rule as scheduled-report.mjs's resolveReportWindow (daily = the past
// day, weekly = the past 7 days, both bounded at 20:00 Beijing time), kept as
// a separate implementation ONLY because importing scheduled-report.mjs here
// would close the cycle described in the header. personal-page.test.ts asserts
// the two agree for both kinds, so a change to one that is not mirrored in the
// other fails the suite rather than silently shifting which alerts a page
// reviews.
export function resolvePersonalPageWindow(kind, date) {
  assertKind(kind);
  assertDateLabel(date);
  const startLabel = addDays(date, kind === "daily" ? -1 : -7);
  return {
    kind,
    label: date,
    startLabel,
    endLabel: date,
    start: new Date(`${startLabel}T20:00:00+08:00`),
    end: new Date(`${date}T20:00:00+08:00`)
  };
}

/**
 * Renders one member's personal page for one report.
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   ownerId: string,
 *   kind: 'daily'|'weekly',
 *   date: string,
 *   now?: string,
 *   helpers: {
 *     renderOfficialPaperSnapshot: (snapshot: object) => string,
 *     summarizeOfficialAccount: (snapshot: object) => string,
 *     summarizeOfficialPositions: (rows: object[]) => string
 *   }
 * }} input
 * @returns {{markdown: string, sections: Array<{key: string, title: string, body: string}>}}
 */
export function renderPersonalPage({ db, ownerId, kind, date, now, helpers } = {}) {
  if (!db) {
    throw new Error("renderPersonalPage requires a db handle.");
  }
  if (!ownerId) {
    throw new Error("renderPersonalPage requires ownerId.");
  }
  assertKind(kind);
  assertDateLabel(date);
  assertHelpers(helpers);

  const window = resolvePersonalPageWindow(kind, date);
  const member = loadMember(db, ownerId);
  const alerts = loadAlertEvents(db, ownerId, window);

  const bodies = {
    holdings: () => renderHoldings(db, ownerId, window, alerts, helpers),
    strategy: () => renderStrategy(db, ownerId, date),
    alerts: () => renderAlerts(alerts, window),
    todos: () => renderTodos(db, ownerId),
    consistency: () => renderTradeConsistency(db, ownerId, window, helpers)
  };
  const sections = SECTION_ORDER_BY_KIND[kind].map((key) => ({
    key,
    title: SECTION_TITLES[key],
    body: bodies[key]()
  }));

  const displayName = member?.displayName ?? "未知成员";
  const generatedAt = now ?? new Date().toISOString();

  const markdown = [
    `# 我的个人页 · ${KIND_LABELS[kind]} ${date}`,
    "",
    `- 成员：${displayName}（${ownerId}）`,
    `- 窗口：${window.startLabel} 20:00 - ${window.endLabel} 20:00（北京时间）`,
    `- 生成时间：${formatDateTime(generatedAt)}`,
    "- 可见性：仅本人可见；本页不进入公共日报/周报正文，也不发到群里。",
    "",
    ...sections.flatMap((section, index) => [`## ${index + 1}. ${section.title}`, "", section.body, ""])
  ]
    .join("\n")
    .trimEnd();

  return { markdown, sections };
}

/**
 * Renders + persists the page of every ACTIVE member for one report.
 * A member whose page throws is recorded in `failures` and does NOT abort the
 * other members' pages - one broken owner must not cost everybody else their
 * page (and the caller reports the failure rather than hiding it).
 *
 * @returns {{generated: Array<{ownerId: string, id: string, sections: object[]}>, failures: Array<{ownerId: string, reason: string}>}}
 */
export function generatePersonalPages({ db, kind, date, now, helpers } = {}) {
  if (!db) {
    throw new Error("generatePersonalPages requires a db handle.");
  }
  assertKind(kind);
  assertDateLabel(date);
  assertHelpers(helpers);

  const generated = [];
  const failures = [];

  for (const member of new MemberRepository(db).listActive()) {
    try {
      const page = renderPersonalPage({ db, ownerId: member.id, kind, date, now, helpers });
      const id = savePersonalPage({ db, ownerId: member.id, kind, date, markdown: page.markdown, now });
      generated.push({ ownerId: member.id, id, sections: page.sections });
    } catch (error) {
      failures.push({ ownerId: member.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { generated, failures };
}

// Upsert on the v16 UNIQUE(owner_id, kind, date): re-running a report refreshes
// that day's page in place. `created_at` is updated alongside `markdown`
// because it dates the TEXT stored in the row (see the migration's comment).
export function savePersonalPage({ db, ownerId, kind, date, markdown, now } = {}) {
  if (!db) {
    throw new Error("savePersonalPage requires a db handle.");
  }
  if (!ownerId) {
    throw new Error("savePersonalPage requires ownerId.");
  }
  assertKind(kind);
  assertDateLabel(date);
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new Error("savePersonalPage refuses to store an empty personal page.");
  }

  const createdAt = now ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO personal_pages (id, owner_id, kind, date, markdown, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, kind, date) DO UPDATE SET
      markdown = excluded.markdown,
      created_at = excluded.created_at
  `).run(createId("personal_page"), ownerId, kind, date, markdown, createdAt);

  // Re-read: on the ON-CONFLICT path SQLite keeps the EXISTING row's id (the
  // freshly generated one above is simply never written), so only a re-read
  // reports the id that actually persisted.
  const row = db
    .prepare(`SELECT id FROM personal_pages WHERE owner_id = ? AND kind = ? AND date = ?`)
    .get(ownerId, kind, date);
  if (!row) {
    throw new Error(`Personal page for ${ownerId}/${kind}/${date} vanished immediately after write.`);
  }
  return String(row.id);
}

// ---------------------------------------------------------------------------
// 1. 我的持仓速览
// ---------------------------------------------------------------------------

function renderHoldings(db, ownerId, window, alerts, helpers) {
  const scope = loadSnapshotScope(db, ownerId, window);
  if (!scope.latest) {
    return [
      `- 暂无持仓：截至 ${window.endLabel} 20:00，数据库里没有属于本人的模拟盘账户快照，也没有可用的共享快照。`,
      "- 说明：这不是「空仓」的结论——是账户数据本身没取到，请勿据此判断仓位。"
    ].join("\n");
  }

  const snapshot = parseSnapshot(scope.latest.raw);
  const lines = [];

  lines.push(
    scope.attributed
      ? `- 数据归属：本人账户快照（owner_id = ${ownerId}）。`
      : "- 数据归属：共享模拟盘快照——这些历史记录未按成员归属（owner_id 为空），不能证明是本人专属账户，仅作账户层面参考。"
  );

  if (!snapshot) {
    lines.push(
      `- 快照时间：${formatDateTime(scope.latest.fetched_at)}`,
      "- 明细不可用：这条快照的原始 JSON 无法解析，因此不展示净资产/现金/持仓明细，避免给出一份读错的账目。"
    );
    return lines.join("\n");
  }

  lines.push(`- 速览：${helpers.summarizeOfficialAccount(snapshot)}`);
  lines.push(`- 持仓：${helpers.summarizeOfficialPositions(snapshot.positions ?? [])}`);
  lines.push(`- 区间净值变动：${describeNetAssetsChange(scope, window)}`);
  lines.push(`- 异动标注：${describeMovers(alerts)}`);
  lines.push("");
  lines.push("明细（长桥官方模拟盘）：");
  lines.push("");
  lines.push(helpers.renderOfficialPaperSnapshot(snapshot));

  return lines.join("\n");
}

// Which snapshots may this page read?
//
// The owner's OWN rows win outright. A legacy `owner_id IS NULL` row is used
// only when the owner has none of their own: those rows predate per-member
// accounts (schema v4 added the column, and the shared paper account wrote
// NULL before that), so they belong to nobody in particular rather than to
// another member - reading them leaks no second member's data. The precedence
// mirrors market-alerts-store.mjs's loadLatestSnapshotForOwner, which
// adjudicated the same question for the alert engine; it is re-implemented
// here only because this page needs the `raw`/`fetched_at` columns that
// function does not return.
//
// Both the latest snapshot and the baseline used for the net-assets delta are
// taken from the SAME scope, so the delta can never compare the owner's own
// account against the shared pool's.
function loadSnapshotScope(db, ownerId, window) {
  const endIso = window.end.toISOString();
  const startIso = window.start.toISOString();

  const own = db
    .prepare(`
      SELECT id, fetched_at, net_assets, raw FROM official_paper_snapshots
      WHERE owner_id = ? AND fetched_at <= ?
      ORDER BY fetched_at DESC LIMIT 1
    `)
    .get(ownerId, endIso);

  if (own) {
    return {
      attributed: true,
      latest: own,
      baseline: db
        .prepare(`
          SELECT id, fetched_at, net_assets FROM official_paper_snapshots
          WHERE owner_id = ? AND fetched_at <= ?
          ORDER BY fetched_at DESC LIMIT 1
        `)
        .get(ownerId, startIso) ?? null
    };
  }

  const shared = db
    .prepare(`
      SELECT id, fetched_at, net_assets, raw FROM official_paper_snapshots
      WHERE owner_id IS NULL AND fetched_at <= ?
      ORDER BY fetched_at DESC LIMIT 1
    `)
    .get(endIso);

  if (!shared) {
    return { attributed: false, latest: null, baseline: null };
  }

  return {
    attributed: false,
    latest: shared,
    baseline: db
      .prepare(`
        SELECT id, fetched_at, net_assets FROM official_paper_snapshots
        WHERE owner_id IS NULL AND fetched_at <= ?
        ORDER BY fetched_at DESC LIMIT 1
      `)
      .get(startIso) ?? null
  };
}

function describeNetAssetsChange(scope, window) {
  const latestNet = toNumberOrNull(scope.latest?.net_assets);
  if (latestNet === null) {
    return "不可计算（原因：最新快照没有净资产字段）";
  }
  if (!scope.baseline) {
    return `不可计算（原因：窗口起点 ${window.startLabel} 20:00 之前没有同口径的账户快照可比）`;
  }
  const baseNet = toNumberOrNull(scope.baseline.net_assets);
  if (baseNet === null) {
    return "不可计算（原因：窗口起点的快照没有净资产字段）";
  }

  const delta = latestNet - baseNet;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "±";
  const pct = baseNet === 0 ? "基准为 0，涨跌幅不可计算" : formatSignedPercent((delta / baseNet) * 100);
  return `${sign}${formatNumber(Math.abs(delta))}（${pct}）；起点 ${formatNumber(baseNet)} → 最新 ${formatNumber(latestNet)}`;
}

function describeMovers(alerts) {
  if (alerts.length === 0) {
    return "窗口内本人没有触发任何提醒，无异动可标注。";
  }
  const counts = new Map();
  for (const event of alerts) {
    counts.set(event.symbol, (counts.get(event.symbol) ?? 0) + 1);
  }
  return [...counts.entries()].map(([symbol, count]) => `${symbol}（窗口内触发 ${count} 次提醒）`).join("、");
}

// ---------------------------------------------------------------------------
// 2. 我的策略对照
// ---------------------------------------------------------------------------

function renderStrategy(db, ownerId, date) {
  const theses = db
    .prepare(`
      SELECT id, symbol, direction, target_low, target_high, invalidation_price, visibility
      FROM theses
      WHERE owner_id = ? AND status = 'active'
      ORDER BY updated_at DESC, id ASC
    `)
    .all(ownerId);

  const lines = [];

  if (theses.length === 0) {
    lines.push("- 暂无论点：本人名下没有 status=active 的论点记录，因此没有可对照的目标价/失效线。");
  } else {
    for (const row of theses) {
      lines.push(renderThesisLine(db, row, date));
    }
  }

  const disciplines = db
    .prepare(`
      SELECT rule_text, enforcement, linked_strategy
      FROM discipline_rules
      WHERE owner_id = ? AND enabled = 1 AND disabled_at IS NULL
      ORDER BY created_at ASC
    `)
    .all(ownerId);

  lines.push("");
  if (disciplines.length === 0) {
    lines.push("- 相关纪律：本人尚未登记任何生效中的纪律条目。");
  } else {
    for (const rule of disciplines) {
      const linked = rule.linked_strategy ? `，关联策略 ${rule.linked_strategy}` : "";
      lines.push(
        `- 相关纪律：${rule.rule_text}（执行方式：${ENFORCEMENT_LABELS[String(rule.enforcement)] ?? String(rule.enforcement)}${linked}）`
      );
    }
  }

  return lines.join("\n");
}

function renderThesisLine(db, row, date) {
  const symbol = String(row.symbol);
  const direction = String(row.direction);
  const latestPrice = loadLatestPrice(db, symbol, date);

  const thesis = {
    direction,
    targetLow: toNumberOrNull(row.target_low),
    targetHigh: toNumberOrNull(row.target_high),
    invalidationPrice: toNumberOrNull(row.invalidation_price)
  };

  // computeThesisOutcome answers "where does this thesis stand against TODAY's
  // price" and stamps the same answer onto every judgment row it is handed
  // (see its module header). This page needs that single standing, so it hands
  // in exactly one synthetic judgment keyed on the thesis id rather than
  // re-deriving the arithmetic - the thesis's own history is the monthly
  // review's subject, not this page's.
  const { perJudgment } = computeThesisOutcome({
    thesis,
    judgments: [{ id: `${row.id}:current` }],
    latestPrice: latestPrice?.price ?? null
  });
  const outcome = perJudgment[0];

  const levels = [
    thesis.targetHigh !== null ? `目标上沿 ${formatNumber(thesis.targetHigh)}` : null,
    thesis.targetLow !== null ? `目标下沿 ${formatNumber(thesis.targetLow)}` : null,
    thesis.invalidationPrice !== null ? `失效线 ${formatNumber(thesis.invalidationPrice)}` : null
  ].filter(Boolean);
  const levelText = levels.length > 0 ? levels.join(" / ") : "未登记目标价与失效线";

  const priceText = latestPrice
    ? `最新价 ${formatNumber(latestPrice.price)}（来源 stock_facts quote.last，交易日 ${latestPrice.tradingDay}）`
    : "最新价不可用（原因：stock_facts 里没有该标的的 quote.last 记录）";

  const invalidationText = outcome.vsInvalidationPct === null
    ? "距失效线：不可计算"
    : `距失效线 ${formatSignedPercent(outcome.vsInvalidationPct)}`;
  const targetText = outcome.vsTargetPct === null ? "距目标：不可计算" : `距目标 ${formatSignedPercent(outcome.vsTargetPct)}`;

  const visibility = String(row.visibility) === "public" ? "公开" : "系统可用";

  return `- ${symbol}（${DIRECTION_LABELS[direction] ?? direction}，${visibility}档）：${levelText}；${priceText}；${invalidationText}；${targetText}；判定：${VERDICT_LABELS[outcome.verdict] ?? outcome.verdict}`;
}

// Latest close-of-record price at or before the report date - never a price
// from AFTER the window, which would judge the thesis on information the
// report itself does not carry.
function loadLatestPrice(db, symbol, date) {
  const row = db
    .prepare(`
      SELECT trading_day, value_num FROM stock_facts
      WHERE symbol = ? AND fact_key = 'quote.last' AND value_num IS NOT NULL AND trading_day <= ?
      ORDER BY trading_day DESC LIMIT 1
    `)
    .get(symbol, date);
  if (!row) {
    return null;
  }
  const price = toNumberOrNull(row.value_num);
  return price === null ? null : { price, tradingDay: String(row.trading_day) };
}

// ---------------------------------------------------------------------------
// 3. 我的提醒回顾
// ---------------------------------------------------------------------------

function loadAlertEvents(db, ownerId, window) {
  return db
    .prepare(`
      SELECT e.id AS id, e.triggered_at AS triggered_at, e.value AS value, e.feedback AS feedback,
             r.symbol AS symbol, r.rule_type AS rule_type, r.threshold AS threshold, r.direction AS direction
      FROM alert_events e
      JOIN alert_rules r ON r.id = e.rule_id
      WHERE e.owner_id = ? AND e.triggered_at > ? AND e.triggered_at <= ?
      ORDER BY e.triggered_at ASC
    `)
    .all(ownerId, window.start.toISOString(), window.end.toISOString())
    .map((row) => ({
      id: String(row.id),
      triggeredAt: String(row.triggered_at),
      value: toNumberOrNull(row.value),
      feedback: row.feedback === null || row.feedback === undefined ? null : String(row.feedback),
      symbol: String(row.symbol),
      ruleType: String(row.rule_type),
      threshold: toNumberOrNull(row.threshold),
      direction: String(row.direction)
    }));
}

function renderAlerts(alerts, window) {
  if (alerts.length === 0) {
    return `- 暂无提醒：${window.startLabel} 20:00 - ${window.endLabel} 20:00 之间没有属于本人的提醒事件。`;
  }
  return alerts
    .map((event) => {
      const feedback = event.feedback === null ? "未标记" : event.feedback === "false_positive" ? "已标记误报" : event.feedback;
      return `- ${formatDateTime(event.triggeredAt)} ${event.symbol} ${RULE_TYPE_LABELS[event.ruleType] ?? event.ruleType}：触发值 ${formatRatioPercent(event.value)}（阈值 ${formatRatioPercent(event.threshold)}，方向 ${RULE_DIRECTION_LABELS[event.direction] ?? event.direction}）；反馈：${feedback}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// 4. 我的待办
// ---------------------------------------------------------------------------

function renderTodos(db, ownerId) {
  const rows = db
    .prepare(`
      SELECT id, symbol, side, quantity, order_type, limit_price, reason, expires_at
      FROM proposals
      WHERE owner_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `)
    .all(ownerId);

  if (rows.length === 0) {
    return "- 暂无待办：本人当前没有待审批的提案。";
  }

  return rows
    .map((row) => {
      const price = toNumberOrNull(row.limit_price);
      const priceText = String(row.order_type) === "market" || price === null ? "市价" : `限价 ${formatNumber(price)}`;
      const side = SIDE_LABELS[String(row.side)] ?? String(row.side);
      return `- [待审批] ${row.symbol} ${side} ${formatNumber(toNumberOrNull(row.quantity) ?? 0, 4)} 份（${priceText}）；截止 ${formatDateTime(row.expires_at)}；理由：${singleLine(row.reason)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// 5. 本周我的交易 vs 策略一致性回顾 (weekly only, spec §3.3)
// ---------------------------------------------------------------------------
// C2 (2026-07-28 review). Two defects met here:
//
//   - the weekly page used `kind` for nothing but the window length and the
//     title, so it was structurally identical to the daily one and §3.3's
//     「本周我的交易 vs 策略一致性回顾」 existed nowhere;
//   - C1 had just taken the fill detail out of the PUBLIC daily/weekly body,
//     where every member could read every other member's order flow. Removing
//     it without rehoming it would have destroyed the content, so it lands
//     here - on the page whose only reader is the member who placed the order.
//
// The verdict vocabulary is deliberately three-valued. 一致 / 冲突 are only
// claimed when a DIRECTIONAL thesis on the same symbol makes the comparison
// meaningful; everything else is 无对照 with the reason spelled out. A
// two-valued verdict would have to guess, and a guess here reads as a judgment
// of the member's discipline.
function renderTradeConsistency(db, ownerId, window, helpers) {
  const rows = helpers.selectExecutionReports(db, window, ownerId);
  const unattributed = helpers.countUnattributedExecutionReports(db, window);
  const disciplines = loadActiveDisciplineRules(db, ownerId);

  // Unattributed rows are excluded by design (schema v17 left pre-per-member
  // history with no owner rather than inventing one), but their EXISTENCE is
  // disclosed: an empty section that silently dropped rows would read as "I
  // traded nothing this week", which is a different claim from "nothing here
  // is attributable to me".
  const exclusionNotice = unattributed > 0
    ? `- 说明：本窗口另有 ${unattributed} 条执行记录未按成员归属（owner_id 为空，早于按成员归属的账户），无法确认是否为本人下单，因此不计入本人对照，也不展开其内容。`
    : null;

  if (rows.length === 0) {
    return [
      `- 本周没有属于本人的执行记录：${window.startLabel} 20:00 - ${window.endLabel} 20:00 之间，execution_reports 里没有归属本人的成交或执行报告。`,
      "- 说明：这不是「本周没有交易」的账户结论——只代表本窗口没有可归属到本人的执行记录，请勿据此判断仓位变化。",
      ...(exclusionNotice ? [exclusionNotice] : [])
    ].join("\n");
  }

  const theses = loadThesesBySymbol(db, ownerId);
  const lines = rows.map((row) => renderConsistencyLine(row, theses, disciplines, helpers));

  return [
    `- 本周共有 ${rows.length} 条归属本人的执行记录，逐条与本人论点、纪律对照如下。`,
    ...(exclusionNotice ? [exclusionNotice] : []),
    ...lines,
    renderDisciplineFootnote(disciplines)
  ].join("\n");
}

function renderConsistencyLine(row, theses, disciplines, helpers) {
  const summary = helpers.summarizeExecutionRow(row);
  const text = `${row.title ?? ""}\n${row.body ?? ""}`;
  const symbol = extractOwnedSymbol(text);
  const side = extractOwnedSide(text);
  const verdict = judgeConsistency(symbol, side, theses);
  const ruleNote = describeSymbolDisciplines(symbol, disciplines);

  return [
    `- ${formatDateTime(row.created_at)} ${summary.heading}：${summary.summary}`,
    `  - 一致性：${verdict.label}（${verdict.reason}）`,
    `  - 状态：${summary.status}`,
    `  - 纪律对照：${ruleNote}`
  ].join("\n");
}

// The comparison itself. `theses` is a symbol -> thesis map of the owner's own
// ACTIVE theses; a withdrawn/superseded thesis is not a live commitment, so it
// is not used to convict a fill.
function judgeConsistency(symbol, side, theses) {
  if (!symbol) {
    return {
      label: "无对照",
      reason: "原因：这条执行记录的正文里读不出标的，无法定位对应论点"
    };
  }
  if (!side) {
    return {
      label: "无对照",
      reason: `原因：这条执行记录的正文里读不出买卖方向，${symbol} 的论点方向无从比较`
    };
  }
  const thesis = theses.get(symbol);
  if (!thesis) {
    return {
      label: "无对照",
      reason: `原因：本人名下没有 ${symbol} 的 status=active 论点，这笔${side}没有可对照的方向`
    };
  }
  const directionLabel = DIRECTION_LABELS[thesis.direction] ?? thesis.direction;
  if (thesis.direction === "neutral") {
    return {
      label: "无对照",
      reason: `原因：${symbol} 的论点方向为${directionLabel}，买入或卖出都不构成一致或冲突`
    };
  }
  const agrees = (thesis.direction === "bull" && side === "买入") || (thesis.direction === "bear" && side === "卖出");
  return agrees
    ? { label: "一致", reason: `${symbol} 论点为${directionLabel}，本次${side}与论点方向同向` }
    : { label: "冲突", reason: `${symbol} 论点为${directionLabel}，本次${side}与论点方向相反，需要说明是减仓/止损还是论点已变` };
}

function loadThesesBySymbol(db, ownerId) {
  const rows = db
    .prepare(`
      SELECT symbol, direction FROM theses
      WHERE owner_id = ? AND status = 'active'
      ORDER BY updated_at DESC, id ASC
    `)
    .all(ownerId);
  const map = new Map();
  for (const row of rows) {
    const symbol = String(row.symbol).toUpperCase();
    // First row wins: the ORDER BY puts the most recently updated thesis first,
    // which is the one that represents the owner's current view.
    if (!map.has(symbol)) {
      map.set(symbol, { symbol, direction: String(row.direction) });
    }
  }
  return map;
}

function loadActiveDisciplineRules(db, ownerId) {
  return db
    .prepare(`
      SELECT rule_text, enforcement FROM discipline_rules
      WHERE owner_id = ? AND enabled = 1 AND disabled_at IS NULL
      ORDER BY created_at ASC
    `)
    .all(ownerId)
    .map((row) => ({ text: String(row.rule_text), enforcement: String(row.enforcement) }));
}

// discipline_rules.rule_text is free-form Chinese written by the member. There
// is no structured field to evaluate a fill against, so the page does NOT claim
// to have checked the fill - it surfaces the rules that name the traded symbol
// and says plainly that the judgment is the member's to make. Inventing a
// pass/fail here would be the fabrication this section is supposed to avoid.
function describeSymbolDisciplines(symbol, disciplines) {
  if (disciplines.length === 0) {
    return "本人尚未登记生效中的纪律条目，本条无纪律可对照";
  }
  if (!symbol) {
    return `本人有 ${disciplines.length} 条生效纪律，但这条记录读不出标的，无法定位相关条目`;
  }
  const matched = disciplines.filter((rule) => rule.text.toUpperCase().includes(symbol));
  if (matched.length === 0) {
    return `本人 ${disciplines.length} 条生效纪律中没有点名 ${symbol} 的条目`;
  }
  return matched
    .map((rule) => `${rule.text}（执行方式：${ENFORCEMENT_LABELS[rule.enforcement] ?? rule.enforcement}）`)
    .join("；");
}

function renderDisciplineFootnote(disciplines) {
  return disciplines.length === 0
    ? "- 判定口径：一致/冲突只在本人存在同标的方向性论点时给出；纪律条目为空，本节没有纪律侧结论。"
    : "- 判定口径：一致/冲突只在本人存在同标的方向性论点时给出；纪律条目是自然语言，本节只列出相关条目供本人对照，不做机器判定。";
}

// Symbol/side re-extracted here (rather than read off summarizeExecutionRow's
// formatted heading) because the verdict must key on the RAW value, not on a
// display string that may carry a fallback label like 「未标明标的」.
function extractOwnedSymbol(text) {
  const patterns = [
    /\bSymbol:\s*([A-Z]{1,5}(?:\.US)?)/iu,
    /\bfor\s+([A-Z]{1,5}(?:\.US)?)/iu,
    /\border\s+(?:buy|sell)\s+([A-Z]{1,5}(?:\.US)?)/iu,
    /\b([A-Z]{1,5}\.US)\b/u
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

function extractOwnedSide(text) {
  const match = text.match(/\b(?:Side:\s*|order\s+)(buy|sell)\b/iu);
  if (!match?.[1]) {
    return null;
  }
  return match[1].toLowerCase() === "buy" ? "买入" : "卖出";
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function loadMember(db, ownerId) {
  const row = db.prepare(`SELECT id, display_name, status FROM members WHERE id = ?`).get(ownerId);
  return row ? { id: String(row.id), displayName: String(row.display_name), status: String(row.status) } : null;
}

function parseSnapshot(raw) {
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// C2 added the last three: the owner-scoped execution read, the unattributed
// count, and the fill formatter that used to feed the public digest. All six
// come from scheduled-report.mjs through the same injection seam, for the
// one-directional-dependency reason in this module's header.
const REQUIRED_HELPERS = [
  "renderOfficialPaperSnapshot",
  "summarizeOfficialAccount",
  "summarizeOfficialPositions",
  "selectExecutionReports",
  "countUnattributedExecutionReports",
  "summarizeExecutionRow"
];

function assertHelpers(helpers) {
  const missing = helpers ? REQUIRED_HELPERS.filter((name) => typeof helpers[name] !== "function") : REQUIRED_HELPERS;
  if (missing.length > 0) {
    throw new Error(`personal-page requires helpers.{${missing.join(", ")}}.`);
  }
}

function assertKind(value) {
  if (value !== "daily" && value !== "weekly") {
    throw new Error(`Personal page kind must be daily or weekly; received ${JSON.stringify(value)}.`);
  }
}

function assertDateLabel(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value))) {
    throw new Error(`Personal page date must use YYYY-MM-DD format; received ${JSON.stringify(value)}.`);
  }
}

function addDays(label, days) {
  const [year, month, day] = label.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value, digits = 2) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

// `pct` already arrives as a percentage figure (computeThesisOutcome's own
// unit), so it is formatted, not re-scaled.
//
// A nonzero move smaller than 0.005% renders as "<0.01%" rather than the
// "-0.00%" two decimals would produce: "-0.00%" reads as "it moved down by
// zero", which is a contradiction, and rounding a real (if tiny) change to a
// flat 0 would be the other kind of wrong.
function formatSignedPercent(pct) {
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "±";
  const magnitude = Math.abs(pct);
  if (magnitude > 0 && magnitude < 0.005) {
    return `${sign}<0.01%`;
  }
  return `${sign}${magnitude.toFixed(2)}%`;
}

// Alert thresholds/values are stored as ratios (0.04 = 4%).
function formatRatioPercent(value) {
  return value === null ? "不可用" : `${(value * 100).toFixed(2)}%`;
}

function formatDateTime(value) {
  const ts = new Date(String(value ?? "")).getTime();
  if (!Number.isFinite(ts)) {
    return "时间不可用";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ts));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

function singleLine(value, maxChars = 160) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export { SECTION_ORDER, SECTION_ORDER_BY_KIND, SECTION_TITLES };
