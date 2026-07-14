# OpenClaw 交易控制栈

本仓库现在只保留四个能力：中文日报/周报、中文个股分析、长桥官方模拟盘、飞书群被 @ 时答复。

## 安全边界

- 永不自动提交真实资金订单。
- 实盘流程只停在结构化建议和人工复核。
- 只有本地 `broker-executor` 可以把 order ticket 转成券商写入。
- 官方长桥模拟盘必须同时满足 `LONGBRIDGE_ACCOUNT_MODE=paper`、`LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true`、`ALLOW_LIVE_EXECUTION=false`。
- OpenClaw 官方模拟盘最多使用总账户 10%；剩余 90% 不动。
- 不做期权自动化；期权只作为个股分析中的到期/交割影响因素。
- 飞书群访问必须 allowlist；所有群发内容必须是中文。
- 凭据、OAuth token、SSH 私钥、runtime DB、logs、`node_modules` 和 `dist` 不入仓。

## 目录结构

- `apps/broker-executor`：官方模拟盘写入边界、风险检查、执行报告。
- `apps/platform-app`：多成员 Web 平台（Phase 3），日报/个股/模拟盘/名片等页面，仅监听 `127.0.0.1`。
- `apps/openclaw-config`：OpenClaw/飞书配置、调度脚本、报告脚本、长桥包装脚本。
- `packages/shared-types`：共享类型、SQLite schema、通知和通用工具。
- `knowledge/notes/stock-trading-notes`：日报流程、个股分析模板和飞书历史提炼。
- `reports/daily`：中文日报 Markdown/PDF。
- `reports/weekly`：中文周报 Markdown/PDF。

## 常用命令

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck

pnpm report:daily
pnpm report:weekly
pnpm stock-analysis:targets -- AAPL MSFT NVDA
pnpm stock-analysis:run
pnpm official-paper:poll
pnpm official-paper:pnl
pnpm paper:submit-official-equity -- buy QQQ.US 1

# platform-app（Phase 3 多成员 Web 平台）本地开发起停
pnpm platform:dev
pnpm platform:start
```

## 调度

- 日报：周二到周五 20:00 发送当天报告，PDF + 摘要卡片。
- 周报：周一 20:00 发送上一周报告，PDF + 摘要卡片。
- 个股分析：用户指定标的后，每三天 21:00 发送一次批量分析，PDF + 摘要卡片。
- 官方模拟盘：美股常规交易时段每小时轮询；美股开盘后 30 分钟发送收支变化表。

安装本地调度——一台正式部署机通常三条都要跑（详见 `apps/openclaw-config/README.md` 的「Launchd」章节）：

```bash
# 日报/周报/个股分析——2026-07-14 起唯一 owner 是 OpenClaw cron 通道
pnpm openclaw:cron:install

# 官方模拟盘每小时轮询 + 开盘后收支变化表
pnpm launchd:install-user

# 每日交易数据库备份 + 市场提醒（market-alerts）轮询器 + platform-app 常驻服务
pnpm launchd:install-backup-alerts
```

只跑其中一条会漏装其余任务——例如只跑 `launchd:install-user` 的机器没有日报/周报/个股分析，也没有每日备份或盘中提醒器（`openclaw:runtime:doctor` 的 `launchd-jobs.*.not_loaded` 提示就是在检测这种情况）。这三条命令彼此不会冲突，可以任意顺序、任意次数重跑。

`launchd:install-backup-alerts`（Phase 3 起）额外安装 `com.alphaloop.platform-app`——一个常驻 `KeepAlive` launchd 服务（不是周期任务），启动 `pnpm --filter @apps/platform-app start`；`openclaw:runtime:doctor` 同样会检测它是否已加载，以及它的 `/health` 是否可达。

## 本地接口

- `GET http://127.0.0.1:4312/health`
- `GET http://127.0.0.1:4312/v1/rules/active`
- `POST http://127.0.0.1:4312/v1/tickets`

`/v1/tickets` 只允许官方模拟盘股票/ETF 在安全环境齐全时继续；实盘、shadow、期权都会被拒绝。

- `GET http://127.0.0.1:4314/health`（platform-app；端口可用 `PLATFORM_APP_PORT` 覆盖，默认 4314）

## 平台成员管理（platform-app）

成员/token 通过 `apps/openclaw-config/scripts/members.mjs` CLI 管理（单行 JSON 输出，出错非零退出）：

```bash
node apps/openclaw-config/scripts/members.mjs add --email a@example.com --name "张三" [--feishu <openId>]
node apps/openclaw-config/scripts/members.mjs list
node apps/openclaw-config/scripts/members.mjs token issue --member <memberId> --label "my-token"
node apps/openclaw-config/scripts/members.mjs token revoke --token-id <tokenId>
node apps/openclaw-config/scripts/members.mjs revoke --member <memberId>
```

`token issue` 生成的明文 token 只打印一次，请当场保存。

环境变量（均默认指向真实 `runtime/trading.sqlite`，只用于指向一次性临时库做手工验证，**不要**在正常运行时改指真实库之外的路径）：

- `PLATFORM_DB_PATH`：覆盖 platform-app 进程（`apps/platform-app/src/index.ts`）使用的交易数据库路径。
- `MEMBERS_DB_PATH`：覆盖 `members.mjs` CLI 使用的交易数据库路径（与 `PLATFORM_DB_PATH` 是两个独立变量，命名不同但通常指向同一个库文件）。
- `PLATFORM_APP_PORT`：覆盖 platform-app 监听端口，默认 `4314`。
