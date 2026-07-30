# AlphaLoop 策略记忆 Skill

> 本目录是 skill 客户端的**清单**（manifest + 工具映射 + 接入文档）。机器可读的
> 工具名 → HTTP 端点映射见 `tools.json`，接入步骤见 `README-onboarding.md`。
> 清单与真实路由表由 `manifest.test.ts` 对着运行中的 platform-app 逐条核对，
> 所以下面写的端点都是真的存在、真的能调的。

## 这是什么

AlphaLoop 是一个圈内多人共用的量化交易辅助系统。每位成员在系统里都有：

- **策略记忆**：个股论点（看多/看空、目标区间、失效价）、纪律规则（三档执行）、
  策略卡（场景/入场/风控/离场），两档可见性（系统可用=仅本人 / 公开=进名片圈内可见）。
- 一个**专属 API token**（`members.mjs token issue` 签发，见
  `README-onboarding.md`），把上述记忆通过 HTTP 写入/读取。

这个 skill 让成员自己机器上的个人 agent（如 Claude Code）能够：读自己的策略页/
名片/日报个人页，把盘中判断随手记成「论点判断」或「纪律规则」写回 AlphaLoop，
发起站内研判并把研判结论一键存成论点，确认自己的月度复盘——而不需要人工登录网页。

## 配置（两项）

skill 的配置只有两个键，两者都是 per-member（不同成员配置不同）：

| 配置键 | 说明 | 值 |
| --- | --- | --- |
| `api.baseUrl` | AlphaLoop platform-app 的公网地址（经 Cloudflare Tunnel 暴露，机器上跑的是 `com.cloudflare.cloudflared` 系统 daemon）。 | `https://reports.qingverse.com` |
| `api.token` | 该成员的个人 API token（`members.mjs token issue` 签发的明文，只显示一次）。**token 是 bearer 凭证，一人一 token，永不共享**。 | `<member 专属 token 明文>` |

两项配置全部**token-scoped 到 owner**：无论调用哪个工具，服务端永远以 token
解出的 `member.id` 作为写入的 owner，请求体里任何试图指定别的 owner 的字段都会
被**忽略**（见下方「写权限边界」）。

## 身份：两条路，没有 Cloudflare Access

- **skill / 机器面走 bearer**：`Authorization: Bearer <api.token>`。本文档里所有
  端点都认这一条。
- **浏览器走邮箱验证码登录**：成员在 `GET /login` 输入邮箱，登录码经飞书单聊发到
  本人，验证通过后拿到一枚签名的 `alphaloop_session` cookie（`src/routes/login.ts`
  + `src/session.ts`）。cookie 里只有 member id 和过期时间，每次请求都重新读成员行，
  所以吊销成员会立刻让他手上的会话失效。
- **Cloudflare Access 最终没有启用**，登录是自建的邮箱验证码。历史文档里让你把
  `api.baseUrl` 指向某个 Access 团队域名的说法已经作废，别照做——填上面那个地址。
  （`identity.ts` 里还留着一条 Access header 分支，默认**失败关闭**——没有经过
  验证的 `Cf-Access-Jwt-Assertion` 就不认那个 header，实际部署里它从不生效。）

## 工具清单

工具按「写」「读」「只有 CLI / 飞书能做的」三类列出；精确映射见 `tools.json`。

### 写（Bearer token；`tools.json` 的 `tools` 数组）

| 工具 | 端点 | 说明 |
| --- | --- | --- |
| `thesis.create` | `POST /api/theses` | 创建一条个股论点（symbol/方向/目标区间/失效价/看多看空依据/可见性）。 |
| `thesis.judgment.append` | `POST /api/theses/:id/judgments` | 给一条已有论点追加一条判断批注（append-only，不可删改）。仅论点所有者可追加。 |
| `thesis.promote` | `POST /api/theses/:id/promote` | 把一条论点从「系统可用」升为「公开」（进名片圈内可见）。仅所有者可操作，幂等。 |
| `thesis.demote` | `POST /api/theses/:id/demote` | 把一条论点降回「系统可用」。返回里的 `notice` 固定说明：**降档已生效，但此前已生成的报告/名片内容不回收**——转述时别暗示能撤回历史内容。 |
| `rule.create` | `POST /api/rules` | 创建一条纪律规则（三档执行：`hard`/`proposal_check`/`self`）。 |
| `rule.disable` | `POST /api/rules/:id/disable` | 停用一条纪律规则（不删除，保留历史）。仅所有者可操作。 |
| `card.create` | `POST /api/cards` | 创建一张策略卡（场景/入场/风控/离场/可见性）。 |
| `card.promote` / `card.demote` | `POST /api/cards/:id/promote` `POST /api/cards/:id/demote` | 策略卡的升档 / 降档，与论点同规则；降档同样带 `notice`。 |
| `research.submit` | `POST /api/research` | 提交一条站内研判（body 只读 `question`）。返回 `taskId` + 任务页地址；跑完后结论会推到本人飞书单聊。配额用完返回 429，按美东交易日切界重置。 |
| `research.promote` | `POST /api/research/:id/promote` | 把自己的研判从「仅本人可见」升为圈内公开。仅所有者可操作，重复调用幂等。 |
| `research.thesis` | `POST /api/research/:id/thesis` | 「存为论点」：把一条已完成研判的结论存成自己的论点（默认落在「系统可用」档——存不等于发布）。 |
| `review.confirm` | `POST /api/reviews/:id/confirm` | 确认自己的月度复盘（draft → confirmed，一次性、幂等）。确认后结论镜像进本人私有记忆并发一张本人确认卡。 |

论点 / 纪律 / 策略卡那几行（`thesis.*`、`rule.*`、`card.*`）是 **bearer-only**
（`resolveBearerIdentity`）：只带 cookie 不带 token 一律 401。`research.*` 与
`review.confirm` 走 `resolveIdentity`，bearer 或浏览器 cookie 都认——因为页面上的
按钮和 skill 调的是同一个端点。

### 读（复用既有 GET 页面，返回 HTML；`tools.json` 的 `read_only_pages`）

| 页面 | 说明 |
| --- | --- |
| `GET /` | 首页。 |
| `GET /strategy` | 我的纪律 + 我的论点/策略卡 + 圈子公开区，三段式。 |
| `GET /member/<id>` | 某成员的名片（公开策略卡 + 公开论点清单）。 |
| `GET /stock/<symbol>` | 个股页：公共分析 + 「我的论点卡」（只含调用者本人的论点与他人**公开**的论点）。 |
| `GET /reports` | 报告列表：公共日报/周报/个股分析，加上**调用者本人的**模拟盘快照；别人的模拟盘产物永远不出现在这里，被挡掉的份数会如实披露。 |
| `GET /daily/<date>` `GET /weekly/<date>` | 公共日报 / 周报（不含任何人的持仓与盈亏）。 |
| `GET /daily/<date>/me` `GET /weekly/<date>/me` | **本人**的日报 / 周报个人页（持仓速览、纪律对照、提醒回顾）。owner-scoped，没有任何办法读到别人的。 |
| `GET /stock-analysis/<date>` | 某一批公共个股分析全文。 |
| `GET /official-paper/<date>` | 模拟盘当日收支产物，**仅归属成员本人可读**。 |
| `GET /research/<id>` | 一条研判：跑的过程实时步骤流，跑完是结论页。仅本人可见，除非升为公开。 |
| `GET /review/<id>` | 月度复盘，仅本人可读（他人一律 403，无论 draft 还是 confirmed）。 |
| `GET /proposal/<id>` | 一条交易提案详情，仅本人可读（他人真实 id → 403，不存在 → 404）。 |
| `GET /news` `GET /paper` | 新闻页 / 模拟盘净值与配置页。 |
| `GET /health` | `{ok:true}`，唯一不需要身份的路由（登录页除外）。 |

同一枚 token 也能读这些页面。写的边界见下。

### 只有本机 CLI / 飞书能做的（`tools.json` 的 `existing_but_not_yet_http`）

| 能力 | 现状 |
| --- | --- |
| 提醒（alert）增删改查 | 已上线，但只有本机 CLI（`market-alerts.mjs`：`add`/`remove`/`pause`/`resume`/`feedback`/`list`），或者直接在飞书里让机器人代跑同一条命令。**没有** bearer HTTP 端点，skill 不能远程调用。 |
| 提案（proposal）发起 | 已上线，创建仍是本机 CLI（`proposals.mjs create`）或飞书对话；HTTP 侧只有只读的 `GET /proposal/<id>`。审批永远只认成员本人点自己单聊里的卡片。 |
| 按需个股分析 | 已上线，本机 CLI `stock-analysis.mjs analyze <SYMBOL>`，或在飞书里让机器人跑。**只读、不入库**：给提问者渲染一份该标的的分析，不写公共分析库、不写预测表。公开那份在 `GET /stock/<symbol>`。 |

## 写权限边界（务必读）

- `thesis.*` / `rule.*` / `card.*` 这几个写端点**只认 Bearer token**，
  `Authorization: Bearer <token>` 缺失或校验失败一律 401——带着浏览器 cookie 也不
  算数（写是「skill / 机器面」）。
- 请求体里任何 `ownerId` 字段都会被**忽略**：所有写入永远归属 token 解出的
  `member.id`，不存在「帮别人写」的用法。
- 对已有记录的操作（追加判断 / 升降可见性 / 停用规则 / 升级研判 / 确认复盘）会先按
  id 查行，再比对 `row.ownerId === token 的 member.id`：id 不存在 → 404；存在但
  不是自己的 → 403。这两者是不同的状态码，与平台其它端点一致。
