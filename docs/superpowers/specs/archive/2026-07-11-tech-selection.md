# AlphaLoop 技术选型文档

> **⚠ 本文档已被取代**：最新有效版本为同目录《2026-07-12-tech-selection.md》。本文件仅作历史存档（其中未被 r2 推翻的选型仍被 r2 引用沿用）。

- 日期：2026-07-11
- 状态：待用户 review（与《2026-07-11-detailed-requirements.md》配套，产品与技术分开审）
- 定位：宏观架构 + 逐项技术选型 + 可行性结论。每项给出：选择、理由、备选、风险、验证方式。
- 证据基础：本机代码库实测（45 agent 评审）、本机安装的 OpenClaw 2026.5.28 源码考察、本机运行中的 memoryd 实测、四份 Opus 专项调研（2026-07-11）。

---

## 1. 宏观架构

### 1.1 三机拓扑

```
                    ┌────────────────────────────────┐
                    │        Mac mini（服务器）        │
                    │                                │
   飞书云 ◄─WS长连──┤ OpenClaw Gateway（唯一权威）      │
   (唯一监听)       │  ├─ control agent（群对话/回调）  │
                    │  └─ cron → runner → 管线脚本     │
                    │ broker-executor :4312（唯一写券商）│
                    │ trading.sqlite（交易事实唯一真源） │
                    │ memoryd 专用实例（共享策略记忆）    │
                    │ 静态站点服务 :4313（只读，暂定）    │
                    │ RSSHub（Docker，仅回环）          │
                    └───────┬──────────────┬─────────┘
                cloudflared │              │ Tailscale tailnet
                （仅出站）    │              │ （私有网络平面）
                    ┌───────▼──────┐   ┌───▼──────────────────┐
   你和mashu的手机 ──► reports.域名  │   │ 两台 MacBook（工作台）  │
   （Access 登录墙）│  看盘站点      │   │ 各自本地 OpenClaw      │
                    └──────────────┘   │  ├─ 读写共享策略记忆     │
                                       │  └─ 只读交易数据(凭token)│
                                       └──────────────────────┘
```

### 1.2 数据流（两个循环）

**生产循环（每日自动）**：行情/新闻源 → 确定性抓取脚本 → 事实表 JSON + SQLite → agent 检索与叙事（预算内）→ 确定性质量门（数字比对/链接抽查）→ HTML 报告 + 站点刷新 → 飞书摘要卡。

**记忆循环（本次新增）**：策略记忆库 ──注入──► 报告生成/提案生成（策略上下文、纪律检查）──呈现──► 你读报告/批提案 ──反馈──►（审批卡采集、飞书一句话、工作台整理）──写回──► 策略记忆库。

### 1.3 单写者约束（不可分布的东西）

| 资源 | 唯一写者 | 理由 |
|---|---|---|
| 飞书 WebSocket 监听 | mini 的 Gateway | 飞书事件随机推给一个客户端，多监听=丢事件；OpenClaw 官方也是单 Gateway 独占 messaging |
| trading.sqlite | mini 上的管线与 broker-executor | 交易事实唯一真源 |
| 券商接口 | broker-executor | 宪法 |
| cron 调度 | mini | 状态机单点 |
| 策略记忆库写入 | mini 的 memoryd 实例（工作台经它写，不直写文件） | 避免 Milvus Lite 文件锁冲突与合并冲突 |

### 1.4 网络平面（三个，互不重叠）

1. **公网入站：零**。站点经 cloudflared 仅出站隧道发布，ingress 仅映射 reports 子域、其余默认拒绝；Access 白名单（你+mashu）。
2. **私有协作面：Tailscale tailnet**（三台机器）。承载：OpenClaw `gateway.remote` 瘦客户端通道（**工作台对策略记忆与交易数据的读写全部经它**，见 §2.1/§2.2）与 SSH 运维。**memoryd 只绑 mini 本机回环、不对 tailnet 暴露**（其 HTTP 无内建鉴权，不能直连）。
3. **本机回环**：broker-executor、RSSHub、静态服务源端口只绑 127.0.0.1。

---

## 2. 分项选型

### 2.1 多机协作：OpenClaw 单权威 Gateway + 瘦客户端 + 共享记忆层

- **选择**：mini 跑唯一权威 Gateway（独占飞书、交易栈）；两台 MacBook 各跑**自治本地 Gateway**做个人工作；协作靠两条通道——共享策略记忆库（判断性知识）+ `gateway.remote.{url,token}` 受控瘦客户端（MacBook 需要交易数据/驱动 mini 上的 agent 时用，走 tailnet，token 可吊销）。
- **理由**：实测 OpenClaw 2026.5.28 与官方文档确认**不存在多 Gateway 联邦**（"The architecture does not support multiple gateways or federation"）；但 `gateway.remote.*` 配置键在 dist 中完整存在（url/token/password/tlsFingerprint/sshTarget/sshIdentity），是官方支持的远程客户端通道。Node 配对（system.run 级外设）方向相反（会把 MacBook 变成 mini 的"手"），不作主协作模式。
- **隔离 agent 工具面**（owner 校验与只读性的技术载体）：mini 上用 `openclaw agents add` 为你与 mashu 各建一个隔离 agent，工作台经 gateway.remote 只能驱动自己的 agent。该 agent 的工具面**白名单**：策略记忆读写工具（写入时由 agent 身份强制注入 owner，memoryd 本身无租户 ACL，owner 校验在这一层完成）+ 只读交易查询工具（持仓/净值/提案查询）；**无 shell、无文件写、无券商工具**——远程用户不获得 shell 面，与宪法"sandbox off 仅限本机可信边界"兼容。mashu 改你的记录会在工具层被拒（对应需求验收"owner 权限边界测试"）。
- **备选**：纯瘦客户端（MacBook 不跑本地 Gateway）——与"各跑各的 OpenClaw"诉求不符；纯 git 协作——拿不到活数据。均次于混合方案。
- **风险**：gateway 暴露到 tailnet 扩大攻击面（用 token+ACL+指纹 pin 收敛）；`gateway.remote` 语义随版本变化（三机版本锁定一致，升级一起升）。
- **验证**：点火后在 mini 上 `openclaw agents add` 建 mashu 的隔离 agent，从 MacBook 用 `gateway.remote` 实连一次，确认路由与权限隔离符合预期。

### 2.2 策略记忆层：memoryd 专用实例（central on mini）

- **选择**：mini 上跑**第二个 memoryd 实例**，专用数据根（`MEMORYD_DATA_ROOT=~/alphaloop-memory`），与个人记忆完全隔离；固定一个非敏感 scope 作为共享策略池；**只绑本机回环**。
- **读接口**：管线脚本走 CLI 子进程（`memoryd search --json` / `memoryd inject`，带超时 try/catch，fire-and-forget 降级）；mini 上的 agent 走 memoryd 的 OpenClaw 原生插件（memory_search/memory_get 工具 + 注入钩子）；工作台经 gateway.remote 隔离 agent 间接读（§2.1）。
- **写接口**：agent 交互写回（飞书一句话、工作台整理、判断批注）用 `mem_save`——对 decision/playbook/warning 等长期类型它**直接落盘**（实读 memoryd 源码确认，不经待审队列；待审队列只作用于会话捕获路径）。确定性管线的镜像写入（交易批注、复盘结论的自动镜像）用 MCP 工具 `mem_capture_passive`（memoryd 设计上给可信导入器用的通道，经 stdio 子进程调用）——注意 **CLI 没有直接写长期记忆的子命令**（`memoryd capture` 是会话捕获路径，不用于此）；若 MCP 子进程调用延迟不可接受，给 memoryd 加一个写入子命令（你是作者，顺手的事），列入黄灯实测。
- **类型映射**：策略卡→`playbook`；纪律规则→`warning`（全文镜像；**结构化规则在 trading.sqlite 的 discipline_rules 表**，提案纪律检查读表不读记忆，见 §2.5）；个股论点/复盘结论→`decision`；判断批注→`decision`（挂论点 tags）；交易批注镜像→`decision`（tags 带提案编号+标的）；标的写入 tags+triggers（如 `[NVDA, 英伟达]`）供触发式召回；owner 由隔离 agent/采集器强制写入 source+tags。
- **理由**（实测）：memoryd 就是用户自己的系统，本机运行健康（1720 条记忆）；Markdown 真源+SQLite 索引+嵌入式 Milvus Lite（**无 Docker、无外部服务**，磁盘 <3GB 含嵌入模型）；六类记忆类型与记录类型天然对应；官方 fire-and-forget 语义与"记忆挂了不阻塞报告"的需求一致；AlphaLoop 现有 local-context 插件已验证同款集成模式。**注意**：本机实测只覆盖了全文检索——向量索引默认关闭（本机 milvus.db 为空），mini 部署时需显式开启并实测（见 §3.2 黄灯）。
- **专用实例的必要性**：memoryd 的 identity 自学习假设单用户——两人共用+交易内容混进个人记忆会互相污染画像；专用数据根一刀切干净。
- **备选**：MacBook 各跑 memoryd + Markdown 同步（Syncthing）——离线可用但有合并冲突与两人竞写问题，次选；自建 SQLite 策略表——放弃向量检索/知识图谱/衰减治理，等于重造轮子，否决。
- **风险**：memoryd HTTP 无鉴权（对策：只绑回环+工作台经隔离 agent，见 §1.4/§2.1）；headless 运行需要给它配 API key 的 LLM provider（当前 provider=claude-code 依赖交互登录，无人值守下实体抽取会静默降级）；结构化字段（目标价/失效线/纪律执行级别）不适合只存记忆正文——**结构化数值落 trading.sqlite（论点表 + discipline_rules 表），memoryd 存全文与检索**（双层：SQLite=结构化真源与硬检查数据源，memoryd=检索与注入层，与宪法"交易事实真源=SQLite"一致；记忆层降级只影响叙述性上下文，不影响纪律硬检查）。
- **验证**：mini 部署后 `memoryd llm test`；预热嵌入模型；从报告脚本实测一次 inject 延迟（CLI 子进程冷启动如 >2s 则改走常驻 HTTP）。

### 2.3 看盘站点生成：自研轻量静态生成器（不引入框架）

- **选择**：扩展现有 Node 渲染层（report-rendering.mjs 已有自包含 HTML+中文字体栈+markdown→HTML 转换器）为多页静态生成器：每次管线运行后重渲染受影响页面，写临时文件+原子改名。不用 Astro/11ty/Next。
- **理由**：页面全是"数据→模板"的确定性渲染，现有代码已完成 60%；引入框架带来构建链、依赖、升级面，对 5 个页面是负资产；自研生成器与质量门/测试基建同栈（vitest 直接测）。
- **图表**：服务端生成内联 SVG（净值折线+基准参考线+回撤标注、持仓涨跌条形图、仓位分布环图、sparkline），零 JS 图表库——满足"无外部请求+秒开+自包含"。UI 调研确认此模式成熟。
- **交互**：底部 tab=纯链接；目录折叠/滚动高亮/表格横滚用少量原生 JS+CSS（内联，无依赖）。
- **安全**：继承现有 escapeHtml 纪律（属性/URL 上下文、拒非 http(s) href）+严格内联 CSP；AI 产出永不作原始 HTML。
- **备选**：Astro（内容站成熟）——多一整条工具链，两人小站不值。
- **验证**：首页+一份日报的样张在真机（iPhone/Android 各一）实测渲染与加载。

### 2.4 站点服务与发布：只读 Node 静态服务 + cloudflared + Access

- **选择**：~百行只读静态服务（拒目录列表/路径穿越、缓存头、仅绑 127.0.0.1）+ launchd 守护 + doctor 检查；cloudflared named tunnel 仅映射 reports 子域；Cloudflare Access 邮箱 OTP 白名单（你+mashu），会话 30 天。
- **风险与实测点**：飞书 webview 与系统浏览器 cookie 不共享——点火后专项实测，必要时卡片按钮配置跳系统浏览器。NS 迁移 24-48h 生效期，点火后立即启动。

### 2.5 数据库：SQLite 集中迁移 + 每日备份

- **选择**：全部新表（提醒规则/事件/运行时状态、提案、预测、论点结构化表、**discipline_rules 纪律规则表**、运行日志）集中进 shared-types `migrate()`，引入 `PRAGMA user_version` 分步迁移，禁止脚本自建表——清理现有 **4 处**分散 DDL（stock-analysis.mjs、reconcile-official-paper-orders.mjs、official-paper-monitor.mjs、feishu-context.mjs 的 feishu_context_messages，最后一处是 07-07 评审也漏计的）；既有 stock_analysis_targets（标的池真源表）一并纳入 migrate() 治理。
- **备份**：每日 launchd 任务两件事——trading.sqlite 用 `VACUUM INTO`（WAL 模式不能直接 cp）；**memoryd 数据根整目录快照**（tar/rsync；Markdown 是真源、索引可重建）。均保留 30 天；上线前恢复演练覆盖两者。
- **理由**：07-07 评审确认现状无版本化迁移且 DDL 漂移风险真实存在。

### 2.6 提醒引擎：launchd StartInterval 直跑 + 状态落库

- **选择**：`StartInterval≈300s` 的 launchd agent 直跑评估脚本（脚本内交易时段门），**不走 OpenClaw cron→agent 会话链路**；滞回臂位/冷却/每日配额（美东交易日重置）落 SQLite；敞口计算从 official-paper-monitor 抽提共享函数。提醒触发与提案状态变更后，**顺带触发受影响页面（首页/模拟盘页/个股页）的重渲染**，保证站点提醒流水的分钟级时效。
- **理由**：评审证实 OpenClaw cron 链路在 5 分钟频率下有四个结构性坑（每次唤醒 agent 会话 ≈78 次/日、runKey 缓存两周溢出重放、故障告警风暴、超时口径错配）；launchd 模式已有小时级快照先例。
- **交易日历**：假日表年份越界即 fail-loud+告警；年度更新入运维手册。

### 2.7 飞书卡片与回调：OpenClaw 原生 card.action.trigger + ocf1 信封

- **选择**：审批卡与所有按钮卡走 OpenClaw 网关原生的 `card.action.trigger` 处理链（实测 2026.5.28 已内建：按钮点击→合成消息→control agent 管线），审批按钮用 ocf1 结构化信封（绑定点击者/过期/token 去重原生支持）；发卡能力在 notifications.ts 新增 `sendInteractiveCard`（含 message_id 回传）与 `updateCard`。
- **点火后两项冒烟**：飞书后台卡片回调事件订阅；requireMention 对合成消息的放行。
- **审批硬化**（配套）：broker-executor `/v1/tickets` 要求已批准 proposal_id（服务端查表+原子消费）+ 本机服务间共享密钥；手动下单脚本改走提案自批链路。

### 2.8 新闻引擎：RSSHub(Docker 仅回环) + Finnhub + 现有源；聚类复用+扩展

- **选择**：RSSHub 本机 Docker（仅绑 127.0.0.1，launchd 包一层 `docker start` 保证重启恢复，纳入 doctor）；中文源配第二路由冗余；Finnhub 走 `X-Finnhub-Token` 头+滑动窗口限速 wrapper。**事件级聚类是新建能力**：现有 mergeNewsArticles 只做 URL/标题的精确匹配去重（无 URL 归一化、无相似度度量），事件聚类需新建"URL 归一化+标题相似度+事件分组"逻辑，聚类结果同时供报告与站点新闻页——工作量按新建估，不按扩展估。
- **agent 检索隔离**：L2/L3 跑在专用受限 agent 配置（仅搜索+抓取，无 shell），取回内容数据定界符包裹，网页文本永不参与工具调用选择（防注入）。

### 2.9 可观测性与失败处理

- 运行日志表（SQLite）：时间/输入/动作/失败步骤/重试/证据 ID/调用次数（token 用量可取则取）；runner 状态机改造：同类失败（job+错误类别）3 次→halted 需人工复位，告警第 1 次提示第 3 次升级。

### 2.10 Tailscale（新增基础设施）

- **选择**：三台机器加入同一 tailnet。它是 memoryd HTTP（无鉴权）与 gateway.remote 的唯一承载面。免费档（3 用户 100 设备）足够。
- **备选**：SSH 隧道（gateway.remote 原生支持 sshTarget）——可作 Tailscale 故障时的手动后备。
- **风险**：新外部依赖（Tailscale 账号体系）；mashu 需入 tailnet（他只需装客户端登录，一次性 10 分钟）。

---

## 3. 可行性总评

### 3.1 绿灯（已验证，直接开工）

- 交易执行护栏（paper 三件套/10% 服务端校验/期权硬拒/审计）——代码实读确认
- OpenClaw 卡片回调原生支持——dist 源码实证
- memoryd 接口/降级语义/无 Docker 部署——本机运行实测+源码实读（全文检索已实测；向量层见黄灯）
- gateway.remote 瘦客户端通道存在——dist 配置键实证
- 报告管线/质量门可承重——45 agent 评审确认（重试状态机需按 §2.9 改造，不在绿灯内）
- 静态 SVG 图表、底部 tab、事件聚类卡——业界成熟模式

### 3.2 黄灯（点火后必须实测，方案已备好后手）

| 项 | 实测 | 后手 |
|---|---|---|
| 飞书后台卡片事件订阅 + requireMention 放行 | 一张测试卡 | 文本审批（同一管线，按钮 value=文本命令） |
| 飞书 webview 的 Access 会话 | 真机点开 | 卡片跳系统浏览器 |
| feishu-user-plugin 发 interactive 卡+message_id 回传 | 一次发卡 | bot API 直发 |
| memoryd CLI 冷启动延迟 | 计时 | 常驻 MCP 子进程复用 |
| memoryd 向量检索（默认关闭，本机未启用） | mini 上开启 auto_index+预热模型+实测召回 | 全文检索兜底（已实测可用） |
| memoryd 管线写入通道（CLI 无写长期记忆的子命令） | MCP 子进程调 mem_capture_passive 计时 | 给 memoryd 加写入子命令（自家项目） |
| memoryd headless LLM provider | `memoryd llm test` | 配 ANTHROPIC_API_KEY 或 ollama |
| mini 环境现状 | 盘点脚本 | 全新安装流程 |
| OpenClaw web search 配额（L2/L3 预算的前提） | 点火后实测一轮 | 降低预算/换检索源 |
| gateway.remote 实连与 agent 隔离路由 | MacBook 实连一次 | 纯 git+记忆库协作（Pattern B） |

### 3.3 红灯（已知风险与固定缓解）

- **memoryd HTTP 无鉴权** → 只绑 mini 本机回环，永不暴露到任何网络；工作台读写一律经 gateway.remote 隔离 agent（部署脚本强制检查绑定地址）
- **注入面**（新闻内容/记忆内容进 prompt）→ 受限 agent 配置+数据定界符+人批门+质量门
- **单点**（mini）→ 已接受；备份+重启自愈+告警缓解
- **小样本统计自欺** → 代码回算+样本不足标注（产品层已定）
- **凭据泄漏进公开报告** → 密钥走 header+错误信息统一脱敏+单测

## 4. 部署蓝图（mini）

1. 环境盘点脚本（Node/pnpm/OpenClaw 版本、旧 launchd 残留、Docker、Python3.11/uv、Tailscale）→ 输出盘点报告。
2. 基础层：Tailscale 入网 → 凭据重建（.env.local，按密钥清单）→ pnpm install/build/test。
3. 服务层（launchd，全部 RunAtLoad+KeepAlive）：gateway → broker-executor → cron-runner → 静态站点服务 → cloudflared → RSSHub(docker start wrapper) → memoryd 专用实例（开启向量索引、预热嵌入模型、配置 headless LLM provider、确认只绑回环）→ 每日备份任务（trading.sqlite + memoryd 数据根）→ 提醒轮询 agent。
4. 验证层：doctor 全绿（覆盖以上全部）→ 两项冒烟测试 → 重启演练 → 恢复演练。
5. 开发→部署常态：开发与测试在你的 MacBook，git push → mini 拉取 + `pnpm deploy:mini`（安装脚本幂等可重跑）。

---

*本文档与详细需求文档配套，待你 review。*
