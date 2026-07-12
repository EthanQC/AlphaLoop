# Phase 1 地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为多成员 AlphaLoop 平台打好数据与消息地基：版本化 SQLite 迁移、成员/owner 数据模型、每日备份、失败停机状态机、飞书交互卡片能力、仓库卫生。

**Architecture:** 所有 DDL 集中到 `packages/shared-types/src/database.ts` 的版本化迁移（`PRAGMA user_version` 步进）；业务表全部带 `owner_id` 引用 `members`；消息层在 `packages/shared-types/src/notifications.ts` 增加 interactive 卡片发送/更新（transport 可注入以便单测）。

**Tech Stack:** Node 24 内置 `node:sqlite`（DatabaseSync）、TypeScript（packages/*）、.mjs 脚本（apps/openclaw-config/scripts）、vitest。

## Global Constraints

- Node >= 24.0.0；pnpm 9.15.0（package.json 既有值）
- 测试命令：`pnpm test`（vitest run，仓库根）；类型检查 `pnpm typecheck`
- 交易事实唯一真源 = `runtime/trading.sqlite`（`resolveTradingDatabasePath()`，packages/shared-types/src/runtime.ts）
- 禁止任何脚本自建表（本阶段之后 DDL 只允许出现在 database.ts 迁移里）
- 全部群发/用户面文案中文；代码与注释英文
- 提交规范：每任务小步提交，消息用英文 conventional 前缀（feat:/refactor:/test:/chore:），结尾带 Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
- 涨跌语义色：绿涨红跌（本阶段无 UI，但常量若出现须遵守）
- 现有测试不得回归：任务动过的每个模块，跑其对应 *.test.ts 必须全绿

---

### Task 1: 版本化迁移框架（user_version）

**Files:**
- Modify: `packages/shared-types/src/database.ts`（migrate() 重构，第 37-127 行）
- Test: `packages/shared-types/src/database.test.ts`（新建）

**Interfaces:**
- Produces: `migrate(db: DatabaseSync): void`（签名不变，内部改为步进迁移）；`export const SCHEMA_VERSION: number`；`export function getSchemaVersion(db: DatabaseSync): number`
- 迁移步骤内部结构：`const MIGRATIONS: Array<(db: DatabaseSync) => void>`，`MIGRATIONS[i]` 把 user_version 从 i 升到 i+1；migrate() 循环执行未应用步骤，每步一个事务，结束 `PRAGMA user_version = i+1`

- [ ] **Step 1: 写失败测试**（新库迁移到最新版本；旧式已有表的库【user_version=0 但表已存在】迁移后 user_version 更新且数据保留；migrate 幂等）

```ts
// packages/shared-types/src/database.test.ts
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate, getSchemaVersion, SCHEMA_VERSION } from "./database.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

describe("versioned migrations", () => {
  it("migrates a fresh db to the latest schema version", () => {
    const db = memoryDb();
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("audit_log");
    expect(names).toContain("official_paper_snapshots");
  });

  it("is idempotent", () => {
    const db = memoryDb();
    migrate(db);
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("adopts a legacy db (tables exist, user_version=0) without data loss", () => {
    const db = memoryDb();
    // simulate legacy: baseline tables created the old way, user_version left at 0
    db.exec(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, category TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    db.prepare("INSERT INTO audit_log VALUES ('a1','c','act','{}',1)").run();
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const row = db.prepare("SELECT id FROM audit_log WHERE id='a1'").get() as { id: string };
    expect(row.id).toBe("a1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm vitest run packages/shared-types/src/database.test.ts` → FAIL（getSchemaVersion/SCHEMA_VERSION 不存在）
- [ ] **Step 3: 实现**——把现有 migrate() 的整段 DDL 原样变成 `MIGRATIONS[0]`（v0→v1 基线；全部保留 `IF NOT EXISTS`，天然兼容 legacy 库）；框架代码：

```ts
export const SCHEMA_VERSION = 1; // Task 2/3/4 会递增

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`/* 现 migrate() 内第 38-125 行的全部 DDL，原样搬入 */`);
  },
];

export function migrate(db: DatabaseSync): void {
  let version = getSchemaVersion(db);
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[version](db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    version += 1;
  }
}
```

- [ ] **Step 4: 跑测试全绿** + `pnpm typecheck` + `pnpm test`（防回归）
- [ ] **Step 5: Commit** `refactor: versioned sqlite migrations with user_version`

### Task 2: members 与 api_tokens（迁移 v2）+ MemberRepository

**Files:**
- Modify: `packages/shared-types/src/database.ts`（MIGRATIONS 追加 v1→v2；新增 repository）
- Test: `packages/shared-types/src/database.test.ts`（追加）

**Interfaces:**
- Produces: 表 `members(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, feishu_open_id TEXT UNIQUE, display_name TEXT NOT NULL, risk_tags TEXT NOT NULL DEFAULT '[]', stock_tags TEXT NOT NULL DEFAULT '[]', show_performance INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`；表 `api_tokens(id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL)`
- Produces: `class MemberRepository { upsert(m: Member): void; getByEmail(email: string): Member | null; getByFeishuOpenId(openId: string): Member | null; listActive(): Member[] }`；`interface Member { id: string; email: string; feishuOpenId?: string; displayName: string; riskTags: string[]; stockTags: string[]; showPerformance: boolean; status: "active" | "revoked"; createdAt: string }`（放 domain.ts）
- Produces: `class ApiTokenRepository { issue(memberId: string, label: string): { id: string; token: string }; verify(token: string): Member | null; revoke(tokenId: string): void }`——token 生成用 `crypto.randomBytes(32).toString("base64url")`，存 `sha256` hex hash；verify 对活跃成员且未吊销的 token 返回 Member

- [ ] Step 1: 失败测试（upsert/getByEmail/issue+verify 往返/revoke 后 verify 为 null/吊销成员的 token verify 为 null）——测试代码按上述接口直接编写，断言行为
- [ ] Step 2: 确认失败 → Step 3: 实现（迁移 v2 DDL + 两个 repository + domain 类型）→ Step 4: 测试与 typecheck 全绿 → Step 5: Commit `feat: members and api tokens with repositories`

### Task 3: 业务新表全集（迁移 v3）+ 既有表 owner 列（迁移 v4）

**Files:**
- Modify: `packages/shared-types/src/database.ts`
- Test: `packages/shared-types/src/database.test.ts`（追加）

**Interfaces（v3 全部建表，一次定齐，后续阶段只写业务逻辑不再动 DDL）:**

```sql
CREATE TABLE IF NOT EXISTS discipline_rules (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
  rule_text TEXT NOT NULL, enforcement TEXT NOT NULL CHECK(enforcement IN ('hard','proposal_check','self')),
  linked_strategy TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, disabled_at TEXT);
CREATE TABLE IF NOT EXISTS theses (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
  symbol TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('bull','bear','neutral')),
  target_low REAL, target_high REAL, invalidation_price REAL,
  visibility TEXT NOT NULL DEFAULT 'system' CHECK(visibility IN ('system','public')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','withdrawn','superseded')),
  memory_slug TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS theses_owner_symbol_idx ON theses(owner_id, symbol, status);
CREATE TABLE IF NOT EXISTS thesis_history (
  id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL REFERENCES theses(id),
  note TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
  symbol TEXT NOT NULL, side TEXT NOT NULL, quantity REAL NOT NULL, order_type TEXT NOT NULL,
  limit_price REAL, reason TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]',
  strategy_ref TEXT, discipline_report TEXT NOT NULL DEFAULT '[]',
  invalidation TEXT, stop_loss REAL, budget_impact REAL, confidence TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','approved_half','rejected','expired','executed','failed')),
  approval_token TEXT UNIQUE, consumed_at TEXT, decided_at TEXT, decided_by TEXT,
  ticket_id TEXT, outcome TEXT, card_message_id TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS proposals_owner_status_idx ON proposals(owner_id, status, created_at);
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
  symbol TEXT NOT NULL, rule_type TEXT NOT NULL CHECK(rule_type IN ('daily_move','unrealized_pnl','spike_5m','exposure')),
  threshold REAL NOT NULL, direction TEXT NOT NULL DEFAULT 'both',
  frequency TEXT NOT NULL CHECK(frequency IN ('once_daily','continuous')),
  hysteresis REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES alert_rules(id), owner_id TEXT NOT NULL,
  triggered_at TEXT NOT NULL, value REAL NOT NULL, message_id TEXT, feedback TEXT);
CREATE TABLE IF NOT EXISTS alert_runtime_state (
  rule_id TEXT PRIMARY KEY REFERENCES alert_rules(id),
  armed INTEGER NOT NULL DEFAULT 1, last_value REAL, cooldown_until TEXT,
  last_fired_trading_day TEXT);
CREATE TABLE IF NOT EXISTS alert_daily_quota (
  owner_id TEXT NOT NULL, trading_day TEXT NOT NULL, fired_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, trading_day));
CREATE TABLE IF NOT EXISTS analysis_predictions (
  id TEXT PRIMARY KEY, symbol TEXT NOT NULL, report_path TEXT NOT NULL,
  conclusion TEXT NOT NULL, confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
  review_trigger TEXT, review_date TEXT, outcome TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_tasks (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
  question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','degraded','failed')),
  steps TEXT NOT NULL DEFAULT '[]', budget_spent INTEGER NOT NULL DEFAULT 0,
  result_path TEXT, visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
  created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS research_tasks_owner_day_idx ON research_tasks(owner_id, created_at);
CREATE TABLE IF NOT EXISTS run_log (
  id TEXT PRIMARY KEY, job TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  ok INTEGER, inputs TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]',
  failed_step TEXT, retries INTEGER NOT NULL DEFAULT 0, call_count INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '[]');
```

**v4（owner 列回填既有表）**：`ALTER TABLE official_paper_snapshots ADD COLUMN owner_id TEXT`；`ALTER TABLE official_paper_order_lifecycle ADD COLUMN owner_id TEXT`；`ALTER TABLE stock_analysis_targets ADD COLUMN owner_id TEXT`；`ALTER TABLE paper_strategy_reflections ADD COLUMN owner_id TEXT`（可空——历史行留空，新写入必填；相关索引 `CREATE INDEX IF NOT EXISTS official_paper_snapshots_owner_idx ON official_paper_snapshots(owner_id, fetched_at)`）

- [ ] Step 1: 失败测试（迁移后全部新表存在、CHECK 约束生效【插非法 enforcement 抛错】、legacy 库经 v1→v4 后旧表数据仍在且新列可写）
- [ ] Step 2-5: TDD 循环 + `pnpm test` 全绿 + Commit `feat: phase-1 schema for members-scoped business tables`

### Task 4: 消除分散 DDL（4 处）

**Files:**
- Modify: `apps/openclaw-config/scripts/stock-analysis.mjs`（约 332-350 行自建表段）
- Modify: `apps/openclaw-config/scripts/reconcile-official-paper-orders.mjs`（约 145-180 行）
- Modify: `apps/openclaw-config/scripts/official-paper-monitor.mjs`（约 251-275 行）
- Modify: `apps/openclaw-config/scripts/feishu-context.mjs`（约 103 行 feishu_context_messages）
- Modify: `packages/shared-types/src/database.ts`（迁移 v5：把 feishu_context_messages 及上述脚本自建的任何表原样收编；脚本自建的 DDL 若与 v1 基线重复则直接删）
- Test: 各脚本对应 *.test.ts 若存在则保持全绿；database.test.ts 追加 v5 断言

**Interfaces:**
- Consumes: Task 1 的 migrate()；脚本侧改为 `import { openTradingDatabase } from "@apps/../shared-types"` 等仓库既有导入方式（先 grep 现有 import 写法保持一致；.mjs 里现用 `new DatabaseSync` 的路径改走 openTradingDatabase 以触发迁移）
- 原则：**行为不变**——脚本读写的表名列名不动，只挪 DDL 归属

- [ ] Step 1: 先跑四个脚本相关的现有测试记录基线 → Step 2: 逐脚本改造（删自建 DDL、openTradingDatabase 开库）→ Step 3: `pnpm test` 全绿 → Step 4: Commit `refactor: centralize all DDL into versioned migrations`

### Task 5: 每日备份与恢复脚本 + launchd 模板

**Files:**
- Create: `apps/openclaw-config/scripts/backup-trading-data.mjs`
- Create: `apps/openclaw-config/scripts/restore-trading-data.mjs`
- Create: `apps/openclaw-config/launchd/com.alphaloop.daily-backup.plist.template`
- Modify: `package.json`（scripts: `"backup:daily": "node apps/openclaw-config/scripts/backup-trading-data.mjs"`, `"backup:restore": "node apps/openclaw-config/scripts/restore-trading-data.mjs"`）
- Test: `apps/openclaw-config/scripts/backup-trading-data.test.ts`

**Interfaces:**
- `backup-trading-data.mjs`：`node ... [--dest <dir>] [--retention-days 30] [--memoryd-root <dir>]`——①对 trading.sqlite 执行 `VACUUM INTO '<dest>/trading-YYYY-MM-DD.sqlite'`（node:sqlite 直接 exec）；②若 --memoryd-root 存在则 `tar -czf <dest>/memoryd-YYYY-MM-DD.tgz -C <root> .`；③删除超过 retention 的旧备份；④stdout 输出 JSON `{ok, files:[], deleted:[]}`。日期取当天本地日期（Asia/Shanghai）。
- `restore-trading-data.mjs`：`--from <backup-file> --to <db-path>`（目标存在则拒绝，需 `--force`），恢复后跑 migrate() 并打印 schema version。
- 测试用临时目录小库端到端：备份→改库→恢复→断言数据回到备份点；retention 清理断言。

- [ ] TDD 循环 + Commit `feat: daily backup and restore for trading db and memoryd root`

### Task 6: cron-runner 失败停机状态机

**Files:**
- Modify: `apps/openclaw-config/scripts/openclaw-cron-runner-state.mjs`（shouldAttemptRun/recordRunResult，现 9-70 行）
- Modify: `apps/openclaw-config/scripts/openclaw-cron-runner.mjs`（告警触发点，现 115-119 行附近）
- Create: `apps/openclaw-config/scripts/cron-runner-reset.mjs`（复位 CLI：`node ... <jobName>` 清除 halted）
- Test: `apps/openclaw-config/scripts/openclaw-cron-runner-state.test.ts`（存在则扩展，否则新建）

**Interfaces:**
- 失败类别键 = `jobName + ':' + errorClass`（errorClass 取 error 消息首行的前 80 字符规整小写；导出 `classifyFailure(jobName, errorMessage): string`）
- 语义：同类失败计数 ≥3 → state 置 `halted:true`（shouldAttemptRun 返回 false 且不再退避重试）；成功清零计数；告警第 1 次失败发提示、第 3 次发升级告警（中文文案含"已停机等待复位"与复位命令）；`cron-runner-reset.mjs` 清 halted+计数并写 audit。
- 兼容：state JSON 新增字段向后兼容（读旧 state 不炸）。

- [ ] TDD 循环（同类 3 次→halted；不同类不互相累计；成功清零；reset 恢复）+ Commit `feat: halt-after-3-same-class-failures state machine with reset CLI`

### Task 7: 飞书交互卡片能力（sendInteractiveCard / updateCard / message_id 回传）

**Files:**
- Modify: `packages/shared-types/src/notifications.ts`
- Test: `packages/shared-types/src/notifications.test.ts`（追加）

**Interfaces:**
- Produces:
```ts
export interface InteractiveCardButton { text: string; value: string; style?: "primary" | "danger" | "default" }
export interface InteractiveCard { title: string; lines: string[]; buttons?: InteractiveCardButton[]; url?: { text: string; href: string } }
export interface CardSendResult { ok: boolean; messageId?: string; error?: string }
export interface CardTransport {
  sendCard(target: { chatId?: string; openId?: string }, cardJson: unknown): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  updateCard(messageId: string, cardJson: unknown): Promise<{ ok: boolean; error?: string }>;
}
export function buildFeishuCardPayload(card: InteractiveCard): unknown; // 纯函数：拼 msg_type=interactive 的卡片 JSON（schema 2.0 elements），按钮 value 透传（供 OpenClaw 合成消息回调）
export async function sendInteractiveCard(card: InteractiveCard, target: { chatId?: string; openId?: string }, transport?: CardTransport): Promise<CardSendResult>;
export async function updateInteractiveCard(messageId: string, card: InteractiveCard, transport?: CardTransport): Promise<{ ok: boolean; error?: string }>;
```
- 默认 transport：复用现有 feishu-user-plugin MCP 子进程通道（参考本文件既有 `trySendFeishuUserPluginBot*` 的 spawn 模式），调工具 `send_message_as_bot`（msg_type interactive）并**解析返回中的 message_id**（现有代码在 794-800 行丢弃结果详情——新路径必须提取）；updateCard 调 `update_message` 工具。真实 MCP 行为点火后实测（黄灯），本阶段单测全部走注入的 fake transport。
- 纯函数 buildFeishuCardPayload 单测：标题/行/按钮/URL 各形态的 JSON 结构断言；中文内容原样保留。

- [ ] TDD 循环 + Commit `feat: interactive feishu card send/update with message_id passthrough`

### Task 8: 仓库卫生（死包清理 + 宪法同步 + 凭据模板）

**Files:**
- Delete: `apps/live-advisor/`, `apps/event-bus/`, `apps/event-ingestor/`, `apps/paper-trader/`, `packages/context-builder/`（均为 dist/node_modules 残留，源码早已在 f2984a5 删除；git 历史可找回）
- Modify: `AGENTS.md`（①删第 10 行期权白名单句，改为 "Options are analysis-only inputs. Option execution stays disabled permanently."；②删第 8 行 "and Honcho" 引用；③新增两条 Hard Rules："OpenClaw paper budget stays <= 10% of total assets, enforced server-side against a fresh snapshot." 与 "Exactly one process holds the Feishu event connection; callbacks are acknowledged within seconds and processed asynchronously."）
- Create: `.env.local.example`（全部键名+注释占位，无真实值：LONGBRIDGE_APP_KEY/SECRET/ACCESS_TOKEN、LONGBRIDGE_ACCOUNT_MODE=paper、LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true、ALLOW_LIVE_EXECUTION=false、FEISHU_* 现有键（grep runtime.ts/render-openclaw-config.mjs 取全）、OPENCLAW_GATEWAY_PORT、FINNHUB_API_KEY、MEMORYD_DATA_ROOT 等 P2+ 预留键加注释）
- Create: `docs/superpowers/specs/secrets-inventory.md`（密钥清单：每个密钥的用途/存放位置/轮换方式/迁移注意，按成员分节的长桥凭据结构说明）
- Test: `pnpm test` 全绿（删包不破坏 workspace）；`pnpm build` 通过

- [ ] Step 1: 删除目录 → Step 2: `pnpm install && pnpm build && pnpm test` 确认无引用残留 → Step 3: AGENTS.md 修订 + 两个新文件 → Step 4: Commit `chore: remove retired packages, sync constitution, add env template and secrets inventory`

---

## 阶段收尾（全部任务完成后）

1. `pnpm test && pnpm typecheck && pnpm build` 全绿。
2. 派 code-review 子 agent 审全阶段 diff（superpowers:requesting-code-review），Critical 项修复后才算完。
3. 实测（verification-before-completion）：本地跑 `pnpm backup:daily -- --dest /tmp/alphaloop-backup-test` 真实备份+恢复往返一次；用一个临时脚本对 fake transport 发一张卡片断言 payload；对现有 runtime 无破坏（migrate 对拷贝的旧库快照跑一遍无损）。
4. 提交记录整洁（每任务 1-2 个 commit），更新本计划文件的 checkbox。
