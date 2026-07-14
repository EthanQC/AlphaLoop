# Phase 3 站点与平台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。逐任务派发子 agent 实现，任务完成后 review。

**Goal:** 交付 AlphaLoop 平台站点骨架：platform-app 全站身份网关（Access 邮箱头 + bearer token）+ 5 页与下钻页的服务端渲染（final.html 双主题 token）+ 成员/token 管理 CLI；有真数据的区块渲染真数据（磁盘报告、快照、提醒），没有的渲染诚实占位（标注所属后续阶段），全站 per-owner 隔离在服务端强制。

**Architecture:** 单一 Node 服务 `apps/platform-app`（TS workspace 包，裸 `node:http`，沿 broker-executor 模式），绑定 `127.0.0.1:4314`。不起独立静态服务（tech 选型留的口子选"本地目录 passthrough"）：公共产物由 platform-app 直接读磁盘回源；个人化页面按身份过滤后服务端渲染。无 SPA/无前端框架：HTML 服务端拼装 + 最小原生 JS（主题切换/研究轮询占位），全资产内联，CSP 带 per-request nonce。

**Tech Stack:** Node ≥24 `node:http`/`node:sqlite`、TypeScript（@apps/platform-app，tsc + tsx watch）、vitest、复用 shared-types（MemberRepository/ApiTokenRepository/http.ts helpers）。

## Global Constraints

- 端口/绑定：`127.0.0.1:4314`（env `PLATFORM_APP_PORT`）；**永不监听 0.0.0.0**。:4312 已被 broker-executor 占用。
- 身份解析链（tech §1.3）：`Authorization: Bearer <token>` → `ApiTokenRepository.verify`；否则 `Cf-Access-Authenticated-User-Email` 头 → `MemberRepository.getByEmail`；都无 → 401。**Access JWT 校验（防伪造头）记为 P10 前置**（本地无 Cloudflare 环境，需真域名）——代码留 `verifyAccessJwt` 挂点 + 显式 TODO，P10 点火清单加项。
- **服务端强制隔离**（req §4）：「只有 owner 能动/看自己的东西」在 handler 层查询即过滤，绝不靠前端隐藏。спec §7 负向测试是本阶段验收判定（见 Task 8）。
- 每页必备（req §1.1）：生成时间条 + 新鲜度标签（最新/延迟/部分缺失）+ 降级横幅（缺数据变灰对应区块并如实标注，绝不静默）；全中文；**页面不向第三方发任何请求**（全资产内联）；深链规则稳定：`/daily/<date>` `/stock/<code>` `/proposal/<id>` `/research/<id>` `/member/<who>`。
- UI token 以 `docs/superpowers/specs/ui-samples/final.html` 为**唯一真源**：双主题 CSS 变量逐字复制（light=作战室 `--up:#12805C/--down:#D5342B`；dark=终端 `--up:#34D399/--down:#FF5C5C`），`data-theme` 切换 + `localStorage('alphaloop-theme')` + `prefers-color-scheme` 兜底；≥1024px 侧栏 + 4 列 bento，移动端底部 5-tab；**绿涨红跌**；`tabular-nums` 数字字体。
- 哨兵值渲染规则：`__legacy_shared__`（标的共享池）、`__shared__`（快照不可归属）、`__legacy_system__`（迁移占位成员，**不得当真人渲染**，`/member/__legacy_system__` → 404）；快照 `positions[].priceSource: 'cost'|'zero'` 与 `degraded/degradedReason` 必须渲染为降级估值标注。
- **PDF 已退役**（req §0.4）：一律渲染 `.md`，忽略 `.pdf`。
- 遗留日报/周报（2026-05~06，旧格式内嵌共享模拟盘持仓）：类型标「历史存档」，全员可见但页顶横幅「历史存档：旧版格式，含当时共享模拟盘账户内容」；**不得**标为「公共日报」（新公共/个人分离格式 = P4/P5）。
- 安全头：每响应 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-<per-request>'` + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`；markdown→HTML 全程严格转义（扩展 report-rendering 的 escapeHtml 思路，新写 web 版渲染器，禁止 raw HTML 直通）。
- `pnpm test`/`typecheck`/`build` 全绿；TDD；DDL 冻结（本阶段**无**迁移授权——报告索引用磁盘扫描 + mtime 缓存，不建表）；提交英文 conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；中文用户文案、英文注释。
- 每任务收尾真跑一次二进制（起服务 curl 真路由 / 跑 CLI），贴真实输出。

---

### Task 1: platform-app 包骨架 + 安全基线

**Files:**
- Create: `apps/platform-app/package.json`（`@apps/platform-app`，scripts: build=tsc / dev=tsx watch / start=node dist）、`tsconfig.json`（对齐 broker-executor）、`src/index.ts`（进程入口）、`src/server.ts`（createServer 工厂，可注入依赖便于测试）、`src/security.ts`（CSP/nonce/安全头）
- Modify: 根 `package.json`（`platform:dev`/`platform:start` scripts）
- Test: `apps/platform-app/src/server.test.ts`

**Interfaces:**
- Produces: `createPlatformServer(deps: { db, repoRoot, now? }): http.Server`（不自动 listen）；`applySecurityHeaders(res, nonce)`；`GET /health` → `{ok:true, service:"platform-app"}`。
- 启动流程沿 broker-executor：resolveRepoRoot → loadLocalEnv → openTradingDatabase → listen 127.0.0.1。

- [ ] 失败测试（/health 200 且带全部安全头；未知路由 404 JSON；监听地址断言 127.0.0.1）→ 实现 → 真跑 `pnpm platform:dev` + `curl -i localhost:4314/health` 贴输出 → Commit `feat: platform-app skeleton with loopback server and security headers`

### Task 2: 身份层 + 成员管理 CLI

**Files:**
- Create: `apps/platform-app/src/identity.ts`、`apps/openclaw-config/scripts/members.mjs`（CLI）
- Test: `apps/platform-app/src/identity.test.ts`、`apps/openclaw-config/scripts/members.test.ts`

**Interfaces:**
- `resolveIdentity(req, db): Member | null` — 解析链见 Global Constraints；bearer 优先；`__legacy_system__` 永不解析为有效身份。未解析 → 401 页面（中文，含"联系圈主开通"提示）。
- `members.mjs`：`add --email <e> --name <n> [--feishu <openId>]`（生成 member id，冲突报错）/ `list` / `revoke --member <id>` / `token issue --member <id> --label <l>`（**明文 token 只打印一次**）/ `token revoke --token-id <id>`。全部单行 JSON 输出、错误非零退出、中文错误——复用 market-alerts.mjs 的 buildCliResult 模式与 per-command flag 白名单。
- 审计：add/revoke/token 操作写 audit_log（category `platform_members`）。

- [ ] 失败测试（header/bearer/无身份/revoked member/revoked token/`__legacy_system__` 各路径；CLI add→token issue→verify 往返 seam 测试；revoke 后 verify null）→ 实现 → 真跑 CLI 全命令（临时库）贴输出 → Commit `feat: identity resolution and member management CLI`

### Task 3: 主题模板引擎（final.html token 落地）

**Files:**
- Create: `apps/platform-app/src/render/layout.ts`（页面外壳：sidenav/底部 tabs/生成时间条/新鲜度标签/降级横幅/主题切换）、`src/render/tokens.ts`（双主题 CSS 变量，**逐字**取自 final.html）、`src/render/html.ts`（escapeHtml/attr/严格拼装原语）
- Test: `apps/platform-app/src/render/layout.test.ts`

**Interfaces:**
- `renderPage({ title, nav, member, freshness, degraded, bodyHtml, nonce }): string` — 完整 HTML 文档；仅一处内联 `<script nonce>`（主题切换，逐字对齐 final.html 的 toggleTheme/localStorage 逻辑）。
- `escapeHtml` 覆盖 `& < > " '`；所有动态值经它；模板函数**不接受** raw HTML 参数除显式 `trustedHtml()` 包装（grep 可审计）。
- Freshness 枚举：`最新|延迟|部分缺失`；降级横幅接受 reason 列表。

- [ ] 失败测试（双主题变量存在性快照——从 final.html 提取的关键 token 逐个断言；XSS 探针 `<script>` 注入被转义；nonce 匹配 CSP；≥1024 与移动布局类名存在）→ 实现 → 真跑起服务浏览器截图双主题（Chrome headless 或 Playwright）→ Commit `feat: dual-theme layout engine from final.html tokens`

### Task 4: 报告库 + 报告页 + 阅读页

**Files:**
- Create: `apps/platform-app/src/reports/scanner.ts`（磁盘扫描 + mtime 缓存索引）、`src/reports/markdown.ts`（md→安全 HTML：标题/列表/表格/链接/代码块，链接仅 http(s) 且 `rel="noreferrer"`）、`src/routes/reports.ts`（列表 + `/daily/<date>`、`/weekly/<date>`、`/stock-analysis/<date>` 阅读页）
- Test: 各自 test 文件

**Interfaces:**
- `scanReports(repoRoot): ReportIndexEntry[]` — `{ type: 'daily'|'weekly'|'stock-analysis'|'official-paper', date, mdPath, title, legacy: boolean }`；README.md 排除；缓存按目录 mtime 失效。
- 列表页：类型筛选片 + 日期倒序卡片（req §1.4）；研判/复盘筛选片存在但空态标注「P8/P9 上线」。
- 阅读页骨架：摘要卡（旧格式无结论框 → 取首段 + 「旧格式无置信度」标注）→ 可折叠目录（H2 锚点）→ 正文 → 来源清单（正文内 `[原文](url)` 汇总）；`legacy: true` → 页顶存档横幅。
- 深链 `/daily/2026-06-19` 直达；不存在日期 → 404 中文页。

- [ ] 失败测试（扫描真实 reports/ 目录结构 fixture；md 渲染 XSS 探针【标题/链接/代码块内注入】；legacy 判定；目录锚点生成；404）→ 实现 → 真跑：起服务打开真实 2026-06 存档报告截图 → Commit `feat: report library, list and reading pages`

### Task 5: 首页 + 新闻页（壳 + 诚实占位）

**Files:**
- Create: `apps/platform-app/src/routes/home.ts`、`src/routes/news.ts`、`src/data/overview.ts`（首页数据聚合查询）
- Test: 各自 test 文件

**Interfaces:**
- 首页区块顺序 = req §1.2：开始研究（提问框 disabled + 「站内研究 P8 上线」）→ 我的模拟盘概览（有快照渲染净值/今日，空 → 「暂无快照数据——模拟盘接入后显示」）→ 我的待办（proposals 空态 → 「提案审批 P6 上线」）→ 我的提醒流水（alert_events 按 owner 查询，真渲染；空 → 「暂无提醒」）→ 今日日报卡（磁盘最新日报链接 + 存档标注）→ 纪律速览（discipline_rules 空 → 「策略记忆 P7 上线」）。
- 新闻页：整页占位卡「新闻引擎 P4 上线——届时事件聚类一事一卡」+ 布局骨架（筛选片/卡片网格样式已就位）。
- `overview.ts` 的每个查询都按 `member.id` 过滤（哨兵回退规则同 loadLatestSnapshotForOwner：本人行优先，NULL/`__shared__` 仅兜底）。

- [ ] 失败测试（双成员数据隔离——A 的提醒不出现在 B 首页；快照 owner 回退次序；空态文案存在）→ 实现 → 真跑双主题截图 → Commit `feat: home and news pages with honest placeholders`

### Task 6: 模拟盘页 + 个股页

**Files:**
- Create: `apps/platform-app/src/routes/paper.ts`、`src/routes/stock.ts`、`src/data/snapshots.ts`（快照读取：owner 优先/哨兵/degraded 解析，复用 H4 的 positions JSON 约定）
- Test: 各自 test 文件

**Interfaces:**
- 模拟盘页（req §1.6）：默认本人；顶部成员切换（`listActive()`，排除哨兵）；KPI 行（净值/今日/累计/最大回撤——快照序列可算则算，不可算标「数据不足」）；持仓表含 `priceSource` 降级标注列；净值曲线/环图/条形图 = 内联 SVG（无第三方库）；对比视图：对方 `show_performance=0` → 只画本人 + 「对方未公开战绩」，**服务端**判断。提案与成交历史块 → 「P6 上线」。
- 个股页 `/stock/<code>`（req §1.9）：头部（代码/数据时间）→ 最新公共分析摘要（stock-analysis 磁盘报告中该 symbol 的段落，无 → 空态）→ 我的论点卡（theses 按 owner+visibility 过滤；空 → 「P7 上线」）→ 我的该标的提醒历史（alert_events JOIN alert_rules 按 symbol+owner）→ 历史分析列表。
- symbol 校验：`normalizeSymbol` 后仍非法 → 404（防路径注入）。

- [ ] 失败测试（show_performance 服务端隐藏；degraded 持仓标注渲染；快照为空的 KPI 空态；B 查 A 的提醒历史被过滤；symbol 注入探针）→ 实现 → 真跑（手播两成员+两快照的临时库）双主题截图 → Commit `feat: paper trading and stock drill-down pages`

### Task 7: 策略页 + 名片 + 提案/研判占位路由

**Files:**
- Create: `apps/platform-app/src/routes/strategy.ts`、`src/routes/member-card.ts`、`src/routes/proposal.ts`、`src/routes/research.ts`
- Test: 各自 test 文件

**Interfaces:**
- 策略页（req §1.7）：三段结构；纪律段徽章映射 `hard→代码强制 / proposal_check→提案检查 / self→自我约束`；策略卡/论点段按 visibility（本人全见；他人仅 `public`）；圈子公开区按成员分组；全空 → 「策略记忆 P7 上线」占位但布局真实。
- 名片 `/member/<who>`（req §1.8、tech §2.5 视图无存储）：偏好标签（risk_tags/stock_tags 真渲染）+ 战绩（show_performance=0 → 「未公开」；=1 但无快照 → 空态）+ 公开策略/论点/研判三清单（visibility='public' 查询，空态）；`__legacy_system__`/不存在/revoked → 404。
- `/proposal/<id>`：**仅 owner 可见**——非 owner → 403 中文页（数据为空也要有真实的 authz 代码路径：先查行、比 owner、再渲染）；无行 → 404。`/research/<id>` 同规则（visibility='public' 例外可见）。
- 403 与 404 页面可区分（验收 §7 要求"被拒"明确）。

- [ ] 失败测试（B 开 A 的 proposal → 403；A 本人 → 404【空库】仍非 403；public research 他人可见、private 被拒；名片 visibility 过滤；`__legacy_system__` → 404）→ 实现 → 真跑 curl 断言状态码贴输出 → Commit `feat: strategy, member card and owner-gated proposal/research routes`

### Task 8: 阶段收尾——双账号隔离实测 + 部署接线

**Files:**
- Create: `apps/openclaw-config/launchd/com.alphaloop.platform-app.plist.template`（KeepAlive，沿 H2 模板约定）
- Modify: `apps/openclaw-config/scripts/openclaw-runtime-doctor-core.mjs`（launchd-jobs 检查加 platform-app；`platform-app-health` 检查：:4314/health 可达性 warn）、两份 README（平台起停/成员管理章节）
- Test: doctor 扩展测试

**Steps:**
- [ ] doctor 扩展 TDD → 真跑 doctor 贴输出
- [ ] **双账号隔离实测**（交付判定）：临时库 seed 成员 A/B + 各发 token + 手播快照/提醒/论点数据 → 起服务 → 逐条跑 req §7 负向矩阵：B 深链 A 的 `/proposal/<id>` 与 `/research/<id>` 被拒（403）；报告列表 B 看不到 A 的研判/复盘条目；B 关闭战绩后 A 侧名片与对比视图正确隐藏；A 本人深链全部可达；页面零外部请求（Playwright 网络面板断言）；无身份 401。全部贴真实输出/截图。
- [ ] **Playwright 实测**（CLAUDE.md 全局要求）：双主题 × PC/移动视口截图 5 页 + 名片 + 阅读页；主题切换 + localStorage 持久化实测。
- [ ] `pnpm test`/`typecheck`/`build` ×3 全绿 → 整分支终审 review → 合并 main + push → 台账/路线图/记忆更新。

## 明确不做（划界）

- 新闻引擎/事件聚类（P4）、结论框三档与预测入库（P5）、提案卡片回调与多账户（P6）、memoryd 策略记忆与三档写入口（P7）、站内研究 worker 与配额（P8）、复盘（P9）、cloudflared/Access 真环境与 JWT 校验（P10）。
- 不建报告索引表、不加任何迁移（DDL 冻结）。
- 不做关注/评论/点赞/私信（req §1.8 明文）。
