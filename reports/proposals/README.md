# 规则提案

本目录保存中文规则提案快照。规则提案是策略学习草案，不是可自动生效的规则。

## 生命周期

- 生成：`generate-rule-proposal.mjs` 从 SQLite 中的审批编辑、执行报告、偏好快照和当前规则文件生成中文提案。
- 待确认：新提案默认写入 `pending_confirmation`，并向飞书群推送审核摘要；未确认不生效。
- 补发审核：如需补发当前待确认提案到飞书群，运行 `generate-rule-proposal.mjs --notify-existing`；如只想本地生成，可加 `--no-notify`。
- 群内低风险审核：可信操作人在飞书群回复 `继续观察 <proposal-id> [原因]`、`拒绝 <proposal-id> <原因>`、`归档 <proposal-id> <原因>`，由 `review-rule-proposal.mjs` 写入状态和审计日志。
- 一审建议激活：回复 `建议激活 <proposal-id> <原因>` 只会写入 `activation_requested`，不会修改 active-version。
- 二次确认激活：回复 `确认激活 <proposal-id> HUMAN_APPROVED <原因>` 才会调用激活脚本；候选规则文件必须已人工落地，并写入审计日志。
- 本地激活：也可人工运行 `activate-rule-version.mjs activate <live|paper> <version> --proposal-id <id> --confirm HUMAN_APPROVED`，但不推荐绕过飞书两步审核记录。
- 本地拒绝/归档：仍可运行 `activate-rule-version.mjs reject|archive ... --confirm ... --reason "..."` 做维护操作。

## 飞书回复语法

- `继续观察 proposal_xxx 样本还不够`
- `拒绝 proposal_xxx 风险收益不匹配`
- `归档 proposal_xxx 已被新提案替代`
- `建议激活 proposal_xxx 审批记录连续支持收紧仓位`
- `确认激活 proposal_xxx HUMAN_APPROVED 已复核候选规则文件和回滚方式`

## 提案要求

- 全文使用中文描述策略学习、证据、风险和回滚方式。
- 必须包含当前规则、候选规则、旧新对比表、推荐动作和人工确认状态。
- 不允许自动激活，也不允许通过提案绕过实盘禁令。
- 不恢复期权策略；候选规则中的期权策略必须保持禁用。

旧英文或模板化提案已从工作区删除；本目录只保留中文、可审计、待人工确认的新提案。
