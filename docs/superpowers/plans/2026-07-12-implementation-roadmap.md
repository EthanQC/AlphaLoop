# AlphaLoop 实施总路线图

> 依据：`docs/superpowers/specs/2026-07-12-detailed-requirements.md` + `2026-07-12-tech-selection.md`（用户已批准开工）。
> 执行方式：每阶段一份详细计划（writing-plans 规范），superpowers:subagent-driven-development 逐任务派发子 agent 实现，任务间两段式 review；**每阶段收尾必须：子 agent code review + 实测（verification-before-completion）**。
> 开发在本机 MacBook；部署目标 Mac mini（Phase 10 点火需用户配合，此前全部为可本地开发+单测的代码工作）。

| 阶段 | 内容 | 交付判定 | 计划文件 |
|---|---|---|---|
| **P1 地基 ✅(2026-07-12 交付)** | 版本化 DB 迁移 + 多成员表/owner 列 + 分散 DDL 清理 + 每日备份 + 失败停机状态机 + 飞书交互卡片能力 + 仓库卫生/宪法同步 | `pnpm test` 全绿；迁移可从现库无损升级；卡片 API 带 stub 单测 | `2026-07-12-phase1-foundation.md`（已写） |
| **P2 提醒引擎 ✅(2026-07-13 交付)** | market-alerts 规则评估（四类/滞回/冷却/配额/owner 隔离）+ CLI + launchd 轮询模板 + 交易日历 fail-loud | 全部规则单测；历史行情回放测试 | 待写 |
| **P2.5 加固 ✅(2026-07-14 交付)** | 清空 P1/P2 全部技术欠账：提醒器心跳/失败升级（五轮对抗修复）+ doctor 检查隔离与 launchd 接线 + schema v7（per-owner 标的池/CHECK/FK）+ 写入方 owner 感知与不变量下沉 + 存量代码审计（49-agent，38 项确认）16 项修复；下单链路 7 项记为 P6 前置 | 623 测试 ×3 全绿；备份往返/doctor/poll/CLI 负向全部实测 | `2026-07-13-phase2.5-hardening.md`；审计报告 `specs/2026-07-14-opus-era-audit.md` |
| **P3 站点与平台 ✅(2026-07-15 交付)** | platform-app 身份网关（bearer + Access 邮箱头，JWT 校验=P10 前置）+ 5 页与下钻页服务端渲染（final.html token 逐字节，双主题双端）+ 成员管理 CLI + per-owner 服务端隔离 + launchd/doctor 接线 | ✅ req §7 双账号隔离矩阵全过（403/404/401 实测）+ Playwright 双主题双视口 + 单请求网络审计；942 测试 ×3 | `2026-07-14-phase3-platform.md` |
| **P4 新闻引擎 ✅(2026-07-15 交付)** | 四项注入修复（摄入层消毒）+ schema v8 三表 + 确定性事件聚类 + L1 多源（RSSHub 冗余/Finnhub 限速脱敏）+ L2/L3 预算编排（真后端=P10）+ daily facts + 质量门四扩展 + 日报聚类段与平台新闻页双面 | ✅ 坏样本全拦截（9 样本逐失败码）+ 聚类 47 测 + seam 贯通 + Playwright 双主题筛选实测；1128 测试 ×3 | `2026-07-15-phase4-news-engine.md` |
| **P5 个股分析深化 ✅(2026-07-15 交付)** | schema v9 per-stock facts + 结论框三档（同源解析器双侧）+ 预测入库（analysis_predictions 首个写入方）+ 叙事编排（数字预比对/重试≤2/降级纯事实表，真后端=P10）+ 质量门三扩展 + 平台结论框摘要卡 + 三项 minor 清理 | ✅ 坏样本 15/15 逐失败码 + 叙事降级 13/13 + 双侧解析 52/52 + Playwright 双主题卡片零外部请求；1267 测试 ×3 | `2026-07-15-phase5-analysis.md` |
| **P6 提案-审批 ✅(2026-07-15 交付)** | v10/v11 熔断表+提案仓储原子消费 + 纪律引擎（hard 阻断/proposal_check 标注/self 提示）+ per-owner 熔断（周亏>3%停一周跨重启）+ 提案生命周期（owner-only 三动作/审批卡 ocf1/24h 过期扫）+ executor 硬化（共享密钥/已批准门/幂等 replay/先记录后执行/预算含挂单）+ 对账重建（状态映射单源，根治审计 #1/#2/#5/#6）+ 多账户凭据隔离 | ✅ 全链路回放 seam + 负向矩阵（owner-only/重复消费/预算含挂单/幂等）+ Playwright 熔断横幅；资金路径真库零污染；1547 测试 ×3 | `2026-07-15-phase6-proposals.md` |
| **P7 策略记忆+名片 ✅(2026-07-16 交付)** | schema v12（strategy_cards + theses 看多看空列）+ 记忆 store（append-only 判断历史/停用不删/升档 owner 校验）+ memoryd fire-and-forget 镜像（真实例 P10）+ 三档可见性服务端强制 + 论点卡（双栏+判断历史+事后走势代码回算）+ 纪律近30天遵守真统计 + 名片公开清单 + bearer 写 API + skill 客户端包 | ✅ 三档端到端隔离实测（系统档跨成员不可见/公开进圈子名片/纪律 hard 被 P6 读到）+ 写入 parity + Playwright 双主题；真库未触碰；1773 测试 ×3 | `2026-07-15-phase7-strategy-memory.md` |
| **P8 站内研究 ✅(2026-07-16 交付)** | schema v13 research 结果列+仓储（原子配额/原子认领/崩溃续拾）+ 确定性研判管线（诚实跳过不编造/惩罚聚合置信度/注入隔离/操作意图重定向）+ 内置 worker（owner-scope 预绑定/抛错优雅降级）+ 提交 API（配额429/303）+ 平台（提问框激活/进行中轮询/研判七段/归档报告+名片）+ 服务器错误边界 | ✅ 全链路含数据缺失场景亲测（跳过不编造+置信度降档）+ 配额+崩溃续跑+隔离+Playwright 研判页零外部请求；真库未触碰；1886 测试 ×3 | `2026-07-16-phase8-research.md` |
| **P9 复盘飞轮 ✅(2026-07-16 交付)** | schema v14 monthly_reviews（draft→confirmed 人工门）+ 主复盘引擎（本人论点命中率/系统置信度校准/决策 vs QQQ 基准/纪律遵守+守规矩值多少钱/误报率，确定性）+ **零 import 独立验证器**（原始 SQL 重算，CLI generate 运行时自检不一致拒存）+ 预测 outcome 回填 + CLI/月度 cron/memoryd 写 + 平台复盘 chip/六段阅读页/确认流 | ✅ 回算一致性单测（主≡验证器+5 坏样本捕获）+ 运行时篡改被抓+owner 隔离+确认门+Playwright 六段零外部请求；真库未触碰；2037 测试 ×3 | `2026-07-16-phase9-review.md` |
| **全仓加固 ✅(2026-07-16 交付)** | P1-P9 全仓 review（资金路径/接缝/隔离/人工清单四路），11 项确认缺陷修复：cron 两任务从不执行、对账把已成交提案永锁 failed、风控无条件豁免 paper 卖单（裸卖空绕过 10% 上限）、预算盲 unknown_broker_status、async 写 handler 崩进程挂 socket、DST 转换日日界差一小时、memoryd 类型映射漂移、错误文本未脱敏、CLI 缺 JSON 信封、外链未过滤 scheme | 每项 TDD（先红后绿）+ 控制器亲审 diff；2058 测试 ×3 确定性全绿；真库未触碰（v11） | 台账 `.superpowers/sdd/progress.md` |
| P10 点火与部署 | mini 环境盘点→凭据重建→全套安装→冒烟测试→重启/恢复演练→双账号真实验收 | spec §7 全部实测项 | `2026-07-16-phase10-ignition-checklist.html`（需用户配合 mini 访问） |

依赖说明：P2-P9 大体可按序独立交付；P6 依赖 P1 的卡片能力与表；P7 依赖 P1 表结构；P8 依赖 P3 平台与 P7 记忆读取；全部真实验收在 P10 后合拢。UI 主题 token 以 `docs/superpowers/specs/ui-samples/final.html` 为准（绿涨红跌）。
