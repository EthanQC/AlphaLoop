# 规则提案

本目录保存中文规则提案快照。规则提案是策略学习草案，不是可自动生效的规则。

## 生命周期

- 生成：`generate-rule-proposal.mjs` 从 SQLite 中的审批编辑、执行报告、偏好快照和当前规则文件生成中文提案。
- 待确认：新提案默认写入 `pending_confirmation`，并向飞书群推送审核摘要；未确认不生效。
- 补发审核：如需补发当前待确认提案到飞书群，运行 `generate-rule-proposal.mjs --notify-existing`；如只想本地生成，可加 `--no-notify`。
- 激活：必须由人工运行 `activate-rule-version.mjs activate <live|paper> <version> --proposal-id <id> --confirm HUMAN_APPROVED`，并写入审计日志。
- 拒绝：人工运行 `activate-rule-version.mjs reject <proposal-id> --confirm HUMAN_REJECTED --reason "..."`
- 归档：人工运行 `activate-rule-version.mjs archive <proposal-id> --confirm HUMAN_ARCHIVED --reason "..."`

## 提案要求

- 全文使用中文描述策略学习、证据、风险和回滚方式。
- 必须包含当前规则、候选规则、旧新对比表、推荐动作和人工确认状态。
- 不允许自动激活，也不允许通过提案绕过实盘禁令。
- 不恢复期权策略；候选规则中的期权策略必须保持禁用。

旧英文或模板化提案已从工作区删除；本目录只保留中文、可审计、待人工确认的新提案。
