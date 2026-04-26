# 本机可信用户模式安全边界

OpenClaw 当前按“本机可信用户模式”运行：`agents.defaults.sandbox.mode=off`，服务只绑定 `127.0.0.1`，默认操作者是本机登录用户。这个模式保留本机直跑体验，但不提供多租户隔离；不要把它当成给互不信任用户共享的一台交易网关。

## 可信边界

- 可信主体：本机 macOS 登录用户、明确加入 Feishu allowlist 的操作者、当前仓库里的受控服务进程。
- 不可信主体：未加入 allowlist 的群成员、任意外部 webhook、未知 MCP/plugin、公共网络来源、任何未经人工核验的模型输出。
- 本机直跑风险：agent 能看到本机工作区和 runtime，上下文里可能出现本机路径、运行状态和交易记录；因此凭证必须留在 `.env.local`、系统 keychain、Longbridge CLI token 目录或 `~/.openclaw/credentials`，不能写入仓库报告。

## Feishu 群边界

- 群入口必须保持 `groupPolicy=allowlist`，且 `requireMention=true`。
- `groups.<chat_id>.allowFrom` 只允许可信操作者 open_id；未知成员只能旁观，不能触发交易、规则激活、维护脚本或高风险工具。
- 新增 Feishu 用户必须由可信操作者确认，再运行授权脚本写入本机 credentials；不得在群里粘贴 token、cookie、OAuth code 或 SSH 私钥。

## 凭证保护

- `.env.local`、`runtime/`、`logs/`、`node_modules/`、`dist/`、`*.tsbuildinfo` 必须被 `.gitignore` 排除。
- 报告和审计日志只能写状态、订单号、ticket id、规则版本和脱敏后的错误信息。
- `broker-executor` 的 health 只暴露 Longbridge auth 是否配置及来源，不输出 token path。
- 执行结果写入 report 前必须递归脱敏包含 `token`、`secret`、`cookie`、`authorization`、`private_key`、`api_key` 的字段。

## 实盘限制

- 自动实盘执行关闭：`ALLOW_LIVE_EXECUTION=false` 是运行基线。
- 代码层强制 `liveExecutionEnabled=false`；即使环境变量被误设为 `true`，live ticket 也会被 `broker-executor` 拒绝。
- live lane 只生成结构化 advice card；高风险建议需要第二次人工确认，人工确认也不能绕过 broker 写入边界。

## 期权限制

- 自动期权、shadow execution、options-shadow 服务均不再创建新票据。
- `paper-trader` 和 `live-advisor` 遇到 `assetClass=option` 的事件直接跳过。
- `broker-executor` 与 Longbridge paper 写入函数都会拒绝 option ticket。

## 官方模拟盘边界

- 官方 Longbridge paper 只允许在 `LONGBRIDGE_ACCOUNT_MODE=paper`、`LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true`、`ALLOW_LIVE_EXECUTION=false` 同时成立时走 CLI 写入。
- 写入范围仅限 stock/ETF paper ticket；live、shadow、option 都会被拒绝。
- broker write 只能由本机 `broker-executor` 发起，手工脚本也必须通过 `POST /v1/tickets` 提交 ticket。

## 人工确认事项

- 规则合并后默认 inactive，必须由人类显式激活。
- 新增 Feishu 操作者、变更 allowlist、修改 Longbridge account mode、启用任何新的 plugin 或 MCP 工具，都需要人工复核。
- 如果 OpenClaw auth、Feishu auth、Longbridge auth 或 health 异常，系统降级为只读检查和报告，不执行 autonomous action。

## Security Audit 解释

- `security.trust_model.multi_user_heuristic`：在无 sandbox 且 Feishu 群入口存在时，OpenClaw 会提示潜在多用户风险。这里接受该提示的前提是本机单用户、网关 loopback、群成员 allowlist、无自动实盘、无期权自动化。若未来出现互不信任用户，必须拆分网关、凭证、OS 用户或主机。
- `plugins.allow_phantom_entries`：这是可修复项。配置渲染器只应把已安装的外部插件放进 `plugins.allow`；bundled runtime/channel/provider 插件通过各自 config block 启用，不写入 allowlist，避免未来同名插件被误放行。
