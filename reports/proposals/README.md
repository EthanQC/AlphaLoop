# 规则提案

本目录保存中文规则提案快照。规则提案是策略学习草案，不是可自动生效的规则。

## 生命周期

- 生成：`generate-rule-proposal.mjs` 从 SQLite 中的审批编辑、执行报告、偏好快照和当前规则文件生成中文提案。
- 待确认：新提案默认写入 `pending_confirmation`，未确认不生效。
- 激活：必须由人工运行 `activate-rule-version.mjs activate <live|paper> <version> --proposal-id <id> --confirm HUMAN_APPROVED`，并写入审计日志。
- 拒绝：人工运行 `activate-rule-version.mjs reject <proposal-id> --confirm HUMAN_REJECTED --reason "..."`
- 归档：人工运行 `activate-rule-version.mjs archive <proposal-id> --confirm HUMAN_ARCHIVED --reason "..."`

## 提案要求

- 全文使用中文描述策略学习、证据、风险和回滚方式。
- 必须包含当前规则、候选规则、旧新对比表、推荐动作和人工确认状态。
- 不允许自动激活，也不允许通过提案绕过实盘禁令。
- 不恢复期权策略；候选规则中的期权策略必须保持禁用。

旧英文或模板化提案已移入 `archive/`，只保留审计参考，不再进入周报摘要。
