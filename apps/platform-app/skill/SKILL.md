# AlphaLoop 策略记忆 Skill

> Phase 7 Task 4 交付物（docs/superpowers/plans/2026-07-15-phase7-strategy-memory.md）。
> 本目录是 skill 客户端的**清单**（manifest + 工具映射 + 接入文档）。真实分发到
> 成员本机、真实计时的接入流程是 P10（见本仓库 Phase 7 计划「明确不做」一节）；
> 在此之前，这份清单描述的是"一旦分发，skill 应该怎么配置、能调用什么"。

## 这是什么

AlphaLoop 是一个圈内多人共用的量化交易辅助系统。每位成员在系统里都有：

- **策略记忆**：个股论点（看多/看空、目标区间、失效价）、纪律规则（三档执行）、
  策略卡（场景/入场/风控/离场），三档可见性（系统可用=仅本人 / 公开=进名片圈内可见）。
- 一个**专属 API token**（`members.mjs token issue` 签发，见
  `README-onboarding.md`），把上述记忆通过 HTTP 写入/读取。

这个 skill 让成员自己机器上的个人 agent（如 Claude Code）能够：读自己的策略页/
名片，把盘中判断随手记成"论点判断"或"纪律规则"写回 AlphaLoop，而不需要人工
登录网页操作。

## 配置（两项）

skill 的配置只有两个键，两者都是 per-member（不同成员配置不同）：

| 配置键 | 说明 | 示例 |
| --- | --- | --- |
| `api.baseUrl` | AlphaLoop platform-app 的地址。本地/圈内部署阶段是回环地址；P10 接入 Cloudflare Access 隧道后会是团队域名下的 HTTPS 地址。 | `http://127.0.0.1:4314`（本地）<br>`https://alphaloop.<your-team>.cloudflareaccess.com`（P10 之后） |
| `api.token` | 该成员的个人 API token（`members.mjs token issue` 签发的明文，只显示一次）。**token 是 bearer-only 的写权限凭证，一人一 token，永不共享**。 | `<member 专属 token 明文>` |

两项配置全部**token-scoped 到 owner**：无论调用哪个工具，服务端永远以 token
解出的 `member.id` 作为写入的 owner，请求体里任何试图指定别的 owner 的字段都会
被**忽略**（见下方「写权限边界」）。

## 工具清单

工具按「读」「写」「引用其它阶段能力」三类列出；机器可读版本见
`tools.json`（工具名 -> HTTP 端点的精确映射）。

### 写（本任务新增，Bearer token 专属，见 tools.json 的 `tools` 数组）

| 工具 | 说明 |
| --- | --- |
| `thesis.create` | 创建一条个股论点（symbol/方向/目标区间/失效价/看多看空依据/可见性）。 |
| `thesis.judgment.append` | 给一条已有论点追加一条判断批注（append-only，不可删改）。仅论点所有者可追加。 |
| `thesis.promote` | 把一条论点从「系统可用」升级为「公开」（进名片圈内可见）。仅所有者可操作，降档目前不支持（升档不可逆，符合平台规则）。 |
| `rule.create` | 创建一条纪律规则（三档执行：`hard`/`proposal_check`/`self`）。 |
| `rule.disable` | 停用一条纪律规则（不删除，保留历史）。仅所有者可操作。 |
| `card.create` | 创建一张策略卡（场景/入场/风控/离场/可见性）。 |

### 读（复用既有 GET 页面，非本任务新增；返回 HTML，非 JSON — 见 tools.json 的
`read_only_pages` 数组）

| 页面 | 说明 |
| --- | --- |
| `GET /strategy` | 我的纪律 + 我的论点/策略卡 + 圈子公开区，三段式。 |
| `GET /member/<id>` | 某成员的名片（公开策略卡 + 公开论点清单）。 |
| `GET /stock/<symbol>` | 个股页（含该股相关论点渲染，Task 5 起）。 |
| `GET /proposal/<id>` | 一条交易提案详情（本人或 P6 已批准公开的提案）。 |

这些页面的身份解析同时接受 `Authorization: Bearer` 与
`Cf-Access-Authenticated-User-Email`（`identity.ts` 的 `resolveIdentity`），
所以同一个 token 也能读这些页面 —— 但**只有 Bearer token 能写**（见下）。

### 引用其它阶段的能力（不是本任务交付，仅供 skill 配置时了解全貌）

| 能力 | 状态 |
| --- | --- |
| 提醒（alert）增删改查 | **P2 已上线**，但目前只有本机 CLI
  （`apps/openclaw-config/scripts/market-alerts.mjs`：`add`/`remove`/`pause`/
  `resume`/`feedback`/`list`），尚未开出 bearer HTTP 端点 —— 本 skill 暂不能
  远程调用它，只是如实记录这项能力已经存在。 |
| 提案（proposal）请求 | **P6 已上线**：提案创建仍是本机 CLI
  （`proposals.mjs run create`），HTTP 侧目前只有只读详情页
  `GET /proposal/<id>`（见上）。尚无 bearer 写端点用于"从 skill 直接发起提案"。 |
| 研究提交（research submit） | **P8 尚未上线**（forthcoming）。当前
  `research_tasks` 表只有只读详情页占位（`GET /research/<id>` 渲染
  「研究执行 P8 上线」），没有任何写入路径，CLI 或 HTTP 都没有。 |

以上三项**全部 token-scoped 到 owner** 是既定约束（一旦落地会复用同一枚
`api.token`），本清单先如实标注现状，避免 skill 配置误以为它们已经可以远程
调用。

## 写权限边界（务必读）

- 认证**只认 Bearer token**，`Authorization: Bearer <token>` 缺失或校验失败一律
  401 —— 即使请求带着 `Cf-Access-Authenticated-User-Email` 头也不算数（写是
  「skill / 机器面」，这条头目前没有任何密码学证明，见 `identity.ts` 里
  `verifyAccessJwt` 的 P10 TODO）。
- 请求体里任何 `ownerId` 字段都会被**忽略**：所有写入永远归属 token 解出的
  `member.id`，不存在"帮别人写"的用法。
- 对已有记录的操作（追加判断 / 升可见性 / 停用规则）会先按 id 查行，再比对
  `row.ownerId === token 的 member.id`：id 不存在 -> 404；存在但不是自己的 ->
  403。这两者是不同的状态码，一致对应平台其它端点的约定。
