# Phase 5 个股分析深化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。逐任务派发子 agent，任务完成后控制器亲自验收。

**Goal:** 个股分析升级为"事实表驱动 + 可解析结论框 + 预测入库 + 数字比对门"：per-stock facts 表（v9）承载全部叙事可引用数字；结论框三档置信度结构化块供平台摘要卡与 analysis_predictions 同源解析；LLM 叙事编排层沿 P4 可注入后端范式落地（数字预比对 + 重生成 ≤2 + 降级纯事实表报告并披露，真后端 P10 点火）；质量门新增 facts 覆盖 ≥6/8 段与个股数字比对，坏样本全拦截（交付判定）。

**Architecture:** 确定性管线保持为降级真源（buildDeterministicAnalysis 的文本=「纯事实表报告」目标态）；叙事是其上的可选增强层。结论框块是唯一结构化真源——渲染器写入 md、平台 stock.ts 解析摘要卡、predictions writer 解析入库，三处共用同一解析器（防 seam 分叉）。stock_facts 按 (trading_day, symbol, fact_key) 唯一、按 symbol 替换。

**Tech Stack:** 同前阶段，零新依赖。

## Global Constraints

- **Migration v9 本阶段授权**（SCHEMA_VERSION → 9：`stock_facts` 表，UNIQUE(trading_day, symbol, fact_key)；此外 DDL 冻结——analysis_predictions 已存在勿动）。
- **spec 定值**：置信度三档 `low|medium|high`（DDL CHECK；中文 高/中/低 映射常量单源导出）；数字比对容差 百分比 ±0.1 / 价格 ±0.01；重生成 ≤2 次仍失败 → 降级为纯事实表报告并标注（07-11 §3 通用规则）；前 8 段 ≥6 段有事实表支撑（缺数据段显式标注原因；failedSymbols 整体剔除不计入分母）；预测入库 = 生成时写 analysis_predictions（**无 owner_id，公共资产**；outcome 留 NULL，状态枚举 P9 定义——本阶段只在代码注释预约 `hit|miss|invalidated`）。
- **段9 策略对照本阶段不做**（平台渲染期注入 + P7 论点数据成熟后完善；公共 md 永不含个人内容）。
- 现有 8 个段落标题字符串是质量门/模板/sectionValues 三方耦合的**冻结契约**——本阶段不改名不重排，新内容以「### 结论框」子块与追加 bullet 方式进入现有段落。
- LLM 后端遵循 P4 范式：可注入、真后端 `createNarrativeLlmBackend()` P10 前抛错、测试全注入 fake、外部文本 defuse + 定界符、后端输出永不参与工具/查询选择。
- 叙事输出约束：只允许引用 facts 键值中的数字（预比对在编排器内，进质量门前）；输出全中文；经 defuseMarkdownInText。
- 凭据不入仓；临时库纪律（PLATFORM_DB_PATH / 专用临时路径；**动 database.ts 前先 pkill pnpm dev 包装进程**——P4 事故教训）；`pnpm test`/`typecheck`/`build` 全绿；TDD；conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务真跑相关二进制。

---

### Task 1: Migration v9 + stock_facts 仓储 + 事实提取

**Files:** Modify: `packages/shared-types/src/database.ts`（MIGRATIONS[8]，SCHEMA_VERSION→9）、`apps/openclaw-config/scripts/report-facts.mjs`（新增 buildStockFacts）、`news-store.mjs` 或新建 `stock-facts-store.mjs`（决策：**放 report-facts 同域的新 store 函数进 news-store 会混域——新建 `stock-facts-store.mjs`**）、`stock-analysis.mjs`（runAnalysis 内 persist）；Test: 各自 test。

**Interfaces:**
- v9 DDL：`stock_facts (id TEXT PK, trading_day TEXT NOT NULL, symbol TEXT NOT NULL, fact_key TEXT NOT NULL, value_num REAL, value_text TEXT, unit TEXT, source TEXT NOT NULL, data_time TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(trading_day, symbol, fact_key))` + index (symbol, trading_day)。
- `replaceStockFacts(db, tradingDay, symbol, facts[])`：单事务按 (tradingDay, symbol) 删旧插新——**不整天删**（兄弟 symbol 保全，测试钉死）；`getStockFacts(db, tradingDay, symbol)` → keyed map。
- `buildStockFacts({symbol, quote, history, fundamentals, optionChain, news, tradingDay})`（report-facts.mjs）：keys 按 07-03 R5.1 域——`quote.last/pct/volume`、`valuation.pe/pb/eps/marketCap/targetPrice`、`fundamentals.*`（缺→value null + source '数据不可得'）、`history.ma20/ma60/maLong`（**maLong 的 unit 标注真实窗口天数**，不假称 180）、`options.nextExpiry/callOi/putOi`、`news.count`、机构持仓 key 置空+『数据不可得（EDGAR 13F 已裁）』；每条带 source+dataTime。
- runAnalysis：每 symbol 分析后 persist facts（failedSymbols 不写）。
- 迁移测试：v8→v9 无损/幂等/fresh 直达/UNIQUE 生效；store 测试：按 symbol 替换不动兄弟、keyed map。

- [ ] TDD → 真跑迁移于副本（先杀 dev 包装进程）→ Commit `feat: schema v9 - per-stock facts table, extraction and store`

### Task 2: 结论框结构化块 + 预测入库（同源解析器）

**Files:** Create: `apps/openclaw-config/scripts/conclusion-box.mjs`（渲染+解析+置信度映射单源）；Modify: `stock-analysis.mjs`（结论段内嵌 `### 结论框` 块；生成后解析自己的输出写 analysis_predictions）；Test: `conclusion-box.test.ts` + stock-analysis 扩展。

**Interfaces:**
- `CONFIDENCE_LABELS = { high: '高', medium: '中', low: '低' }` + 反向映射；导出供全仓引用。
- `renderConclusionBox({coreConclusion, confidence, valueRange:{low,high,basis}, pricePosition, reviewTrigger, reviewDate})` → 固定 bullet 键的 markdown 块（`- 核心结论：` / `- 置信度：高|中|低` / `- 合理价值区间：X–Y 美元（依据：…）` / `- 当前价格位置：` / `- 复盘触发：…（复盘日期：YYYY-MM-DD）`）。
- `parseConclusionBox(sectionMarkdown)` → 同形状对象或 null（缺任一必填键→null，绝不猜）；**渲染→解析往返测试钉死**。
- 确定性结论框生成：从现有 `.conclusion` 三路径概率 + summarizeValuation 推导（置信度启发式：数据覆盖度 ≥6/8 且非降级→medium，加上行/趋势信号一致→high，覆盖 <6→low——确定性规则，文档化）；reviewDate = 生成日 +1 个月（美东日历日）；reviewTrigger = invalidation 式条件文本。
- 预测入库：runAnalysis 渲染完成后 `parseConclusionBox` 自己的输出 → INSERT analysis_predictions（symbol/report_path/conclusion=核心结论/confidence=enum/review_trigger/review_date；outcome NULL）；同 symbol 同日重跑 → 先删同 report_path 旧行再插（幂等）。
- 平台契约预告（T5 实现）：解析器同源复用——conclusion-box.mjs 保持零依赖纯函数以便 TS 侧 port 或经 dist 引用（选择并文档化）。

- [ ] TDD（往返/缺键 null/中文映射/入库幂等）→ Commit `feat: structured conclusion box with three-tier confidence and prediction persistence`

### Task 3: LLM 叙事编排层（可注入后端 + 重生成→降级）

**Files:** Create: `apps/openclaw-config/scripts/narrative-engine.mjs`；Modify: `stock-analysis.mjs`（叙事尝试包裹现有段落生成）；Test: `narrative-engine.test.ts`。

**Interfaces:**
- backend 接口：`async ({symbol, sectionKey, factsDigest, deterministicText}) => {text}`；`createNarrativeLlmBackend()` → P10-gated throw（文档注明点火接线点）。
- `generateNarrativeSections({backend, symbol, facts, sections})`：逐段调用；每段输出校验——①全中文（CJK 占比阈值）；②defuseMarkdownInText；③**数字预比对**：文本中每个数字必须能在 facts 值（±容差）中找到对应，多余数字=失败；失败→带失败原因重试该段 ≤2 次；仍失败→该段回落 deterministicText + 段内标注「（叙事降级：数字比对未通过）」。backend 整体抛错→全部段落回落 + 报告头标注「叙事引擎不可用（纯事实表报告）」。返回 {sections, degraded, degradedSections[], retriesUsed}。
- stock-analysis 接线：backend 由 env/参数注入（生产默认 createNarrativeLlmBackend()——今天必然降级路径，报告与 P4 前输出等价 + 头部披露行；测试注入 fake 验证叙事路径）。
- 坏样本测试：fake backend 编数（122959.91 vs facts 122000）→ 重试 2 次→降级+标注；fake 输出英文→重试→降级；fake 抛错→整体降级披露；fake 良好输出→叙事替换成功且比对通过。

- [ ] TDD → Commit `feat: narrative orchestration with numeric pre-check, bounded retries and honest degradation`

### Task 4: 质量门扩展 + 坏样本全拦截（交付判定）

**Files:** Modify: `report-quality.mjs`（validateStockAnalysisMarkdown 扩展 + 新导出）、`stock-analysis.mjs`（投递前接线数字比对）；Test: `report-quality.test.ts` 扩展 + `report-quality-bad-samples.test.ts` 追加个股组。

**Interfaces:**
- era 标记：新格式个股报告含 `### 结论框`——新门仅对含标记的报告生效（legacy 存档只走旧门，同 P4 规则）。
- 新门（各带失败码）：`stock.conclusion_box`（parseConclusionBox 每个 `## SYMBOL` 段非 null；置信度∈三档）；`stock.facts_coverage`（每 symbol 段 ≥6/8 段含事实表支撑标记或显式「数据不可得」标注——分母排除 failedSymbols）；`stock.numeric_match`（`validateStockNarrativeNumbers(markdown, getStockFactsForReport, tolerances)`——按 `## SYMBOL` 段 scope 比对该 symbol 的 facts，容差同 spec）。
- stock-analysis 投递前：assertStockAnalysisQuality 扩展调用新门（数字门拿 db 读 stock_facts）；失败=拒投递（编排层的重试已在 T3 消化，此处是最后防线 fail-loud）。
- 坏样本追加组（逐失败码断言）：数字造假、缺结论框、坏置信度（'很高'）、覆盖不足（3/8 段无支撑无标注）、结论框缺必填键、legacy 报告不触发新门。

- [ ] TDD → 真跑 validateStockAnalysisMarkdown 于真实历史个股报告（legacy 通过旧门、新门跳过）→ Commit `feat: stock analysis quality gates - conclusion box, facts coverage and numeric match`

### Task 5: 平台结论框摘要卡 + deferred minors

**Files:** Modify: `apps/platform-app/src/routes/stock.ts`（摘要卡升级）、`apps/openclaw-config/scripts/stock-analysis.mjs`（三个 minor）；Create: `apps/platform-app/src/reports/conclusion-box.ts`（TS 侧解析器 port，注释互指 .mjs 真源 + 同 fixture 双侧测试防漂移）；Test: 各自扩展。

**Interfaces:**
- stock.ts 摘要卡：最新 stock-analysis 报告的该 symbol 段 → parseConclusionBox → 有→渲染 核心结论 + 置信度徽章（高=up 色 pill / 中=amber / 低=sub 色）+ 合理区间 + 复盘日期 + 阅读全文链接；无（legacy）→ 现有首 bullet 行为保留 + 「旧格式无结论框」标注。双侧解析器共用 fixture 测试（同一 md 输入，mjs 与 ts 输出深等）。
- minors：①`toYahooSymbol` 点分级股票 `BRK.B`→`BRK-B`（去 .US 后剩余点转横线）+ 平台 normalizeStockSymbol 字符集对齐 report-data（含 `-`）；②`prepare` 写 `<label>-preview.md`/`.pdf`，不再覆盖已投递存档（run/scheduled 路径不变）；③`nextUsMonthlyOptionExpiry` 当日第三个周五→返回当日（校验现行为，若已含当日则补钉死测试）。

- [ ] TDD → 实测：临时库 seed 新格式报告 fixture → 起平台服务 curl /stock/<code> 贴结论框卡片段 → Commit `feat: conclusion-box summary card and stock-analysis housekeeping fixes`

### Task 6: 阶段收尾

**Steps:**
- [ ] **交付判定**：①坏样本个股组全绿（逐失败码）；②叙事编排坏样本（编数→降级）全绿；③conclusion-box 双侧解析器 fixture 一致；④真跑 `node stock-analysis.mjs prepare QQQ`（真实外网 Yahoo/Longbridge 不可用则降级路径也算通过——贴输出与降级标注）；⑤Playwright：seed 新格式报告的临时库 → /stock/QQQ.US 结论框摘要卡双主题截图 + 零外部请求。
- [ ] `pnpm test`/`typecheck`/`build` ×3 → 合并 main + push → 台账/路线图/记忆更新 → **不停，直接进 P6**（先读台账 P6 PREREQUISITES）。

## 明确不做（划界）

- 段9 策略对照per-viewer 渲染（P7 论点成熟后）；LLM 真后端与叙事真跑（P10）；outcome 回算与置信度校准（P9 复盘）；五因子同业分级/EDGAR 13F（已裁，facts 留位）；月度复盘报告类型（P9）。
