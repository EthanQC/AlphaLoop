# Phase 4 新闻引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。逐任务派发子 agent，任务完成后控制器亲自验收。

**Goal:** 交付事件聚类新闻引擎全链路：L1 确定性多源采集（RSSHub 中文源 + Finnhub + 既有 Yahoo/Google/Longbridge）→ URL 归一 + 标题相似度聚类（一事一卡）→ SQLite 持久化 → 日报「多源新闻（事件聚类）」段 + 平台新闻页真实内容；L2/L3 受限检索的编排层（预算/schema/降级）以可注入后端落地；日报级最小事实表 + 质量门扩展（≥3 源/中文占比/URL 抽查/数字比对），坏样本全拦截。先修四项审计注入 bug 再建新能力。

**Architecture:** 纯函数聚类核心（news-engine.mjs，零 IO）+ 源客户端层（news-sources.mjs：RSSHub 双路由冗余/Finnhub 滑窗限速/既有源迁移包装，源级健康=失败记录跳过不阻塞）+ SQLite 仓储（news-store.mjs，migration v8 三表）+ L2/L3 编排（news-agent-search.mjs，检索后端注入，真实 OpenClaw 后端 P10 点火）+ 两个渲染面消费同一聚类结果（scheduled-report 日报段 / platform-app 新闻页）。标题消毒在 normalizer 摄入层一次完成，覆盖 PDF 与平台两面。

**Tech Stack:** 同前阶段。无新第三方依赖；Finnhub 走原生 fetch；RSSHub 为本机 Docker HTTP（本地开发用 fixtures，容器部署 P10）。

## Global Constraints

- **Migration v8 本阶段授权**（SCHEMA_VERSION → 8，MIGRATIONS 末尾追加一步；此外 DDL 冻结）。新闻表无 owner 列（公共资产，07-12 §0.4 按全体标的池并集生产；平台 identity 门只是登录门，勿加 owner 过滤）。
- **spec 定值（不得更改）**：新闻检索预算 日报 ≤30 次 / 周报 ≤60 次；L3 深挖每事件 ≤5 轮（周报 ≤8）；**L3 日报默认关，先周报 only**（07-07 评审决策，推翻 07-03 原文）；新闻时间窗近 7 天；质量门 ≥60% 非券商源、≥30% 中文源、≥3 个独立来源、URL 抽查每报告 ≥5 条全可达、数字比对容差 百分比 ±0.1 / 价格 ±0.01；L2 输出 schema `{title, publisher, url, publishedAt, summary_zh, impact:{direction,affected,reason}, evidence_quote}`，**无 url 条目直接丢弃**；报告生成总时长 ≤15 分钟。
- **RSSHub 路由（binding）**：`/cls/telegraph`、`/wallstreetcn/live`、`/gelonghui/live`，每条配第二冗余路由（这三条历史上常失效）；`RSSHUB_BASE_URL` env（默认 `http://127.0.0.1:1200`）。Finnhub company news，`X-Finnhub-Token` 头 + 60 次/分滑动窗口限速，错误串过 redaction（不落 key）。
- **published_at 可空=未知**：任何"缺失时间→Date.now()"兜底一律禁止；未知时间条目不参与 recency 排序与 7 天窗，报告中如出现须标「时间未知」置底。
- **标题消毒在摄入层**：normalizer 输出的 title/titleZh 必须已转义 markdown 链接语法（`[`→`［`、`](` 拆解或等效），使 PDF 的 formatInlineHtml 与平台 markdown.ts 两面都不再能被标题注入活链接。
- **H7 语义保留**：质量门收紧后，显式「来源降级状态」披露的 L1-only/单源报告仍放行（拦截的是**未披露**的降级与伪造）。
- 凭据不入仓不入报告；`.env.local.example` 补 `FINNHUB_API_KEY`/`RSSHUB_BASE_URL` 占位并回填 secrets-inventory.md 表格。
- `pnpm test`/`typecheck`/`build` 全绿；TDD；中文用户文案英文注释；提交 conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；每任务真跑一次相关二进制贴输出；实测一律临时库/fixtures（禁碰 runtime/trading.sqlite 与真实外网除非任务明示）。

---

### Task 1: 审计注入修复（先修地基）

**Files:** Modify: `apps/openclaw-config/scripts/report-news.mjs`（xmlText/decodeXmlEntities 顺序、normalizeEpochMs、标题消毒）、`report-data.mjs`（normalizeEpochMs 同修、normalizeNewsArticle 标题消毒）、`report-quality.mjs`（extractSourceLabels section-scoped）；Test: 各自 test。

**Interfaces:**
- #30：先解码实体**再**剥标签；`decodeXmlEntities` 把 `&amp;` 放最后解。坏样本 `Fed &lt;img onerror&gt; decision` 出来必须是转义文本。
- #31：`normalizeEpochMs` 缺失/不可解析 → 返回 `undefined`（不是 now）；`publishedAt/publishedAtMs` 全链路可空；`mergeNewsArticles` 排序把未知时间排最后。两处（report-news/report-data）都改。
- #29：新增 `defuseMarkdownInText(text)`（导出，供 P4 后续任务复用）：把 `[text](url)` 语法替换为全角括号等价物，normalizer/decorate 层对 title/titleZh/summary 一律过它；`renderDetailedNewsLine`/`renderChineseNewsLine` 的字段自然继承。回归测试：恶意标题在 PDF 渲染（formatInlineHtml）与平台 renderMarkdown 都不再产出 `<a>`。
- #32：`extractSourceLabels` 只认「### 证据与来源」/汇总段内的 `来源分布：` 行（section-scoped 解析），新闻标题正文中同字样不再被采集也不再被从 detail_depth 计数剔除。伪造样本必须 fail source_diversity。
- 现有测试全部保持绿（涉及排序/时间的 fixture 合理更新，逐一说明）。

- [ ] 逐项 TDD（坏样本先红）→ 全量绿 → Commit `fix: news injection hardening - decode order, unknown-time honesty, title defusing, scoped source labels`

### Task 2: Migration v8 + news-store

**Files:** Modify: `packages/shared-types/src/database.ts`（MIGRATIONS[7]，SCHEMA_VERSION→8）；Create: `apps/openclaw-config/scripts/news-store.mjs`；Test: `database.test.ts` 追加、`news-store.test.ts`。

**Interfaces（v8 DDL）:**
```sql
CREATE TABLE news_events (
  id TEXT PRIMARY KEY, cluster_key TEXT NOT NULL UNIQUE,
  title_zh TEXT NOT NULL, summary_zh TEXT,
  impact_direction TEXT CHECK(impact_direction IN ('bullish','bearish','neutral','unknown')),
  impact_affected TEXT NOT NULL DEFAULT '[]', impact_reason TEXT,
  first_published_at TEXT, last_published_at TEXT,
  source_count INTEGER NOT NULL DEFAULT 0, zh_source_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX news_events_window_idx ON news_events(last_published_at);
CREATE TABLE news_event_sources (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES news_events(id),
  origin TEXT NOT NULL, publisher TEXT NOT NULL, url TEXT, title_raw TEXT NOT NULL,
  published_at TEXT, lang TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL);
CREATE INDEX news_event_sources_event_idx ON news_event_sources(event_id);
CREATE TABLE daily_facts (
  id TEXT PRIMARY KEY, trading_day TEXT NOT NULL, fact_key TEXT NOT NULL,
  value_num REAL, value_text TEXT, unit TEXT, source TEXT NOT NULL,
  data_time TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(trading_day, fact_key));
```
- store：`upsertEventWithSources(db, event, sources)`（按 cluster_key upsert，源去重按 url/标题，回写 source_count/zh_source_count/first/last_published_at）、`listEventsInWindow(db, {sinceIso, symbol?, topic?})`（affected JSON LIKE 过滤 + 时间窗，未知时间排除）、`replaceDailyFacts(db, tradingDay, facts[])`（单事务全量替换当日）、`getDailyFacts(db, tradingDay)`。
- 迁移测试：v7→v8 无损、幂等、fresh 直达、约束生效（坏 impact_direction 拒）。

- [ ] TDD → 真跑迁移于真库**副本** → Commit `feat: schema v8 - news events, sources and daily facts`

### Task 3: 聚类核心（news-engine.mjs，纯函数）

**Files:** Create: `apps/openclaw-config/scripts/news-engine.mjs`；Test: `news-engine.test.ts`。

**Interfaces:**
- `normalizeNewsUrl(url)`：小写 host、去 utm_*/fbclid 等跟踪参数、去尾斜杠、剥 Google News 跳转包装；无效返回 null。
- `titleSimilarity(a, b)`：归一化 token（大小写/标点/停用词）Jaccard ∈ [0,1]。
- `clusterArticles(articles, {similarityThreshold=0.6, windowMs=48h})`：同一归一 URL **或** 相似度≥阈值且时间差≤窗口 → 同事件；返回 `{clusterKey, articles[], firstPublishedAt|null, lastPublishedAt|null}`[]；clusterKey 确定性（首条归一 URL 或标题 shingle hash）；未知时间条目可入簇但不参与窗口判定。
- `deriveImpact(cluster, trackedSymbols)`：迁移 scheduled-report 的 classifyMarketNews/summarizeMarketNewsTitle 启发式 → `{direction, affected[], reason}`；L2 结构化 impact 存在时优先。
- `buildEventFromCluster(cluster, trackedSymbols)`：产出 store 事件形状（title_zh 经 Task 1 的 defuse + 既有翻译启发式；zh_source_count 按 lang 统计）。
- 测试含 spec 场景：「二十条近似重复合并成一张卡」、跨源同 URL 合并、utm 变体合并、不相关标题不误合、未知时间处理、确定性（同输入同 clusterKey）。

- [ ] TDD → Commit `feat: news event clustering core - url normalization, title similarity, impact labels`

### Task 4: L1 源客户端（RSSHub + Finnhub + 既有源整合）

**Files:** Create: `apps/openclaw-config/scripts/news-sources.mjs`；Modify: `.env.local.example`、`docs/superpowers/specs/secrets-inventory.md`；Test: `news-sources.test.ts`（fixtures，零真实外网）。

**Interfaces:**
- `fetchRsshubFeed(route, {baseUrl, timeoutMs, fetchImpl})`：三条 binding 路由常量 + 每条第二冗余路由（主路由失败自动试冗余）；解析走 Task 1 修复后的 RSS 管线；lang='zh'。
- `fetchFinnhubCompanyNews(symbol, {apiKey, fetchImpl})`：`X-Finnhub-Token` 头；**滑动窗口限速 60 次/分**（导出可测的 RateLimiter）；错误消息过 redaction（key 绝不出现在任何 error/log/报告，测试断言）；近 24h 参数。
- `collectL1News({symbols, env, fetchImpl})`：全源并发 Promise.allSettled（RSSHub×3、Finnhub×N、既有 Yahoo search/RSS、Google RSS、Longbridge——复用 scheduled-report 现有 fetcher，本任务把它们抽到本模块，scheduled-report 改 import）；**源级健康：单源失败 → warnings 记录 + 跳过，绝不阻塞**；全源空才抛。返回 `{articles, warnings, sourceHealth}`。
- env：`FINNHUB_API_KEY`（缺失→Finnhub 源标 skipped_no_key，不报错）、`RSSHUB_BASE_URL`。

- [ ] TDD（fixtures：真实抓包样本脱敏；限速器时序测试；key 泄漏断言）→ Commit `feat: L1 news sources - rsshub with redundancy, rate-limited finnhub, unified collection`

### Task 5: L2/L3 编排层（可注入检索后端）

**Files:** Create: `apps/openclaw-config/scripts/news-agent-search.mjs`；Test: `news-agent-search.test.ts`。

**Interfaces:**
- `runL2TopicSearch({searchBackend, budget, symbols, l1Titles})`：预算记账（每次调用扣减，超budget 立即停）；每标的至少一轮 + 宏观/行业至少两轮的计划器；结果逐条 schema 校验（Global Constraints 的 L2 schema），**无 url 丢弃并计数**；取回文本用数据定界符包裹（`<<<EXTERNAL_UNTRUSTED>>>...<<<END>>>`），标题/摘要过 Task 1 defuse。
- `runL3DeepDive({searchBackend, events, perEventBudget, enabled})`：按影响评分选 top 2-3；**enabled 默认 false（日报），周报 true**；每事件 ≤perEventBudget 轮；输出「事件-多源证据-影响分析-不确定性」结构，须含反方证据字段或显式 `counterEvidence: 'not_found'`。
- `searchBackend` 接口：`async ({query, kind}) => {results:[{title,publisher,url,publishedAt,snippet}]}`——真实 OpenClaw 受限 agent 后端本任务只留 `createOpenclawSearchBackend()` 占位（throw 'P10 ignition required'，文档注明）；测试全部用注入 fake。
- 降级：backend 抛错/预算耗尽 → 返回 `{degraded: true, reason}`，调用方（Task 7）生成 L1-only 报告 + 头部标注「agent 检索不可用」。
- 坏样本拦截测试（交付判定一部分）：无 URL 条目被丢弃且计数、纯英文条目（summary_zh 缺失/非中文）被拒、预算越界第 31 次调用被拒。

- [ ] TDD → Commit `feat: L2/L3 restricted search orchestration with injectable backend and budgets`

### Task 6: daily_facts 写入 + 质量门扩展 + 坏样本全拦截

**Files:** Create: `apps/openclaw-config/scripts/report-facts.mjs`；Modify: `report-quality.mjs`、`scheduled-report.mjs`（数据收集期写 facts）；Test: 各自 test。

**Interfaces:**
- `buildDailyFacts({snapshot, qqqQuote, macroEntries, tradingDay})`：确定性抽取全部会出现在叙事里的数字（QQQ 价/涨跌%、净资产、现金、暴露%、剩余预算、宏观事件数等），每条 `{factKey, valueNum|valueText, unit, source, dataTime}`；写库走 Task 2 的 replaceDailyFacts；scheduled-report 生成期先写 facts 再渲染。
- 质量门新增（validateReportMarkdown 扩展，全部带失败码）：
  - `news.source_diversity_v2`：独立来源 ≥3（section-scoped 解析，沿 Task 1 修复）；**保留 H7 显式降级放行**。
  - `news.chinese_ratio`：中文源占比 ≥30%（按事件卡来源统计行解析）。
  - `news.url_reachability`：抽查 ≥5 条链接 HEAD 全可达（`fetchImpl` 注入；生产默认真 HEAD，超时视为不可达；报告 <5 条链接时全查）。
  - `facts.numeric_match`：叙事段数字 vs daily_facts 比对，百分比容差 ±0.1、价格 ±0.01；facts 缺失该键 → fail（编数即拦截）。
- **坏样本套件**（单测形式固化，交付判定）：无 URL 新闻条目、纯英文摘要、数字造假（叙事 122,959.91 vs facts 122,000.00）、伪造来源分布标题、`<img>` 实体注入标题、markdown 链接注入标题——**全部被对应门拦截**，每样本断言具体失败码。

- [ ] TDD → 真跑一次 validateReportMarkdown 于真实历史报告（应通过或给出明确失败码）→ Commit `feat: daily facts table and hardened quality gates with bad-sample interception`

### Task 7: 双面消费——日报事件聚类段 + 平台新闻页

**Files:** Modify: `apps/openclaw-config/scripts/scheduled-report.mjs`（fetchMarketNews → collectL1News + 聚类 + 入库 + 新渲染段）、`apps/platform-app/src/routes/news.ts`（占位 → 真实事件卡页）、`apps/platform-app/src/server.ts`（若需 deps 扩展）；Create: `apps/platform-app/src/data/news.ts`（平台侧读 news_events/sources）；Test: 各自 test + seam 测试（引擎写库 → 平台读库同一行）。

**Interfaces:**
- 日报段（07-11 §3.1 binding）：`### 多源新闻（事件聚类）`——每事件：中文标题/影响（方向/标的/理由）/两行摘要/来源角标（媒体名+时间）/原文链接；段尾来源统计行（供质量门：来源分布、非券商占比、中文占比）；L2/L3 结果并入（degraded 时标注）；聚类结果同步 upsert 入库（同一引擎两个渲染面）。
- 平台新闻页（07-12 §1.5 binding）：事件聚类一事一卡（全部来源+各自相对时间，点击展开绝对时间——纯 CSS/details 实现，无新 JS）；顶部筛选片=「全部 + 全体标的池并集符号 + 宏观」（stock_analysis_targets 全表 distinct symbol，含哨兵池）；`?symbol=`/`?topic=` 过滤；近 7 天窗（listEventsInWindow）；影响标签徽章（方向色 up/down/neutral）；空态「近 7 天暂无聚类事件——新闻引擎随日报生成积累」；freshness=最新事件 last_published_at 距今（<6h 最新/<48h 延迟/更久或空 部分缺失）。
- seam 测试：collectL1News(fixtures) → clusterArticles → upsertEventWithSources → 平台 listEventsInWindow → renderNewsPage，全链路一次贯通，卡片内容与 fixture 对得上。

- [ ] TDD → 实测：临时库跑全链路 seam + 起平台服务 curl /news 贴片段 → Commit `feat: clustered news in daily report and live platform news page`

### Task 8: 部署接线 + 阶段收尾

**Files:** Create: `apps/openclaw-config/launchd/com.alphaloop.rsshub.plist.template`（`docker start rsshub` 包装，KeepAlive=false RunAtLoad=true，容器本体 P10 建）；Modify: `openclaw-runtime-doctor-core.mjs`（`rsshub-health`：GET `${RSSHUB_BASE_URL}/healthz` 或根路由，不可达→warn 点名 P10/docker；`news-engine-health`：news_events 最新 last_published_at 距今 >48h 且非全新库→warn）；README 两份补新闻引擎章节；Test: doctor 扩展。

**Steps:**
- [ ] TDD + 真跑 doctor 贴输出
- [ ] **交付判定**：①坏样本套件全绿（Task 6，逐样本失败码）；②聚类单测全绿含二十重复合并场景；③全链路 seam 实测（临时库）；④Playwright：新闻页 fixtures 渲染双主题截图 + 筛选片 + 零外部请求断言。
- [ ] `pnpm test`/`typecheck`/`build` ×3 → 合并 main + push → 台账/路线图/记忆更新 → **不停，直接进 P5**。

## 明确不做（划界）

- RSSHub 容器实际部署与三路由真实连通（P10 mini 点火）；OpenClaw 受限 agent 真实检索后端（P10）；L3 日报开启（观察 2-3 周后人工决策）；启发式翻译退役（L2 实证后）；PDF 路径删除（P10 切换决策）；per-stock facts（P5）；研判/复盘报告类型（P8/P9）。
