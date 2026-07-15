# Phase 6 提案-审批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。逐任务派发子 agent，任务完成后控制器亲自验收。**本阶段是资金路径：负向测试密度必须高于以往任何阶段。**

**Goal:** 交付提案→审批→执行→对账全链路：提案生成（纪律硬检查前置/熔断前置/预算预览）+ 审批三动作（批准/减半/拒绝，owner-only，原子消费）+ 飞书审批卡（ocf1 按钮=文本命令，发 owner 私聊，决策/过期回改卡）+ broker-executor 服务端硬化（共享密钥 + 必须已批准 proposal_id + **先记录后执行幂等**）+ 对账重建（lifecycle 关联，根治审计 7 项）+ per-owner 熔断（周亏 >3% 停一周跨重启）+ 多账户凭据与轮询骨架。交付判定：**回放与负向测试**全绿。

**Architecture:** proposals 表（v3 已有）为状态机真源；幂等键=proposal id（一提案至多一单）；执行链严格顺序 = 原子消费 approval_token → lifecycle 'submitting' 行落库 → 下单 → 更新 lifecycle/回执。熔断为账户级独立状态表（v10），拦在提案生成入口。对账不再读报告标题——lifecycle 行天生携带 ticket_id，correlation 只做增补与状态同步。审批双轨：CLI（本地全链路可测）与 ocf1 卡片按钮（值=同一文本命令，P10 接线冒烟）。

**Tech Stack:** 同前。fake broker（可注入 execFn）贯穿测试；真实下单 = P10。

## Global Constraints

- **Migration v10 本阶段授权**（SCHEMA_VERSION → 10：`circuit_breaker_state (owner_id TEXT PRIMARY KEY REFERENCES members(id), paused_until TEXT NOT NULL, reason TEXT NOT NULL, weekly_loss_pct REAL, tripped_at TEXT NOT NULL)`；此外 DDL 冻结——proposals/discipline_rules/lifecycle 表不改）。
- **spec 定值**：审批三动作 批准/减半批准/拒绝；减半量 = `Math.max(1, Math.floor(quantity/2))`（qty=1 减半=1，文档化）；过期 = `expires_at`（创建 +24h，07-12 §4 语义覆盖 07-11 样张的 23:58）；熔断 = per-owner 周亏 >3% → 暂停新提案 7 天，跨重启（状态表），暂停中生成请求被拒并说明；每次生成 0-2 条且 **0 条是常见合法输出**；每日自动生成默认关（07-07：先按需，3 次真实验证后再开 cron）；审批卡只认 owner 本人（服务端 `decided_by` 校验 + ocf1 wrong_user 双保险）；卡发 owner **私聊**。
- **纪律语义**：`hard` 违反 → 提案**不生成**（不写行，返回拒绝原因）；`proposal_check` → 逐条 ✓/✗ 进 discipline_report 上卡；`self` → 仅提示行。纪律硬检查只读 trading.sqlite（memoryd 不可用不影响）。
- **执行链不变量（资金路径核心，每条负向测试钉死）**：①无有效共享密钥头 → 401；②无 proposal_id 或提案非 approved/approved_half → 403；③approval_token 原子消费（`UPDATE ... SET consumed_at=? WHERE approval_token=? AND consumed_at IS NULL`，changes≠1 → 409 重复消费拒绝）；④**先记录后执行**：消费成功 → INSERT lifecycle(stage='submitting', ticket_id=提案 id, owner_id) → 才调 broker；重试携同 proposal_id → 查到已有 lifecycle 行 → 幂等返回原结果不重下单；⑤预算门 per-owner 且**计入未成交挂单**（lifecycle 处 submitting/accepted/pending 态的 notional）；⑥execFileSync 补 timeout（LONGBRIDGE_CLI_TIMEOUT_MS）。
- **对账重建规则**：correlation 首选 external_order_id ↔ lifecycle；孤儿单增补时 ticket_id 关联只从 lifecycle 推断（symbol+side+qty+提交时间窗），**永不覆盖已有非空 ticket_id**（`COALESCE(existing.ticket_id, excluded.ticket_id)` 方向）；broker 状态映射器单源模块（executor 与 reconcile 共 import），覆盖 WaitToCancel/PendingCancel/PartialWithdrawal/Replaced/*NotReported；reconcile **不再写 execution_reports trade 行**（差异记 audit_log）。
- 多账户：凭据 `~/.alphaloop/credentials/<member-id>/longbridge.env`（测试用临时目录注入）；子进程 env 注入，永不写全局 process.env；region-cache 与 rate-limit 文件 per-member 隔离路径。
- 真实飞书回调订阅/requireMention/真实下单/第二账户 = **P10 黄灯**（沿 P2/P4 范式：本地 fake transport/fake broker 全覆盖，接线点文档化）。
- 凭据不入仓不入报告；临时库纪律（动 database.ts 前杀 watcher）；`pnpm test`/`typecheck`/`build` 全绿；TDD；conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务真跑相关二进制。

---

### Task 1: Migration v10 + proposals 仓储

**Files:** Modify: `packages/shared-types/src/database.ts`（MIGRATIONS[9]，SCHEMA_VERSION→10；新增 ProposalRepository）；Test: database.test.ts 追加。

**Interfaces:**
- v10 DDL 见 Global Constraints。迁移测试：v9→v10 无损/幂等/fresh 直达/FK 生效。
- `ProposalRepository`：`create(p)`（写 pending 行 + approval_token=createId('approval')）；`getById/getByToken`；`consumeApproval(token, {decision: 'approved'|'approved_half'|'rejected'|'expired', decidedBy, decidedAt})` → 原子 UPDATE（`WHERE approval_token=? AND consumed_at IS NULL`），返回 `{consumed: boolean, proposal?}`——**唯一**的状态跃迁通道，点击/CLI/过期清扫全走它（竞态天然裁决，测试：并发两次消费恰一次成功）；`markExecuted(id, ticketId)` / `markFailed(id, reason)`；`listPendingExpired(nowIso)`；`updateCardMessageId(id, messageId)`。
- `CircuitBreakerRepository`：`getState(ownerId)`；`trip(ownerId, {pausedUntil, reason, weeklyLossPct})`（upsert）；`clearIfExpired(ownerId, now)`；`isPaused(ownerId, now)`。

- [ ] TDD（含并发消费恰一次；重复 markExecuted 幂等）→ 真跑迁移于副本 → Commit `feat: schema v10 - circuit breaker state and proposal repository with atomic consume`

### Task 2: 纪律引擎 + 熔断引擎

**Files:** Create: `apps/openclaw-config/scripts/discipline-engine.mjs`、`circuit-breaker.mjs`；Test: 各自 test。

**Interfaces:**
- `evaluateDiscipline(db, ownerId, draft)` → `{hardViolations: [{ruleId, ruleText, detail}], report: [{ruleId, ruleText, enforcement, pass, detail}]}`：读 discipline_rules(enabled=1, owner)；内置检查器按 rule_text 结构化前缀匹配（v1 支持：仓位上限类『仓位 ≤N%』→ 对照预算预览；财报周类『财报周不{买入|加仓}』→ 对照 stock_facts options.nextExpiry/财报日 fact（缺 fact → pass:'无法判定' 标注）；自定义文本 → enforcement=self 仅提示）；hard 且违反 → 进 hardViolations。规则解析器表驱动、可扩展，未识别格式 → 按 self 处理并标注『规则格式未识别』（绝不静默当 pass）。
- `computeWeeklyLoss(db, ownerId, now)` → 从 per-owner 快照序列（loadSnapshotSeriesForOwner 语义，本周一美东起点 vs 最新）算周收益率；数据不足 → null（不触发）。
- `checkAndTripCircuit(db, ownerId, now)` → weeklyLoss < -3% 且未暂停 → trip(pausedUntil=+7d) 返回 `{tripped: true, card}`（中文通知卡内容）；已暂停 → `{paused: true, until}`。
- `assertProposalAllowed(db, ownerId, now)` → 熔断暂停中 → throw 中文原因（含恢复时间）。

- [ ] TDD（周亏边界 -2.99/-3.01；跨重启读回；数据不足不触发；hard 违规清单）→ Commit `feat: discipline engine and per-owner circuit breaker`

### Task 3: 提案创建 + 审批 CLI + 飞书卡

**Files:** Create: `apps/openclaw-config/scripts/proposals.mjs`（CLI：create/approve/approve-half/reject/list/sweep）、`proposal-cards.mjs`（卡组装/发送/回改）；Test: 各自 test + seam。

**Interfaces:**
- `create --owner <id> --symbol --side --quantity [--limit-price] --reason <text> [--strategy <ref>] [--invalidation] [--stop-loss] [--confidence low|medium|high]`：流程 = assertProposalAllowed（熔断）→ evaluateDiscipline（hardViolations 非空 → 拒绝返回原因清单，**不写行**）→ 预算预览（per-owner 快照 + 未成交挂单，budget_impact 文本）→ ProposalRepository.create → 组卡（07-11 §4.2 样张字段全集：编号/动作/理由/引用 evidence/关联策略/纪律检查 ✓✗ 行/失效/止损/置信度/预算影响/三按钮/过期时间）→ sendInteractiveCard 至 owner 私聊（feishuOpenId；缺 → 提案照建，卡记 skipped_no_open_id 警告）→ updateCardMessageId 回填。按钮 value = `批准 <token>` / `减半批准 <token>` / `拒绝 <token>`（ocf1 文本命令语义，P10 接管道）。
- `approve|approve-half|reject --token <t> --actor <memberId>`：**actor 必须 = 提案 owner**（非 owner → 单行 JSON 错误退出非零，测试钉死 A 批 B 被拒）→ consumeApproval（未消费成功 → 『已处理/已过期』错误）→ 减半改量规则见 Global Constraints → 决策回改卡（updateInteractiveCard：按钮区替换为决策结果行 + 时间 + decided_by 名）→ approved/approved_half 时**调 executor**（POST /v1/tickets 带 proposal_id + 共享密钥；executor 不可达 → 提案停在 approved 态 + 警告输出，重试安全（幂等键），**绝不回滚消费**——文档化理由：宁可人工补执行，不可重复审批）。
- `sweep`：listPendingExpired → 逐条 consumeApproval(decision:'expired') → 卡回改『已过期』；接入 cron runner 任务清单（小时级）。竞态：点击与清扫同 token 只有一方成功（T1 原子性，seam 测试钉死）。
- 全 CLI 遵循 members.mjs 约定（单行 JSON/中文错误/per-command flags/审计 audit_log category `proposals`）。

- [ ] TDD（负向优先：非 owner 三动作全拒/重复消费/过期后点击/熔断中 create/hard 违规 create 不写行/qty=1 减半）→ 真跑 CLI 全流程于临时库（fake transport）贴输出 → Commit `feat: proposal lifecycle - creation with discipline gates, owner-only approval and feishu cards`

### Task 4: broker-executor 服务端硬化（先记录后执行）

**Files:** Modify: `apps/broker-executor/src/index.ts`、`src/longbridge-paper.ts`、`src/risk.ts`、`packages/shared-types/src/domain.ts`（OrderTicket + ownerId + proposalId）；Test: broker-executor 测试扩展（fake exec 注入）。

**Interfaces:**
- `/v1/tickets` 新序：①`X-AlphaLoop-Broker-Secret` 头 ≠ env `BROKER_EXECUTOR_SHARED_SECRET` → 401（env 缺失 → 启动即 fail-loud，测试断言）；②body.proposalId 必填 → 查 proposals：状态 ∈ approved|approved_half 且 ticket_id IS NULL → 否则 403（携原因）；③**幂等查**：lifecycle 已有 ticket_id=该提案衍生 ticket 的行 → 返回原结果 200（idempotent replay，不重下单）；④风控 evaluateRisk **per-owner**（快照按 ticket.ownerId 取 own-row-first；预算计入该 owner 未成交挂单 notional——lifecycle stage ∈ submitting|accepted|pending）；⑤INSERT lifecycle(stage='submitting', ticket_id, owner_id, symbol/side/qty/limit) → ⑥`executeLongbridgePaperOrder`（execFileSync 加 `timeout: LONGBRIDGE_CLI_TIMEOUT_MS`）→ ⑦更新 lifecycle(external_order_id/broker_status/stage) + reports.save + proposals.markExecuted + audit。⑥抛错/超时 → lifecycle 置 stage='submit_unconfirmed'（**不是 failed**——单可能已到券商，文档化：reconcile 负责裁决）+ proposals.markFailed + 507 响应。
- metadata 风险参数不再信 body verbatim：dailyNewRisk/openIdeas 服务端算（当日 lifecycle 计数）。
- 旧 manual 路径：submit-official-paper-equity-order.mjs 改为薄壳 → `proposals.mjs create + approve`（自批注明 source='manual'）；直接 POST 无 proposalId 的调用被 403（负向测试）。

- [ ] TDD（401/403/409/幂等 replay/submit_unconfirmed/预算含挂单/秘钥缺失启动拒绝）→ 真跑 executor 于临时库 + fake CLI stub 全序贴输出 → Commit `feat: broker executor hardening - shared secret, approved-proposal gate and record-before-execute`

### Task 5: 对账重建 + 状态映射单源

**Files:** Create: `apps/broker-executor/src/broker-status-map.ts`（或共享位置——executor 与 .mjs 都可达，选择并文档化）；Rewrite: `apps/openclaw-config/scripts/reconcile-official-paper-orders.mjs`；Test: 各自 + 回放。

**Interfaces:**
- 单源映射：全量 Longbridge 状态表（Filled/PartialFilled/New/WaitToNew/WaitToCancel/PendingCancel/Canceled/PartialWithdrawal/Replaced/Rejected/Expired/*NotReported…）→ `{stage, localStatus}`；两侧共 import；未知状态 → stage='unknown_broker_status' + audit 记录（绝不静默当 accepted）。
- reconcile 新逻辑：拉券商当日订单 → 按 external_order_id 匹配 lifecycle 行 → 更新 broker_status/stage/last_observed_at；孤儿券商单（无 lifecycle 行）→ 增补行（ticket_id 推断仅从 lifecycle 近邻：同 symbol+side+qty 且 submitted_at ±30min 的 submit_unconfirmed 行 → 认领并携其 ticket_id；否则 ticket_id NULL + audit 『orphan_broker_order』告警）；**保护已有非空 ticket_id**；submit_unconfirmed 裁决（券商有单 → 补 external_order_id 转正常态；券商无单且超时窗 → 转 failed）；**不写 execution_reports**，全部差异进 audit_log。
- 回放测试（交付判定组件）：脚本化序列——正常成交/部分成交/撤单中/reconcile 先于回执/孤儿单认领/submit_unconfirmed 两个方向裁决/重复 reconcile 幂等（行数与 ticket_id 不变）。

- [ ] TDD → Commit `feat: lifecycle-based reconciliation with unified broker status map`

### Task 6: 多账户凭据 + per-owner 轮询 + 平台呈现

**Files:** Create: `apps/openclaw-config/scripts/member-credentials.mjs`（凭据目录解析/校验/子进程 env 构造）；Modify: `official-paper-monitor.mjs`（per-member 轮询循环：有凭据成员逐个拉快照写 owner_id；零凭据 → 现行 H4 单账户行为不变）、`_longbridge.mjs`（region-cache/rate-limit 路径接受 per-member 覆盖）、`apps/platform-app/src/routes/proposal.ts` + `home.ts`（approved_half 显示/熔断横幅：circuit_breaker_state 暂停中 → home 顶部 amber 横幅『熔断暂停中至 X』）；Test: 各自。

**Interfaces:**
- `loadMemberCredentials(memberId, {rootDir})` → 解析 `<root>/<memberId>/longbridge.env`（parseEnvText 复用）→ `{env: {LONGBRIDGE_*}, cachePaths: {home, rateLimitDir}}`；缺目录 → null（成员无盘，degrade）；权限过宽（非 0600/0700）→ 警告。
- monitor：`listActive()` 成员逐个 loadMemberCredentials → 有则以该 env+隔离路径拉快照（owner_id=member id）；全员无凭据 → 现行为（'__shared__' 哨兵）。
- 平台：proposal 详情时间线补 consumed/decided/executed 事件；熔断横幅 server 端读状态。

- [ ] TDD → 实测临时凭据目录双成员 fake 轮询贴输出 → Commit `feat: per-member broker credentials, polling and platform circuit visibility`

### Task 7: 阶段收尾——回放与负向矩阵（交付判定）

**Steps:**
- [ ] **全链路回放 seam**（临时库 + fake broker + fake transport，我亲自跑）：create（含纪律 ✓✗ 卡）→ approve → executor（先记录后执行全序）→ fake 成交回执 → reconcile → 平台提案页时间线完整呈现。减半分支同回放。
- [ ] **负向矩阵**（逐条断言）：B 批 A → 拒；重复点击/重复 POST → 恰一次执行；过期后点击 → 已过期；扫与点竞态 → 恰一方成功；熔断中 create → 拒；hard 违规 → 不写行；无密钥/无 proposalId/未批准提案 POST → 401/403；预算含挂单：两笔 9.5% 第二笔被拒；executor 中途崩溃重试 → 不重复下单（幂等回放）；submit_unconfirmed 两向裁决。
- [ ] Playwright：提案详情页（seed 全状态提案各一）双主题截图 + 熔断横幅 + 零外部请求。
- [ ] `pnpm test`/`typecheck`/`build` ×3 → 合并 main + push → 台账/路线图/记忆 → **不停，直接进 P7**。

## 明确不做（划界）

- 真实飞书卡片回调订阅/requireMention 冒烟、真实下单、第二真实账户、每日自动提案 cron 开启（3 次真实验证后）——全部 P10；期权/实盘（宪法永久 analysis-only/禁）；提案生成的智能化选股逻辑（P6 建机械管道，提案内容生成属 control agent 职责，P10 后迭代）。
