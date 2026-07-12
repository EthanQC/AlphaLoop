# AlphaLoop v2 产品迭代需求文档（PRD）

- 日期：2026-07-03
- 状态：待用户审批（审批前不开工）
- 依据：2026-07-03 深度调研报告（三轮工作流 + 人工交叉质证，约 60 条论断，24 条三票确认、约 30 条原文核对、0 条实质证伪）
- 方法：system-wright 四层框架（Prompt / Context / Harness / Loop + 人工判断门）

---

## 1. 背景与目标

### 1.1 现状

仓库现有四能力：中文日报/周报（Markdown→PDF→飞书）、个股批量分析、长桥官方模拟盘监控与受限下单、飞书群 @ 回复。运行时因机器用户迁移（mashu→abble）后未重装，当前全停（2026-07-03 确认）。

### 1.2 v2 目标（一句话）

把 AlphaLoop 从「定时发 PDF 的脚本集」升级为「主动、可读、可审批、可复盘的个人美股交易工作系统」。

### 1.3 v2 四个主题

1. **呈现升级**：PDF 退役，全部报告 HTML 化并经子域名发布（R1、R2）。
2. **主动化**：盘中异动与持仓预警推送飞书（R4）。
3. **深度化**：agent 自主检索的新闻引擎 + 个股分析数据供给扩展（R3、R5）。
4. **决策闭环**：模拟盘提案-审批 + 月度复盘飞轮（R6、R7）。

---

## 2. 工作系统总览（Work System Card）

- **系统名**：AlphaLoop v2 个人美股交易辅助工作系统
- **使用者**：用户本人（唯一审批人与运维者）；飞书群可信成员（内容读者）
- **要完成的工作（JTBD）**：以最低阅读成本持续获得可信的美股信息、提醒与决策支持，并把每次预测与决策沉淀为可复盘的数据
- **触发**：OpenClaw cron 调度（报告/轮询/复盘）＋事件（飞书群 @、卡片按钮、提醒阈值命中）
- **输入**：长桥行情与官方模拟盘快照、新闻源（RSS/API/agent 检索）、用户维护的标的池与提醒规则、用户的审批决定
- **输出**：HTML 报告站点、飞书通知卡片、经审批的模拟盘 ticket、SQLite 中的决策/审计/复盘数据

### 2.1 Prompt 层（AI 被要求做什么）

| Prompt | 角色与任务 | 可自主决定 | 必须人批 |
|---|---|---|---|
| control agent（现有 `agents/control.md`，扩展） | 群内中文答复；提醒规则的自然语言 CRUD | 回复内容、规则解析 | 高风险工具调用 |
| 新闻研究 prompt（R3 新增） | 围绕持仓/标的池/宏观主题检索-整理-分析，输出结构化 JSON | 检索词、来源取舍（预算内） | 无（产物过确定性质量门） |
| 报告叙事 prompt（R5 新增） | 基于事实表 JSON 写中文叙事与观点，禁止编造数字 | 叙事结构与措辞 | 无（数字过比对校验） |
| 提案 prompt（R6 新增） | 基于分析+快照生成 0-2 条结构化开仓提案 | 提案内容；**0 条是合法输出** | **每一笔执行** |

### 2.2 Context 层（AI 需要知道什么，真源规则）

- 交易事实真源：SQLite（`runtime/trading.sqlite`）；Markdown/上下文仅为报告材料——沿用现行宪法。
- 报告数字真源：确定性脚本产出的**事实表 JSON**（R5）；LLM 叙事只允许引用其中的值。
- 新闻入场规则：任何信息必须带 URL 证据，无 URL 一律丢弃（R3）。
- 方法论沉淀：`knowledge/notes/stock-trading-notes/`（分析模板、日报清单、复盘结论——复盘结论经人审后才入库）。
- 排除项：飞书群闲聊历史不进报告管线；凭据/token 不进任何 prompt。

### 2.3 Harness 层（在哪里、被允许做什么）

- 运行环境：Mac mini（macOS，launchd 守护 + OpenClaw cron runner），全链路仅出站连接，无公网监听面。
- 工具面：长桥 CLI 包装脚本（限速与审计边界内）、RSSHub（本机 Docker）、Finnhub API、OpenClaw web search、Cloudflare Tunnel（cloudflared）、飞书长连接（监听进程全局唯一）。
- **权限分层**：
  - read-only：拉行情/快照/新闻。
  - draft：生成报告草稿、提案卡（未发送）。
  - local-write：写 HTML/SQLite/日志。
  - external-tool：飞书发卡（受频控与每日封顶）、站点经 Tunnel 发布（受 Access 登录墙）。
  - **real-world：模拟盘下单——永远人批**（即使是 paper，也按 real-world 层级对待，保持习惯一致）。实盘/期权自动化被宪法永久禁止，不在任何层级。
- **验证梯（每项交付的完成证据，便宜的在前）**：
  1. deterministic：单测通过；质量门数字比对通过；URL HEAD 抽查可达；`/health` 200；doctor `ok:true`。
  2. rule：新闻六要素 schema 校验、中文比例检查、提案 schema 校验。
  3. multi-model：不使用（质量控制以确定性检查为主，避免 LLM 判官被流畅文本欺骗）。
  4. human：下单审批、月度复盘 review、每周一次报告抽查。
- 回滚：报告站点为静态文件（重新生成即回滚）；SQLite 每日备份；launchd 服务可 `bootout` 单独下线。

### 2.4 Loop 层（如何越转越好）

四类循环全部在场，逐一命名：

- **agent loop**：报告生成、新闻研究、提案生成（做事）。
- **verification loop**：质量门失败→重新生成（≤2 次）→仍失败则降级交付并标注（把关）。
- **event-driven loop**：cron 调度、5 分钟轮询、卡片按钮回调、群 @（起动）。
- **hill-climbing loop**：R7 月度复盘——用预测命中率/提醒误报率/决策 vs 基准的数据，反过来改 prompt、阈值、新闻源配置（进化）。

**禁止手段（forbidden means）**：不得伪造/拼凑 URL 以通过质量门；不得为提高提醒触发率而移除活跃度前置条件；不得为「显得有产出」而凑提案数（0 条合法）；不得绕过 broker-executor 直接调券商。

**停止/升级/预算**：
- 新闻检索硬顶：日报 30 次、周报 60 次、L3 每事件 5 次；报告管线总时长 ≤15 分钟。
- 同类失败 3 次→停止重试、降级交付、飞书告警（cron-runner-alerts 已有基础）。
- 飞书卡片全局每日 ≤30 条；单规则冷却 60 分钟。
- 提案熔断：模拟盘周亏 >3% → 暂停新提案一周。

**可观测性（每次运行记录）**：运行时间、读取的输入、执行的动作、判断依据、失败步骤、重试次数、token/调用成本、最终证据（报告 URL / 卡片 message_id / ticket id）。落在 cron runner state + SQLite 运行日志表。

### 2.5 人工判断门

1. 每一笔模拟盘下单（卡片审批，24h 超时作废）。
2. 月度复盘结论写入 knowledge/notes 前的人审。
3. 提醒阈值、新闻源配置、预算参数的变更。
4. 域名/Access 访问策略变更。

**防认知让渡**：每份报告和每条提案必须携带证据（URL、事实表引用）与不确定性标注，「不确定」是一等公民输出——系统给判断材料，不替用户判断。

### 2.6 MCP / Orchestrator / Skill 决定

- **MCP：不需要新建**。飞书收发已有 feishu-user-plugin；检索用 OpenClaw 内置 web search；长桥走既有 CLI 包装。Fallback 全部现成。
- **Orchestrator：不需要独立编排器**。OpenClaw cron runner（已有）承担 staged workflow；报告管线是确定性脚本顺序编排；提案-审批的多角色结构（分析→提案→人批→执行）由「脚本+卡片回调」实现，不引入新运行时。
- **Skill：不需要新 skill**。运维手册写进 `apps/openclaw-config/README.md`。

### 2.7 最小首版与扩展路径

- **最小首版**：R0（点火）+ R4（提醒，纯通知面）——只读+通知，无任何 real-world 写。R6 自始至终在审批门后。
- **扩展路径**：LongPort WebSocket 实时行情（R4 v2）→ 第二行情源冗余 → 复盘驱动的自动调参建议（仍人批）。

### 2.8 Top 3 运行时失败模式与对策（对照 failure-modes）

| 失败模式 | 本系统的具体表现 | 对策 |
|---|---|---|
| 工具失败 | 长桥 CLI 限速/token 过期；RSSHub 源失效；飞书 429 | 既有重试包装（`runLongbridgeJsonWithRetry`）；源级健康检查，单源失效不阻塞管线；429 按建议等待退避；所有写操作前置审批门 |
| 验证失败 | 生成者自己打分；质量门只查格式不查事实；agent 编造来源 | maker-checker：生成脚本≠质量门脚本；数字与事实表逐一比对；URL HEAD 抽查；无 URL 即丢弃 |
| 循环失控/经济失败 | 检索预算爆炸；提醒刷屏；失败无限重试 | 检索硬顶+时长顶；卡片冷却/合并/每日封顶；3 次同类失败降级+告警；「无新输入不产出」（节假日不发报告，已有交易日历） |

---

## 3. 安全宪法约束（不变式，全部需求受其约束）

1. 永不自动提交真实资金订单；实盘流程只停在结构化建议与人工复核。
2. 只有 broker-executor 可将 ticket 转为券商写入；官方模拟盘三件套环境变量缺一不可。
3. OpenClaw 模拟盘预算 ≤ 总仓 10%（服务端新鲜快照校验，不信任调用方）。
4. 期权只作分析因素，永不自动化。
5. 飞书 allowlist；全部群发内容中文。
6. 凭据、token、私钥不入仓、不入 prompt、不入报告。
7. 飞书事件监听进程全局唯一；回调 3 秒内 ack、异步处理。

---

## 4. 详细需求

### R0 运行时点火（硬前置）

**目标**：Mac mini 上恢复全套运行时，所有后续需求的前提。

**行为定义**：
1. `.env.local` 核对（长桥三件套、飞书凭据、`OPENCLAW_GATEWAY_PORT`）。
2. `pnpm install && pnpm build && pnpm test` 全绿。
3. OpenClaw workspace 配置：control agent 挂载 `agents/control.md`，飞书 allowlist 群配置。
4. `pnpm openclaw:cron:install` 注册全部报告/轮询任务；`pnpm launchd:install-system` 安装 gateway + broker-executor 守护（`TARGET_USER=abble` 默认已修正）。
5. cloudflared、RSSHub 守护随 R2/R3 加入同一 launchd 管理面。

**验收标准（全部实测，不接受"代码改完"）**：
- `pnpm openclaw:runtime:doctor` 返回 `ok:true`（gateway 18789 与 cron-runner 18792 监听正常）。
- `curl 127.0.0.1:4312/health` 返回 200 且 `officialPaperExecutionEnabled:true`。
- `~/.openclaw/cron/runs/` 出现调度记录且 runner 消费成功。
- 飞书群 @ 机器人一次，收到中文回复（实测截图）。
- `pnpm longbridge:snapshot` 成功返回模拟盘快照。
- mini 重启后上述全部自动恢复（重启实测一次）。

### R1 报告 HTML 化（PDF 退役）

**目标**：所有报告（日报/周报/个股分析/模拟盘收支/月度复盘）以移动端友好的 HTML 页面为唯一正式载体。

**行为定义**：
1. 新增 `report-html.mjs` 渲染层：输入与现有 `report-rendering.mjs` 相同的 Markdown/数据结构，输出**自包含单文件 HTML**（内联 CSS/JS/数据；禁止外部 CDN——离线可读、不泄漏访问记录）。
2. 设计要求：中文排版（合理字体栈/行距/字号）、响应式（首要场景=手机上从飞书点开）、图表内联渲染（净值曲线、持仓分布、涨跌条形图；用打包进文件的本地图表库或生成 SVG）、报告头含生成时间与数据时间戳。
3. 站点结构：输出到 `runtime/reports-site/`——`index.html`（按日期倒序、按类型筛选的报告列表）+ `daily/<date>.html`、`weekly/<date>.html`、`stock-analysis/<date>.html`、`official-paper/<date>.html`、`review/<month>.html`。每次生成报告后原子更新索引。
4. 投递形态变更：飞书发**摘要卡片 + 「查看完整报告」按钮**（链接到 R2 子域名 URL）。不再发 PDF 附件。
5. PDF 退役：`writeMarkdownPdf` 及依赖标记 deprecated，保留一个版本周期后删除；`reports/` 目录停止新增 PDF（历史 PDF 保留）。Markdown 产物保留（作为 HTML 的源与 git 存档）。

**验收标准**：
- 手机 4G 网络从飞书卡片点开报告 ≤3 秒可读；图表正确渲染；无外部网络请求（浏览器 devtools 验证）。
- 索引页可访问任意历史报告。
- 同一数据渲染 HTML 与 Markdown 内容一致（快照测试）。

### R2 子域名发布（Cloudflare Tunnel + Access）

**目标**：报告站点通过用户子域名安全可达，Mac mini 不暴露任何入站端口。

**行为定义**：
1. 域名迁移：阿里云域名**不转出**，在 Cloudflare 免费版添加站点→核对自动导入的解析记录→在阿里云控制台把 NS 改为 Cloudflare 分配的两个地址（生效最长 24-48h，此步应尽早启动）。
2. Tunnel：mini 上安装 cloudflared，创建 named tunnel，`reports.<domain>` 映射到本机静态文件服务（127.0.0.1 上专用端口，只读、目录列表关闭）；cloudflared 进 launchd 常驻。
3. **访问控制（必须项）**：Cloudflare Access 自托管应用覆盖 `reports.<domain>/*`，策略=邮箱 OTP 白名单（用户邮箱+指定群成员邮箱）；未登录一律 302 到登录页。
4. 报告 URL 规则稳定（`/daily/2026-07-03.html`），供飞书卡片深链与 R4 提醒卡引用。

**验收标准（全部实测）**：
- 手机蜂窝网络访问子域名→OTP 登录→看到报告索引。
- 白名单外邮箱无法通过 Access。
- `nmap` 确认 mini 无新增入站监听；家庭公网 IP 不出现在 DNS 记录中。
- mini 重启后 tunnel 自动恢复（实测）。
- 原域名下其他解析记录迁移后全部正常。

### R3 新闻引擎（三层混合：搜集-整理-分析）

**目标**：日报/周报新闻部分从「英文 RSS+启发式翻译」升级为「多源中文优先、agent 深度参与、证据可审计」。

**行为定义**：

*L1 确定性基线（永远在跑）*：
1. 本机 Docker 部署 RSSHub，接入路由：`/cls/telegraph`（财联社电报）、`/wallstreetcn/live`+`/news`（华尔街见闻）、`/gelonghui/live`（格隆汇快讯）。
2. 接入 Finnhub company news（免费 60 次/分）：每标的近 24h 新闻。
3. 保留现有 Yahoo/Google/Bing RSS 与 Longbridge news。
4. 源级健康检查：单源失败记录并跳过，不阻塞管线。

*L2 agent 主题检索*：
5. OpenClaw 任务：输入=持仓+标的池+L1 素材标题清单；任务=补盲区（每标的至少一轮检索、宏观/行业主题至少两轮）；预算=**日报 ≤30 次、周报 ≤60 次**检索。
6. 输出 schema（每条）：`{title, publisher, url, publishedAt, summary_zh, impact: {direction, affected, reason}, evidence_quote}`。**无 url 的条目直接丢弃。**

*L3 事件深挖（日报默认开启）*：
7. 按影响评分选当日 top 2-3 事件，每事件 ≤5 次检索做多源交叉核实，输出「事件-多源证据-影响分析-不确定性」结构。

*整理与分析*：
8. 跨层去重合并（URL 归一 + 标题相似度），聚类到事件；沿用 `selectDiverseNewsArticles` 的多样性选择。
9. agent 撰写「今日要点」中文分析段：只允许引用事实表与入选新闻条目（按 ID 引用）。
10. 启发式翻译 `translateFinancialHeadlineToChinese` 退役，中文化全部由 agent 完成。

*质量门（扩展 `report-quality.mjs`）*：
11. 校验：六要素齐全、中文占比、来源多样性（≥3 个独立来源且非 Longbridge-only）、L2/L3 条目 URL HEAD 抽查（每报告 ≥5 条）、分析段数字与事实表比对。
12. 失败处理：重新生成 ≤2 次；仍失败→降级为 L1-only 报告并在报告头标注「agent 检索不可用」，同时 runner 告警。

**验收标准**：
- 连续 5 个交易日：新闻条目 ≥60% 来自非 Longbridge 源、≥30% 来自中文源；URL 抽查全可达。
- 质量门单测覆盖全部校验规则；构造坏样本（无 URL/纯英文/数字造假）全部被拦截。
- L2 检索次数、耗时、降级事件出现在运行日志。

### R4 飞书主动提醒

**目标**：盘中异动与持仓风险主动推送，设计对齐富途/TradingView 的实锤范式。

**行为定义**：
1. 新增 `market-alerts.mjs` + SQLite 表：
   - `alert_rules(id, symbol, type, threshold, direction, frequency, hysteresis, enabled, created_by, created_at)`
   - `alert_events(id, rule_id, triggered_at, value, state, message_id)`
2. 四种内置规则与**默认阈值**（每条可单独调整）：
   | 类型 | 默认阈值 | 默认频率 | 附加条件 |
   |---|---|---|---|
   | 持仓日内涨跌 | ±4% | 每日一次 | — |
   | 持仓浮动盈亏 | ±6% | 持续（滞回 1%） | 相对成本价 |
   | 5 分钟急涨急跌 | ±2.5% | 持续（冷却 60min） | 连续 3 个周期有成交（防低流动性误报） |
   | 敞口超预算 | >10% | 持续 | 复用 `buildStrategyReflection` 计算 |
3. 轮询：OpenClaw cron 美股交易时段每 5 分钟一次（交易时段/DST/假日判定复用 `trading-schedule.mjs`），拉取持仓+标的池行情，逐规则评估。
4. 频控与去重：单规则同方向 60 分钟冷却；滞回复位（回落 1% 后才可再触发，TradingView Crossing 语义）；5 分钟窗口内多条合并为一张卡片；每股每类型 ≤10 条规则；**全局每日 ≤30 张提醒卡**；遵守飞书单群 5 QPS。
5. 卡片内容：中文；当前值/阈值/方向/涉及持仓与影响金额；深链到 R1 站点对应页面。
6. 规则管理：群内对 control agent 说自然语言（「NVDA 跌破 800 提醒我」「把特斯拉的提醒关了」）→ agent 调 `market-alerts.mjs` CLI（`list/add/remove/pause`）读写 `alert_rules`。
7. v2 预留：LongPort WebSocket 实时订阅常驻进程替代轮询（本 PRD 只留接口不实现）。

**验收标准**：
- 单测覆盖：四规则触发/滞回/冷却/合并/配额/交易时段判定。
- 实盘时段实测：临时调低阈值制造一次真实触发，收到卡片、深链可开、60 分钟内同规则不重复（实测记录）。
- 连续一周运行：误报（用户主观判定无价值的卡）≤3 张/周，否则回到阈值调整。

### R5 个股分析深化

**目标**：分析报告从「指标拼盘」升级为「数据充分、数字可信、结论结构化」。

**行为定义**：
1. **数据供给扩展**（全部免费源）：Finnhub basic financials（营收/毛利/FCF 增速）与财报日历、Yahoo quoteSummary 分析师目标价共识、FINRA 空头仓位、SEC EDGAR 13F 机构持仓变化。写入每标的**事实表 JSON**（`facts` schema：报价、估值、基本面、目标价、空头、机构、期权链、事件日历；每个值带来源与数据时间）。
2. **叙事与校验**：LLM 按现有 8 段模板写叙事，只允许引用 facts 键值；质量门抽取叙事中所有数字与 facts 比对（容差规则：百分比 ±0.1、价格 ±0.01），比对失败→重生成 ≤2 次→降级为纯事实表报告。
3. **结论框**（每篇报告尾部，结构化 schema）：竞争力判断、合理价值区间（含依据）、**置信度五档**（对齐 Morningstar Low/Medium/High/Very High/Extreme 语义）、当前价格位置、复盘触发条件与日期。
4. **因子卡**：Value/Growth/Profitability/Momentum/Revisions 五因子 A-F 分级（相对同行业），并实现「单因子过差一票否决」规则（对齐 Seeking Alpha）。
5. 预测记录：结论框与多路径概率写入 SQLite（`analysis_predictions` 表），供 R7 复盘。

**验收标准**：
- 3 只代表性标的（大盘股/高波动股/ETF）样例报告全部通过质量门并经用户抽查认可。
- 数字比对单测：构造叙事数字与 facts 不符的样本，全部拦截。
- 每篇报告 facts 覆盖率：8 段模板中 ≥6 段有对应事实表数据支撑（缺数据段落必须显式标注「数据不可得原因」）。

### R6 模拟盘提案-审批

**目标**：把「OpenClaw 自主交易」落成「AI 提案、人批准、机器执行、全程留痕」，定位为决策试验场（研究证据：LLM 自主交易无 alpha）。

**行为定义**：
1. 触发：每交易日收盘后自动一次 + 用户群内主动请求；每次生成 **0-2 条**提案（0 条为合法且常见输出）。
2. 提案 schema：`{symbol, side, qty, orderType, reason(引用 facts 与新闻 ID), invalidation(失效条件), stopLoss, budgetImpact(占 10% 预算比例), confidence}`。
3. 卡片：**新版 `card.action.trigger` 回调（长连接接收；严禁使用旧版"消息卡片回传交互"）**；按钮=批准/拒绝/减半批准；点击后 3 秒内 ack（toast），异步执行；**24 小时无操作自动作废**。
4. 执行：批准→POST `broker-executor /v1/tickets`——现有全部护栏原样生效（paper 三件套环境、10% 服务端校验、股票/ETF only、期权/实盘/shadow 拒绝）。
5. 决策日志：`proposals` 表（payload、status、decided_at、ticket_id、执行结果、事后 outcome 字段供 R7 回填）。
6. **熔断**：模拟盘周亏 >3%（相对周初净值）→ 自动暂停新提案一周，飞书告知。

**验收标准（官方模拟盘实测）**：
- 全链路三笔实测：①1 股 ETF 提案→批准→成交→审计日志完整；②一笔拒绝→无任何券商调用；③一笔 24h 超时→自动作废。
- 未批准状态下任何路径无法触达 broker-executor（代码审查+测试）。
- 熔断单测 + 用历史快照回放验证阈值计算。

### R7 复盘飞轮

**目标**：让系统「越用越准」有数据依据——hill-climbing 循环的实体。

**行为定义**：
1. 每月第一个周末 cron 生成**月度复盘 HTML 报告**：
   - 个股预测复盘：`analysis_predictions` 中到期的多路径预测 vs 实际走势，按方向命中/置信度校准打分。
   - 决策复盘：`proposals` 已执行提案的收益 vs 同期 Buy-and-Hold 基准；拒绝提案的假想收益（诚实呈现，防事后美化）。
   - 提醒质量：触发数、用户反馈的误报数、冷却/合并生效统计。
2. 报告尾部输出「本月改进建议」（阈值/prompt/新闻源调整建议）——**建议 only，变更须人批**（人工判断门 #3）。
3. 经用户确认的复盘结论写入 `knowledge/notes/stock-trading-notes/review-<month>.md`。

**验收标准**：
- **确定性检查（第一道）**：复盘报告中每项指标（命中率、收益对比、误报率）可由独立校验脚本从 SQLite 原始记录回算，与报告数值逐一比对通过（单测覆盖）。
- 首月报告生成，指标口径经用户确认（第二道，人工）。
- 复盘数据全部可溯源到 SQLite 原始记录（抽查 3 项）。

---

## 5. 推荐实施顺序（无分期，一次排完；→ 表依赖）

```
R0 点火 ──┬─→ R2 域名/Tunnel（NS 迁移有 24-48h 传播期，最早启动）
          ├─→ R4 提醒 v1（独立、见效最快，先让系统"有存在感"）
          └─→ R1 HTML 渲染 ──→ R3 新闻引擎 ──→ R5 分析深化 ──→ R6 提案-审批 ──→ R7 复盘
                （R1 是 R3-R7 呈现地基；R6 复用 R4 的卡片交互与 R5 的分析；R7 吃全部数据）
```

即：**R0 → R2(启动 NS 迁移) → R4 → R1 → R3 → R5 → R6 → R7**，其中 R2 的收尾（Access 配置与实测）在 R1 产出第一份 HTML 报告时合拢。

## 6. 遗留决定与假设（已与用户确认）

| 事项 | 决定 |
|---|---|
| 承重假设 | Mac mini 为唯一节点，美股时段在线；离线=提醒停发+站点不可访问，用户接受此单点风险 |
| 域名 | 用户现有阿里云域名，NS 迁 Cloudflare（不转出注册商） |
| PDF | 退役（保留历史文件与一个版本周期的代码） |
| 检索预算 | 日报 30 / 周报 60 / L3 每事件 5 次 |
| 提醒阈值 | 4% / 6% / 2.5%（比调研建议值收紧一档） |
| 众安 | 无开放 API，排除 |
| 第二券商行情冗余 | 延后，不在 v2 |

## 7. 试运行（设计一致性推演，Trial mode: design-consistency dry-run）

> 运行时尚未点火，以下为纸面推演，验证设计闭环，不承诺未实现能力。

**场景：2026-07-06（周一）**
- 20:00 cron 触发周报：L1 拉取 RSSHub 中文源+Finnhub → L2 agent 执行 47 次检索（≤60 预算内）→ L3 对「联储纪要」「NVDA 财报前瞻」两事件深挖 → 质量门通过（来源 5 家、URL 抽查 6/6 可达、数字比对 0 失败）→ 生成 `weekly/2026-07-06.html` 并更新索引 → 飞书卡片送达，用户手机点开子域名（OTP 已记住会话）阅读。
- 21:30 美股开盘；21:35 起每 5 分钟轮询。22:10 NVDA 自开盘 -4.3% 命中「持仓日内 ±4%」→ 该 5 分钟窗口内 QQQ -2.1% 未达阈值不并卡 → 发出 1 张卡片（含影响金额、深链），当日该规则不再触发（每日一次档）。
- 22:15 敞口 9.7% 未超限，无卡。
- 04:05 收盘后提案 job：分析结论中性 → **生成 0 条提案**（合法输出），运行日志记录判断依据。
- 假设与限制：L2 质量依赖 OpenClaw web search 工具的实际可用性与配额（点火后才能实测）；Access 会话时长需实测调优；本推演未覆盖长桥 CLI 限速边界。

---

*本 PRD 待用户审批；审批前不进入实现。*
