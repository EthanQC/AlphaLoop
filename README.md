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

`pnpm test` 对仓库里真实的 `runtime/`（含 `trading.sqlite` 和长桥限流账本）是只读的：`test/runtime-write-guard.ts` 在每个用例前后、`test/global-setup.ts` 在整轮前后各比对一次该目录，任何写入都会让对应用例失败（见 5df98b9）。

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

## 部署机安装顺序（2026-07-29 起：跑一条脚本，不要粘贴命令块）

无人值守的 8 个服务在 ac741d8 之后全部住在 `/Library/LaunchDaemons`（系统域，开机即起，不需要有人登录图形界面）；只有 `com.alphaloop.rsshub` 仍是用户级 LaunchAgent，因为它依赖用户级的 colima/docker socket。谁拥有哪个标签，唯一事实来源是 `apps/openclaw-config/scripts/install-launchd-ownership.txt`。

### ⚠ 跑之前必读：第 3 步会打断你自己的 OpenClaw agent

第 3 步重启 `ai.openclaw.system.gateway`。在 mini 上，那个 gateway **不是 AlphaLoop 专用的**——2026-07-28/29 只读实测：

- 18789 上**只有它一个**监听进程（`node`，用户 `qingchang`，同时监听 `127.0.0.1` 和 `[::1]`），没有第二个 gateway 可以兜底；
- 操作者自己的 `~/.openclaw/openclaw.json` 里配了 **185 个带 workspace 的 agent**，`~/.openclaw/agents` 下有 **187 个目录**，全部由这一个进程提供服务；
- 写这段话的时候它底下**正挂着一个活着的 codex 会话**（gateway pid 21802 → `node` 27714 → `.../@openai/codex-darwin-arm64/.../bin/codex`）。

**所以：跑第 3 步 = 你个人正在跑的 agent 会话会被打断。**重启后子进程不会自己回来。

跑之前请：①确认没有正在跑的会话（`openclaw cron status`，以及看一眼 gateway 的子进程），等它跑完或手动停掉；②把重要的 codex 会话结果落盘；③挑一个你自己不用 agent 的时间窗口。确认了才带上 `DEPLOY_ACK_GATEWAY_RESTART=yes`——没有这个确认，部署脚本会在**什么都还没做**的时候停下来。

### 跑之前先确认这四件事

开发机（代码写在哪台就是哪台）：

```bash
git rev-list --count origin/main..HEAD    # 必须是 0
```

不是 0 就先 `git push origin main`。部署机只认 `origin`，本地没 push 的 commit 它拉不到。

部署机（下面按 mini 的实际布局写成 `~/AlphaLoop`，换机器时替换成实际检出路径）：

```bash
id -un                                                   # 记下这个用户名，第 3 步的 daemon 以他的身份运行
git -C ~/AlphaLoop status --porcelain | grep -v '^??'    # 必须无输出（未跟踪的 reports/ 产物不算）
zsh -lc 'command -v pnpm node docker'                    # 三个都要有
```

最后一条必须走 login shell：mini 上 `ssh … 'command -v docker'` 什么都不返回，`ssh … zsh -lc 'command -v docker'` 才返回 `/opt/homebrew/bin/docker`。Homebrew 的 PATH 只在 login shell 里，第 7 步会踩到这一点。

工作区有已跟踪文件的本地改动时，第 0 步的 `git pull --ff-only` 会中止——部署脚本会**先**检查这一点并把文件名打出来，而不是让 git 报一句看不出后果的话。

### 部署：一条命令

```bash
cd ~/AlphaLoop
DEPLOY_ACK_GATEWAY_RESTART=yes zsh apps/openclaw-config/scripts/deploy.sh
```

它按顺序跑第 0 到第 8 步，**任何一步非零退出就立刻停下**，并且把每一步的退出码写进 `runtime/deploy/steps.jsonl`。失败时它会告诉你：哪一步失败、后面哪些步骤因此没有执行、以及怎么从那一步继续：

```bash
DEPLOY_ACK_GATEWAY_RESTART=yes DEPLOY_FROM_STEP=3 zsh apps/openclaw-config/scripts/deploy.sh
```

**为什么必须是脚本而不是粘贴命令块。** 2026-07-29 之前这一节就是一段可以整体复制的命令序列——没有 `&&`、没有 `set -e`、没有任何守卫（这一点看那段文本本身就能确认）。第 5 轮实测到的后果：让第 0 步的 `git pull --ff-only` 因为一个改动过的 README 中止，第 1 到第 8 步照样全部跑完，跑的全是**旧 commit 的代码**，最后第 8 步还给了绿灯。同一个形状对每一步都成立：第 3 步退出 1 拦不住第 4 步去动它刚刚有意保留的退路。粘进交互式 shell 的命令块没法 fail-fast（`set -e` 会把操作者的 ssh 会话一起杀掉），所以 runbook 变成了这个脚本。

**验收以第 8 步的退出码为准**（0 = 通过）。第 8 步现在也会因为「部署收据里有失败的步骤」而报错——也就是说，跑到一半失败的部署，不可能在下一次验收时装作没发生过。

### 0 → 8 分别在做什么（也是手工重跑单步时的参考）

上面那条脚本跑的就是下面这些。除第 0 步外整段可以任意次数重跑，但每一步的幂等方式不同：

```bash
# 0. 把新代码弄到这台机器上——全流程唯一的代码传输步骤。
#    脚本会先检查工作区是否干净（有改动就直接报文件名并停下），再 fetch + pull --ff-only。
#    可重跑：已经最新时 --ff-only 打印 "Already up to date" 并退出 0。
git -C ~/AlphaLoop fetch origin && git -C ~/AlphaLoop pull --ff-only origin main

# 1. daemon 直接跑 dist 产物，必须先装依赖并构建（可重跑）
pnpm install && pnpm build

# 2. 安装用户级任务（当前只有 com.alphaloop.rsshub），并顺带 `openclaw gateway install`。
#    必须排在第 3 步之前：这一步会创建用户级 ai.openclaw.gateway，第 3 步会把它 bootout；
#    顺序反了，用户级 gateway 会活到最后，和系统 gateway 抢同一个 18789 端口。
#    可重跑：每个模板都是 launchctl unload 之后再 load。
pnpm launchd:install-backup-alerts

# 3. 安装 8 个无人值守服务到 /Library/LaunchDaemons。【需要 sudo，且会重启 gateway，见上面的警告】
#    先干跑一次，确认这次会为哪个用户安装（不写任何文件、不建目录、不调 launchctl）：
PRINT_CONFIG_ONLY=1 zsh apps/openclaw-config/scripts/install-system-daemons.sh
#    确认输出里的 target_user / target_home / node_bin 是部署机操作者本人的之后，再真正安装。
#    它按【服务】逐个交接：①停掉该服务的用户级副本 → ②bootstrap 它的 daemon
#    → ③**验证它真的在跑**（不是"launchctl 认得它"）→ ④确认后才把该标签的用户级 plist
#    【移进】备份目录（永远是移动，不是删除）。
#    第 ③ 步是 2026-07-29 补的：之前它只问 `launchctl print` 退出码，那只能证明"注册过"。
#    2026-07-29 把【HEAD 上那一版】和现在这一版放进同一个沙箱、同一个 launchctl stub
#    对照跑，注入 platform-app / broker-executor / market-alerts 三个 daemon「bootstrap
#    成功但当场就死」（state = not running、last exit code = 1）：
#      HEAD 那版  → 退出 0、8 个标签全部打印成 loaded、两份用户级 plist 全部归档掉
#      现在这版    → 退出 1、死掉的打印成 NOT RUNNING、两份 plist 原样留在磁盘上现在它按 launchd-health.mjs 的
#    residency 契约判定：常驻服务必须 state = running，周期任务的首次运行不能异常退出，
#    不满足就【不归档】、把刚停掉的用户级 agent 立刻 bootstrap 回去，并以退出码 1 汇总。
#    用户级副本 bootout 之后仍然活着时，这个服务【不会】被 bootstrap（两份一起跑会抢同一个
#    端口和同一份 trading.sqlite），而是原地保留旧的那份并报错。
#    可重跑；退出码 1 不代表整批失败：它逐个装完再汇总，打印
#    "FAILED - N of M daemons did not come up" 加上还有几个是 running 的。
sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh

# 4. 收尾清理旧标签。这条脚本从 2026-07-28 起【只退役、不再安装任何 plist】。
#    它同样不删除任何东西：退役 = 移进 ~/Library/LaunchAgents.disabled/openclaw-system-backup-<时间戳>/。
#    而且对第 3 步管的那 8+1 个标签，它会先问 `launchctl print system/<label>`：
#    接管它的 daemon 没加载 → 这份用户级副本【就是机器现在跑的那份】，原地不动、
#    只打印 keptLaunchAgent 并以退出码 1 结束。
pnpm launchd:install-user

# 5. 注册 5 个报告类 openclaw cron 任务（需要第 3 步的 gateway 已经在跑）
#    可重跑：每个任务都先 `cron rm` 掉同名旧任务再 add，不会注册两份。
#    某一条装不上时，它会继续装剩下的、逐条列出失败原因（不再是一条 uncaught 异常的裸栈），
#    最后以退出码 1 结束并写下部署收据——第 8 步会因此报错。
pnpm openclaw:cron:install

# 6. 部署 control agent 人设，否则飞书机器人会以无人设的 vanilla Codex 应答（整份覆盖写，可重跑）
node apps/openclaw-config/scripts/render-openclaw-config.mjs

# 7. 创建 rsshub 容器（之后由 com.alphaloop.rsshub 负责重启后 docker start）。
#    必须用 login shell：docker 只在 login shell 的 PATH 里（见上一节）。
#    下面是可重跑的写法：容器在跑 → docker start 空转退出 0；容器停了 → 拉起来；
#    容器不存在 → docker start 退出 1，才落到 docker run 去创建。
#    不要退回裸 `docker run -d --name rsshub …`：容器已存在时它会以
#    "The container name /rsshub is already in use" 非零退出，看起来像部署失败。
zsh -lc 'docker start rsshub 2>/dev/null || docker run -d --name rsshub -p 127.0.0.1:1200:1200 diygod/rsshub'

# 8. 验收：以【退出码】为准（0 = 通过；1 = 有 error 级发现项）。
pnpm openclaw:runtime:doctor
```

### 第 8 步现在拦得住什么

这道门在 2026-07-29 之前拦不住"部署失败"本身——第 5 轮实测的五个 critical 全是同一个形状：某一步失败了、明明白白打印了、非零退出了，而这道门仍然 `ok=true` 退出 0。现在它会在下列情况上失败：

- **部署收据里有失败的步骤**（`deploy-ledger.step_N_failed`，error）。`deploy.sh` 和 `install-system-daemons.sh` 会把每一步的退出码写进 `runtime/deploy/steps.jsonl`；修好那一步再重跑，成功的新收据会覆盖它。收据缺失或对应的是别的 commit 只报 warn——"没有证据"不等于"失败"。
- **这台机器的检出不是你 push 的代码**（`deploy-checkout.behind_origin`，error）：直接比较 `HEAD` 和本地的 `origin/main` ref（不联网、不 fetch）。
- **某个标签一个域都没装**（`launchd-jobs.<name>.not_loaded`）。这在**已经部署过的机器**上是 error（判据：有部署收据、或者已有别的受管标签处于加载状态、或者磁盘上已经有受管标签的 plist）；在完全没有部署痕迹的开发机上仍然只是 warn。
- **常驻服务在崩溃重启循环**（`crash_looping`，error）：`runs ≥ 20` 即成立，不再要求"上次退出码非零"。原因是 `runs` 只在服务死掉时增加、而且每次重新 bootstrap 都会清零（本机实测：同一个标签 bootout+bootstrap 之后 runs 从 3 回到 1），所以它累计不到部署次数上去。旧规则挂在 `last exit code` 上，而**被信号杀死的 job 根本不打印这一行**（mini 上的 platform-app 现在就是这样：只有 `last terminating signal = Terminated: 15`），于是整个分支对这类死法不可达。信号本身也纳入判定，但 SIGTERM/SIGKILL 除外——那正是 `launchctl bootout` 和 `kickstart -k` 发的信号，也就是这套安装脚本每次都会对每个 daemon 做的事。
- **`~/Library/LaunchAgents` 里还留着系统域标签的用户级 plist**（`launchd-plists.stray_user_copy`，error）。此刻它们没有加载，所以 launchd 任务表看不出问题；但下次登录时 launchd 会把它们全部 bootstrap 起来，同一个服务就有两份在抢同一个端口和同一份 `trading.sqlite`。通常是归档目录写不进去留下的。
- **5 个报告类 openclaw cron 任务缺了任何一个**（`openclaw-cron.jobs_missing`，error）。这 5 条任务就是日报、周报和个股分析本身。读不到 cron 任务表时，已部署的机器算 error、开发机算 warn。
- **报告投递去向没配好**（`notification-routing.*`）：`FEISHU_GROUP_CHAT_ID` 没配（公共卡改投私聊、或者根本发不出去）、`PLATFORM_PUBLIC_BASE_URL` 没配（卡片按钮点不进任何页面）、或者最近一次投递确实降级成了私聊。这三项只看"配没配"，不读也不打印具体值。
- **回环探针连不上一个 launchd 正持有的标签**（platform-app / broker-executor / rsshub 的 `unreachable` 从 warn 升为 error；标签根本没装的开发机仍然只是 warn）。
- 标签装在错误的域、周期任务上次运行失败、备份/模拟盘产物过期、人设文件缺失（第 3、4 轮就有的检查项，未变）。

这一步对交易库是只读的（3d19dfc 之后）：三个读库检查项走 `new DatabaseSync(path, { readOnly: true })`，既不会 `migrate()`，也不会把一个不存在的库凭空建出来再对着空库报健康。2026-07-28 实测：对着真实 `runtime/trading.sqlite` 跑完整条命令，文件 sha256 不变；唯一残留副作用是 WAL 读取本身会生成 `-shm`/`-wal` 边车文件。⚠ 所以 migration 不发生在这一步：真正把交易库升到 `SCHEMA_VERSION 17` 的是第 3 步起来的那几个 daemon（broker-executor / platform-app / cron-runner 启动时都调 `openTradingDatabase`，该函数结尾必定跑 `migrate()`）。

哪些要 sudo、装给谁：

| 命令 | 需要 sudo | 装到哪 | 服务以谁的身份运行 |
| --- | --- | --- | --- |
| `pnpm launchd:install-backup-alerts` | 否 | `~/Library/LaunchAgents` | 当前登录用户 |
| `sudo zsh .../install-system-daemons.sh` | **是** | `/Library/LaunchDaemons` | plist 里的 `UserName`，默认取 `SUDO_USER`（即敲 sudo 的那个人），**不是 root** |
| `pnpm launchd:install-user` | 否 | 什么都不装（只退役，且只移动不删除） | — |
| `pnpm openclaw:cron:install` | 否 | `openclaw cron`（不写 plist） | 当前登录用户的 gateway 会话 |

`package.json` 里另有一条 `pnpm launchd:install-system`，跑的就是同一个 `install-system-daemons.sh`。它同样需要 root，而 `sudo pnpm` 未必能在 root 的 PATH 里找到 pnpm，所以上面统一写成 `sudo zsh <脚本路径>`；不加 sudo 直接跑会被脚本拦下并打印这条正确命令。

`install-system-daemons.sh` 的 `TARGET_USER` 默认值：有 `SUDO_USER` 就用它，否则用 `id -un`；解析成 `root` 会直接拒绝安装（repo 检出、`~/.openclaw` 凭据、node 都在操作者家目录里，让 daemon 跑成 root 是错的）。装给别人用 `TARGET_USER=<用户名> sudo -E zsh ...`。它同样会检查 `NODE_BIN`（默认 `~/.local/node-v24/bin/node`）确实是个可执行的 node——那条路径会被写进三个 plist，指错了就是三个"能加载、每次运行都 ENOENT"的 daemon。

**不要**再按旧文档单独跑 `pnpm launchd:install-user` 或 `pnpm launchd:install-backup-alerts` 当作"完整安装"：前者现在只退役、不安装，后者只安装 rsshub 一个用户级任务。只跑这两条的机器，8 个无人值守服务会被全部下线且一个都装不回来。

迁移一台还在跑旧布局的机器——跑上面那条 `deploy.sh` 即可，不需要额外的手工清理。整条链路上**没有任何一步会删除 plist**：第 3、4、5 步一律是移进 `~/Library/LaunchAgents.disabled/openclaw-system-backup-<时间戳>/`。要回退某个服务到旧的用户级副本：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents.disabled/openclaw-system-backup-<时间戳>/<label>.plist
```

归档失败（比如 `~/Library/LaunchAgents.disabled` 被早期 sudo 运行建成了 root 所有——mini 上现在就是这样）时，脚本保留 plist 原地不动并以退出码 1 报出来，绝不会因为归档不了就改成删除。修法：`sudo chown -R "$(id -un)":staff ~/Library/LaunchAgents.disabled`。这种机器下次登录会双份加载，所以第 8 步现在会以 `launchd-plists.stray_user_copy` 直接报 error。

迁移前 doctor 会对这 6 个标签报 `wrong_domain` error，迁移后应当全部消失。

**第 0 步对迁移是必须的，不是可选项。** 迁移逻辑本身就住在新代码里：mini 上那份 `install-system-daemons.sh` 是 7 月 16 日的旧版（6111 字节），既没有 `install-launchd-ownership.txt` 可读，`TARGET_USER` 又写死成一个它上面并不存在的用户。跳过第 0 步直接从第 1 步开始，第 3 步会在解析 `TARGET_UID` 时当场退出，什么都装不上。

2026-07-28 只读实测的 mini 现状（尚未迁移）：`~/Library/LaunchAgents` 里有 `com.alphaloop.daily-backup` / `market-alerts` / `platform-app` / `rsshub`、`com.openclaw.trading.cron-runner` / `official-paper.poll` / `official-paper.pnl` 七个用户级 agent（`launchctl list` 全部在列，platform-app 上次退出码 -15、rsshub 为 1），`/Library/LaunchDaemons` 里只有 `ai.openclaw.system.gateway` 和 `com.openclaw.system.trading.broker-executor` 两个 daemon；用户级 `ai.openclaw.gateway` 当前不存在。也就是说 8 个系统域标签里有 6 个还在错误的域上。

## 调度任务清单

- `com.alphaloop.platform-app`（系统域，`KeepAlive`）——`pnpm --filter @apps/platform-app start`，日志 `logs/platform-app.log`。
- `com.alphaloop.market-alerts`（系统域，每 300 秒）——盘中提醒轮询。
- `com.alphaloop.daily-backup`（系统域，每天 05:30）——交易数据库备份。
- `com.openclaw.trading.cron-runner`（系统域，`KeepAlive`）——执行 openclaw cron 派发的日报/周报/个股分析。
- `com.openclaw.trading.official-paper.poll` / `.pnl`（系统域，每小时 :30 / :00）——官方模拟盘轮询与收支变化表。
- `ai.openclaw.system.gateway` / `com.openclaw.system.trading.broker-executor`（系统域，`KeepAlive`）。
- `com.alphaloop.rsshub`（**用户域**，`RunAtLoad=true`/`KeepAlive=false`）——每次重启跑一次 `docker start rsshub`；容器本体不由它创建，见上面第 7 步。

`pnpm openclaw:runtime:doctor` 会按上面这张表逐个探测：系统域用 `launchctl print system/<label>`，用户域用 `launchctl list`——两个域分开问，因为 `launchctl list` 只回答调用者自己的 `gui/$UID` 域，系统 daemon 在它的输出里根本不出现。装错域（例如迁移只做了一半，服务还留在 `~/Library/LaunchAgents`）报 `launchd-jobs.<name>.wrong_domain`，是 error 不是 warn。

## 新闻引擎（Phase 4）

L1 多源采集（RSSHub 中文源 + Finnhub + 既有 Yahoo/Google/Longbridge）→ 事件聚类 → SQLite 持久化，供日报「多源新闻（事件聚类）」段和平台新闻页共用。

- 环境变量（可选，见 `.env.local.example`）：`FINNHUB_API_KEY`（Finnhub company-news 鉴权，未设置时该源整体跳过）、`RSSHUB_BASE_URL`（本机 RSSHub 地址，默认 `http://127.0.0.1:1200`）。
- RSSHub 容器点火命令见「部署机安装顺序」第 7 步（`docker start … || docker run …`，必须走 login shell）；建好之后由 `com.alphaloop.rsshub` launchd 任务负责重启后 `docker start`。
- `pnpm openclaw:runtime:doctor` 覆盖 `rsshub-health`（容器 `/healthz` 探活；`com.alphaloop.rsshub` 已加载时不可达算 error，没装才是 warn，非 200 一律 error）和 `news-engine-health`（`news_events` 超过 48 小时无新事件且非全新库 → warn）两个检查项。

## 本地接口

- `GET http://127.0.0.1:4312/health`
- `GET http://127.0.0.1:4312/v1/rules/active`
- `POST http://127.0.0.1:4312/v1/tickets`

`/v1/tickets` 只允许官方模拟盘股票/ETF 在安全环境齐全时继续；实盘、shadow、期权都会被拒绝。

- `GET http://127.0.0.1:4314/health`（platform-app；端口可用 `PLATFORM_APP_PORT` 覆盖，默认 4314）

## 公网入口（cloudflared）

platform-app 只监听 `127.0.0.1:4314`，不开任何公网端口。外网访问一律经 Cloudflare Tunnel 的**出站**连接回源。

**mini 上跑的是哪一份（2026-07-28 只读实测）：**

| 项 | 值 |
| --- | --- |
| launchd 标签 | `com.cloudflare.cloudflared`（系统域 LaunchDaemon，`root:wheel`，7 月 27 日安装） |
| 命令行 | `/opt/homebrew/bin/cloudflared --config /etc/cloudflared/config.yml tunnel run` |
| 状态 | `launchctl print system/com.cloudflare.cloudflared` → `state = running` |
| 凭据 | `/etc/cloudflared/<tunnel-uuid>.json`，`root:wheel` 0600（named tunnel，不是 token 模式） |
| 实测可达 | `https://reports.qingverse.com/health` → HTTP/2 200，走 Cloudflare anycast（104.21.27.3 / 172.67.139.197），响应带 `cf-cache-status` |

这个 daemon 由 `cloudflared service install` 安装，**不归本仓库**，所以在 `install-launchd-ownership.txt` 里记为 `external`——列出来是为了让「谁拥有哪个标签」的清单真的覆盖公网入口，而不是让任何安装脚本去动它。改隧道请改 `/etc/cloudflared/config.yml` 再 `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`。

**仓库里那条 `pnpm tunnel:install` 是另一套路径**：它装的是用户级 LaunchAgent `com.alphaloop.cloudflared-tunnel`，走 token 模式（`cloudflared tunnel run --token …`，ingress 配在 Zero Trust 后台而不是磁盘上）。两个标签不同名，launchd 会让它们**同时**跑——在已有系统 daemon 的机器上跑它，等于在活着的公网入口旁边再拉起第二个 connector。因此该脚本检测到 `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` 存在时直接拒绝安装（`--force` 可强制；`--dry-run` 的 JSON 里 `systemDaemonPresent` / `wouldRefuse` 会先告诉你结论）。**mini 属于这种情况，不要在 mini 上跑 `pnpm tunnel:install`。** 它是给还没有任何 connector 的新机器用的。

doctor 目前不探测这两个标签中的任何一个（ownership 清单里 `external` 行不参与 `launchd-jobs.*` 检查）。隧道是否健在只能手工确认：`curl -sS -o /dev/null -w '%{http_code}\n' https://reports.qingverse.com/health`。

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

## 浏览器登录（邮箱验证码 + 飞书）

Cloudflare Access 未启用（Zero Trust 需要付款方式），因此 `Cf-Access-Authenticated-User-Email`
这条身份链路在生产环境永久 fail-closed。浏览器改走自建的邮箱验证码登录：

1. 未登录访问任意页面 → 401，页面本身就是登录表单（也可直接访问 `/login`）。
2. 输入圈内邮箱 → 无论邮箱是否在册都返回同一句「验证码已发送」（防成员枚举）；
   只有「active 且已配置 `feishu_open_id`」的成员才真的会收到卡片。
3. 6 位验证码通过成员本人的飞书私聊下发，10 分钟有效、一次性、最多 5 次错误尝试。
4. 验证通过后下发签名会话 Cookie（`alphaloop_session`，HttpOnly / Secure / SameSite=Lax，30 天）。
5. `/logout` 清除 Cookie。撤销成员（`members.mjs revoke`）会立即使其已签发的 Cookie 失效。

限流：同一邮箱 15 分钟内最多 3 条、两条之间至少间隔 60 秒；同一 IP 15 分钟内最多 10 条。
被限流时返回的仍是同一句「验证码已发送」。

- `PLATFORM_SESSION_SECRET`：**必填**，会话 Cookie 的签名密钥。未设置时进程直接拒绝启动
  （没有任何默认值）。生成方式：`openssl rand -base64 48`。轮换该值会立即失效所有会话。
