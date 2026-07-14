# AlphaLoop 实施总路线图

> 依据：`docs/superpowers/specs/2026-07-12-detailed-requirements.md` + `2026-07-12-tech-selection.md`（用户已批准开工）。
> 执行方式：每阶段一份详细计划（writing-plans 规范），superpowers:subagent-driven-development 逐任务派发子 agent 实现，任务间两段式 review；**每阶段收尾必须：子 agent code review + 实测（verification-before-completion）**。
> 开发在本机 MacBook；部署目标 Mac mini（Phase 10 点火需用户配合，此前全部为可本地开发+单测的代码工作）。

| 阶段 | 内容 | 交付判定 | 计划文件 |
|---|---|---|---|
| **P1 地基 ✅(2026-07-12 交付)** | 版本化 DB 迁移 + 多成员表/owner 列 + 分散 DDL 清理 + 每日备份 + 失败停机状态机 + 飞书交互卡片能力 + 仓库卫生/宪法同步 | `pnpm test` 全绿；迁移可从现库无损升级；卡片 API 带 stub 单测 | `2026-07-12-phase1-foundation.md`（已写） |
| **P2 提醒引擎 ✅(2026-07-13 交付)** | market-alerts 规则评估（四类/滞回/冷却/配额/owner 隔离）+ CLI + launchd 轮询模板 + 交易日历 fail-loud | 全部规则单测；历史行情回放测试 | 待写 |
| **P2.5 加固 ✅(2026-07-14 交付)** | 清空 P1/P2 全部技术欠账：提醒器心跳/失败升级（五轮对抗修复）+ doctor 检查隔离与 launchd 接线 + schema v7（per-owner 标的池/CHECK/FK）+ 写入方 owner 感知与不变量下沉 + 存量代码审计（49-agent，38 项确认）16 项修复；下单链路 7 项记为 P6 前置 | 623 测试 ×3 全绿；备份往返/doctor/poll/CLI 负向全部实测 | `2026-07-13-phase2.5-hardening.md`；审计报告 `specs/2026-07-14-opus-era-audit.md` |
| P3 站点与平台 | 静态生成器（5 页+下钻页，final.html 主题 token）+ platform-app 身份网关（Access 邮箱头/bearer token）+ 静态服务 | 本地起服务双账号实测隔离 | 待写 |
| P4 新闻引擎 | RSSHub 接入+Finnhub+事件聚类（新建）+L2/L3 受限检索+质量门扩展+最小事实表 | 坏样本全拦截；聚类单测 | 待写 |
| P5 个股分析深化 | facts 表+LLM 叙事+数字比对门+结论框三档+预测入库 | 数字比对坏样本拦截 | 待写 |
| P6 提案-审批 | proposals+卡片回调（ocf1）+broker 多账户与服务端审批硬化+熔断 per-owner | 回放与负向测试 | 待写 |
| P7 策略记忆+名片 | memoryd 平台实例集成（per-owner scope）+三档可见性+名片视图+skill 客户端 | 三档端到端本地测试 | 待写 |
| P8 站内研究 | research_tasks worker+受限 agent+研判页+配额 | 全链路含数据缺失场景 | 待写 |
| P9 复盘飞轮 | 每人月度复盘+独立回算校验 | 回算一致性单测 | 待写 |
| P10 点火与部署 | mini 环境盘点→凭据重建→全套安装→冒烟测试→重启/恢复演练→双账号真实验收 | spec §7 全部实测项 | 待写（需用户配合 mini 访问） |

依赖说明：P2-P9 大体可按序独立交付；P6 依赖 P1 的卡片能力与表；P7 依赖 P1 表结构；P8 依赖 P3 平台与 P7 记忆读取；全部真实验收在 P10 后合拢。UI 主题 token 以 `docs/superpowers/specs/ui-samples/final.html` 为准（绿涨红跌）。
