# OpenClaw 交易控制栈

这是一个运行在本地 macOS 单节点上的 OpenClaw 交易控制平面仓库。它把交易建议、纸面交易、规则演化、日报周报、通知交接和本地审计统一放在一个 monorepo 中管理。

## 项目范围

- 使用 OpenClaw 作为控制平面和 agent 路由器。
- 使用 Longbridge 作为已认证的券商接入层，用于实时建议、行情适配和官方纸面交易。
- 使用本地 `paper-sim` 自动执行股票/ETF 纸面交易。
- 真实资金流程只产出结构化建议卡，不自动提交订单。
- 期权自动化保持禁用；历史记录可以保留，但不提供自动期权影子执行服务。
- 使用 SQLite 保存队列、交易事实、审计记录和报告索引。
- 可选接入 Honcho，用于长期偏好和记忆建模。
- 可选接入飞书，用于通知、审批、报告分发和渠道交接。
- 从人工审批、笔记和执行历史中生成每周规则提案。
- 使用 GitHub 管理代码、规则、报告和 CI。

## 安全边界

本仓库遵守根目录 `AGENTS.md` 中的 Trading Constitution。关键约束包括：

- 永不自动提交真实资金订单。
- live lane 只做建议，不做 broker write。
- 所有 broker write 只能由本地 `broker-executor` 执行。
- `ALLOW_LIVE_EXECUTION=false` 是默认且必须保持的安全边界。
- 官方 Longbridge 纸面交易必须同时满足 `LONGBRIDGE_ACCOUNT_MODE=paper`、`LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true` 和 `ALLOW_LIVE_EXECUTION=false`。
- 期权自动化和 live execution 即使环境变量误配置也保持禁用。
- 飞书群访问必须 allowlist，未信任成员不能触发高风险工具。
- 凭据、OAuth token、SSH 私钥、runtime DB、logs、`node_modules` 和 `dist` 不入仓。

## 目录结构

- `apps/openclaw-config`：OpenClaw 配置模板、agent prompt、launchd 模板和运维脚本。
- `apps/event-bus`：基于 SQLite 的持久化队列 API。
- `apps/event-ingestor`：行情、新闻、日历等事件源适配和事件写入循环。
- `apps/broker-executor`：风险闸门、纸面执行和券商执行 API。
- `apps/live-advisor`：live lane 消费者，只产出建议和审批材料。
- `apps/paper-trader`：股票/ETF 纸面交易消费者和交易报告触发器。
- `packages/shared-types`：共享领域类型、SQLite schema、repository 和通用工具。
- `packages/context-builder`：为 OpenClaw agent 组装运行时上下文。
- `knowledge/notes`：研究笔记、观察列表和偏好资料；原始 stock-trading-notes 已整理到 `knowledge/notes/stock-trading-notes/`。
- `knowledge/memory`：稳定记忆和日常摘要。
- `rules/live`：live advisor 规则版本。
- `rules/paper`：paper trading 规则版本。
- `reports/daily`：中文日报。
- `reports/weekly`：中文周报。
- `reports/proposals`：基于本地证据生成的规则提案快照。

## 环境要求

- Node.js 24+
- pnpm 9+
- 本地已安装 OpenClaw
- 可选：OpenClaw Honcho plugin
- 可选：飞书 app 凭据和 Longbridge paper 凭据

## 本地初始化

```bash
pnpm install
pnpm build
pnpm test
pnpm preferences:bootstrap
pnpm proposals:generate
```

OpenClaw 配置渲染、OAuth、launchd 安装和本地运维流程见 [apps/openclaw-config/README.md](apps/openclaw-config/README.md)。

## 常用命令

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm maintenance:latest
pnpm report:daily
pnpm report:weekly
pnpm proposals:generate
pnpm proposals:review
pnpm longbridge:reconcile-official-paper
```

## 本地接口

- `GET http://127.0.0.1:4314/v1/advice/recent`
- `POST http://127.0.0.1:4314/v1/advice/approvals`
- `GET http://127.0.0.1:4314/v1/preferences/latest`
- `GET http://127.0.0.1:4312/v1/paper/positions`

期权和 shadow execution 不作为自动化入口使用。

## 本地可信用户模式

该栈有意在本地 macOS 主机上直接运行，并允许 OpenClaw 在本地可信用户边界内使用 `agents.defaults.sandbox.mode=off`。边界说明见 [apps/openclaw-config/docs/local-trusted-user-security.md](apps/openclaw-config/docs/local-trusted-user-security.md)。

强制执行基线：

- `ALLOW_LIVE_EXECUTION=false`；live flow 始终保持 advice-only。
- 官方 paper order 需要 `LONGBRIDGE_ACCOUNT_MODE=paper` 和 `LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true`。
- 期权自动化和 shadow execution 保持禁用。
- 飞书群访问只允许可信 operator。
- broker 写入只能通过本地 `broker-executor`。

## 凭据与数据

- 本地凭据只放在用户 shell、本地 OpenClaw auth store 或被忽略的 `.env.local` 中。
- SQLite runtime DB 是事实账本，但 runtime 文件不提交到 Git。
- Markdown 报告和 Honcho 是上下文层，不是交易事实账本。
- 每次自动纸面执行必须产出 per-trade report。
- 每个交易日必须产出 daily report。
- 规则提案需要 old-vs-new 对比，并且合并后仍需人工显式激活。
