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
- `scripts/install-user-schedules.mjs`：安装用户级 launchd 调度。

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

```bash
pnpm launchd:install-user
```

安装后只会保留：

- 周二到周五 20:00 日报发送。
- 周一 20:00 周报发送。
- 每天 21:00 检查个股分析三日 cadence。
- 美股盘中官方模拟盘每小时轮询。
- 美股开盘后 30 分钟官方模拟盘收支变化表。
