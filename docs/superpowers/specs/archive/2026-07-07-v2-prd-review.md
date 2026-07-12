# AlphaLoop v2 PRD 评审报告

- 日期：2026-07-07
- 评审对象：`docs/superpowers/specs/2026-07-03-v2-product-iteration-prd.md`
- 方法：45 个子 agent 的三阶段 workflow——7 名读者深读全部子系统 → 4 个维度（可行性 / 过度设计 / 遗漏 / 安全）评审 PRD → 42 条 blocker/major 发现逐条对照代码对抗验证（39 条确认、3 条证伪）
- 结论性质：本文是决策材料，不改动 PRD 本身；修订待用户拍板后统一进行

---

## 0. 总体结论

PRD 的骨架是扎实的：四层框架完整、宪法真实存在（AGENTS.md）、验收文化正确（实测-only）、R6 执行护栏的全部断言经实读核实为真（paper 三件套、服务端 10% 新鲜快照校验、equity-only、live/option/shadow 硬拒、完整审计——见附录 A）。**方向不需要推翻。**

但按原文直接开工会踩三类坑：

1. **三块共享地基没有归属**：交互卡片能力、SQLite 迁移/备份/运行日志、静态文件服务器——R1/R4/R6/R7 都依赖它们，但不属于任何 R 的行为定义。
2. **若干"已有基础"实际不存在或语义不同**：`.env.local` 不存在（迁移后丢失）、"同类失败 3 次停止"与现有无限重试状态机直接矛盾、5 分钟轮询不适配现有 cron→runner 链路、交易日历只有 2026 年。
3. **"审批不可绕过"目前是 prompt 级而非代码级**：broker-executor `/v1/tickets` 无鉴权、无提案关联；卡片点击者身份校验未提；新闻注入面无对策。

另有一条重要的**反向修正**（评审者被证伪）：R6 卡片回调不是重大未知——本机安装的 OpenClaw 2026.5.28 原生处理 `card.action.trigger`（见 §1）。

---

## 1. 被证伪的"最大风险"：R6 卡片回调有现成路径

评审的 4 条 R6 相关 blocker 中，3 条断言"卡片回调链路完全未验证、可能违反宪法 #7"。对抗验证**证伪**了这一前提：

- 本机 `/opt/homebrew/lib/node_modules/openclaw`（openclaw@2026.5.28）在唯一飞书 WebSocket 的事件表中**原生注册了 `card.action.trigger` 处理器**（`monitor.account-*.js:5300`）。
- 按钮点击经 `handleFeishuCardAction → dispatchSyntheticCommand → handleFeishuMessage`，即**卡片按钮的 `action.value`（文本/命令）会被转成合成消息，注入与群 @ 完全相同的 control agent 管线**——按钮 value 填 `批准 P-123` 与用户手打 `批准 P-123` 走同一条 dispatch 路径。
- OpenClaw 还自带结构化审批卡语义（`ocf1` 信封）：token 去重、过期失效（stale）、**绑定点击用户（wrong_user 拒绝）**、绑定会话、异步 ack。

**结论**：无需第二条 WS 监听，宪法 #7 不冲突；R6 仓库侧新增量收敛为：发卡（能力待建，见 §3.1）+ proposals 表 + 审批 CLI + 24h 清扫器。残余未知仅两点，点火后几分钟可验：①飞书开发者后台是否已订阅卡片回调事件；②`requireMention:true` 是否拦截合成消息。建议列为 R0 后的第一个冒烟测试，而非 R6 的前置 spike。

---

## 2. PRD 对现状的不实/过时断言（全部经代码核实）

| # | PRD 断言 | 实际情况 | 影响 |
|---|---|---|---|
| 1 | 「.env.local 核对」（R0.1） | 文件不存在，也无 `.env.local.example` 模板；实为**从零重建**，凭据需从旧机/密码库找回 | R0 最耗时步骤被一笔带过 |
| 2 | 「同类失败 3 次→停止重试（cron-runner-alerts 已有基础）」（2.4） | 现状是**无限重试**（退避封顶 30 分钟、无次数上限，`openclaw-cron-runner-state.mjs:24-46`），告警在第 1 次即发；"同类"未定义、无 R 负责 | Loop 层核心安全承诺无人实现 |
| 3 | 「OpenClaw cron 每 5 分钟轮询」（R4.3） | 现有链路每次 cron 触发都注入 agent 会话事件（≈78 次/日）、runKey 缓存 1000 条约两周溢出重放、故障时每 5 分钟一张告警卡、子进程超时按 15-20 分钟设定 | R4 需改走 launchd StartInterval 模式（已有 official-paper 小时轮询先例） |
| 4 | 「交易时段/假日判定复用 trading-schedule.mjs」（R4.3） | 假日表**只有 2026 年**（`trading-schedule.mjs:12-27`），无年份越界保护，2027-01-01 起假日按交易日处理 | 常驻设施跨年静默出错 |
| 5 | 「注册全部报告/轮询任务」（R0.4） | `openclaw:cron:install` 只装 3 个报告任务；**每小时 official-paper 快照是 `launchd:install-user` 装的，R0 未列**——而 10% 服务端校验要求快照 ≤90 分钟，缺了它所有 paper 买单被硬拒，R4 敞口规则、R6 熔断也无数据 | R0 验收清单缺关键一项 |
| 6 | 「保留现有 Yahoo/Google/Bing RSS」（R3.3） | Bing 抓取器不存在（只有显示名映射）；现有 4 源为 Longbridge/Yahoo search/Yahoo RSS/Google News | 措辞修正 |
| 7 | 「SQLite 运行日志表」（2.4） | 不存在；run 记录是散落 JSON 文件（仅 timing/exit/stdio tail）；token 成本从 OpenClaw 外部运行时**可能根本拿不到** | R3 验收依赖不存在的表 |
| 8 | 「SQLite 每日备份」（2.3 回滚） | 全仓零备份代码；WAL 模式正确备份需 `VACUUM INTO`，不能直接 cp | 复盘/审计真源无保护 |
| 9 | 「复用 buildStrategyReflection」（R4.2） | 函数存在但是 `official-paper-monitor.mjs` 内未导出的私有函数，需先抽提 | 小重构，列任务即可 |
| 10 | 宪法引用 | 条款 7（监听唯一+3 秒 ack）在任何现有文档中**不存在**（PRD 新引入）；条款 3 的 10% 不在 AGENTS.md；AGENTS.md:10 期权白名单与「期权永不自动化」冲突、AGENTS.md:8 引用已废弃的 Honcho | 需要一次宪法文档同步 |

另确认：PRD 引用为真的关键地基见附录 A，可放心承重。

---

## 3. 缺失的三块共享地基（建议立为 F0 前置工作项）

### 3.1 F-A 飞书交互卡片能力
`notifications.ts` 只会发 `text/post/file`，**全仓从未发过 interactive 卡片**；发送路径丢弃 MCP 返回详情拿不到 `message_id`；`update_message` 从未接线。而 R1 摘要卡按钮、R4 提醒卡、R6 审批卡、R6 决策后更新卡片**全部依赖它**。
→ 立项：`sendInteractiveCard`（含 message_id 回传）+ `updateCard`；点火后先实测一张带按钮的卡。

### 3.2 F-B SQLite 治理（迁移 + 备份 + 运行日志）
v2 新增 5 张表（alert_rules、alert_events、analysis_predictions、proposals、run_log）+ outcome 回填列。现状：`migrate()` 只有 `CREATE TABLE IF NOT EXISTS`、无 `user_version` 版本化、无法表达加列；另有 3 处脚本自建 DDL（漂移风险）。
→ 立项：所有新表集中进 shared-types `migrate()` + `PRAGMA user_version` 分步迁移 + 禁止脚本自建表；每日 launchd `VACUUM INTO` 备份（保留 N 天 + 一次恢复演练验收）；run_log 表（token 成本降级为调用次数）。

### 3.3 F-C 报告站点静态文件服务器
PRD 只写「本机静态文件服务」，仓库无任何静态服务器，cloudflared 不能直接伺服目录。
→ 立项：~100 行只读 node 服务（禁目录列表、拒非法路径、缓存头）+ launchd plist + doctor 检查；索引「原子更新」定义为 write-temp + rename。

---

## 4. 建议砍掉 / 缩小的功能（over-design，全部经确认）

| 项 | 原 PRD | 建议 | 理由 |
|---|---|---|---|
| R5.4 五因子 A-F 同业分级 | Value/Growth/Profitability/Momentum/Revisions 相对同行业 + 一票否决 | **砍掉 v1**；改为已抓数据的绝对值启发标签（无字母级、无否决） | 无同业数据源；同业面板需拉全行业基本面，免费配额撑不住；这是把零售研究产品移植进单人工具 |
| R5.1 EDGAR 13F | 「免费源」之一 | **砍掉 v1**（facts 键置空+「数据不可得」标注） | 13F 按机构（filer）申报而非按标的，需批量解析数千份季报；数据滞后至 4.5 个月，对短线决策近零价值 |
| R5.3 置信度五档 | Morningstar 五档 | **降为三档**（schema 留扩展） | 每月约 10-20 条到期预测摊到五档=每档 2-4 样本，R7 校准到 2027 年都是噪声；五档是假精度 |
| R3 L3 事件深挖 | 日报默认开 | **先周报 only**（日报加开关默认关），观察 2-3 周后再开 | 30 次 L2 + 15 次 L3 检索最挤压 ≤15 分钟管线预算；L3 是零先例的最新层，不该放最高频档 |
| R4 v1 规则集 | 四规则 + 5 分钟轮询一步到位 | **v1 = 日内涨跌 + 浮动盈亏**，走 15-30 分钟 launchd 轮询（复制 official-paper 已验证模式）；5 分钟急涨急跌 + 敞口规则为 R4.1 增量 | 只有急涨急跌规则需要 5 分钟节奏；先证明提醒通道有价值再上高频（§2 表 #3 的四个坑也随之避开） |
| R4 规则配额 | 每股每类型 ≤10 条 | 改为全局 sanity 上限（如 50 条） | 多用户产品残留；NL CRUD 本身**不是**过度设计（确认保留：手机上飞书改规则 + CLI 反正要建） |
| R1 索引与图表 | 类型筛选 + 三类图表 | 静态分组列表（零 JS）；图表 v1 只做净值 SVG 曲线 + 持仓表格 | 单读者经深链到达；SVG 无 JS 依赖、体积可控，保住 4G ≤3 秒验收（ECharts 全量内联约 1MB/份） |
| R6 提案节奏 | 每交易日收盘后 cron | **先 on-demand**，三笔验收实测通过后再开每日 cron | PRD 自己承认无 alpha、0 条是常见输出；避免凌晨 4 点空转 job 污染首月运行日志 |
| R7 拒绝提案反事实 | 「假想收益」 | 定义为**朴素 mark-to-market**（提案价→复盘日收盘价）+ 固定免责声明 | 严谨模拟需要止损/失效路径回放语义，无人定义且样本个位数；口径不定死会让独立校验验收打架 |
| 2.4 可观测性 | token/调用成本入 SQLite | 扩展现有 JSON run 记录（检索次数、降级事件、证据 ID）；成本字段降为调用次数 | OpenClaw 外部运行时的 token 用量可能拿不到；先实测有无接口 |

---

## 5. 必须补的设计点（gaps，全部经确认）

1. **R3↔R5 依赖倒置**：R3 质量门要"数字与事实表比对"，但事实表 schema 在 R5 才建，实施顺序 R3 在前。→ 把「日报级最小事实表」（行情/持仓/宏观数字）提前为 R3 的一部分，R5 再扩展为个股 facts。
2. **R4 运行时状态持久化**：滞回臂位、冷却、每日一次标记、全局 30 张配额都要跨进程/跨重启成立，PRD 表设计全部缺列。→ 新增 alert 运行时状态表（armed、last_triggered_at、cooldown_until、daily_fire_count），跨日重置按**美东交易日**。
3. **标的池唯一真源**：三个互相矛盾的候选（SQLite `stock_analysis_targets` / 长桥 watchlist / notes 承诺的目录）。→ 建议定为 `stock_analysis_targets`，R4 规则 symbol 必须 ∈ 池 ∪ 持仓，并给池子大小上限（配额推算依据）。
4. **RSSHub 恢复与冗余**：Docker Desktop 容器不是 launchd 服务，重启恢复依赖登录会话；「≥30% 中文源」验收全押在 cls/wallstreetcn/gelonghui 三条历史上常失效的路由上。→ launchd 包一层 `docker start` 或改 colima；加第二中文源冗余；doctor 加容器健康检查。
5. **失败处理状态机**：定义"同类"（job + 错误类别）、3 次后置 halted 需人工复位、告警第 1 次提示 + 第 3 次升级。列为具名工作项。
6. **R6 状态机细节**：24h 作废清扫器归属（并入小时级轮询）、清扫与点击的竞态裁决、熔断暂停态落 SQLite 单行状态表、作废/熔断更新原卡片。
7. **交易日历跨年**：查询超出覆盖年份即 fail-loud + 告警；「每年更新假日表」入运维手册；收盘后任务用「固定北京时间跑 + 脚本内校验美股已收盘」模式。
8. **飞书测试替身**：回调 handler 接受注入的事件 JSON fixture；发卡抽象可 stub 的 transport；「回调→提案状态迁移→ticket 生成」做成纯函数可单测——否则 R6 每次改动都要真人手点回归。
9. **R1 连带清理**：PDF 退役需同步修订 4 处文档（2026-06-14 spec、两个 README、control.md）+ `stock-analysis.mjs:129` 调用点，否则 control agent 按旧口径应答。
10. **死包清理**：live-advisor/event-bus/event-ingestor/paper-trader + context-builder 的 dist/node_modules 残留会误导读代码的 agent。→ v2 首个 PR 顺带删除；R6 设计前翻一遍 `git show f2984a5^` 的 live-advisor 审批学习实现作参考。
11. **验收时间线声明**：R3 连续 5 交易日、R4 一周误报观察、R7 首月——代码完成 ≠ 验收完成；R6 第①笔「成交」改为可控条件（贴价限价 + 成交或撤单重试）。
12. **R7 误报反馈通道**：alert_events 加一个 nullable feedback 列，用户对 control agent 说「这条提醒没用」即标记——否则 R4 误报验收与 R7 提醒质量指标都无法计算。

---

## 6. 安全必改清单（全部 CONFIRMED）

| # | 风险 | 现状证据 | 修法 |
|---|---|---|---|
| S1 | **审批可绕过**：`/v1/tickets` 无鉴权、无提案关联；control agent 有无沙箱 shell（sandbox off + approve-all），一条 curl 即达执行 | `broker-executor/src/index.ts:110-187`；`render-openclaw-config.mjs:100,188` | broker-executor 服务端校验：ticket 必须携带 proposal_id，查 proposals 表 status='approved' 且未消费（原子标记）；外加 `/v1/tickets` 共享密钥头。无对应提案的 ticket 拒绝 + 飞书告警 |
| S2 | **点击者身份**：群内任何成员可点「批准」 | PRD:269 无身份校验；allowlist 只覆盖消息 | 审批卡 **DM 发给 owner**（不发群）+ 回调校验 operator open_id == OWNER_OPEN_ID + 按 proposal_id 幂等；优先用 OpenClaw ocf1 信封自带的绑定用户能力 |
| S3 | **规则 CRUD 越权**：任何 allowlist 成员可删 owner 的风控提醒 / 刷爆 30 张配额（提醒 DoS） | `render-openclaw-config.mjs:45-56` 只有群级门 | `market-alerts.mjs` CLI 加 `--actor <open_id>`，add/remove/pause 强制 actor==owner（确定性层校验，不靠 prompt）；非 owner 只读 |
| S4 | **注入面**：新闻正文是攻击者可控输入，流入分析叙事与 R6 提案理由；质量门只查事实/格式，不防指令注入；现 control agent 无沙箱 | PRD:65-69,211-213 全是事实校验 | L2/L3 检索跑在**专用受限 agent profile**（仅 web search + HTTP fetch，无 shell、无文件写、无 MCP）；取回内容以数据定界符包裹；新闻文本永不参与选择/参数化工具调用；人批门为硬后盾 |
| S5 | **存储型 XSS**：新 report-html.mjs 渲染 agent 产出的标题/摘要/URL；一条恶意标题=Access 会话内执行 | 现有 `escapeHtml`（`report-rendering.mjs:315-321`）是安全先例 | 新渲染器继承 escapeHtml 纪律（含属性/URL 上下文，拒非 http(s) href）+ 严格内联 CSP；agent 输出永不作原始 HTML |
| S6 | **凭据泄漏进公开报告**：fetch 错误串含完整 URL（可能带 `?token=`），现有降级模式把错误串写进报告文本，R1/R2 后报告上公网 | `stock-analysis.mjs:695` | Finnhub key 走 `X-Finnhub-Token` 头；报告文本方向的错误串统一过脱敏（复用 broker-executor redaction helpers）；单测覆盖 |
| S7 | **本机第三方进程**：R3 加 Docker 容器、R2 加 tunnel，扩大了对无鉴权 loopback 端点的信任面 | `/v1/tickets` 信任一切 localhost | S1 的密钥头顺带覆盖；RSSHub 容器仅绑 127.0.0.1；tunnel ingress 只映射 reports 子域 + deny 兜底 |
| S8 | **手动下单脚本定位**：`submit-official-paper-equity-order.mjs` 直接 POST /v1/tickets，control.md 明确授权 agent 在用户口头指示下使用——它本身就是"未批准触达路径" | `control.md:14-15` | 需用户决策：改走提案流（保留審批一致性）或保留但改验收措辞为「无审批记录的自动路径不可触达」 |
| S9 | **Access 残余风险** | OTP 单因素；会话默认可长达数周 | 显式设定会话时长；白名单先 owner-only 起步；文档写明"成员邮箱安全=报告保密性" |

---

## 7. 修订后的实施顺序建议

```
R0 点火（补 launchd:install-user、.env.local 重建清单、密钥清单）
 ├─→ 冒烟测试①：feishu-user-plugin 发一张带按钮的 interactive 卡（验 F-A 可行性 + OpenClaw 卡片回调透传）
 ├─→ R2 NS 迁移启动（24-48h 传播期，最早挂起）
 ├─→ F-B SQLite 治理（迁移框架 + 备份 + run_log）
 └─→ F-A 交互卡片能力（sendInteractiveCard + message_id + updateCard）
      └─→ R4 v1（两规则、15-30 分钟 launchd 轮询、状态持久化表、owner-only CRUD）
R1 HTML 渲染 + F-C 静态服务器 ──→ R2 收尾（Access 策略 + 实测合拢）
R1 ──→ R3（L1 中文源 + L2 预算检索 + 日报级最小事实表 + 质量门扩展；L3 周报 only）
R3 ──→ R5（个股 facts 扩展 + LLM 叙事 + 数字比对 + 三档结论框 + analysis_predictions）
R5 + F-A ──→ R6（proposals 表 + on-demand 提案 + ocf1 审批卡 + S1/S2 服务端强化 + 熔断状态机）
R6 ──→ R7（月度复盘 + 误报反馈列 + mark-to-market 反事实口径）
全程伴随：宪法文档同步（AGENTS.md 更新）、死包清理、R1 连带文档修订
```

与原 PRD 顺序的差异：R4 提前依赖 F-A/F-B 而非裸奔；R2 收尾与 R1 合拢不变；新增三个 F 前置项与两个冒烟测试。

---

## 8. 待用户决策项

1. **R6 审批形态**：直接做 ocf1 卡片按钮（有原生路径，增量小），还是 v1 先文本回复审批、按钮作增量？
2. **R2 访问控制**：保留 Access OTP（会话拉长 + 验收改「已登录会话 ≤3 秒」+ 白名单先 owner-only），还是 v1 先 Tunnel + 不可猜路径、Access 后置？
3. **瘦身清单**（§4）是否整体接受？（逐项可谈）
4. **S8 手动下单脚本**：并入提案流，还是保留旁路 + 收窄验收措辞？
5. **宪法归一**：以「期权永不自动化」为准更新 AGENTS.md（删 v1 期权白名单、补 10% 与监听条款、删 Honcho 引用）？

---

## 附录 A：经实读核实为真的 PRD 断言（可承重地基）

- `TARGET_USER=abble` 默认已修正（`install-system-daemons.sh:5`）
- `runLongbridgeJsonWithRetry` 存在（`_longbridge.mjs:39`）
- `report-quality.mjs` 存在且为可扩展的确定性质量门（PRD 对"只查格式"认知正确）
- `selectDiverseNewsArticles` 存在可复用（`report-news.mjs:98`）
- SQLite 真源路径与 §2.2 一致（`runtime.ts:21-22`；schema `database.ts:37-127`；文件待 R0 重建）
- 8 段个股模板存在（`stock-analysis-template.mjs:7-72`）
- R6.4 全部执行护栏属实且服务端强制：paper 三件套（`longbridge-paper.ts:250-266`）、10% 新鲜快照校验（`risk.ts:33-51`）、equity-only、live/option/shadow 硬拒（`execution-guards.ts:3-26`）、完整审计（`index.ts:150-171`）
- 飞书 allowlist 已实现（`render-openclaw-config.mjs:44-45,135-155`）；OpenClaw 网关单进程持有唯一 WS（宪法 #7 现状即满足）
- 实测-only 验收整体可执行（全部 pnpm 入口存在），但注意 §5.11 的验收时间线

## 附录 B：数据与方法

- Workflow run：`wf_0c69ee25-91b`（45 agents，约 172 万 tokens，506+94 次工具调用）
- 逐 agent 结果：会话 `subagents/workflows/wf_0c69ee25-91b/journal.jsonl`
- 68 条去重发现全文与 7 份子系统报告：见会话工件（tool-results/bwote6zw7.txt、bpv0ns3ha.txt）
