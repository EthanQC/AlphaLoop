# Skill 接入流程（§5.3）

> Phase 7 Task 4 交付物。这份文档描述**操作员**（圈主/管理员）怎么给一个新成员
> 开通 skill 写权限，以及**成员**本人怎么把 skill 配置填好并自证可用。真实分发
> 到成员本机、真实计时是 P10（本文档先把流程钉死，分发机制留给 P10）。

## 前提

- 操作员能访问运行 AlphaLoop 的机器（trading db 所在主机），并且能执行仓库根目录
  下的 `node` 脚本。
- 成员已经知道 AlphaLoop platform-app 对外的地址
  （本地/圈内阶段是 `http://127.0.0.1:4314`；P10 接入 Cloudflare Access 隧道后
  会换成团队域名下的 HTTPS 地址 —— 两种情况下 `api.baseUrl` 都指向这同一个地址）。

## 第一步（操作员）：`members.mjs add` 新增成员

```bash
node apps/openclaw-config/scripts/members.mjs add \
  --email <member-email> \
  --name  <member-display-name>
```

成功输出形如：

```json
{"ok":true,"member":{"id":"member_xxxxxxxx","email":"...","displayName":"...","status":"active", "...": "..."}}
```

记下 `member.id` —— 下一步要用。

## 第二步（操作员）：`members.mjs token issue` 签发该成员的专属 token

```bash
node apps/openclaw-config/scripts/members.mjs token issue \
  --member <member.id 来自第一步> \
  --label  "skill-<member 简称>"
```

成功输出形如：

```json
{
  "ok": true,
  "tokenId": "token_xxxxxxxx",
  "token": "<明文 token，只显示这一次>",
  "memberId": "member_xxxxxxxx",
  "label": "skill-...",
  "warning": "该 token 只会显示这一次，请立即妥善保存；系统不会再次展示明文，遗失后只能吊销并重新签发。"
}
```

**`token` 字段只显示这一次** —— 把它通过安全渠道（当面/加密消息，不要明文过飞书
群）转交给成员本人。系统只存 token 的哈希（`api_tokens.token_hash`），丢失后无法
找回，只能 `token revoke` 后重新 `token issue`。

## 第三步（成员）：填写 skill 配置

按 `SKILL.md` 的两项配置填入成员自己的 skill 配置（具体填写位置取决于 P10 落地
后 skill 实际的分发/配置形式；今天先确认这两个值本身是对的）：

| 配置键 | 值 |
| --- | --- |
| `api.baseUrl` | 操作员告知的 platform-app 地址 |
| `api.token` | 第二步操作员转交的明文 token |

## 第四步（成员）：用一次读调用自证 token 有效

用真实 HTTP 请求验证 token 能正常认证（选一个只读页面即可，不消耗任何写配额）：

```bash
curl -s -H "Authorization: Bearer <api.token>" "<api.baseUrl>/strategy" | head -c 200
```

- 返回 200 且是一段 HTML（`<!doctype html>...`）—— token 有效，接入成功。
- 返回 401 —— token 打错了，或者已被吊销；找操作员核对。

再用一次真实写调用，确认写权限也生效（会真的创建一条论点，用完可以直接留着当
第一条策略记忆，或者知会操作员后续按需处理）：

```bash
curl -s -X POST "<api.baseUrl>/api/theses" \
  -H "Authorization: Bearer <api.token>" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"AAPL.US","direction":"bull"}'
```

返回 `{"ok":true,"thesis":{...,"ownerId":"<member.id>",...},"mirror":{...}}` 即
接入完成 —— 特别确认 `thesis.ownerId` 就是第一步拿到的 `member.id`，而不是别的
任何人（写入的 owner 永远由 token 决定，请求体给不给 `ownerId` 都不影响这一点）。

## 吊销 / 换机

- 成员离开圈子或 token 疑似泄露：操作员执行
  `node apps/openclaw-config/scripts/members.mjs token revoke --token-id <tokenId>`，
  该 token 立即失效（`api_tokens.revoked_at` 置位，`ApiTokenRepository.verify`
  即时生效，不需要重启 platform-app）。
- 成员换机器：不需要新开成员，直接把同一个 `api.baseUrl` + 同一枚
  `api.token` 抄到新机器的 skill 配置里即可 —— token 认证与机器无关。
