# 需求漂移全量修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把代码与 `docs/superpowers/specs/2026-07-12-detailed-requirements.md`(r2)之间 46 项经对抗验证确认的漂移全部消除,使线上系统的实际行为回到需求约定的产品形态。

**Architecture:** 三批顺序执行。第一批修产品形态(飞书↔Web 分工、深链、个人页、公共报告剥离个人内容),这批决定用户每天看到什么;第二批修可用性与正确性(审批卡回调、重启自愈、标的池覆盖、占位符、legacy 标记、置信度);第三批收尾(PDF 退役、降档、各页面细节、报告内容补全、minor)。批内按文件归属并行,批间串行(后批依赖前批产出的基础设施)。

**Tech Stack:** Node 24 + TypeScript(platform-app / shared-types)、纯 .mjs CLI(openclaw-config/scripts)、node:sqlite、vitest、飞书开放平台 API、OpenClaw 网关。

## Global Constraints

- **绝不编造数据**:取不到就按现有 disclosure 约定如实披露原因(§0.4)。
- **DDL 只走版本化迁移**:`packages/shared-types/src/database.ts` 的 migrate 链,禁止 ad-hoc 建表。当前 SCHEMA_VERSION = 15。
- **只有 owner 能动自己的东西**:所有写操作以解析出的身份为准,绝不读请求体里的 ownerId(§4)。
- **`ALLOW_LIVE_EXECUTION=false` 是宪法**:任何改动不得触碰实盘路径。
- **测试用临时库**:绝不触碰 `runtime/trading.sqlite`。
- **全中文用户可见文案**;代码注释与标识符保持英文。
- **提交信息**:conventional commits,结尾 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`。
- **交付判定**:`pnpm test` + `pnpm typecheck` + `pnpm build` 全绿才算完成;线上验证由控制器在 mini 上执行。
- **平台公网地址**:`https://reports.qingverse.com`(经 Cloudflare Tunnel);深链规则 `/daily/<date>`、`/weekly/<date>`、`/stock/<code>`、`/proposal/<id>`、`/research/<id>`、`/review/<id>`、`/member/<who>`(§1.1)。

---

## 文件结构

**新建**
- `packages/shared-types/src/deep-links.ts` — 平台深链单一出口(`buildDeepLink`)。所有卡片、通知、报告引用平台页面时只能经这里。
- `apps/openclaw-config/scripts/personal-page.mjs` — 个人页渲染器(持仓速览/策略对照/提醒回顾/待办),owner 作用域。
- `apps/platform-app/src/routes/personal.ts` — `/daily/<date>/me`、`/weekly/<date>/me` owner-only 路由。
- `apps/platform-app/src/routes/feishu-callback.ts` — 飞书卡片回调端点(审批按钮)。

**主要修改**
- `packages/shared-types/src/notifications.ts` — 报告投递改单卡 + 深链按钮;卡片 payload 改 ocf1 信封。
- `apps/openclaw-config/scripts/scheduled-report.mjs` — 剥离个人内容、接个人页、置信度结论框、L3/财报日历、假日守卫。
- `apps/openclaw-config/scripts/report-data.mjs` — `buildTrackedSymbols` 读标的池并集。
- `apps/platform-app/src/reports/scanner.ts` — legacy 改 per-file 检测。
- `apps/platform-app/src/routes/{home,paper,research,reports,stock}.ts` — 占位符清理、入口补齐、第 9 段。
- `apps/openclaw-config/scripts/{market-alerts-cards,proposal-cards,reviews,strategy-store}.mjs` — 深链、回调信封、复盘通知、降档。
- 安装脚本 — 用户级 LaunchAgent 提升为系统守护。

---

# 第一批:产品形态(critical)

## Task 1: 深链基础设施

**Files:**
- Create: `packages/shared-types/src/deep-links.ts`
- Create: `packages/shared-types/src/deep-links.test.ts`
- Modify: `packages/shared-types/src/index.ts`(导出)
- Modify: `.env.local.example`(新增 `PLATFORM_PUBLIC_BASE_URL`)

**Interfaces:**
- Produces: `buildDeepLink(kind, id): string | null`,`kind` ∈ `"daily" | "weekly" | "stock-analysis" | "stock" | "proposal" | "research" | "review" | "member" | "personal-daily" | "personal-weekly"`;未配置 base url 时返回 `null`(调用方据此降级为不带链接,绝不输出裸路径或占位文案)。

- [ ] **Step 1: 写失败测试** — 断言 `buildDeepLink("daily","2026-07-28")` === `https://reports.qingverse.com/daily/2026-07-28`;`buildDeepLink("proposal","prop_x")` === `.../proposal/prop_x`;未设 env 时返回 `null`;base url 带尾斜杠时不产生双斜杠;`kind` 非法时抛错。
- [ ] **Step 2: 跑测试确认失败**(模块不存在)。
- [ ] **Step 3: 实现** — 从 `process.env.PLATFORM_PUBLIC_BASE_URL` 读取,去尾斜杠,按 kind 映射路径段(`personal-daily` → `/daily/<date>/me`)。
- [ ] **Step 4: 跑测试确认通过**,`pnpm typecheck` 绿。
- [ ] **Step 5: 提交** `feat(shared-types): single source of truth for platform deep links`

## Task 2: 报告投递改为单张结论卡 + 深链

**Files:**
- Modify: `packages/shared-types/src/notifications.ts`(`deliverReportViaAppCredentials` ~:433-487、`shouldSendFullReportChapters` ~:618)
- Modify: `packages/shared-types/src/notifications.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `buildDeepLink`。
- Produces: `ReportDeliveryPayload` 新增可选 `reportKind`、`reportDate`、`conclusion?: {headline: string; confidence?: string; bullets: string[]}`;投递结果 `deliveries` 只含一条 `kind:"summary"`。

- [ ] **Step 1: 写失败测试** — app-credential 通道投递一份报告时,只发 **1 条** interactive card 消息(不再是 summary+N chapters);卡片含标题、结论行、`url` 按钮指向 `https://reports.qingverse.com/daily/<date>`;`shouldSendFullReportChapters()` 仍为 false 且**不再被绕过**;未配置 base url 时卡片无按钮但正文含「请在平台查看全文」且不含裸路径。
- [ ] **Step 2: 跑测试确认失败**(当前发 N 条)。
- [ ] **Step 3: 实现** — 删掉 :428-432 那段绕过注释与逻辑;把 summary+chapters 循环换成 `sendInteractiveCard` 单卡;卡片 `url` 用 `buildDeepLink(reportKind, reportDate)`。
- [ ] **Step 4: 全量测试绿**。
- [ ] **Step 5: 提交** `fix(notifications): deliver reports as one card with a platform deep link, not the full body`

## Task 3: 四类卡片接深链,删除过期占位文案

**Files:**
- Modify: `apps/openclaw-config/scripts/market-alerts-cards.mjs`(:72 `FOOTER_LINE`)
- Modify: `apps/openclaw-config/scripts/proposal-cards.mjs`
- Modify: `apps/platform-app/src/data/feishu-review-notifier.ts` 与 `apps/openclaw-config/scripts/feishu-review-notifier.mjs`(:153 裸路径)
- Modify: `apps/platform-app/src/research/worker.ts`(:274 裸路径)
- Modify: 对应 test 文件

- [ ] **Step 1: 写失败测试** — 四类卡片各断言:含 `url` 按钮且 href 为绝对地址(提醒卡→`/stock/<code>`、审批卡→`/proposal/<id>`、研判卡→`/research/<id>`、复盘卡→`/review/<id>`);断言全仓不再出现字符串「站点上线后将直达」;未配置 base url 时不渲染按钮也不输出裸路径。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — 四处统一改用 `buildDeepLink` + `InteractiveCard.url`。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `fix(feishu): every notification card links to the platform instead of a placeholder`

## Task 4: 公共日报/周报剥离个人持仓与策略内容

**Files:**
- Modify: `apps/openclaw-config/scripts/scheduled-report.mjs`(`renderCoreSummary`、模拟盘段落)
- Modify: `apps/openclaw-config/scripts/scheduled-report.test.ts`
- Modify: `apps/openclaw-config/scripts/report-quality.mjs`(新增负向门)

**Interfaces:**
- Produces: 公共报告 md 不含净资产/现金/持仓/剩余预算/暴露 等 owner 私有字段。

- [ ] **Step 1: 写失败测试** — 生成的公共日报 md **不含** 「净资产」「现金」「持仓」「剩余…预算」「模拟盘暴露」等字样;新增 report-quality 门 `report.no_personal_content`,命中即失败。
- [ ] **Step 2: 跑测试确认失败**(当前「今日结论」就带这些)。
- [ ] **Step 3: 实现** — 把这些行从公共正文移除(数据留给 Task 5 的个人页);公共报告保留行情/新闻/宏观/QQQ 基准。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `fix(reports): keep personal holdings out of the public daily and weekly body`

## Task 5: 个人页生成器

**Files:**
- Create: `apps/openclaw-config/scripts/personal-page.mjs`
- Create: `apps/openclaw-config/scripts/personal-page.test.ts`
- Modify: `apps/openclaw-config/scripts/scheduled-report.mjs`(生成后调用)
- Modify: `packages/shared-types/src/database.ts`(迁移 v16:`personal_pages` 表)

**Interfaces:**
- Produces: `renderPersonalPage({db, ownerId, kind, date}): {markdown, sections}` 四段:我的持仓速览 / 我的策略对照(论点距失效线)/ 我的提醒回顾 / 我的待办;写入 `personal_pages(id, owner_id, kind, date, markdown, created_at)`,UNIQUE(owner_id,kind,date)。

- [ ] **Step 1: 写失败测试** — 给定含持仓快照 + 论点 + 提醒事件的临时库,渲染出四段齐全的 md;两个成员各得各的、互不含对方数据;无数据时如实写「暂无持仓」而非留空;迁移在 v15 副本上干净应用。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — 复用 `official_paper_snapshots`(按 owner)、`theses` + `computeThesisOutcome`(距失效线)、`alert_events`(提醒回顾)、`proposals` 待审(待办)。
- [ ] **Step 4: 测试绿 + 迁移在真库副本验证**。
- [ ] **Step 5: 提交** `feat(reports): per-owner personal page generated with each daily and weekly report`

## Task 6: 个人页平台路由(owner-only)

**Files:**
- Create: `apps/platform-app/src/routes/personal.ts` + `personal.test.ts`
- Modify: `apps/platform-app/src/server.ts`(路由分发)
- Modify: `apps/platform-app/src/routes/reports.ts`、`home.ts`(入口链接)

- [ ] **Step 1: 写失败测试** — `GET /daily/<date>/me` 登录后返回本人四段;**非本人一律 403**;不接受 `?owner=` 参数;未登录 401;报告阅读页与首页各渲染一个「我的个人页 →」入口。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — 读 `personal_pages` 按 `resolveIdentity` 的 owner;markdown 走已有渲染器。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `feat(platform): owner-only personal page at /daily/<date>/me`

## Task 7: 个人页单聊摘要卡 + 公共报告卡发群

**Files:**
- Modify: `apps/openclaw-config/scripts/scheduled-report.mjs`(投递编排)
- Modify: `packages/shared-types/src/notifications.ts`(群/单聊目标解析)
- Modify: `apps/openclaw-config/scripts/render-openclaw-config.mjs`(群 chat_id 配置项)

**Interfaces:**
- Produces: 公共报告卡 → 群(配置了 `FEISHU_GROUP_CHAT_ID` 时;未配置则回落单聊并如实记录原因);个人页摘要卡 → 各成员本人单聊,含 `/daily/<date>/me` 深链。

- [ ] **Step 1: 写失败测试** — 一次日报投递:群收到 1 张公共卡;每个 active 成员单聊各收到 1 张个人页卡且内容互不相同;未配置群 id 时公共卡回落单聊并在结果里标注 `groupFallback: true`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `feat(reports): public card to the group, personal summary card to each member`

---

# 第二批:可用性与正确性

## Task 8: 审批卡回调打通(ocf1 信封 + 平台回调端点)

**Files:**
- Modify: `packages/shared-types/src/notifications.ts`(`buildFeishuCardPayload` 按钮 value)
- Modify: `apps/openclaw-config/scripts/proposal-cards.mjs`
- Create: `apps/platform-app/src/routes/feishu-callback.ts` + test
- Modify: `apps/platform-app/src/server.ts`

**Interfaces:**
- Produces: 按钮 value 为 ocf1 信封 `{oc:"ocf1", k:"quick", a:"alphaloop.proposal.decide", q:"批准 <token>", c:{u:<owner open_id>, e:<expiresAt ms>}}`;回调端点验签 → open_id 反查成员 → 只认本人 → 原子消费 token → `updateInteractiveCard` 原地回改。

- [ ] **Step 1: 写失败测试** — 信封形状符合 OpenClaw `decodeFeishuCardAction` 期望;回调端点:本人点击 → 提案转 approved 且卡片回改;他人点击 → 拒绝且卡片不变;重复点击 → 幂等(第二次不重复消费);过期 token → 拒绝;伪造签名 → 401。
- [ ] **Step 2: 跑测试确认失败**(当前无任何代码消费 `card.action.trigger`)。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `feat(proposals): wire the Feishu approval button end to end`

## Task 9: 重启自愈(用户级 LaunchAgent → 系统守护)

**Files:**
- Modify: `apps/openclaw-config/scripts/install-system-daemons.sh`
- Modify: `apps/openclaw-config/scripts/install-launchd.sh` / `install-user-schedules.mjs`
- Modify: 对应 test

- [ ] **Step 1: 写失败测试** — 断言安装器为 platform-app / cron-runner / market-alerts / daily-backup / official-paper poll+pnl 写 `/Library/LaunchDaemons` plist 且带 `UserName=<target>` 与 `RunAtLoad=true`;断言不再往 `~/Library/LaunchAgents` 写这些 label。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — 复用 install-system-daemons.sh 已有的 write_plist 模式;保留幂等 bootout→bootstrap。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `fix(deploy): unattended services survive a reboot that stops at the login window`

## Task 10: 新闻抓取按全体标的池并集

**Files:**
- Modify: `apps/openclaw-config/scripts/report-data.mjs`(`buildTrackedSymbols` :103-120)
- Modify: `apps/openclaw-config/scripts/scheduled-report.mjs`(:1411 调用点传 db)
- Modify: 对应 test

- [ ] **Step 1: 写失败测试** — 库里有两个成员各自的标的池 + 一份持仓时,`buildTrackedSymbols` 返回 QQQ + 两池并集 + 持仓,不依赖环境变量;env 变量仅作 override。
- [ ] **Step 2: 跑测试确认失败**(当前硬编码)。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `fix(reports): news coverage follows the union of member watchlists`

## Task 11: 清理线上占位符(首页纪律速览 / 模拟盘提案历史)

**Files:**
- Modify: `apps/platform-app/src/routes/home.ts`(:105 区域)
- Modify: `apps/platform-app/src/routes/paper.ts`(提案与成交历史卡)
- Modify: 对应 test

- [ ] **Step 1: 写失败测试** — 首页纪律空态渲染「已连续遵守 N 天」(N 来自 `computeComplianceStats`,样本不足如实标注),**不含**「P7 上线」;模拟盘页提案区读真实 proposals 渲染五态徽章并链到 `/proposal/<id>`,**不含**「P6 上线」;看他人盘时该区块隐藏。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `fix(platform): replace shipped P6/P7 placeholders with real data`

## Task 12: legacy 标记改 per-file 检测

**Files:**
- Modify: `apps/platform-app/src/reports/scanner.ts`(:44 `ALL_CURRENT_REPORTS_ARE_LEGACY`)
- Modify: `apps/platform-app/src/routes/reports.ts`(摘要卡回落文案)
- Modify: 对应 test

- [ ] **Step 1: 写失败测试** — 含新格式标记的报告 `legacy === false` 且不显示历史存档横幅;真正的旧文件仍为 true;摘要卡优先用 `parseConclusionBox`,解析失败时文案为「该报告未提供结论框」而非「旧格式」。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — 调用 `report-quality.mjs` 已导出的 `isNewFormatReport(fileContents)`。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `fix(platform): stop stamping every report as a legacy archive`

## Task 13: 日报/周报置信度结论框

**Files:**
- Modify: `apps/openclaw-config/scripts/scheduled-report.mjs`(`renderCoreSummary`)
- Modify: `apps/openclaw-config/scripts/report-quality.mjs`(新门:缺置信度不许发)
- Modify: 对应 test

- [ ] **Step 1: 写失败测试** — 日报/周报开头渲染结论框(核心结论 + 置信度 高/中/低 + 依据 + 截至时间);置信度由本次可得证据推导(数据源完整度/新闻覆盖),不足时降档并说明;缺置信度的报告被质量门拦下。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — 复用 `conclusion-box.mjs` 的三档口径。
- [ ] **Step 4: 测试绿**。
- [ ] **Step 5: 提交** `feat(reports): daily and weekly carry a conclusion box with a confidence tier`

---

# 第三批:内容与细节收尾

## Task 14: PDF 退役

**Files:** `scheduled-report.mjs`、`stock-analysis.mjs`、`official-paper-monitor.mjs`、`report-rendering.mjs`、相关 test 与 state 写入。

- [ ] **Step 1: 失败测试** — 生成报告后目录中**无 .pdf**;投递载荷无 `pdfPath`;报告自述行不再写「PDF」,改为由投递层回填的实际交付方式。
- [ ] **Step 2: 确认失败** → **Step 3: 删除 writeMarkdownPdf 调用链** → **Step 4: 测试绿** → **Step 5: 提交** `chore(reports): retire the PDF artifact per spec §0.4`

## Task 15: 三档可见性支持降档

**Files:** `apps/openclaw-config/scripts/strategy-store.mjs`、`apps/platform-app/src/data/strategy-write.ts`、`routes/api-strategy.ts`、`packages/shared-types/src/database.ts`、相关 test。

- [ ] **Step 1: 失败测试** — owner 可将 public 论点/卡片降回 system;非 owner 403;降档写审计并返回「降档已生效；此前已生成的报告/名片内容不回收」;降档后他人名片不再可见。
- [ ] **Step 2-5:** 同上 TDD 循环 → 提交 `feat(strategy): owner-only demote from public back to system`

## Task 16: 月度复盘草稿发飞书

**Files:** `apps/openclaw-config/scripts/reviews.mjs`(`generateForOwner`)、test。

- [ ] **Step 1: 失败测试** — 草稿保存成功后立即给 owner 单聊发摘要卡(头条指标 + 置信度校准 + `/review/<id>` 深链);投递失败不回滚草稿。
- [ ] **Step 2-5:** → 提交 `feat(reviews): notify the owner in Feishu when a monthly draft is generated`

## Task 17: 个股分析阅读页第 9 段(我的策略对照)

**Files:** `apps/platform-app/src/routes/stock.ts` 或 `reports.ts`、test。

- [ ] **Step 1: 失败测试** — 个股分析阅读页对**登录者本人**渲染第 9 段:逐符号「我的论点 vs 本次结论框」一致/冲突/无对照;他人论点绝不出现;无论点时渲染引导文案。
- [ ] **Step 2-5:** → 提交 `feat(platform): per-viewer strategy comparison section on stock analysis`

## Task 18: 对比入口 + 研判公开控件

**Files:** `apps/platform-app/src/routes/paper.ts`、`home.ts`、`research.ts`、test。

- [ ] **Step 1: 失败测试** — 成员 chip 旁渲染「对比 →」指向 `/paper?member=<id>&compare=1`,对 `show_performance=0` 的成员置灰;研判页 done/degraded 分支渲染「设为公开」表单,提交前的确认页列出将连带暴露的 N 条 system 档内容。
- [ ] **Step 2-5:** → 提交 `feat(platform): expose the comparison entry and research promotion control`

## Task 19: 顶栏生成时间用数据时间

**Files:** `apps/platform-app/src/layout.ts` + 各路由传参、test。

- [ ] **Step 1: 失败测试** — `RenderPageOptions.dataGeneratedAt` 必填;打开两天前的日报,顶栏显示报告日期而非当前时刻;拿不到时显示「数据时间未知」。
- [ ] **Step 2-5:** → 提交 `fix(platform): the header timestamp reflects the data, not the request`

## Task 20: 报告内容补全(L3 深挖 / 财报日历 / 周报自有渲染器)

**Files:** `scheduled-report.mjs`、`report-macro.mjs`、test。

- [ ] **Step 1: 失败测试** — (a) 日报 L3 深挖开启,预算 `perEventBudget: 5, maxEvents: 3`;(b) `### 宏观与财报日历` 含 Finnhub earnings calendar 行(按标的池并集),取不到时如实披露;(c) 周报用自己的周度摘要(周开→周收收益与回撤,来自 daily_facts),不再逐字复用日报渲染器。
- [ ] **Step 2-5:** → 提交 `feat(reports): daily deep-dive, earnings calendar, and a real weekly summary`

## Task 21: 调度正确性(月度复盘首周末 + 美股假日守卫)

**Files:** `reviews.mjs`、`scheduled-report.mjs`、`trading-schedule.mjs`、`openclaw-cron-jobs.mjs`、test。

- [ ] **Step 1: 失败测试** — 月度复盘 cron 改 `0 10 * * 6,0` 且在 `generate-all` 内加首周末守卫(非当月第一个周六/日则跳过并返回 `{ok:true, skipped:"not-first-weekend"}`);美股全休市日日报/周报返回 `{ok:true, skipped:"us-market-holiday"}` 而不产出空报告。
- [ ] **Step 2-5:** → 提交 `fix(schedule): first-weekend review guard and US-holiday report guard`

## Task 22: 首页补块 + 提醒时段边界 + 纪律情境匹配

**Files:** `apps/platform-app/src/routes/home.ts`、`apps/platform-app/src/data/{overview,strategy}.ts`、test。

- [ ] **Step 1: 失败测试** — 首页渲染「最近研判」入口与净值 sparkline;提醒流水按最近一个交易时段过滤且标题写明时段,空时如实显示「最近一个交易时段无提醒」;纪律速览按情境(临近财报/接近 10% 预算/接近 3% 熔断)挑 1-2 条置顶。
- [ ] **Step 2-5:** → 提交 `feat(platform): home page recent research, sparkline, session-scoped alerts, contextual discipline`

## Task 23: 诚实性细节(概率披露 / 宏观中文 / 表格滚动 / 目录高亮)

**Files:** `stock-analysis-metrics.mjs`、`report-macro.mjs`、`apps/platform-app/src/reports/markdown.ts`、test。

- [ ] **Step 1: 失败测试** — 多路径概率用「约 36%」无符号格式并附一行依据披露(输入=当日涨跌幅+趋势分,区间钳制 20-60%,确定性启发式非模型概率);宏观日历常见美国指标有中文标签(英文原名括注),未映射时写「(英文原名：…)」;报告表格外层有 `overflow-x:auto`;目录有滚动高亮(nonce'd IntersectionObserver)。
- [ ] **Step 2-5:** → 提交 `fix(reports): honest probability disclosure, Chinese macro labels, scrollable tables`

## Task 24: 运维一致性(心跳 / skill 包 / cloudflared 归属)

**Files:** `install-user-schedules.mjs` 或 cron-runner、`skill/SKILL.md` + `tools.json`、`install-cloudflared-tunnel.mjs`、`apps/openclaw-config/README.md`、test。

- [ ] **Step 1: 失败测试** — launchd 调度任务各写 run_log 心跳并接入连续失败升级;SKILL.md/tools.json 与当前路由表一致(含 research submit/promote,baseUrl 为 `https://reports.qingverse.com`,去掉 Access 措辞);仓库只保留一套 cloudflared 部署路径且 README 有「公网入口」章节。
- [ ] **Step 2-5:** → 提交 `chore(ops): heartbeats for scheduled jobs, refreshed skill manifest, single cloudflared owner`

---

---

# 第一批返修:评审确认的 14 项缺陷

第一批(`7a5d1aa..c0a141d`)落地后,三路对抗评审(规格符合性 / 隐私隔离 / 回归)提出 15 项,经逐条对抗性反驳后 **14 项成立**(1 项被驳回:「个人页对 owner_id IS NULL 快照兜底」——反驳证明这些行确非任何成员私有)。其中两项 critical,且有本批自身引入的回归。

## Task 25: notifications.ts 及其调用点(A1-A4)

- [ ] **A1(critical 回归)** — cron 运维告警变空卡。`openclaw-cron-runner.mjs:184` 把 `alertDeliverer` 绑成 `deliverReportToFeishu`,而 Task 2 把该路径改成只发结论卡,告警 markdown 非报告结构 → 作业失败/熔断/发现缺口/状态持久化失败四处告警内容为空。运维告警不是报告,给它保留全文的独立投递路径。
- [ ] **A2(important)** — 深链按钮用卡片 1.0 的 `url`,payload 声明 `schema:"2.0"`;2.0 的按钮跳转走 `behaviors:[{type:"open_url", default_url,…}]`。全仓 `behaviors|open_url` 零命中 → 本批所有卡片按钮在真实飞书里可能不可点或整卡被拒,而单测只断言我们自己的 `InteractiveCard` 抽象。**先查飞书官方文档确证,再让发出的 JSON 对其声明的 schema 无歧义合法,并把断言下移到飞书面向的 JSON 形状。** 同时修「三种 null 原因塌缩成一句'未配置平台公开地址'」。
- [ ] **A3(important 回归)** — `stock-analysis.mjs:299` / `official-paper-monitor.mjs:162` 未传 `reportKind`/`reportDate`,新单卡路径下既丢正文又无按钮。
- [ ] **A4(important)** — `deliverReportViaUserPlugin(:689)` 无视 `payload.openId`/`audience`,发往固定共享群并记为已送达 → owner-scoped 个人页可能进共享会话。要么尊重 openId,要么拒发并如实返回 `{sent:false, reason}`;静默错投记成成功是不可接受的结果。

## Task 26: 平台读取侧隐私(B1-B2)

- [ ] **B1(critical 线上暴露)** — `/official-paper/<date>` 只过 `requireIdentity`,任意 active 成员可读净资产/现金/持仓明细,且 `scanner.ts:47` 把它索引进 `/reports` 列表,`official-paper-monitor.mjs:155-160` 每交易日新生成一份。磁盘产物本身无归属信息 —— 归属无法确立时不得对非本人可读,**绝不猜归属**。
- [ ] **B2(minor)** — 个人页响应无 `Cache-Control`,`applySecurityHeaders` 也不设。补 `private, no-store` 并断言,让「只有本人可见」在缓存层同样成立。

## Task 27: 报告与数据侧(C1-C4)

- [ ] **C1(important 暴露)** — 公共正文的 `renderExecutionDigest(:747-775)` 仍逐条展开成交(标的/方向/数量/参考价格),`renderCoreSummary:644` 还公布条数与拒绝数;`execution_reports`(database.ts:116)**无 owner_id**,`selectExecutionReports(:1662)` 无法按成员过滤。迁移 v17 加 owner_id,broker-executor 写入时打戳,存量行不猜归属(未归属行不得进公共面),公共正文去掉成交明细与人均计数。
- [ ] **C2(minor,§3.3)** — 周报个人页与日报逐字同构。把 C1 移出的成交流水放这里,并加逐笔「一致/冲突/无对照」判定(对照本人论点与纪律,给出理由)。
- [ ] **C3(important 编造数据)** — 窗口内无快照时 `loadSnapshotScope` 两条查询命中同一行,`describeNetAssetsChange` 不比 id → 渲染成「区间净值变动 ±0.00」,把「无数据」说成「零变动」。每逢周一/假日必现。改为如实披露原因。
- [ ] **C4(important)** — 个人页 DM 无幂等:`{delivered,skipped,failed}` 写了从没被读;`:336` 任一成员失败即 `exitCode=1` → cron 重试整轮 → 已收到的人重复收卡。

## Self-Review

**1. Spec coverage** — 46 项漂移去重为 24 个任务,逐条映射:
- CRIT-1/2 → Task 1,2,3;CRIT-3/4/5 → Task 5,6,7;CRIT-6/10 → Task 10;CRIT-7 → Task 8;CRIT-8 → Task 9;CRIT-9 → Task 4。
- IMPO-1→T16、2/5→T12+T13、3/18→T17、4→T8、6→T19、7→T11+T22、8/9→T11+T18、10→T18、11→T4、12→T14、13/23→T13、14/15/16→T20、17→T21、19/20→T3+T7、21/22→T24、24→T15。
- MINO-1→T14、2/3/4→T22、5→T23、6→T12、7/11→T21、8/12→T23、9→T24(路由表)、10→T24。
**2. Placeholder scan** — 每个任务都给了具体文件、具体断言、具体提交信息;无 TBD。
**3. Type consistency** — `buildDeepLink` 在 T1 定义,T2/T3/T7/T16 引用同名同签名;`renderPersonalPage` 在 T5 定义,T6/T7 引用;`personal_pages` 表在 T5 建,T6 读。
