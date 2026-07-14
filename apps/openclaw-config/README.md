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
- `scripts/install-launchd.sh`：安装每日数据库备份 + 市场提醒（market-alerts）轮询器这两个 launchd 任务（`com.alphaloop.daily-backup` / `com.alphaloop.market-alerts`），并顺带跑一次 `openclaw gateway install`。

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

`launchd:install-user` 和 `launchd:install-backup-alerts` 安装的是两组完全不重叠的 launchd 任务，都只在各自文档里出现过一次——正式部署机上两条命令通常都要跑一遍；只跑其中一条会漏装另一半（例如只跑 `launchd:install-user` 的机器既没有每日备份、盘中也没有提醒器轮询）。这里没有把两者合并成一条命令：它们面向的部署场景不完全相同（例如只需要日报/个股分析的轻量机器，未必需要 `install-launchd.sh` 顺带执行的 `openclaw gateway install`），合并会让 `launchd:install-user` 悄悄多做事，也会让不想装 gateway 的场景失去单独跳过的办法。

```bash
# 日报/周报/个股分析/官方模拟盘轮询
pnpm launchd:install-user

# 每日交易数据库备份 + 市场提醒（market-alerts）轮询器
pnpm launchd:install-backup-alerts
```

`launchd:install-user` 安装后只会保留：

- 周二到周五 20:00 日报发送。
- 周一 20:00 周报发送。
- 每天 21:00 检查个股分析三日 cadence。
- 美股盘中官方模拟盘每小时轮询。
- 美股开盘后 30 分钟官方模拟盘收支变化表。

`launchd:install-backup-alerts` 安装后额外保留：

- 每日交易数据库备份（`com.alphaloop.daily-backup`）。
- 市场提醒轮询器（`com.alphaloop.market-alerts`）。

`pnpm openclaw:runtime:doctor` 会检测这两个任务是否都已通过 `launchctl list` 加载，缺失时给出对应的安装命令提示。
