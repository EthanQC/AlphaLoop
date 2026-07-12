# Phase 2 提醒引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 盘中主动提醒全链路：四类规则评估（滞回/冷却/配额/合并/owner 隔离）→ 中文飞书卡片投递 → 规则的自然语言可管理（CLI 层）→ launchd 轮询模板。全部本地可测（真实投递属点火黄灯）。

**Architecture:** 纯函数评估核心（输入行情+持仓+规则+运行时状态 → 输出告警决策+新状态，零 IO）+ SQLite 仓储（P1 已建表：alert_rules/alert_events/alert_runtime_state/alert_daily_quota）+ 组卡投递层（复用 P1 sendInteractiveCard）+ 轮询器脚本（IO 编排）。行情与持仓取数复用既有 longbridge 脚本模式。

**Tech Stack:** Node 24、.mjs 脚本（apps/openclaw-config/scripts）+ shared-types（TS）、vitest、launchd StartInterval。

## Global Constraints

- 阈值与频控（spec 定值，不得更改）：持仓日内涨跌 ±4%（once_daily）；浮动盈亏 ±6%（continuous，滞回 1%）；5 分钟急涨急跌 ±2.5%（continuous，冷却 60 分钟，连续 3 个采样周期有成交才可触发）；敞口 >10%（continuous）。单规则同方向 60 分钟冷却；滞回复位后才可再触发；同轮多条合并为一张卡；每股每类型 ≤10 条规则；**每成员**每日 ≤30 张卡；"每日一次/每日配额"按**美东交易日**切界重置。
- 规则归属：owner_id 必填；增删改只允许 owner 本人（CLI 以 --actor 校验）；规则 symbol 必须 ∈ 该 owner 的标的池（stock_analysis_targets where owner）∪ 该 owner 当前持仓。
- 卡片：中文；含当前值/阈值/方向/涉及持仓与影响金额；v1 无站点深链（P3 后补），落款"详情见日报"。投递到成员飞书单聊（openId），message_id 写回 alert_events。
- 交易时段判定复用 trading-schedule.mjs；日历年份越界必须 fail-loud（本阶段 T1 加保护）。
- 真实飞书投递与真实行情轮询属点火（P10）黄灯——本阶段测试一律注入 fake transport/fake 数据。
- `pnpm test`/`pnpm typecheck` 全绿；TDD；DDL 禁改（表已在 P1 定齐；若发现表结构不够用，STOP 上报而非私改）；提交规范同 P1（英文 conventional + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>）。
- 绿涨红跌语义（卡片文案中"涨/跌"用词与数值符号一致即可，无颜色）。

---

### Task 1: 交易日历年份越界保护（fail-loud）

**Files:**
- Modify: `apps/openclaw-config/scripts/trading-schedule.mjs`（NYSE_FULL_CLOSE_DATES/NYSE_EARLY_CLOSE_DATES 仅含 2026；isUsRegularMarketHours 等入口）
- Test: `apps/openclaw-config/scripts/trading-schedule.test.ts`（存在则扩展）

**Interfaces:**
- Produces: `export function assertCalendarCoverage(date: Date): void` — 若给定日期的年份不在日历覆盖年份集合内，抛出含"trading calendar has no data for year YYYY"的 Error；导出 `export const CALENDAR_COVERED_YEARS: number[]`（从两张日期表推导，不手写）。
- 既有市场时段判定函数在入口处调用 assertCalendarCoverage（行为变化：2027 日期从"静默当交易日"变为"响亮报错"——这正是需求）。
- 同时导出 `export function currentUsEasternTradingDay(date: Date): string`（返回 "YYYY-MM-DD"，美东时区日期字符串，供 T3 的每日配额切界使用；用 Intl.DateTimeFormat America/New_York）。

- [ ] Step 1: 失败测试（2027-01-01 调 isUsRegularMarketHours 抛错含年份；2026 正常日期不抛；CALENDAR_COVERED_YEARS 含 2026；currentUsEasternTradingDay 对"北京时间 2026-07-13 04:00"返回 "2026-07-12"——跨日断言）
- [ ] Step 2-5: TDD 循环 → `pnpm test`/`typecheck` → Commit `feat: trading calendar year-coverage guard and us-eastern trading day helper`

### Task 2: 敞口计算抽提为共享函数

**Files:**
- Modify: `apps/openclaw-config/scripts/official-paper-monitor.mjs`（内部私有函数 buildStrategyReflection ~line 140 附近的敞口计算逻辑）
- Create: `apps/openclaw-config/scripts/portfolio-exposure.mjs`
- Test: `apps/openclaw-config/scripts/portfolio-exposure.test.ts`

**Interfaces:**
- Produces: `export function computeExposure(snapshot: { netAssets: number|null, marketValue: number, positions: Array<{symbol, quantity, marketValue?}> }): { exposureRatio: number|null, budgetRatio: 0.1, overBudget: boolean, detail: string }` — 语义与 buildStrategyReflection 现行计算**逐值一致**（先读原实现，提取时保持数值口径不变；netAssets 缺失时 exposureRatio 为 null 且 overBudget=false）。
- official-paper-monitor.mjs 改为调用共享函数（行为不变，其现有测试保持全绿）。

- [ ] Step 1: 先给现行为写 characterization 测试（用 official-paper-monitor 现逻辑的输入输出样例固化口径），Step 2: 抽提，Step 3: 双侧测试全绿，Step 4: Commit `refactor: extract portfolio exposure calculation into shared module`

### Task 3: 提醒评估引擎（纯函数核心 + 仓储 + 回放测试）

**Files:**
- Create: `apps/openclaw-config/scripts/market-alerts-engine.mjs`（纯函数，零 IO）
- Create: `apps/openclaw-config/scripts/market-alerts-store.mjs`（SQLite 仓储：规则/事件/运行时状态/配额的读写，用 openTradingDatabase）
- Test: `apps/openclaw-config/scripts/market-alerts-engine.test.ts`、`market-alerts-store.test.ts`

**Interfaces:**

```js
// market-alerts-engine.mjs —— 全部纯函数
// 输入快照（由轮询器组装）：
// sample = { atIso, tradingDay,                       // tradingDay 来自 T1 currentUsEasternTradingDay
//   quotes: { [symbol]: { price, prevClose, volume } },
//   positions: { [symbol]: { quantity, costPrice, marketValue } },
//   exposure: { exposureRatio, overBudget } }         // 来自 T2
// rule = alert_rules 行（camelCase 化）
// runtime = alert_runtime_state 行 + sampleHistory（最近 3 次 {price, volume}，JSON 存于 runtime.last_value 旁的新用法——存进 alert_runtime_state.last_value 仅存数值、历史存 sampleHistory 字段：该列不存在 → 用 detail JSON 打包进 last_value? 不允许改表 → 决定：sampleHistory 由轮询器落在 run 期间内存 + 持久化到 alert_runtime_state 的 last_value（仅最近一次）——5 分钟急涨急跌的"连续 3 周期有成交"由 store 在 alert_events 之外维护一张内存/文件态？STOP：见下方设计决定
export function evaluateRule(rule, runtime, sample, quota) {
  // 返回 { decision: 'fire' | 'skip', reason, value, newRuntime, quotaDelta }
}
export function evaluateAll(rules, runtimes, sample, quotaByOwner) { /* 逐规则 evaluateRule + 每成员配额裁剪（超出 30 的决策改 skip:quota），返回 { fires: [...], newRuntimes, newQuotas } */ }
```

**设计决定（实现者照此执行，不再自行发挥）**：spike 规则需要最近 3 个采样点的 (price, volume)。**不改表**：`alert_runtime_state.last_value` 列改存 JSON 字符串 `{"lastPrice":..., "history":[{p,v},{p,v},{p,v}]}`（REAL 列在 SQLite 动态类型下可存 TEXT——实测断言写读回；如实现中发现严格模式阻碍，STOP 上报）。store 层负责 JSON 编解码，引擎只见解码后的对象。

**规则语义（逐条，测试各自覆盖）**：
- daily_move（once_daily）：|price/prevClose - 1| ≥ threshold（0.04）且该规则 last_fired_trading_day ≠ 当前 tradingDay → fire；fire 后写 last_fired_trading_day。
- unrealized_pnl（continuous+滞回）：|price/costPrice - 1| ≥ 0.06 触发且 armed；fire 后 disarm；|value| 回落到 (threshold - hysteresis)=0.05 以内 → re-arm。方向独立（向上/向下各自 armed 语义按同一 armed 位+方向记录在 runtime JSON）。
- spike_5m（continuous+冷却 60min+活跃度）：|price/history[0].p - 1| ≥ 0.025（与 3 个采样点前比）且 history 3 点 volume 全 >0 且 cooldown_until < now → fire；fire 后 cooldown_until = now+60min。
- exposure（continuous+滞回 1%）：exposureRatio > 0.10 且 armed → fire+disarm；回落 ≤0.09 re-arm。
- 全部 fire 先过 owner 当日配额（fired_count < 30），超配额→skip（reason: 'quota'），事件不写、卡不发。

**store 接口**：`listEnabledRules(db)`, `getRuntimes(db, ruleIds)`, `saveRuntimes(db, updates)`, `recordEvents(db, events)`（写 alert_events 含 owner_id/value/triggered_at；message_id 由 T5 投递后回填 `updateEventMessageId(db, eventId, messageId)`）, `getQuota(db, ownerId, tradingDay)`, `bumpQuota(db, ownerId, tradingDay, n)`, `setFeedback(db, eventId, feedback)`。

**回放测试（阶段交付判定要求）**：构造一段确定性的多日多标的样本序列（含开盘跳空、缓涨、急跌、缩量毛刺、敞口爬升场景），把序列逐样本喂给 evaluateAll，断言完整的 fire/skip 时间线（含：once_daily 不重复、滞回复位后二次触发、缩量毛刺不触发 spike、配额第 31 条被裁、跨交易日配额重置）。

- [ ] Step 1: 引擎失败测试（按上面规则语义逐条+回放序列）→ Step 2-5: TDD 循环 → Commit `feat: alert evaluation engine with hysteresis, cooldown, quota and replay tests`（store 可拆第二个 commit `feat: alert sqlite store`）

### Task 4: 规则管理 CLI（owner 强制）+ 误报反馈

**Files:**
- Create: `apps/openclaw-config/scripts/market-alerts.mjs`（CLI：list/add/remove/pause/resume/feedback）
- Test: `apps/openclaw-config/scripts/market-alerts.test.ts`

**Interfaces:**
- `node market-alerts.mjs list --actor <memberId> [--all]`（本人规则；--all 只读展示全体）
- `add --actor <id> --symbol NVDA --type daily_move|unrealized_pnl|spike_5m|exposure [--threshold 0.04] [--direction both|up|down]` — 校验：actor 是 active 成员；threshold 缺省用类型默认（0.04/0.06/0.025/0.10）；**symbol ∈ actor 的 stock_analysis_targets（owner_id=actor）∪ actor 持仓（official_paper_snapshots 最新一行 positions JSON, owner_id=actor 或 owner_id IS NULL 时视为历史单人数据不匹配→仅池校验）**；同 owner+symbol+type 的规则数 ≤10；exposure 类型 symbol 固定为 '*'（组合级）。
- `remove|pause|resume --actor <id> --rule <ruleId>` — 规则 owner ≠ actor → 非零退出 "not your rule"。
- `feedback --actor <id> --event <eventId> --note 无用` — 事件 owner ≠ actor 拒绝；写 alert_events.feedback。
- 全部输出单行 JSON；错误非零退出。中文错误消息面向用户（这些消息未来由 control agent 原样转述）。

- [ ] TDD 循环（重点负向测试：跨 owner 增删改拒绝、池外 symbol 拒绝、超 10 条拒绝）→ Commit `feat: market-alerts CLI with owner enforcement and feedback`

### Task 5: 提醒卡组装与投递

**Files:**
- Create: `apps/openclaw-config/scripts/market-alerts-cards.mjs`
- Test: `apps/openclaw-config/scripts/market-alerts-cards.test.ts`

**Interfaces:**
- `export function composeAlertCards(fires, memberById, positionsByOwner): { batches: Array<{ ownerId, openId, card: InteractiveCard, eventIds: [] }>, skipped: Array<{ ownerId, reason, eventIds }> }` —— **契约（T5 实施时收紧，T6 必须遵守）**：每条 fire 除引擎字段外还必须携带 `threshold`（来自对应规则）与 `eventId`（来自 recordEvents 的同序返回）；缺失即抛错（接线 bug 必须响亮失败，不做静默降级）。`positionsByOwner` 用 T5 导出的 `buildPositionsForCards(sample)` 构造，不要手搓。`EXPOSURE_SYMBOL` 从 engine 导入。 — 纯函数：同 owner 同轮的多条 fire 合并为一张卡（标题"盘中提醒 N 条"，每条一行：`22:10 NVDA 日内 -4.3%（阈值 ±4%）· 持仓 12 股 · 影响 -$520`；金额=quantity×price×变动幅度，四舍五入整数美元；exposure 行无 symbol 显示"组合敞口"）；卡片无按钮；落款行"详情见今日日报（站点上线后将直达）"。
- `export async function deliverAlertCards(db, composed, transport?)`（`composed` 即 composeAlertCards 的整个返回对象；传裸数组会抛错） — 逐批 sendInteractiveCard（P1 能力，target={openId}），成功把 messageId 回填每个 eventId（store.updateEventMessageId）；失败记 stderr + 事件保留无 message_id（不重试——轮询器下轮自然继续，告警不补发，避免风暴；语义写进注释与测试）。
- 测试：合并/文案/金额计算/中文/回填/失败不抛出，全走 fake transport。

- [ ] TDD 循环 → Commit `feat: alert card composition and delivery with message_id backfill`

### Task 6: 轮询器 + launchd 模板

**Files:**
- Create: `apps/openclaw-config/scripts/market-alerts-poll.mjs`
- Create: `apps/openclaw-config/launchd/com.alphaloop.market-alerts.plist.template`（StartInterval 300，样式对齐既有模板）
- Modify: `package.json`（`"alerts:poll": "node apps/openclaw-config/scripts/market-alerts-poll.mjs"`）
- Test: `apps/openclaw-config/scripts/market-alerts-poll.test.ts`

**Interfaces:**
- 流程：assertCalendarCoverage(now)（T1，抛错即退出非零）→ isUsRegularMarketHours(now) 为 false → 输出 `{ok:true, skipped:"off-hours"}` 退出 0 → 为 true：加载 enabled 规则（无规则→快速退出）→ 组装 sample：行情用注入的 quote provider（默认 provider 走既有 longbridge quote 脚本模式，但**声明为点火实测项**；测试全部注入 fake provider）、持仓/敞口取各 owner 最新 official_paper_snapshots（复用 T2）→ evaluateAll → recordEvents/saveRuntimes/bumpQuota → composeAlertCards → deliverAlertCards → 单行 JSON 总结（fires/skips/sent/failed 计数）。
- 异常：任何一步抛错 → 单行 JSON {ok:false,error} + 退出 1（launchd 下次 StartInterval 自然重试；不引入自己的重试）。
- `--dry-run`：评估但不投递不落事件（打印 would-fire 列表）——点火后人工验证用。
- 测试：off-hours 跳过；正常路径端到端（fake provider+fake transport+内存库）；--dry-run 不落库。

- [ ] TDD 循环 → Commit `feat: market alerts poller with launchd template`

---

## 阶段收尾

1. `pnpm test && pnpm typecheck && pnpm build` 全绿。
2. 整阶段 diff 派 code-review 子 agent（含 P1 遗留 next-phase 清单中与本阶段文件相关的项：class-key 时间戳、KNOWN_CRON_JOB_NAMES 单源化——若本阶段动了相应文件顺手修，否则留档）。
3. 实测：本地以 fake provider 跑一次 `pnpm alerts:poll -- --dry-run`（构造触发场景），检查 JSON 输出与 would-fire 列表；回放测试输出人工抽查一次。
4. 更新计划 checkbox 与台账；合并 main。
