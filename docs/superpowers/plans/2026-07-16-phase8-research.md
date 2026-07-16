# Phase 8 站内研究 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。逐任务派发子 agent，任务完成后控制器亲自验收。

**Goal:** 交付站内提问式研究全链路：首页提问框 → research_tasks 任务（每日配额 + 状态机 + 崩溃续跑）→ 内置 worker 调受限 agent 后端（可注入，真检索 P10）跑确定性研判管线（意图解析→拉行情→检索新闻→读论点纪律→数字校验→生成研判，数据缺失显式「跳过」绝不编造）→ 研判页（结论先行 + 置信度三档 + 与我的论点/纪律对照 + 证据链 + 调研过程透明）→ 归档进报告页「研判」+ /research/<id> + 可公开进名片。交付判定：**全链路含数据缺失场景**（跳过而非编造）+ 每日配额生效 + 离页不丢。

**Architecture:** research_tasks 表即状态机（queued→running→done|degraded|failed），worker 是 platform-app 内置队列（启动时重拾未完成行）。研判引擎纯确定性管线，受限 agent 后端可注入（沿 news-agent-search 范式，真后端 P10 抛错，测试注入 fake）；owner scope 由 worker 预绑定，agent 无自由 scope 参数。记忆/行情读取复用 P7 SQL readers（owner 强制）。外部文本走 defuse + 定界符隔离，永不参与工具选择。研判内容存 DB（result_json），研判页/报告页/名片同源渲染（视图无独立存储）。

**Tech Stack:** 同前。零新依赖。进行中页轮询 = CSP-兼容 nonce'd setTimeout reload。

## Global Constraints

- **Migration v13 本阶段授权**（SCHEMA_VERSION → 13，research_tasks **ADD COLUMN**（无需表重建，沿 v6 removed_at 先例）：`result_json TEXT`、`confidence TEXT CHECK(confidence IS NULL OR confidence IN ('low','medium','high'))`、`title TEXT`）。此外 DDL 冻结。
- **spec 定值**：配额每人每日 ≤10 次（美东交易日切界，`currentUsEasternTradingDay`）；单次调研预算与超时固定（budget_spent 记账 + 超时→degraded）；置信度三档 low|medium|high（复用 CONFIDENCE_LABELS 高/中/低）；visibility private|public 默认 private（研判默认仅本人可见，公开进名片）；轮询 3-5s 无 WebSocket；数据缺失 → 步骤流「跳过：未找到 X」**绝不编造**；只研究类问题（操作类提示走飞书）；标的范围 = 全体标的池并集 + 本人持仓（池外提示先加自选）。
- **隔离铁律**（复用 P3/P7）：owner = 解析身份，绝不取 body/query；worker 记忆工具按任务 owner 预绑定 scope，agent 无自由 scope；`/research/<id>` 非 owner 且非 public → 403，报告页研判列表 B 看不到 A 的条目；名片只见 public 研判。
- **受限 agent 后端**：`createResearchBackend()` 真 OpenClaw 受限网关 = P10 抛错（`"research agent backend requires P10 ignition (restricted no-shell OpenClaw gateway + search quota measurement)"`）；工具面只读白名单（检索/抓取[P10]、行情读[stock_facts]、记忆读[P7 SQL readers owner-proxied]），**无 shell/无文件写/无券商**。
- **注入隔离**（复用 news-agent-search）：外部取回文本 → defuseMarkdownInText + `<<<EXTERNAL_UNTRUSTED>>>...<<<END_EXTERNAL>>>` 包裹，dead-end 永不再读入工具/查询选择；研判数字必须溯源 stock_facts（数字校验步 ±0.1%/±0.01 价，超差标「数字待核」不编造）。
- 凭据不入仓；临时库纪律（动 database.ts 前杀 watcher）；`pnpm test`/`typecheck`/`build` 全绿；TDD；conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务真跑相关二进制。

---

### Task 1: Migration v13 + ResearchTaskRepository + 配额

**Files:** Modify: `packages/shared-types/src/database.ts`（MIGRATIONS[12]，SCHEMA_VERSION→13：research_tasks ADD 三列 + ResearchTaskRepository + Research domain type）；Test: database.test.ts 追加。

**Interfaces:**
- v13：ADD COLUMN result_json/confidence/title（plain step，非重建）。测试：v12→v13 无损/幂等/fresh 直达/confidence CHECK 生效/既有行三列 NULL。
- `ResearchTaskRepository`：
  - `countTodayForOwner(db, ownerId, tradingDay)` → 今日（美东）该 owner 的任务数（created_at 落在 tradingDay 的美东日界内——用 currentUsEasternTradingDay 反算区间；复用 alerts 的日界逻辑）。
  - `createIfWithinQuota(db, {ownerId, question, tradingDay, dailyLimit=10})` → 单事务 BEGIN IMMEDIATE：count ≥ limit → `{ok:false, reason:'quota_exceeded', used, limit}`；否则 INSERT status='queued' + 返回 `{ok:true, task}`（原子防并发超配额，测试并发提交恰好卡在第 11 次）。
  - `claimNextQueued(db, nowIso)` → 原子把一个 queued 行转 running（`UPDATE ... SET status='running' WHERE id=(SELECT id ... WHERE status='queued' ORDER BY created_at LIMIT 1) AND status='queued'`，changes=1 才算认领；返回该 task 或 null）——worker 并发安全。
  - `appendStep(db, id, step)` / `setResult(db, id, {status, resultJson, confidence, title, finishedAt})` / `getById` / `listForOwner(db, ownerId, {status?})` / `listRunningOrQueued(db)`（启动续跑用）/ `promoteVisibility(db, id, ownerId)`（private→public，非 owner 拒）。
- Research domain type（result_json 结构：`{conclusion, confidence, keyPoints:[{text,evidenceRefs[]}], dataTable:[{label,value,source}], comparison:{theses:[...],disciplines:[...]}, suggestedAction, evidence:[{ref,title,url,publisher}], skipped:[{step,reason}]}`）。

- [ ] TDD（配额原子/claim 原子/续跑列表/promote owner）→ 真跑迁移于副本（先杀 watcher）→ Commit `feat: schema v13 - research task result columns, repository and daily quota`

### Task 2: 研判引擎（确定性管线 + 可注入后端）

**Files:** Create: `apps/openclaw-config/scripts/research-engine.mjs`；Test: research-engine.test.ts。

**Interfaces:**
- backend 接口：`async ({query, kind}) => {results:[{title,publisher,url,summary_zh,publishedAt}]}`；`createResearchBackend()` → P10 抛错（文档接线点）。
- `runResearchPipeline({db, ownerId, question, backend, quoteReader, memoryReader, budget, now, onStep})` → 顺序步骤，每步 onStep 回调（供 worker 落 steps）：
  1. **意图解析**：从 question 抽标的/主题（正则 + 标的池匹配）；非研究类（操作意图关键词 改规则/批提案/记记忆）→ 立即 `{status:'failed', reason:'operational_intent', message:'操作类请走飞书'}`。
  2. **拉取行情**：quoteReader（stock_facts quote.last，owner 无关公共）；缺 → 步骤记「跳过：未找到 <symbol> 行情」。
  3. **检索新闻**：backend（预算记账，超预算停）；抛错/空 → degraded 部分结果 + 跳过标注；外部文本 defuse + 定界符。
  4. **读取论点与纪律**：memoryReader（P7 owner-proxied readers：loadOwnTheses/computeComplianceStats）——scope=ownerId 预绑定；无则跳过。
  5. **数字校验**：结论引用的数字 vs stock_facts（±0.1%/±0.01）；不符 → 标「数字待核」不编造。
  6. **生成研判**：确定性组装 result_json；**置信度 = 惩罚聚合**（无证据→low/高不确定；反方证据存在→标注；单源→medium；≥2 源一致→high——沿 news-agent-search buildAnalysis，非 LLM）；与论点/纪律对照（一致/冲突显式）。
- 返回 `{status: 'done'|'degraded'|'failed', resultJson, confidence, title, steps, skipped, budgetSpent}`；backend 抛错保留部分结果 → degraded（never reset）；超预算 ≠ degraded（正常完成）。
- 纯确定性（注入 fake backend/reader），非 LLM。

- [ ] TDD（数据缺失跳过不编造/操作意图拒/预算停/degraded 保留部分/置信度各档/数字校验拦截/注入 defuse）→ Commit `feat: deterministic research pipeline with honest skips, penalized confidence and injection quarantine`

### Task 3: 内置 worker + 提交 API + 飞书通知

**Files:** Create: `apps/platform-app/src/research/worker.ts`、`apps/platform-app/src/routes/api-research.ts`；Modify: `apps/platform-app/src/server.ts`（deps 加 researchBackend/quoteReader/memoryReader；worker 启停）、`index.ts`（worker 挂载）；Test: 各自。

**Interfaces:**
- `createResearchWorker({db, backend, quoteReader, memoryReader, now, notify?, budget})` → `{tick(), start(), stop()}`：tick = claimNextQueued → runResearchPipeline（onStep→appendStep）→ setResult → notify（飞书单聊结果卡，fire-and-forget，缺 openId 跳过）；start = 定时 tick（或注入触发，测试手动 tick）；**boot 续跑**：启动时 listRunningOrQueued，把孤儿 running（进程重启中断）重置 queued 再跑。in-process，单实例（单写者，mini-only）。
- `POST /api/research`（提交）：`resolveIdentity`（bearer 或 Access 头——首页提问框走 Access，skill 走 bearer；owner=身份，body 无 ownerId）→ 校验 question 非空 → createIfWithinQuota（配额超 → 429 中文「今日研究配额已用完（10/10），美东交易日切界后重置」）→ 入队 → 返回 `{ok:true, taskId, redirect:'/research/<id>'}`。worker 异步跑（提交即返回，不阻塞）。
- `POST /api/research/:id/promote`（private→public，owner 校验；公开前检查引用的 system 档论点/纪律——本阶段简化：仅 owner 校验 + 记 audit，引用检查确认弹窗属前端 P10）。
- 测试：提交入队 + 配额 429；worker tick 跑完一个任务（fake backend）状态 done + result_json 写入；degraded/failed 路径；boot 续跑（预置 running 孤儿 → 重置跑完）；notify fire-and-forget（缺 openId 不失败）；owner 从身份非 body。

- [ ] TDD → 真跑：临时库提交任务 + 手动 tick worker → 查 result_json + steps 贴输出 → Commit `feat: in-process research worker, submit API with quota and feishu notify`

### Task 4: 平台渲染（提问框/进行中/研判页/报告归档/名片）

**Files:** Modify: `apps/platform-app/src/routes/home.ts`（提问框激活）、`research.ts`（进行中轮询 + 研判页全版式）、`reports.ts`（研判筛选片从 DB）、`member-card.ts`（公开研判真渲染）、`data/`（研判读取）、`render/layout.ts`（可选第二 nonce'd 脚本支持进行中轮询）；Test: 各自。

**Interfaces:**
- home.ts 提问框：`<input>` + `<button>` 激活（form POST /api/research，method=post；Access 身份提交）；非研究类前端不拦（后端 failed 兜底）；提交后重定向 /research/<id>。
- research.ts：
  - 进行中（queued/running）：步骤流实时（steps）+ 「调研进行中，本页每 3 秒自动刷新（可关闭页面，完成后飞书通知）」+ **nonce'd `setTimeout(()=>location.reload(),3000)`（仅进行中态发，CSP 兼容）**。
  - 研判页（done/degraded）：结论先行卡（conclusion + 置信度徽章高/中/低 + 「截至」时间）→ 关键要点（证据角标）→ 数据表 → **与我的论点/纪律对照**（一致/冲突标注，读 result_json.comparison）→ 建议动作（「不构成投资建议，模拟盘语境」）→ 证据链（可点）→ 调研过程（可展开步骤流 + 跳过项）。degraded → 头部「降级：已收集材料，研判未完成」横幅。failed → 失败原因卡。
  - visibility label 修正：private→「仅本人可见」（不是「系统可用」——修 P3 遗留 label bug）。
- reports.ts：「研判」筛选片从 research_tasks（owner 的 done/degraded）列表，非磁盘；列表卡 = title/question + 置信度 + 日期 + /research/<id> 链接。
- member-card.ts：公开研判区 = subject 的 public research_tasks（结论 + 置信度 + 链接）。
- 全 SQL owner/visibility 过滤。

- [ ] TDD（提问框 POST/进行中轮询脚本存在且 nonce 匹配/研判全版式/degraded 横幅/private label/报告研判列表 owner 过滤/名片公开）→ Commit `feat: research question box, polling progress page, verdict rendering and archival`

### Task 5: 阶段收尾——全链路含数据缺失场景（交付判定）

**Steps:**
- [ ] **全链路矩阵**（我亲自跑，临时库 + fake backend）：①正常问题：提交→worker tick→done→研判页结论/置信度/对照/证据/过程全渲染；②**数据缺失场景**：fake backend 对某标的返回空 + stock_facts 无该价 → 研判页「跳过：未找到 X」显式呈现、置信度相应降档、**绝不编造数字**；③操作类问题 → failed「请走飞书」；④配额：连提 11 次 → 第 11 次 429；⑤离页不丢：提交后不轮询，worker tick 完，再开 /research/<id> 结果在；⑥隔离：B 开 A 的 private 研判 → 403，B 报告页无 A 研判条目，A 升 public → B 名片可见；⑦boot 续跑：预置 running 孤儿 → worker 启动重置跑完。
- [ ] Playwright：进行中页（轮询脚本）+ 研判页（结论/置信度/对照/证据/过程）双主题截图 + 零外部请求；数据缺失场景研判页截图（跳过项可见）。
- [ ] `pnpm test`/`typecheck`/`build` ×3 → 合并 main + push → 台账/路线图/记忆 → **不停，直接进 P9**。

## 明确不做（划界）

- 真实 OpenClaw 受限 agent 网关 + 真检索 + 搜索配额实测（P10）；真 memoryd 检索（P7 SQL readers 已够本地）；公开前引用②档论点确认弹窗（前端交互 P10）；飞书结果卡真实投递（fake transport 本地，真投递 P10）；worker launchd 守护（P10 部署）；研究智能化的真实 agent 推理质量（本地 fake 确定性管线，真推理 P10）。
