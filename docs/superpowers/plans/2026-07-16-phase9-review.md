# Phase 9 复盘飞轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。逐任务派发子 agent，任务完成后控制器亲自验收。

**Goal:** 交付每人月度复盘全链路：预测复盘（本人论点方向命中率 + 系统置信度校准）+ 决策复盘（提案收益 vs 买入持有基准，被拒提案简化口径）+ 策略纪律复盘（遵守率 + "守规矩值多少钱"）+ 提醒质量（触发/误报率）+ 错误归类/一句话教训/下一步 + 改进建议（建议 only，变更须本人确认）。所有指标**确定性代码回算**，交付判定 = **回算一致性单测**：一份完全独立的验证器从原始 SQLite 用不同方法重算每个头条数字并逐一断言相等（防复盘报告自己编数）。复盘归档进报告页「复盘」（仅本人可见），确认后结论写 memoryd（fire-and-forget）+ 飞书单聊（P10）。

**Architecture:** monthly_reviews 表（per-owner，draft→confirmed 人工确认门，result_json）。主复盘引擎复用 P5-P8 的确定性 helper（computeThesisOutcome/computeComplianceStats/computePaperKpis 等）产出指标。**独立验证器**（review-verifier.mjs）刻意不 import 任何主引擎 helper，直接从原始行用独立算术重算——两套实现交叉验证是本阶段的交付判定，绝非共用 fixture 的双端镜像（那是空转）。analysis_predictions 保持公共无 owner；本人预测复盘取本人 theses。memoryd 镜像沿 P7/P8 可注入 fire-and-forget。

**Tech Stack:** 同前。零新依赖。

## Global Constraints

- **Migration v14 本阶段授权**（SCHEMA_VERSION → 14）：新建 `monthly_reviews (id TEXT PK, owner_id TEXT NOT NULL REFERENCES members(id), period TEXT NOT NULL, result_json TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')), confirmed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, period))` + index (owner_id, period)。**analysis_predictions/proposals 的 outcome 回填不改 DDL**（现有列，应用层枚举 hit|miss|invalidated|pending 校验）。此外 DDL 冻结。
- **架构决策记录**：①预测复盘 per-owner 取本人 theses（analysis_predictions 无 owner_id、是公共个股分析产物，不加 owner）；置信度校准是系统级（analysis_predictions 三档），标注"系统个股分析置信度校准"非"我的"。②独立回算=第二套独立实现，**验证器禁止 import 主引擎的任何指标 helper**（reviewer 从原始 SQL 重算），gate 断言两者逐值相等。
- **spec 定值**：每月第一个周末生成、每人一份 per-owner；复盘默认仅本人可见（报告页 type=复盘 private）；改进建议 only，变更须本人确认（draft→confirmed 人工门）；确认后结论入 memoryd；样本不足显式标注（论点<10 判断标"样本不足"，策略小样本标注）；被拒提案用"提案价→复盘日价简化口径 + 固定免责说明"，诚实呈现防事后美化；圈子公共月报（两人公开战绩/命中榜）两人都同意才开——**本阶段仅个人复盘，圈子月报划到 P10 后**。
- **确定性/无 LLM 的指标**：命中率/置信度校准/遵守率/收益对比/误报率全部代码回算（纯算术，如 thesis-outcome.mjs）；改进建议叙事可后续接 LLM，但不入 gate 不回算。
- **无历史时点价**：填 outcome/算命中需要 review_date 的行情——stock_facts 是 per trading_day 最新价；缺该日价 → outcome=pending/样本不足，**绝不编造**。
- **隔离铁律**：每个指标服务端按 owner 过滤（proposals/theses/official_paper_snapshots/alert_events.owner_id + discipline via computeComplianceStats(ownerId)）；复盘页/列表 B 看不到 A 的。
- 凭据不入仓；临时库纪律（动 database.ts 前杀 watcher）；`pnpm test`/`typecheck`/`build` 全绿；TDD；conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务真跑相关二进制。

---

### Task 1: Migration v14 + MonthlyReviewRepository + outcome 回填

**Files:** Modify: `packages/shared-types/src/database.ts`（MIGRATIONS[13]，SCHEMA_VERSION→14 + MonthlyReviewRepository + Review domain type）；Create: `apps/openclaw-config/scripts/prediction-outcome.mjs`（analysis_predictions/proposals outcome 回填纯函数）；Test: database.test.ts + prediction-outcome.test.ts。

**Interfaces:**
- v14：monthly_reviews DDL（见 Global Constraints，plain step 新表）。测试：v13→v14 无损/幂等/fresh 直达/status CHECK/UNIQUE(owner,period) 生效。
- `MonthlyReviewRepository`：`upsertDraft(db, {ownerId, period, resultJson})`（ON CONFLICT(owner_id,period) 覆盖 draft；已 confirmed → 拒或另存，选一并文档化）；`confirm(db, id, ownerId)`（draft→confirmed + confirmed_at，非 owner 拒，已 confirmed 幂等）；`getById` / `getByOwnerPeriod` / `listForOwner`。
- `prediction-outcome.mjs`：`computePredictionOutcome({prediction, priceAtReview})` → `hit|miss|invalidated|pending`（direction 命中→hit，反向→miss，失效触发→invalidated，无价/未到期→pending；纯确定性）；`fillPredictionOutcomes(db, {now, priceReader})`（遍历到期未填 outcome 的 analysis_predictions，用 priceReader 取 review_date 价，回写 outcome；缺价保持 pending）。应用层枚举校验（写非法 outcome 抛错）。

- [ ] TDD（各 outcome 分支/无价 pending/confirm owner 门/UNIQUE）→ 真跑迁移于副本（先杀 watcher）→ Commit `feat: schema v14 - monthly reviews, repository and prediction outcome fill`

### Task 2: 复盘引擎（主实现，确定性指标）

**Files:** Create: `apps/openclaw-config/scripts/review-engine.mjs`；Test: review-engine.test.ts。

**Interfaces:**
- `buildMonthlyReview({db, ownerId, period, now, helpers})` → result_json（helpers = 注入的 computeThesisOutcome/computeComplianceStats/computePaperKpis/loadSnapshotSeriesForOwner 等，便于测试注入 + 明确主实现依赖这些）：
  - **预测复盘**：本人 theses 方向命中率（computeThesisOutcome 聚合，样本<10 标注）+ 系统置信度校准（analysis_predictions 到期已填 outcome 的按三档 low/medium/high 分桶命中率，标"系统级"）。
  - **决策复盘**：本人 period 内 executed 提案的收益（成交价 vs 复盘日价，简化口径）vs 买入持有基准（同期 QQQ 或标的自身）；被拒提案简化口径（提案价→复盘日价 + 固定免责"未执行，仅口径参考"）。
  - **策略纪律复盘**：computeComplianceStats 聚合遵守率 + "守规矩值多少钱"（遵守纪律的成交 vs 违反纪律的成交收益对比；样本小标注）。
  - **提醒质量**：period 内 alert_events 触发数 / 误报数（feedback 标"误报"计数）/ 误报率。
  - **错误归类 + 一句话教训 + 下一步 + 改进建议**：从上述指标确定性推导骨架（如遵守率低→建议收紧纪律；命中率低档置信度过高→建议校准）——本阶段确定性模板，非 LLM。
  - 全部按 owner 过滤；每指标带 sample 标注（none/insufficient/ok）。
- 返回结构化 result_json，每头条数字是纯算术可回算的值。

- [ ] TDD（各段指标/样本不足/owner 过滤/无数据空态）→ Commit `feat: monthly review engine with deterministic per-owner metrics`

### Task 3: 独立验证器 + 复盘 CLI + cron + memoryd

**Files:** Create: `apps/openclaw-config/scripts/review-verifier.mjs`（**独立重算，禁 import 主引擎 helper**）、`reviews.mjs`（CLI）；Modify: `openclaw-cron-jobs.mjs`（月度 cron）；Test: review-verifier.test.ts + **review-consistency.test.ts（交付判定 gate）** + reviews.test.ts。

**Interfaces:**
- `review-verifier.mjs`：`recomputeReviewMetrics({db, ownerId, period, now})` → 与 review-engine 头条数字**同形状**的对象，但**从原始 SQLite 行用独立算术重算**（自己 SELECT thesis_history/proposals/alert_events/official_paper_snapshots，自己数命中/遵守/误报，**不调 computeThesisOutcome/computeComplianceStats 等**）。刻意用不同的实现路径。
- **review-consistency.test.ts（GATE）**：seed 确定性 fixture（多论点+判断、多提案 executed/rejected、纪律遵守/违反、提醒触发/误报、快照序列）→ buildMonthlyReview 主实现 vs recomputeReviewMetrics 验证器 → **逐头条数字断言相等**（命中率/置信度校准各档/遵守率/收益对比/误报率）；再构造几个坏样本（报告数字被人为改错 → 验证器捕获不一致）。这是 roadmap "回算一致性单测"。
- `reviews.mjs` CLI（members.mjs 约定，REVIEWS_DB_PATH env）：`generate --owner <id> --period YYYY-MM`（buildMonthlyReview → upsertDraft → **可选跑 verifier 自检不一致则拒存并报错**）；`confirm --owner --review <id>`（draft→confirmed + memoryd 写复盘结论 fire-and-forget + 飞书单聊 fire-and-forget）；`list --owner`；`show --owner --review <id>`。owner 校验 + audit（category `monthly_review`）。
- cron：月度（每月第一个周末）注册 `reviews:generate`（沿 openclaw-cron-jobs 模式；实际每成员生成 draft，等本人 confirm）。
- memoryd：确认时写复盘结论（type=decision，s6 类记录之一，per-owner scope，fire-and-forget，沿 P7 memoryd-mirror）。

- [ ] TDD（**consistency gate 主=验证器**；坏样本被捕获；CLI generate/confirm owner 门；memoryd fire-and-forget）→ 真跑 CLI generate+confirm 于临时库贴输出 → Commit `feat: independent review verifier, consistency gate, CLI, cron and memoryd write`

### Task 4: 平台渲染（复盘 chip/阅读页/首页/确认）

**Files:** Modify: `apps/platform-app/src/routes/reports.ts`（复盘 chip 从 monthly_reviews）、`home.ts`（复盘入口/最近复盘）、`data/`（复盘读取 TS port）；Create: `apps/platform-app/src/routes/review.ts`（复盘阅读页 + 确认端点）、`apps/platform-app/src/data/monthly-review.ts`；Test: 各自。

**Interfaces:**
- reports.ts：复盘 chip 激活（沿研判 P8 模板：DB-backed owner-scoped 列表，非磁盘）；列表卡 = period + 状态（草稿/已确认）+ /review/<id> 链接。仅本人可见（B 看不到 A）。
- review.ts：`GET /review/<id>`（owner 校验，非 owner 403，**复盘永远 private 无 public**）→ 阅读页六段（预测复盘/决策复盘/策略纪律复盘/提醒质量/错误归类教训下一步/改进建议）+ 草稿态显"待确认"横幅 + 确认按钮（form POST）；`POST /api/reviews/:id/confirm`（bearer 或 Access，owner 校验 → confirm → memoryd/飞书 fire-and-forget → 303 回 /review/<id>）。
- home.ts：复盘速览块（最近一份复盘 period + 状态 + 链接；无 → "暂无复盘，每月第一个周末自动生成草稿"）。
- 全 SQL owner 过滤；改进建议标"建议 only，变更须本人在飞书/CLI 确认"。

- [ ] TDD（复盘列表 owner 过滤/阅读六段/草稿确认 owner 门/隔离 B 开 A 403）→ Commit `feat: monthly review chip, reading page, home entry and confirm flow`

### Task 5: 阶段收尾——回算一致性（交付判定）

**Steps:**
- [ ] **回算一致性矩阵**（我亲自跑）：①seed 完整 fixture（论点/提案/纪律/提醒/快照）→ generate → 主实现 result_json 每头条数字 vs 独立验证器重算逐一相等（贴数字对照）；②坏样本：手改 result_json 一个数字 → 验证器捕获不一致；③outcome 回填：到期预测 + review_date 有价 → hit/miss，无价 → pending 不编造；④owner 隔离：A/B 各生成，B 开 A 的 /review/<id> → 403，B 报告页无 A 复盘；⑤确认门：draft→confirm→memoryd fire-and-forget（注入抛错 backend，SQL 照常）+ 状态变已确认；⑥样本不足：论点<10 标"样本不足"，策略小样本标注。
- [ ] Playwright：复盘阅读页六段 + 草稿确认横幅双主题截图 + 零外部请求。
- [ ] `pnpm test`/`typecheck`/`build` ×3 → 合并 main + push → 台账/路线图/记忆 → **P9 完成即 v2 代码部分全部就绪**；整理 P10 点火完整清单交付用户。

## 明确不做（划界）

- 圈子公共月报（两人公开战绩/命中榜对比，都同意才开）→ P10 后；真 memoryd 实例写入、真飞书单聊投递、真 cron 调度、真历史行情锚定 outcome → P10；改进建议的 LLM 叙事（本阶段确定性模板）→ P10 后迭代；人工确认的飞书交互流 → P10。
