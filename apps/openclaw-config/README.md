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
- `scripts/install-launchd-ownership.txt`：**哪个标签归哪个 launchd 域**的唯一事实来源；下面所有安装脚本和 `openclaw:runtime:doctor` 都读它。
- `scripts/install-system-daemons.sh`：**唯一**安装无人值守服务的脚本，把 8 个 daemon 写进 `/Library/LaunchDaemons`（需要 sudo）。
- `scripts/install-user-schedules.mjs`：2026-07-28 起**只退役、不安装**——把系统域拥有的标签和历史报告 plist 从 `~/Library/LaunchAgents` 里移进归档目录（不删除；接管它的 daemon 没加载时干脆不动，见下面「谁拥有哪个标签」）。
- `scripts/launchd-agent-archive.mjs`：上面那条规则的唯一实现，`install-user-schedules.mjs` 和 `install-openclaw-cron.mjs` 共用它。
- `scripts/install-launchd.sh`：只安装 ownership 里 scope 为 `user` 的模板（当前仅 `com.alphaloop.rsshub`），并顺带跑一次 `openclaw gateway install`。
- `scripts/members.mjs`：platform-app 身份层的成员/token 管理 CLI（`add`/`list`/`revoke`/`token issue`/`token revoke`）。
- `scripts/install-cloudflared-tunnel.mjs`：给**还没有 connector 的机器**安装用户级 cloudflared 隧道（token 模式）。mini 上已经跑着系统级的 `com.cloudflare.cloudflared`，所以这条脚本在那里会拒绝执行，见下面「公网入口」。

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

完整部署顺序见仓库根 `README.md` 的「部署机安装顺序」，这里只补充"为什么"。

### 谁拥有哪个标签

`scripts/install-launchd-ownership.txt` 是唯一事实来源，五个消费者都读它（4 个安装脚本 `install-system-daemons.sh` / `install-launchd.sh` / `install-user-schedules.mjs` / `install-openclaw-cron.mjs`，加上 `openclaw-runtime-doctor-core.mjs`），所以一个标签不可能有两个 owner：

| scope | 含义 | 安装者 |
| --- | --- | --- |
| `system` | `/Library/LaunchDaemons`，开机即起、不需要图形登录 | `install-system-daemons.sh`（**sudo**） |
| `user` | `~/Library/LaunchAgents`，需要用户登录会话 | `install-launchd.sh`（`pnpm launchd:install-backup-alerts`） |
| `retired` | 谁都不许装，所有安装脚本都会主动 bootout 掉，并**统一移进** `~/Library/LaunchAgents.disabled/openclaw-system-backup-<时间戳>/`（三个脚本共用同一个归档目录，谁都不删除） | — |
| `external` | 由 `openclaw` CLI 自己拥有，本仓库不碰 | — |

当前只有 `com.alphaloop.rsshub` 是 `user`：它整个任务体就是 `docker start rsshub`，而它依赖的容器运行时（`homebrew.mxcl.colima`）本身就是用户级 LaunchAgent，socket 和 context 都在用户家目录下。系统 daemon 会赶在那个 socket 存在之前启动然后报 "Cannot connect to the Docker daemon"——把它提升到系统域只会让新闻源更不可靠。

### 公网入口：`com.cloudflare.cloudflared` 才是那一个

清单里 2026-07-28 新增了一行 `external com.cloudflare.cloudflared`。原因是这个标签此前**根本不在**「唯一事实来源」里，而它恰恰是用户唯一依赖的公网入口。

mini 上只读实测：`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`（`root:wheel`，7 月 27 日），`launchctl print system/com.cloudflare.cloudflared` 报 `state = running`，命令行是 `/opt/homebrew/bin/cloudflared --config /etc/cloudflared/config.yml tunnel run`（named tunnel，凭据在 `/etc/cloudflared/<uuid>.json`，0600 root），`https://reports.qingverse.com/health` 经 Cloudflare anycast 返回 200。

而 `install-cloudflared-tunnel.mjs` 装的是 `com.alphaloop.cloudflared-tunnel`——**另一个标签**，用户级 LaunchAgent，token 模式。名字不同意味着 launchd 不会用新的替换旧的，而是两个 connector 一起跑。所以：

- **系统 daemon 赢。** 它是 root 拥有、由 `cloudflared service install` 安装的第三方产物（scope `external`，本仓库任何脚本都不写它、不删它），而且它是系统域——开机不需要图形登录就能起来，正是这轮把 8 个标签搬去 `/Library/LaunchDaemons` 的同一个理由。用户级 LaunchAgent 在这条标准上是退步。
- `install-cloudflared-tunnel.mjs` 现在会在 `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` 存在时拒绝安装（消息里给出改 `/etc/cloudflared/config.yml` + `launchctl kickstart` 的正确做法），`--force` 才能越过。判断放在 `ensureCloudflaredInstalled()` 之前，所以拒绝时不会顺手 `brew install` 一个包。`--dry-run` 的 JSON 里多了 `systemDaemonPresent` / `wouldRefuse` 两个字段。
- 它的自己那个标签**故意不写进清单**：装了系统 daemon 的机器上它永远不该被安装，而没有 connector 的新机器由操作者显式选路径。
- doctor 不探测这两个标签中的任何一个（`external` 行不参与 `launchd-jobs.*`）。隧道健康只能手工确认：`curl -sS -o /dev/null -w '%{http_code}\n' https://reports.qingverse.com/health`。

### 三个安装脚本各自做什么（2026-07-28 之后）

```bash
# 1) 只安装 scope=user 的模板（当前 = com.alphaloop.rsshub），外加 openclaw gateway install
pnpm launchd:install-backup-alerts

# 2) 安装全部 8 个 scope=system 的 daemon；先干跑确认装给谁，再 sudo 真装
PRINT_CONFIG_ONLY=1 zsh apps/openclaw-config/scripts/install-system-daemons.sh
sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh

# 3) 只退役、不安装任何 plist
pnpm launchd:install-user
```

历史包袱提醒：ac741d8 之前 `launchd:install-user` 和 `openclaw:cron:install` 各自会安装 plist，那时的文档要求"三条都跑一遍"。现在它们只剩退役逻辑，照旧文档跑会把运行中的服务全部下线而什么都装不上。

只剩一条顺序约束：

- `install-launchd.sh` 必须排在 `install-system-daemons.sh` **之前**。它结尾的 `openclaw gateway install` 会重新创建用户级 `ai.openclaw.gateway`，而只有后跑的 `install-system-daemons.sh` 才会把它 bootout 掉；反过来跑，用户级 gateway 会活到最后，和系统 gateway 抢同一个 18789 端口。

以前这里还有第二条：「`launchd:install-user` 最好排在 daemon 安装之后，因为前者 `rmSync` 直接删、后者移进备份目录」。那条约束**是靠文档执行的，而文档执行不了**——第 5 轮 D1 实测到的正是它失效的样子：`install-system-daemons.sh` 因为某个 daemon 起不来而有意保留了它的用户级 plist、退出码 1，紧接着的 `pnpm launchd:install-user` 把这份 plist 无备份删掉、退出码 0。`com.openclaw.trading.cron-runner` / `official-paper.poll` / `official-paper.pnl` 三个标签在本仓库里没有任何模板（`apps/openclaw-config/launchd/` 只有 platform-app / market-alerts / daily-backup / rsshub 四个模板加两个历史 plist），删掉就再也生成不出来，而 mini 上这三份 plist 现在都还在。

现在这条约束由代码保证，不再由顺序保证：两个 node 安装器和 shell 安装器共用 `scripts/launchd-agent-archive.mjs` 的同一条规则——

1. **谁都不删除。** 退役 = 移进 `~/Library/LaunchAgents.disabled/openclaw-system-backup-<时间戳>/`，三个脚本用同一个归档目录。归档目录建不出来（mini 上它是早期 sudo 运行留下的 `root staff`）时，plist 原地保留并报错退出，不会退化成删除。
2. **接管者没起来就不动它。** 对 system/retired 标签，node 安装器先问 `launchctl print system/<接管它的 daemon>`；没加载就说明这份用户级副本正是机器现在跑的那份，于是原地不动、打印 `keptLaunchAgent` 并以退出码 1 结束。
3. **shell 安装器按服务逐个交接。** 停旧 → 起新 → `launchctl print` 确认 → 才归档；起不来就把刚停掉的 agent 立刻 `bootstrap gui/<uid>` 回去。所以单个服务的停机窗口是「一次 bootout + settle」（默认 2 秒，本机实测最坏 2.1 秒），其余服务不受影响，任何服务都不会同时跑两份。

（这也修正了旧版这里写的「中途中断也不会留下两个实例」之外那半句：第 4 轮的 Phase A/B/C 注释曾声称「随时中断都安全，机器任何时刻要么跑旧的要么跑新的」。实测不是——Phase A 一次性停掉全部 9 个标签，Phase B 才带着 settle 逐个拉起，最后一个标签整段时间既没有旧的也没有新的。用会给每次调用打时间戳的 launchctl stub 分别跑旧版和新版：旧版最坏单服务窗口 17.1 秒（official-paper.poll），新版 2.1 秒。另测在第 1.5 / 4 / 9 秒 SIGTERM 打断新版：每次都恰好只有 1 个标签处于交接中间态，其余标签要么跑着旧的、要么跑着新的，且没有残留临时目录。）

`PRINT_CONFIG_ONLY=1` 那次干跑不写任何文件、不建任何目录（包括临时目录）、不调 launchctl，只把这次解析出来的 `target_user` / `target_home` / `repo_root` / `pnpm_bin` / `gateway_port` / `proxy_labels` 打出来。同样在真正动手之前退出的还有 root 检查：不带 sudo 跑会直接被拦下并打印正确命令，不会写到一半才 "Permission denied"。

### 各服务的出网路径（proxy）

`install-system-daemons.sh` 按标签逐个决定要不要往 plist 里写 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`（含小写别名）和 `NO_PROXY`，默认只有两个服务写：

- `ai.openclaw.system.gateway`、`com.openclaw.system.trading.broker-executor` —— proxy。它们在 ac741d8 之前就一直带着 proxy 在跑，保持不变。
- 其余 6 个（platform-app / market-alerts / daily-backup / cron-runner / official-paper poll+pnl）—— 直连。它们从用户级 LaunchAgent 迁过来，原模板只 export 了 `PATH`，从来没有任何 proxy 变量；ac741d8 让它们无声地继承了 proxy，这里把行为改回去。

判断依据（2026-07-28 在 mini 上只读实测）。关键事实是：**TUN 和 7897 是同一个 mihomo 进程、同一份配置提供的**——`verge-mihomo`（pid 1411，由 clash-verge 特权 helper 拉起）读的那份 `clash-verge.yaml` 里同时有 `tun.enable: true` + `fake-ip-range: 198.18.0.1/16`（对应 `netstat -rn` 里持有 `1/8, 2/7, 4/6, 8/5 …` 切分默认路由的 `utun1024`）和 `mixed-port: 7897`。两者同生同死，于是只剩两种情形：

- **mihomo 在跑**：TUN 已经在网络层接管出网，env 变量不增加任何可达性。`curl --noproxy '*'` 与 `curl -x http://127.0.0.1:7897` 对 `news.google.com`(302)、`query1.finance.yahoo.com`(429)、`finnhub.io`(200)、`open.feishu.cn`(404)、`openapi.longportapp.com`(404) 返回完全相同的状态码。
- **mihomo 没跑**：7897 拒绝连接，TUN 路由同时也不在。带 env 变量的 daemon 每一个出网请求都会在 connect 阶段失败；不带的至少还能连上本来就没被墙的目标。

launchd 不保证 `RunAtLoad` 的 daemon 和 mihomo 绑上 7897 之间的先后，所以"开机时抢在 mihomo 前面"是真实存在的窗口。也就是说这 6 个服务加上 proxy 变量，好的时候没用，坏的时候把局部故障放大成全面故障。

从代码看这 6 个到底连什么：`daily-backup` 根本不出网（`backup-trading-data.mjs` 只做本地 sqlite 拷贝）；`market-alerts` 和 `official-paper` poll/pnl 走本地 Longbridge CLI（`openapi.longportapp.com`）和飞书（`open.feishu.cn`），上面的 curl 已证明两者直连可达；`platform-app` 只监听本地端口；`cron-runner` 通过 `127.0.0.1` 连 gateway（`NO_PROXY` 本来就排除了它），真正发往 Anthropic 的流量是 gateway 进程出去的，不是 cron-runner。这一组里唯一被墙的目标是 `cron-runner` 派发的 `stock-analysis.mjs` 要取的 `news.google.com`（还有 `finnhub.io`）——而它走的正是 TUN 默认路由，恰好就是 7897 存在的那个前提。

保留 proxy 的那两个：`gateway` 是唯一目标确定被墙的服务（`api.anthropic.com`），而且这是当前 mini 上已验证在跑的配置（`/Library/LaunchDaemons/ai.openclaw.system.gateway.plist` 今天就带着这 8 个 key）。`broker-executor` 的目标是 Longbridge，按上面的逻辑其实也可以改直连，但它是下单链路，这次改动没有在 mini 上实跑验证过，所以**有意不动**。

没有透明代理的部署机可以显式给某个服务加回来：

```bash
OPENCLAW_PROXY_LABELS="ai.openclaw.system.gateway com.openclaw.trading.cron-runner" \
  sudo -E zsh apps/openclaw-config/scripts/install-system-daemons.sh
```

安装结束时脚本会逐行打印每个 daemon 的 `egress=proxy(...)` / `egress=direct`，可以当场核对。

### doctor 的 launchd 检查

`pnpm openclaw:runtime:doctor` 按 ownership 清单逐个探测，**分域询问**：

- `system` 域用 `launchctl print system/<label>`（存在返回 0 并打印 `state = ...`，不存在退出 113）。
- `user` 域用 `launchctl list`。

必须分开问，因为 `launchctl list` 只回答调用者自己的 `gui/$UID` 域——一个加载中且正在运行的系统 daemon 在它的输出里根本不出现。旧版 doctor 只读 `launchctl list`，所以 ac741d8 之后它对 6 个已正确安装的服务永远报 `not_loaded`，还给出一条装不上它们的修复命令。

三种结果：

- 在应属的域里加载 → 不报告（`state` 仍会出现在 snapshot 里供人工核对）。
- 两个域都没有 → warn `launchd-jobs.<name>.not_loaded`，并点名**该域对应的**安装命令（system → `sudo zsh .../install-system-daemons.sh`，user → `pnpm launchd:install-backup-alerts`）。
- 加载在错误的域、或两个域同时加载 → **error** `launchd-jobs.<name>.wrong_domain`。这正是 ownership 清单要防的"一个标签两个 owner"（两个 broker-executor 抢同一个交易数据库），任何开发机都不会误入这个状态。

### 回环探针的严重级取决于 launchd 怎么说（第 5 轮 D2）

另外还会单独探测 platform-app 的 `GET /health`、broker-executor 的 `GET /health`、rsshub 的 `GET /healthz`（404 时回退 `/`）。这三个探针「连不上」的严重级**不是探针的属性，是机器的属性**：

- launchd **没有**持有这个标签 → warn。开发机没装这个服务，连不上是常态。
- launchd **正持有**这个标签 → **error**。装过了、此刻本该在跑，回环连接却被拒，只能是进程起来又崩了或正在崩溃重启循环。
- 连上了但状态码/响应体不对 → error（不变）。

这条是补上第 8 步「过不了才怪」的窟窿。实测：把 platform-app 做成崩溃重启循环、在 launchd 刚把它拉起来的瞬间采样（`state = running`、`last exit code = 1`、`runs = 918`），`/health` 连接被拒，改之前 `analyzeOpenClawRuntimeSnapshot` 返回 `ok=true`、doctor 退出 0、零条 error；broker-executor、gateway 各自单独测同样如此。

同一批还补了常驻服务的崩溃重启循环判定：`state = running` + 上次退出非零时，`runs ≥ 20` 报 `launchd-jobs.<name>.crash_looping`（error），低于阈值仍是原来的 `restarted_after_failure`（warn，"崩过一次但现在好着"）。20 这个阈值是**选的不是测出来的**：常驻 daemon 只有死掉才会累加 `runs`，而 mini 上那四个常驻服务只读实测是 platform-app 2、broker-executor 2、cron-runner 10、gateway 10，其中打印了 `last exit code` 的两个都是 0、另外两个上次是被信号杀死所以根本没这一行——也就是说不管阈值取多少它们都进不了这个分支。真正的判据是探针，这个阈值只是兜住「采样恰好落在两次崩溃之间的存活窗口」。

### platform-app（Phase 3 多成员 Web 平台）

起停：

```bash
pnpm platform:dev    # tsx watch 本地开发
pnpm platform:start  # node dist/index.js，launchd 常驻用的就是这条

# 常驻服务 com.alphaloop.platform-app 从 ac741d8 起是系统域 daemon，
# 由这条（需要 sudo）安装，launchd:install-backup-alerts 装不上它
sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh
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

本机 RSSHub 容器**不由**任何 launchd 任务创建，需要在部署时手动建一次（根 README「部署机安装顺序」第 7 步）：

```bash
zsh -lc 'docker start rsshub 2>/dev/null || docker run -d --name rsshub -p 127.0.0.1:1200:1200 diygod/rsshub'
```

两个细节都是 2026-07-28 在 mini 上实测出来的：

- **`zsh -lc` 不能省。** 非 login shell 里 `command -v docker` 什么都不返回（`zsh:1: command not found: docker`），login shell 里才是 `/opt/homebrew/bin/docker`。用 ssh 或脚本远程执行时默认拿到的正是前者。
- **不要用裸 `docker run`。** 容器已存在时它以 "The container name /rsshub is already in use" 非零退出，把一次正常的重跑变成看起来像失败的部署。`docker start` 在容器已在运行时空转返回 0、容器停止时把它拉起来、容器不存在时返回 1，所以上面的 `||` 写法三种状态都对。

容器创建后，`com.alphaloop.rsshub` launchd 任务（`launchd:install-backup-alerts` 一并安装）负责在每次机器重启后跑 `docker start rsshub`，确保容器继续常驻——它不创建、不重建容器，容器不存在时这一步会失败（`logs/rsshub.err.log` 里会看到 "No such container"），此时需要回去手动跑一遍上面那条命令。

`pnpm openclaw:runtime:doctor` 覆盖两个新闻引擎检查项：

- `rsshub-health`：GET `${RSSHUB_BASE_URL 或默认值}/healthz`（404 时回退 `/`）——容器不可达时，`com.alphaloop.rsshub` 没装是 warn（点名上面的 P10 命令和 `pnpm launchd:install-backup-alerts`），已装则是 error（那个 agent 的全部职责就是 `docker start rsshub`）；返回非 200 状态码一律 error。见上面「回环探针的严重级取决于 launchd 怎么说」。
- `news-engine-health`：`news_events` 表最新一条 `last_published_at` 距今超过 48 小时且表内已有数据（非全新库）→ warn「新闻引擎超过 48 小时无新事件」；全新库（0 条事件）不报告。

### 日报/周报/个股分析调度：已迁移到 OpenClaw cron（2026-07-14）

日报（`report.daily.prepare/deliver`）、周报（`report.weekly.prepare/deliver`）和个股分析（`stock-analysis`）这 5 个调度**不再由 `launchd:install-user` 安装**，它们的唯一 owner 是 OpenClaw cron 通道：

```bash
pnpm openclaw:cron:install
```

该命令会：①先 retire 这 5 个 launchd 任务对应的旧 plist（如果存在）；②同样 retire 系统域已经拥有的那些标签的用户级副本；③把等价的 5 个任务注册进 `openclaw cron`。详见 `docs/superpowers/specs/2026-06-14-openclaw-report-quality-cron-design.md`。

真正执行这些任务的 `com.openclaw.trading.cron-runner` **不再由这条命令安装**——ac741d8 起它是系统域 daemon，归 `sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh`。所以正确顺序是先装 daemon（gateway 起来了，`openclaw cron add` 才连得上），再跑 `openclaw:cron:install`。

**历史教训（2026-07-14 存量代码审计）**：这 5 个标签曾经在 `install-user-schedules.mjs` 和 `install-openclaw-cron.mjs` 里各自硬编码一份——先跑 `openclaw:cron:install`（retire 这 5 个 plist、装 cron 等价物），后跑 `launchd:install-user`（原样重装这 5 个 plist）会让它们同时复活：两个通道各自成功，日报/周报/选股每次都双份生成、双份投递飞书。现在两边共享 `scripts/openclaw-report-launchd-jobs.mjs` 里的同一份标签清单，且都只 retire 不安装，所以这两条谁先谁后都安全、可以任意重跑。

**2026-07-28 补充**：同一类"两个 owner"隐患现在由 `install-launchd-ownership.txt` 统一防守——4 个安装脚本和 doctor 都读它，doctor 会把"标签加载在错误的域"直接报成 error（`launchd-jobs.<name>.wrong_domain`）。
