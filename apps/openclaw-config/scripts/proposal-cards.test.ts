import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemberRepository,
  ProposalRepository,
  openTradingDatabase,
  type CardTransport
} from "../../../packages/shared-types/dist/index.js";

const { composeDecisionUpdate, composeProposalCard, deliverProposalCard } = await import("./proposal-cards.mjs");

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-proposal-cards-"));
  tempDirs.push(dir);
  return openTradingDatabase(join(dir, "trading.sqlite"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, overrides: Partial<{ id: string; feishuOpenId: string }> = {}) {
  new MemberRepository(db).upsert({
    id: overrides.id ?? "member_1",
    email: `${overrides.id ?? "member_1"}@example.com`,
    ...(overrides.feishuOpenId ? { feishuOpenId: overrides.feishuOpenId } : {}),
    displayName: "Alice",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function fullProposal(db: DatabaseSync, overrides: Partial<Record<string, unknown>> = {}) {
  const repo = new ProposalRepository(db);
  return repo.create({
    ownerId: "member_1",
    symbol: "NVDA.US",
    side: "buy",
    quantity: 2,
    orderType: "limit",
    limitPrice: 845,
    reason: "财报前动量+论点目标未到",
    evidence: ["事实F3", "新闻N2", "论点T-NVDA"],
    strategyRef: "AI 算力龙头持有",
    invalidation: "跌破 $720",
    stopLoss: 760,
    budgetImpact: 6.8,
    confidence: "medium",
    expiresAt: "2026-07-16T18:00:00.000Z",
    ...overrides
  } as Parameters<ProposalRepository["create"]>[0]);
}

const DISCIPLINE_REPORT = [
  { ruleId: "rule_1", ruleText: "仓位≤10%", enforcement: "hard", pass: true, detail: "8.2%<10%" },
  { ruleId: "rule_2", ruleText: "财报周不买入", enforcement: "hard", pass: true, detail: "非财报周" },
  { ruleId: "rule_3", ruleText: "未触熔断", enforcement: "self", pass: null, detail: "无法判定" }
];

describe("composeProposalCard", () => {
  it("golden: every field renders, buttons carry the approval token verbatim", () => {
    const db = makeDb();
    seedMember(db);
    const proposal = fullProposal(db);

    const card = composeProposalCard(proposal, DISCIPLINE_REPORT);

    expect(card.title).toBe(`📋 提案 ${proposal.id} · 买入 NVDA 2 股 · 限价 $845`);
    expect(card.lines).toEqual([
      "理由: 财报前动量+论点目标未到 [引用: 事实F3, 新闻N2, 论点T-NVDA]",
      "关联策略: AI 算力龙头持有",
      "纪律检查: ✓ 仓位≤10%  ✓ 财报周不买入  ? 未触熔断",
      "失效条件: 跌破 $720 · 止损: $760 · 置信度: 中",
      "预算影响: 占模拟盘预算 6.8%",
      expect.stringMatching(/^过期时间: .+ 后自动作废$/)
    ]);
    expect(card.buttons).toEqual([
      { text: "批准", value: `批准 ${proposal.approvalToken}`, style: "primary" },
      { text: "减半批准", value: `减半批准 ${proposal.approvalToken}` },
      { text: "拒绝", value: `拒绝 ${proposal.approvalToken}`, style: "danger" }
    ]);
  });

  it("omits optional clauses and falls back gracefully when fields are missing", () => {
    const db = makeDb();
    seedMember(db);
    const repo = new ProposalRepository(db);
    const proposal = repo.create({
      ownerId: "member_1",
      symbol: "AAPL.US",
      side: "sell",
      quantity: 5,
      orderType: "market",
      reason: "止盈",
      expiresAt: "2026-07-16T18:00:00.000Z"
    });

    const card = composeProposalCard(proposal, []);

    expect(card.title).toBe(`📋 提案 ${proposal.id} · 卖出 AAPL 5 股 · 市价`);
    expect(card.lines).toEqual([
      "理由: 止盈",
      "关联策略: 未设置",
      "纪律检查: 无已启用规则",
      "失效条件: 未设置 · 止损: 未设置 · 置信度: 未设置",
      "预算影响: 预算无法核算（无快照或无限价）",
      expect.stringMatching(/^过期时间: .+ 后自动作废$/)
    ]);
  });

  it("strips a dotted exchange suffix from the symbol in the title", () => {
    const db = makeDb();
    seedMember(db);
    const proposal = fullProposal(db, { symbol: "TSLA.US" });

    const card = composeProposalCard(proposal, []);

    expect(card.title).toContain("TSLA 2 股");
    expect(card.title).not.toContain("TSLA.US");
  });
});

describe("composeDecisionUpdate", () => {
  function decide(db: DatabaseSync, proposal: ReturnType<typeof fullProposal>, decision: "approved" | "approved_half" | "rejected" | "expired") {
    const repo = new ProposalRepository(db);
    const result = repo.consumeApproval(proposal.approvalToken!, {
      decision,
      decidedBy: "member_1",
      decidedAt: "2026-07-15T20:00:00.000Z"
    });
    return result.proposal!;
  }

  it("replaces buttons with a decision line, preferring decidedByDisplayName over decidedBy", () => {
    const db = makeDb();
    seedMember(db);
    const proposal = fullProposal(db);
    const decided = decide(db, proposal, "approved");

    const card = composeDecisionUpdate({ ...decided, decidedByDisplayName: "Alice" });

    expect(card.buttons).toBeUndefined();
    expect(card.lines.at(-1)).toMatch(/^决策: 已批准 · 时间: .+ · 操作人: Alice$/);
  });

  it("falls back to the raw decidedBy id when no display name is attached", () => {
    const db = makeDb();
    seedMember(db);
    const proposal = fullProposal(db);
    const decided = decide(db, proposal, "rejected");

    const card = composeDecisionUpdate(decided);

    expect(card.lines.at(-1)).toMatch(/^决策: 已拒绝 · 时间: .+ · 操作人: member_1$/);
  });

  it.each([
    ["approved", "已批准"],
    ["approved_half", "已批准（减半）"],
    ["rejected", "已拒绝"],
    ["expired", "已过期（超时自动作废）"]
  ] as const)("labels decision %s as %s", (decision, label) => {
    const db = makeDb();
    seedMember(db);
    const proposal = fullProposal(db);
    const decided = decide(db, proposal, decision);

    const card = composeDecisionUpdate(decided);

    expect(card.lines.at(-1)).toContain(`决策: ${label}`);
  });
});

describe("deliverProposalCard", () => {
  it("skips with {skipped:'no_open_id'} when the owner has no feishuOpenId on file, without touching card_message_id", async () => {
    const db = makeDb();
    seedMember(db); // no feishuOpenId
    const proposal = fullProposal(db);
    const card = composeProposalCard(proposal, []);
    let sendCalled = false;
    const transport: CardTransport = {
      sendCard: async () => {
        sendCalled = true;
        return { ok: true, messageId: "om_1" };
      },
      updateCard: async () => ({ ok: true })
    };

    const result = await deliverProposalCard(db, proposal, card, transport);

    expect(result).toEqual({ skipped: "no_open_id" });
    expect(sendCalled).toBe(false);
    expect(new ProposalRepository(db).getById(proposal.id)?.cardMessageId).toBeUndefined();
  });

  it("sends to the owner's openId and backfills card_message_id on success", async () => {
    const db = makeDb();
    seedMember(db, { feishuOpenId: "ou_alice" });
    const proposal = fullProposal(db);
    const card = composeProposalCard(proposal, []);
    let capturedTarget: unknown;
    const transport: CardTransport = {
      sendCard: async (target) => {
        capturedTarget = target;
        return { ok: true, messageId: "om_42" };
      },
      updateCard: async () => ({ ok: true })
    };

    const result = await deliverProposalCard(db, proposal, card, transport);

    expect(result).toEqual({ ok: true, messageId: "om_42" });
    expect(capturedTarget).toEqual({ openId: "ou_alice" });
    expect(new ProposalRepository(db).getById(proposal.id)?.cardMessageId).toBe("om_42");
  });

  it("surfaces a transport failure as {ok:false, error} without throwing", async () => {
    const db = makeDb();
    seedMember(db, { feishuOpenId: "ou_alice" });
    const proposal = fullProposal(db);
    const card = composeProposalCard(proposal, []);
    const transport: CardTransport = {
      sendCard: async () => ({ ok: false, error: "rate limited" }),
      updateCard: async () => ({ ok: true })
    };

    const result = await deliverProposalCard(db, proposal, card, transport);

    expect(result).toEqual({ ok: false, error: "rate limited" });
    expect(new ProposalRepository(db).getById(proposal.id)?.cardMessageId).toBeUndefined();
  });
});
