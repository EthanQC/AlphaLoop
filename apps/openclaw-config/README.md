# OpenClaw Configuration

这里保留 OpenClaw 和飞书所需的最小配置。

## 保留内容

- `config/openclaw.example.json5`：单 control agent + Feishu allowlist 模板。
- `agents/control.md`：群聊 @ 回复、日报/周报、个股分析、官方模拟盘的中文操作边界。
- `scripts/scheduled-report.mjs`：日报/周报生成与飞书 PDF + 摘要卡片投递。
- `scripts/stock-analysis.mjs`：用户指定标的后的三日一次个股分析。
- `scripts/official-paper-monitor.mjs`：长桥官方模拟盘盘中轮询和开盘后收支变化表。
- `scripts/submit-official-paper-equity-order.mjs`：通过 `broker-executor` 提交官方模拟盘股票/ETF ticket。
- `scripts/feishu-context.mjs`：飞书群上下文入库和 @ 回复提示注入。
- `scripts/install-user-schedules.mjs`：安装用户级 launchd 调度（日报/周报/个股分析/官方模拟盘轮询）。
- `scripts/install-launchd.sh`：安装每日数据库备份 + 市场提醒（market-alerts）轮询器 + platform-app 常驻服务 + rsshub 容器启动这四个 launchd 任务（`com.alphaloop.daily-backup` / `com.alphaloop.market-alerts` / `com.alphaloop.platform-app` / `com.alphaloop.rsshub`），并顺带跑一次 `openclaw gateway install`。
- `scripts/members.mjs`：platform-app 身份层的成员/token 管理 CLI（`add`/`list`/`revoke`/`token issue`/`token revoke`）。

## Feishu

报告投递固定为：

- 第一条：中文摘要卡片。
- 第二条：PDF 文件。
- 不发送完整正文到群里。

刷新 user-plugin OAuth：

```bash
pnpm feishu:user-plugin:oauth
pnpm feishu:user-plugin:status
```

渲染 OpenClaw 配置：

```bash
node apps/openclaw-config/scripts/render-openclaw-config.mjs
```

## Longbridge Official Paper

官方模拟盘自动化必须同时满足：

```bash
LONGBRIDGE_ACCOUNT_MODE=paper
LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true
ALLOW_LIVE_EXECUTION=false
```

盘中轮询和开盘后收支表：

```bash
pnpm official-paper:poll
pnpm official-paper:pnl
```

## Launchd

`launchd:install-user` 和 `launchd:install-backup-alerts` 安装的是两组完全不重叠的 launchd 任务，都只在各自文档里出现过一次——正式部署机上两条命令通常都要跑一遍；只跑其中一条会漏装另一半（例如只跑 `launchd:install-user` 的机器盘中就没有官方模拟盘轮询，也没有每日备份/提醒器轮询）。这里没有把两者合并成一条命令：它们面向的部署场景不完全相同（例如只需要官方模拟盘轮询的轻量机器，未必需要 `install-launchd.sh` 顺带执行的 `openclaw gateway install`），合并会让 `launchd:install-user` 悄悄多做事，也会让不想装 gateway 的场景失去单独跳过的办法。

```bash
# 官方模拟盘每小时轮询 + 开盘后收支变化表
pnpm launchd:install-user

# 每日交易数据库备份 + 市场提醒（market-alerts）轮询器
pnpm launchd:install-backup-alerts
```

`launchd:install-user` 安装后只会保留：

- 美股盘中官方模拟盘每小时轮询。
- 美股开盘后 30 分钟官方模拟盘收支变化表。

`launchd:install-backup-alerts` 安装后额外保留：

- 每日交易数据库备份（`com.alphaloop.daily-backup`）。
- 市场提醒轮询器（`com.alphaloop.market-alerts`）。
- platform-app 常驻服务（`com.alphaloop.platform-app`，Phase 3 起）——`KeepAlive`（不是周期任务），启动 `pnpm --filter @apps/platform-app start`，日志写到 `logs/platform-app.log` / `.err.log`。
- rsshub 容器启动包装（`com.alphaloop.rsshub`，Phase 4 起）——`RunAtLoad=true`/`KeepAlive=false`，只跑 `docker start rsshub`（容器本体不由这个任务创建，见下方「新闻引擎」章节），日志写到 `logs/rsshub.log` / `.err.log`。

`pnpm openclaw:runtime:doctor` 会检测这四个任务是否都已通过 `launchctl list` 加载，缺失时给出对应的安装命令提示；另外还会单独探测 platform-app 的 `GET /health`（`platform-app-health` 检查项）和 rsshub 的 `GET /healthz`（`rsshub-health` 检查项，404 时回退 `/`）——开发机没起服务只是 warn，起了但状态码/响应体不对才算 error。

### platform-app（Phase 3 多成员 Web 平台）

起停：

```bash
pnpm platform:dev    # tsx watch 本地开发
pnpm platform:start  # node dist/index.js，launchd 常驻用的就是这条

pnpm launchd:install-backup-alerts   # 顺带安装 com.alphaloop.platform-app
```

成员管理（`scripts/members.mjs`，单行 JSON 输出、错误非零退出）：

```bash
node apps/openclaw-config/scripts/members.mjs add --email a@example.com --name "张三" [--feishu <openId>]
node apps/openclaw-config/scripts/members.mjs list
node apps/openclaw-config/scripts/members.mjs revoke --member <memberId>
node apps/openclaw-config/scripts/members.mjs token issue --member <memberId> --label "my-token"
node apps/openclaw-config/scripts/members.mjs token revoke --token-id <tokenId>
```

`token issue` 打印的明文 token 只出现这一次，之后无法再次查看，请当场保存。

环境变量（默认都指向真实 `runtime/trading.sqlite`，只应在手工验证时改指临时库）：

- `PLATFORM_DB_PATH`：platform-app 进程自己的数据库路径覆盖。
- `MEMBERS_DB_PATH`：`members.mjs` CLI 自己的数据库路径覆盖（与上面是两个独立变量）。
- `PLATFORM_APP_PORT`：platform-app 监听端口，默认 `4314`。

### 新闻引擎（Phase 4）

L1 多源采集（RSSHub 中文源 + Finnhub + 既有 Yahoo/Google/Longbridge）→ 事件聚类 → SQLite 持久化（`news_events` / `news_event_sources`，schema v8）。

环境变量（均可选，见 `.env.local.example`）：

- `FINNHUB_API_KEY`：Finnhub company-news API 鉴权（`X-Finnhub-Token` 请求头）；未设置时 Finnhub 源整体跳过（`sourceHealth.finnhub = 'skipped_no_key'`），不报错、不阻塞报告。
- `RSSHUB_BASE_URL`：本机/自建 RSSHub 实例地址，供财联社电报、华尔街见闻快讯、格隆汇快讯三条中文源路由使用；未设置默认 `http://127.0.0.1:1200`。

本机 RSSHub 容器**不由**任何 launchd 任务创建，只在 P10 首次点火时手动跑一次：

```bash
docker run -d --name rsshub -p 127.0.0.1:1200:1200 diygod/rsshub
```

容器创建后，`com.alphaloop.rsshub` launchd 任务（`launchd:install-backup-alerts` 一并安装）负责在每次机器重启后跑 `docker start rsshub`，确保容器继续常驻——它不创建、不重建容器，容器不存在时这一步会失败（`logs/rsshub.err.log` 里会看到 "No such container"），此时需要回去手动跑一遍上面的 `docker run` 命令。

`pnpm openclaw:runtime:doctor` 覆盖两个新闻引擎检查项：

- `rsshub-health`：GET `${RSSHUB_BASE_URL 或默认值}/healthz`（404 时回退 `/`）——容器不可达只是 warn（点名上面的 P10 命令和 `pnpm launchd:install-backup-alerts`），返回非 200 状态码算 error。
- `news-engine-health`：`news_events` 表最新一条 `last_published_at` 距今超过 48 小时且表内已有数据（非全新库）→ warn「新闻引擎超过 48 小时无新事件」；全新库（0 条事件）不报告。

### 日报/周报/个股分析调度：已迁移到 OpenClaw cron（2026-07-14）

日报（`report.daily.prepare/deliver`）、周报（`report.weekly.prepare/deliver`）和个股分析（`stock-analysis`）这 5 个调度**不再由 `launchd:install-user` 安装**，它们的唯一 owner 是 OpenClaw cron 通道：

```bash
pnpm openclaw:cron:install
```

该命令会：①先 retire 这 5 个 launchd 任务对应的旧 plist（如果存在）；②把等价的 5 个任务注册进 `openclaw cron`；③安装 `com.openclaw.trading.cron-runner` launchd 服务，由它监听 `openclaw cron` 的 run 记录并实际执行这些脚本。详见 `docs/superpowers/specs/2026-06-14-openclaw-report-quality-cron-design.md`。

**历史教训（2026-07-14 存量代码审计）**：这 5 个标签曾经在 `install-user-schedules.mjs` 和 `install-openclaw-cron.mjs` 里各自硬编码一份——先跑 `openclaw:cron:install`（retire 这 5 个 plist、装 cron 等价物），后跑 `launchd:install-user`（原样重装这 5 个 plist）会让它们同时复活：两个通道各自成功，日报/周报/选股每次都双份生成、双份投递飞书。现在两边共享 `scripts/openclaw-report-launchd-jobs.mjs` 里的同一份标签清单：`install-user-schedules.mjs` 不再安装这 5 个任务，且防御性地把它们也 retire 一遍（如果 `openclaw:cron:install` 还没跑过，这一步是 no-op）。**部署顺序**：`openclaw:cron:install` 和 `launchd:install-user` 谁先谁后都安全，且可以任意重跑——不会再互相打架。
