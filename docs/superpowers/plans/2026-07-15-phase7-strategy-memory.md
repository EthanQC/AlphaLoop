# Phase 7 策略记忆+名片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。逐任务派发子 agent，任务完成后控制器亲自验收。

**Goal:** 交付策略记忆全链路：六类记录的结构化写入（纪律规则/策略卡/个股论点/判断批注 + 交易批注[P6 已采]/复盘结论[P9]）+ 三档可见性（私有不上平台/系统可用本人专属/公开进名片，**服务端强制隔离**）+ 论点卡（看多看空双栏 + 判断历史 append-only + 事后走势代码回算）+ 纪律 CRUD（三档执行 + 近30天遵守统计）+ 名片公开清单 + memoryd 镜像层（fire-and-forget 可注入，真实例 P10）+ skill 客户端（清单 + JSON 写 API + 接入文档）。交付判定：**三档端到端本地测试**全绿。

**Architecture:** SQL 是可见性与结构化数据的唯一真源；memoryd 只做全文镜像（fire-and-forget，不可用不影响任何 SQL 路径与纪律硬检查）。写入双面共用 store 层：CLI（strategy.mjs，本地可测）+ bearer-token JSON API（platform-app，skill 客户端调用）。所有隔离在 SQL WHERE 层（owner_id=? / visibility='public' AND owner_id!=?），绝不 JS 后过滤。判断历史永不删（复盘原料），事后走势渲染时用 stock_facts 最新价回算，不入库。

**Tech Stack:** 同前。memoryd 后端可注入（真 HTTP P10 抛错，测试注入 fake）。

## Global Constraints

- **Migration v12 本阶段授权**（SCHEMA_VERSION → 12）：①新表 `strategy_cards (id TEXT PK, owner_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL, scene TEXT, entry_condition TEXT, risk_control TEXT, exit_rule TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','retired')), visibility TEXT NOT NULL DEFAULT 'system' CHECK(visibility IN ('system','public')), memory_slug TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)` + index (owner_id, status)；②`theses` 加两列 `bull_points TEXT NOT NULL DEFAULT '[]'`、`bear_points TEXT NOT NULL DEFAULT '[]'`（JSON 数组，看多/看空结构化依据——**表重建走 needsForeignKeysOff 模式**，保 v3 CHECK/index/removed 语义）。此外 DDL 冻结。
- **技术决策记录**：spec 原文"策略卡/看多看空依据只在 memoryd"——本阶段将**结构化字段下沉 SQL**（可见性真源必须 SQL 才能服务端强制隔离；交付判定要求本地可渲染可测）；memoryd 仍收全文镜像。
- **spec 定值**：三档 = 私有(不上平台，theses/strategy_cards 无此档)/系统可用(visibility='system'，仅本人)/公开(visibility='public'，进名片圈内可见)；升档 ①→②→③，**降档不回收已生成历史**（如实告知）；②系统可用**绝不泄露给其他成员**；纪律三档执行 hard(违反不生成提案)/proposal_check(卡标✓✗)/self(仅提醒)；规则/论点/判断**可停用不可删**（停用保留全部历史）；判断历史 append-only；事后走势**确定性代码回算**（价格 vs 目标/失效线），样本<10 标「样本不足」，非 AI 宣称；人工必填 ≤2 字段。
- **隔离铁律**（复用 P3 约定）：只有 owner 能动自己的东西；隔离在 SQL 层；他人只见 public。名片 `__legacy_system__`/revoked/不存在 → 404。
- **memoryd**：镜像层 `createMemorydBackend()` 真 HTTP loopback（无 auth，回环即信任）= P10 抛错；fire-and-forget（save 失败仅告警，SQL 已提交）；per-owner scope；可见性档位写进 memoryd tags（**但读永远从 SQL，tags 只是镜像**）。
- 凭据不入仓；临时库纪律（动 database.ts 前杀 watcher）；`pnpm test`/`typecheck`/`build` 全绿；TDD；conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务真跑相关二进制。

---

### Task 1: Migration v12 + 记忆写入 store

**Files:** Modify: `packages/shared-types/src/database.ts`（MIGRATIONS[11]，SCHEMA_VERSION→12：strategy_cards 新建 + theses 表重建加两列）；Create: `apps/openclaw-config/scripts/strategy-store.mjs`；Test: database.test.ts + strategy-store.test.ts。

**Interfaces:**
- theses 表重建（needsForeignKeysOff）：保留全部 v3 列/CHECK/index + 加 bull_points/bear_points；数据保全测试（既有行 bull/bear 默认 '[]'）。
- `ThesisStore`：`createThesis(db, {ownerId, symbol, direction, targetLow, targetHigh, invalidationPrice, bullPoints[], bearPoints[], visibility})`（direction∈bull|bear|neutral，visibility∈system|public 默认 system）；`appendThesisJudgment(db, thesisId, {note, source})`（写 thesis_history，**无删除方法**）；`promoteThesisVisibility(db, thesisId, ownerId)`（system→public，非 owner 拒，已 public 幂等）；`withdrawThesis`（status→withdrawn，保留历史）；`setThesisMemorySlug`。
- `DisciplineStore`：`createRule(db, {ownerId, ruleText, enforcement, linkedStrategy})`；`disableRule`（enabled=0 + disabled_at，**不删**）；`enableRule`；`listRulesForOwner`（含停用，标注）。
- `StrategyCardStore`：`createCard(db, {ownerId, name, scene, entryCondition, riskControl, exitRule, visibility})`；`setStatus`（active|paused|retired）；`promoteVisibility`；`listCardsForOwner` / `listPublicCards(excludeOwner)`。
- 全部 owner 归属；升档非 owner 拒。

- [ ] TDD（表重建保全/三档升档/停用不删/append-only 无删除法）→ 真跑迁移于副本（先杀 watcher）→ Commit `feat: schema v12 - strategy cards, thesis evidence columns and memory stores`

### Task 2: memoryd 镜像后端（可注入 fire-and-forget）

**Files:** Create: `apps/openclaw-config/scripts/memoryd-mirror.mjs`；Test: memoryd-mirror.test.ts。

**Interfaces:**
- backend 接口：`async ({scope, type, title, content, tags}) => {ok, memoryId?}`；`createMemorydBackend()` → P10-gated throw（`"memoryd backend requires P10 ignition (dedicated MEMORYD_DATA_ROOT instance, loopback HTTP)"`，文档接线点）。
- `mirrorRecord(backend, {ownerId, recordType, title, content, visibility})`：type 映射（策略卡→playbook / 纪律→warning / 论点·判断→decision）；scope = per-owner（owner id 派生）；tags 含可见性档；**fire-and-forget**：backend 抛错/不可用 → 返回 `{mirrored:false, reason}` 并 console.warn，**绝不抛**（调用方 SQL 已提交）。
- `scopeForOwner(ownerId)` 确定性派生。
- 测试：type 映射正确；fire-and-forget（fake backend 抛错 → mirrorRecord 不抛、返回 mirrored:false）；tags 含档位；真后端抛 P10 错。

- [ ] TDD → Commit `feat: fire-and-forget memoryd mirror backend with per-owner scope`

### Task 3: strategy CLI + 事后走势回算

**Files:** Create: `apps/openclaw-config/scripts/strategy.mjs`（CLI）、`thesis-outcome.mjs`（回算纯函数）；Test: 各自 test。

**Interfaces:**
- `thesis-outcome.mjs`：`computeThesisOutcome({thesis, judgments, latestPrice})` → 每条判断的事后走势 `{judgmentId, priceAtRender, vsTargetPct, vsInvalidationPct, verdict: 'toward_target'|'toward_invalidation'|'neutral'|'insufficient'}`；命中率 = 判断数 ≥ 阈值才算否则 'sample_insufficient'（样本<10）；latestPrice 缺失 → 'no_price'（不猜）。纯确定性，非 AI。
- `strategy.mjs` CLI（members.mjs 约定，STRATEGY_DB_PATH env）：
  - `thesis create --owner --symbol --direction bull|bear|neutral [--target-low --target-high --invalidation] [--bull "点1;点2"] [--bear "..."] [--visibility system|public]` → ThesisStore.createThesis + mirrorRecord（注入 backend；缺失=降级）→ 回填 memory_slug。
  - `thesis judge --owner --thesis <id> --note <text> [--source <ref>]`（owner 校验）→ appendThesisJudgment + mirror。
  - `thesis promote --owner --thesis <id>`（system→public）；`thesis withdraw`。
  - `rule create --owner --text <t> --enforcement hard|proposal_check|self [--strategy <ref>]`；`rule disable/enable --owner --rule <id>`；`rule list --owner`。
  - `card create --owner --name --scene --entry --risk --exit [--visibility]`；`card status/promote`；`card list --owner`。
  - 全部单行 JSON、中文错误、per-command flags、audit（category `strategy_memory`）。
- 从"结论框存为论点"入口：`thesis from-conclusion --owner --report <path> --symbol`（读该报告 parseConclusionBox → 草拟 thesis 结构，人确认字段——CLI 直接创建，标 source='conclusion_box'）。

- [ ] TDD（回算各 verdict/样本不足/无价；CLI 全命令负向 owner）→ 真跑 CLI 全流程于临时库（注入 fake memoryd）贴输出 → Commit `feat: strategy memory CLI and deterministic thesis outcome backtest`

### Task 4: 平台写 API（bearer-gated）+ skill 客户端

**Files:** Create: `apps/platform-app/src/routes/api-strategy.ts`（JSON 写端点）、`skill/SKILL.md` + `skill/tools.json` + `skill/README-onboarding.md`；Modify: `apps/platform-app/src/server.ts`（路由接线）；Test: api-strategy.test.ts。

**Interfaces:**
- JSON API（全部 **bearer token only**——resolveIdentity 已支持；无 token / Access 头无写权 → 401/403；身份=owner，所有写作用于该 owner）：
  - `POST /api/theses`（create）、`POST /api/theses/:id/judgments`（append）、`POST /api/theses/:id/promote`、`POST /api/rules`、`POST /api/rules/:id/disable`、`POST /api/cards`……——薄封装 T1 stores + T2 mirror；请求体校验（坏 direction/enforcement → 400）；owner 从 token 身份取，**body 里的 ownerId 被忽略/拒绝**（防越权，负向测试）。
  - 响应单行 JSON；CSP/安全头复用（虽 JSON 无脚本，仍设 nosniff）。
- skill 交付物（分发到成员机 = P10，本阶段建清单）：
  - `SKILL.md`：AlphaLoop skill 说明 + 配置两项（`api.<域名>` + 个人 token）+ 工具清单（论点/纪律/策略卡读写、研究提交[P8]、提醒 CRUD[P2]、提案请求[P6]——token-scoped owner）。
  - `tools.json`：工具→API 端点映射。
  - `README-onboarding.md`：§5.3 接入流程（members.mjs add + token issue → 填 skill config → 验证）。

- [ ] TDD（bearer 必需/body-ownerId 被拒/坏字段 400/端点作用于 token owner）→ 真跑：临时库发 token → curl POST /api/theses 带 bearer 建论点 → SQL 查到该 owner 行贴输出 → Commit `feat: bearer-gated strategy write API and skill client package`

### Task 5: 平台渲染升级（论点卡/纪律统计/策略卡/名片）

**Files:** Modify: `apps/platform-app/src/routes/strategy.ts`、`member-card.ts`、`stock.ts`、`data/overview.ts`（新读取）；Create: `apps/platform-app/src/data/strategy.ts`（论点回算/遵守统计读取）；Test: 各自扩展。

**Interfaces:**
- 论点卡升级（strategy.ts §2 + stock.ts 个股论点）：看多依据/看空依据双栏（bull_points/bear_points JSON 渲染）+ 目标区间 + 失效条件 + visibility pill + **判断历史时间线**（thesis_history + computeThesisOutcome 事后走势标注，样本不足如实标）。
- 纪律段（strategy.ts §1）：规则 + 执行徽章（代码强制/提案检查/自我约束）+ **近30天遵守统计**（真实计算：读 proposals 该 owner 该规则 proposal_check 命中/违反数 —— alert_events 或 proposals.discipline_report 解析；无数据 → 「近30天无相关提案」不再是「统计 P7 上线」占位）。
- 策略卡段（strategy.ts §2 新增）：strategy_cards 本人 system+public + 状态徽章（活跃/暂停/退役）+ visibility pill。
- 圈子公开区（strategy.ts §3）：他人 public 论点 + public 策略卡，按成员分组。
- 名片（member-card.ts）：公开策略清单（public strategy_cards）+ 公开论点清单（public theses + 事后走势回算，"公开即接受检验"）——真渲染替换占位。
- 所有新读取 SQL 层 owner/visibility 过滤。

- [ ] TDD（bull/bear 渲染/判断历史回算/遵守统计/名片 public 清单/隔离：B 不见 A 的 system 论点）→ Commit `feat: thesis card evidence, compliance stats, strategy cards and member card public lists`

### Task 6: 阶段收尾——三档端到端本地测试（交付判定）

**Steps:**
- [ ] **三档端到端矩阵**（我亲自跑，临时库双成员 A/B）：①A 建 system 论点 → A 的策略页/名片可见、**B 的圈子区/A 名片不可见**（系统可用绝不泄露）；②A 升 public → 进 A 名片、B 圈子区可见、B 看 A 名片可见；③降档不回收（withdraw 后历史仍在）；④判断历史 append 多条 + 事后走势回算随最新价变化；⑤纪律 hard 规则 → P6 evaluateDiscipline 读到并阻断（跨阶段 seam）；⑥bearer API 建论点 owner 正确、body-ownerId 越权被拒；⑦memoryd fire-and-forget（注入抛错 backend，SQL 照常提交）。
- [ ] Playwright：策略页三段 + 名片公开清单双主题截图 + 论点卡判断历史 + 零外部请求。
- [ ] `pnpm test`/`typecheck`/`build` ×3 → 合并 main + push → 台账/路线图/记忆 → **不停，直接进 P8**。

## 明确不做（划界）

- memoryd 真实例/真 scope/向量层（P10）；skill 真实分发到 mashu 机器 + §5.3 真计时（P10）；私有档①本地层（成员本地 memoryd，永不上平台，无服务端代码）；复盘结论写入（P9）；bull/bear 富文本叙事的 memoryd 回读渲染（P10，本地渲染结构化 JSON 依据）；研判类记录（P8）。
