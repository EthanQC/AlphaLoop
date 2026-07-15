# AlphaLoop 密钥清单（Secrets Inventory）

> 配套模板：根目录 `.env.local.example`（全部键名 + 占位注释，无真实值）。本文档只描述每个密钥的用途、存放位置、轮换方式与迁移注意事项，**不含任何真实密钥值**——这与 `AGENTS.md` "Do not write broker credentials, OAuth tokens, or SSH private keys into memory or reports" 的宪法约束一致。

## 1. 范围与读取路径

所有密钥统一存放在仓库根目录的 `.env.local`（已加入 `.gitignore`，永不提交）。以下脚本会在启动时读取它并写入 `process.env`：

- `packages/shared-types/src/runtime.ts`（`loadLocalEnv`，供 broker-executor 等 TS 包调用）
- `apps/openclaw-config/scripts/render-openclaw-config.mjs`（渲染 `~/.openclaw/openclaw.json`）
- `apps/openclaw-config/scripts/setup-feishu-user-auth.mjs`（飞书用户态 OAuth/Cookie 导入）
- `apps/openclaw-config/scripts/authorize-feishu-user.mjs`（飞书用户白名单授权）
- `apps/openclaw-config/scripts/run-feishu-user-plugin.mjs`（feishu-user-plugin 子进程启动器）
- `apps/openclaw-config/scripts/report-data.mjs`（官方模拟盘报告环境校验）
- `apps/openclaw-config/scripts/_longbridge.mjs`（长桥只读 CLI 限流封装）
- `apps/openclaw-config/scripts/news-sources.mjs`（L1 新闻源客户端：RSSHub/Finnhub）

新增密钥时：先在 `.env.local.example` 补一行占位 + 注释，再回填本文档对应表格。

## 2. Longbridge 经纪商凭据

| 键名 | 用途 | 存放位置 | 轮换方式 | 迁移注意 |
|---|---|---|---|---|
| `LONGBRIDGE_APP_KEY` | 长桥官方 OpenAPI 应用 key，长桥 CLI 二进制直接从环境变量读取（本仓库代码只透传，不解析） | `.env.local`（本机）；未来 Phase 6 改为按成员目录隔离存放于 mini | 在长桥开发者控制台重新生成 app key/secret 对 | 迁移新机器需从长桥控制台重新下发，不可从旧机器明文拷贝到聊天记录或报告中 |
| `LONGBRIDGE_APP_SECRET` | 同上，配对的 app secret | 同上 | 与 `LONGBRIDGE_APP_KEY` 成对轮换 | 同上；`apps/broker-executor/src/redaction.ts` 已将其列入敏感字段自动脱敏 |
| `LONGBRIDGE_ACCESS_TOKEN` | 长桥 OpenAPI 访问令牌；`runtime.ts` 的 `resolveLongbridgeAuthState()` 优先读取此项判定"已配置" | `.env.local` | 长桥控制台或长桥 CLI 登录流程重新签发；有效期到期需重新获取 | 若改用 CLI 登录态（见下一行）可留空 |
| `LONGPORT_ACCESS_TOKEN` | `LONGBRIDGE_ACCESS_TOKEN` 的兜底别名（`runtime.ts` 用 `||` 顺序读取两者），仅为兼容长桥 SDK 历史命名 | `.env.local`（可选） | 同 `LONGBRIDGE_ACCESS_TOKEN` | 两者同时存在时以 `LONGBRIDGE_ACCESS_TOKEN` 为准 |
| `LONGBRIDGE_OPENAPI_TOKEN_PATH` | 无 access token 时的兜底：指向长桥 CLI 登录后落盘的 token 文件；未设置时默认扫描 `~/.longbridge/openapi/tokens/` 目录取最新一个 | 文件系统路径（非密钥本体，密钥在被指路径下） | 由长桥 CLI 的登录流程自动维护，无需手动轮换 | 迁移机器后该目录不会自动同步，需在新机器上重新执行一次长桥 CLI 登录 |

## 3. Longbridge 执行安全开关（非密钥，安全关键）

| 键名 | 用途 | 存放位置 | 轮换方式 | 迁移注意 |
|---|---|---|---|---|
| `LONGBRIDGE_ACCOUNT_MODE` | 必须恒为 `paper`；`assertOfficialPaperReportEnvironment()` 与 broker-executor 双重校验 | `.env.local` | 不轮换，是固定安全常量 | 迁移时必须显式设置，缺失会被判定为未配置从而拒绝生成报告/执行 |
| `LONGBRIDGE_OFFICIAL_PAPER_ENABLED` | 必须恒为 `true`，配合 `ACCOUNT_MODE=paper` 开启官方模拟盘报告/执行 | `.env.local` | 不轮换 | 同上 |
| `ALLOW_LIVE_EXECUTION` | 必须恒为 `false`；`AGENTS.md` Hard Rule 规定即使此变量被误配置，实盘执行也必须保持禁用 | `.env.local` | 不轮换 | 任何环境下都不应改为 `true`；这是宪法级红线，不是可迁移配置 |

## 4. Longbridge CLI 读取调优（非密钥，可选）

`LONGBRIDGE_CLI_PATH`、`LONGBRIDGE_CLI_TIMEOUT_MS`、`LONGBRIDGE_READ_RETRY_ATTEMPTS`、`LONGBRIDGE_READ_RETRY_BASE_MS` 均为 `_longbridge.mjs` 的限流/重试调优参数，不含敏感信息，缺省即用内置默认值（CLI 路径 `~/.local/bin/longbridge`、超时 45s、重试 4 次、基础退避 1200ms）。迁移新机器时若长桥 CLI 安装路径不同，只需调整 `LONGBRIDGE_CLI_PATH`。

## 5. OpenClaw 网关

| 键名 | 用途 | 存放位置 | 轮换方式 | 迁移注意 |
|---|---|---|---|---|
| `OPENCLAW_GATEWAY_PORT` | 本地 OpenClaw 网关监听端口 | `.env.local` | 一般不轮换，冲突时改端口 | — |
| `OPENCLAW_GATEWAY_TOKEN` | 本地网关鉴权 bearer token；`render-openclaw-config.mjs` 若未设置会用 `crypto.randomUUID()` 自动生成新的 | `.env.local`；渲染后落盘到 `~/.openclaw/openclaw.json` | 若需失效已配对客户端，删除后重渲染即可轮换 | **迁移或重装前务必先固定此值**，否则每次重渲染都会生成新 token，导致已配对的客户端/脚本失效 |

## 6. 飞书机器人主账号

| 键名 | 用途 | 存放位置 | 轮换方式 | 迁移注意 |
|---|---|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书自建应用凭据，驱动主账号机器人（消息收发、卡片） | `.env.local` | 飞书开放平台后台重新生成 secret | 迁移后需在飞书后台确认事件订阅回调地址仍指向新机器 |
| `FEISHU_VERIFICATION_TOKEN` | 事件订阅验证 token（可选，取决于飞书应用配置） | `.env.local` | 飞书开放平台重新生成 | — |
| `FEISHU_DOMAIN` / `FEISHU_BOT_NAME` | 非密钥，域名（`feishu`/`lark`）与展示名 | `.env.local` | 不适用 | — |
| `FEISHU_ALLOW_FROM` / `FEISHU_GROUP_ALLOW_FROM` | 私聊/群聊白名单（open_id、chat_id 列表），配合 `authorize-feishu-user.mjs` 增量维护 | `.env.local` + `~/.openclaw/credentials/feishu-main-allowFrom.json` | 通过 `authorize-feishu-user.mjs <open_id>` 追加，无需手改 | 迁移新机器需重新导入白名单（`.env.local` 里的 CSV 值随迁移拷贝即可，凭据类字段除外） |
| `FEISHU_DM_POLICY` / `FEISHU_REQUIRE_MENTION` | 非密钥，私聊/群聊触发策略 | `.env.local` | 不适用 | — |

## 7. 飞书用户插件（个人自动化，OAuth/Cookie）

| 键名 | 用途 | 存放位置 | 轮换方式 | 迁移注意 |
|---|---|---|---|---|
| `LARK_APP_ID` / `LARK_APP_SECRET` | 未设置时默认取 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`（见 `applyFeishuAliases`） | `.env.local` | 与飞书主账号凭据同源轮换 | — |
| `LARK_COOKIE` | 飞书网页会话 Cookie，供只读消息浏览等无 OAuth 覆盖的能力使用 | `.env.local`，经 `setup-feishu-user-auth.mjs cookie-from-state <playwright-state.json>` 从 Playwright 登录态导入 | 会话过期后需重新登录浏览器并重新导入 | 迁移新机器需在新机器上重新走一次登录+导入，Cookie 不建议跨机器复用 |
| `LARK_USER_ACCESS_TOKEN` / `LARK_USER_REFRESH_TOKEN` | 用户态 OAuth 访问/刷新令牌，仅用于 P2P 用户消息读取，不用于机器人报告下发 | `.env.local`，由 `setup-feishu-user-auth.mjs oauth` 的本地回调服务器写入 | 到期后用 refresh token 静默续期；refresh token 失效则需重新走一次 `oauth` 命令 | 迁移新机器需重新授权（回调地址是 `http://127.0.0.1:<PORT>/callback`，只在本机有效） |
| `LARK_UAT_SCOPE` / `LARK_UAT_EXPIRES` | 记录上次 OAuth 授权的 scope 与过期时间戳（秒），供状态展示用 | `.env.local` | 随每次 OAuth 授权自动更新 | 非密钥本体，仅为运维可观测性字段 |
| `FEISHU_USER_PLUGIN_OAUTH_PORT` | 本地 OAuth 回调端口 | `.env.local` | 端口冲突时调整 | — |
| `FEISHU_USER_PLUGIN_GROUP_NAME` / `FEISHU_USER_PLUGIN_BOT_CHAT_ID` / `FEISHU_USER_PLUGIN_CHAT_ID` / `FEISHU_NOTIFY_CHAT_ID` | 用户插件报告投递目标（群名/群 chat_id/私聊 chat_id，后者互为兜底） | `.env.local` | 目标群/会话变更时手动更新 | 迁移前需现场确认目标群仍存在、机器人仍在群内 |

## 8. 新闻引擎数据源（Phase 4，L1 源客户端）

| 键名 | 用途 | 存放位置 | 轮换方式 | 迁移注意 |
|---|---|---|---|---|
| `FINNHUB_API_KEY` | Finnhub company-news API（`https://finnhub.io/api/v1/company-news`）鉴权，`news-sources.mjs` 以 `X-Finnhub-Token` 请求头发送；未设置时该源整体跳过（`sourceHealth.finnhub = 'skipped_no_key'`），不报错、不阻塞报告 | `.env.local`（可选） | Finnhub 控制台重新生成 | 迁移新机器时若暂不配置，新闻引擎自动降级为不含 Finnhub 的其余源，无需先补齐才能跑通；任何错误消息落地前都经 `news-sources.mjs` 的 `redactSecret` 脱敏，绝不落 key 明文 |
| `RSSHUB_BASE_URL` | 本机/自建 RSSHub 实例地址，供财联社电报、华尔街见闻快讯、格隆汇快讯三条中文源路由使用；未设置默认 `http://127.0.0.1:1200` | `.env.local`（可选） | 不适用（非密钥，RSSHub 本身不带任何凭据） | 迁移新机器需先起本机 RSSHub Docker 容器（见 `apps/openclaw-config/launchd`，P10 部署）或指向可达的自建实例，否则三条 RSSHub 路由（含各自的第二冗余路由）全部失败，新闻引擎降级为仅剩 Yahoo/Google/Longbridge/Finnhub |

## 9. 多成员长桥凭据规划（Phase 6，尚未实现）

当前阶段（Phase 1）只有单一 Longbridge 凭据集，直接放在根目录 `.env.local` 里，`broker-executor` 全程用同一份 `process.env` 执行。这在多成员平台落地后不再成立：`docs/superpowers/specs/2026-07-12-tech-selection.md` §2.3/2.5 已定下方向——**每个成员一套独立长桥凭据，互不可见，按成员命名隔离**，订单提案/工单带 `owner_id`，executor 按 `owner_id` 加载对应凭据、以子进程级环境变量注入方式执行（长桥 CLI 本就从环境变量读取凭据，因此不需要凭据文件落盘到共享路径）。

规划中的结构（Phase 6 落地时细化）：

- 每个成员的 `LONGBRIDGE_APP_KEY` / `LONGBRIDGE_APP_SECRET` / `LONGBRIDGE_ACCESS_TOKEN` 独立存放于 mini 上按成员 id 命名隔离的位置（例如 `~/.alphaloop/credentials/<member-id>/longbridge.env`），只有 broker-executor 进程可读；执行某成员的工单时，仅把该成员这一份注入子进程环境，不写回全局 `process.env`、不与其他成员共享。
- 两处**现存的跨账户共享状态**在多账户并发前必须先隔离，否则会串账户：
  - `~/.longbridge/openapi/tokens/` 与 `~/.longbridge/openapi/region-cache` 是长桥 CLI 的单文件缓存，按成员切分需要给每个成员一个独立的 `HOME`（或等价的路径重定向）子进程环境。
  - `runtime/longbridge-rate-limit-quote.json` / `runtime/longbridge-rate-limit-trade.json` 目前按调用类别（quote/trade）限流、不区分账户；多账户并发轮询前需拆成按账户+类别限流，或确认共享限流窗口在双账户量级下仍然可接受（当前评估：调用量翻倍仍远低于限速，可接受，但拆分更稳妥）。
- `official_paper_snapshots` 等表已在 Phase 1 加了 `owner_id` 列（历史行可空），Phase 6 会据此让快照拉取、10% 预算校验、熔断判断全部按 `owner_id` 分别计算。
- 迁移/新增成员时的密钥管理：新增成员走"生成 token + Access 白名单提示"的成员管理命令（Phase 6 规划），长桥凭据由该成员自行在长桥官方渠道申请后提交，管理员只负责按上述目录结构落盘，不经手复制到聊天记录、报告或 memory。

## 10. 迁移注意事项（通用，适用于所有密钥）

1. **禁止经由 AI 对话或报告传递明文密钥**：本仓库的宪法约束（`AGENTS.md`）明确禁止把经纪商凭据、OAuth token、SSH 私钥写入 memory 或报告；迁移凭据请使用 1Password/scp 等带加密的通道，人工在目标机器上手填 `.env.local`。
2. **`.env.local` 本身不随 git 迁移**：它被 `.gitignore` 排除，`.env.local.example` 只是键名模板；新机器需要照模板逐项手动重建。
3. **`OPENCLAW_GATEWAY_TOKEN` 必须先固定再迁移**：否则每次 `render-openclaw-config.mjs` 重渲染都会生成新 token，已配对客户端全部失效。
4. **飞书用户态令牌（`LARK_COOKIE`/`LARK_USER_ACCESS_TOKEN`/`LARK_USER_REFRESH_TOKEN`）不建议跨机器复用**：Cookie 与 OAuth 回调都与"当前登录的浏览器会话"/"当前机器的回调地址"绑定，迁移后应在新机器上重新走一遍导入/授权流程，而不是直接拷贝旧值。
5. **长桥 CLI 登录态（`~/.longbridge/openapi/tokens/`）不会随代码仓库迁移**：新机器需要重新执行一次长桥 CLI 登录，或者显式配置 `LONGBRIDGE_ACCESS_TOKEN`/`LONGPORT_ACCESS_TOKEN` 环境变量跳过 CLI 登录态依赖。
6. **任何密钥变更后都需要重新渲染并重启相关服务**：跑一次 `node apps/openclaw-config/scripts/render-openclaw-config.mjs` 更新 `~/.openclaw/openclaw.json`，并重启对应 launchd 服务，变更才会生效。
