// feishu-review-notifier.mjs: the REAL review-confirm Feishu notifier
// (members.feishu_open_id lookup + sendInteractiveCard over an injected fake
// CardTransport - NO real Feishu/HTTP/subprocess is ever touched here) and
// the pure 月度复盘确认摘要 card composer. Mirrors, assertion for assertion,
// apps/platform-app/src/data/feishu-review-notifier.test.ts (the TS
// sibling's suite) so the two faces cannot drift silently.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemberRepository,
  openTradingDatabase,
  type CardTransport,
  type Member
} from "../../../packages/shared-types/dist/index.js";

import { composeReviewConfirmCardLines, createFeishuReviewNotifier } from "./feishu-review-notifier.mjs";

const OWNER = "member_a";
const OPEN_ID = "ou_member_a_open_id";

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-feishu-review-notifier-"));
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

function seedMember(db: DatabaseSync, overrides: Partial<Member> = {}): void {
  new MemberRepository(db).upsert({
    id: OWNER,
    email: `${OWNER}@example.com`,
    displayName: OWNER,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  });
}

interface SentCard {
  target: { chatId?: string; openId?: string };
  cardJson: unknown;
}

function fakeTransport(
  result: { ok: boolean; messageId?: string; error?: string } = { ok: true, messageId: "om_test_1" }
): { transport: CardTransport; calls: SentCard[] } {
  const calls: SentCard[] = [];
  const transport: CardTransport = {
    async sendCard(target, cardJson) {
      calls.push({ target, cardJson });
      return result;
    },
    async updateCard() {
      return { ok: true };
    }
  };
  return { transport, calls };
}

// Only the fields composeReviewConfirmCardLines actually reads - same
// numbers as the TS sibling suite's RESULT_FIXTURE.
const RESULT_FIXTURE = {
  predictionReview: {
    selfThesisHitRate: { sample: "ok", n: 12, hits: 8, total: 12, hitFraction: 0.67 }
  },
  decisionReview: {
    executed: { sample: "ok", n: 10, avgDecisionReturnPct: 8.5, avgBenchmarkReturnPct: 3.2, avgAlphaPct: 5.3 }
  },
  disciplineReview: {
    complianceRate: { sample: "ok", checked: 10, passed: 8, failed: 2, rate: 0.8 }
  },
  alertQuality: { sample: "ok", triggeredCount: 4, misreportCount: 2, misreportRate: 0.5 },
  oneLineLesson: "本月遵守率偏低，需复核高频违反的规则。"
};

describe("composeReviewConfirmCardLines (.mjs face)", () => {
  it("renders period, confirm time, every headline metric, the lesson, the review page path, and the disclaimer - in that order", () => {
    const lines = composeReviewConfirmCardLines({
      id: "monthly_review_1",
      period: "2026-07",
      confirmedAt: "2026-08-01T02:00:00.000Z",
      result: RESULT_FIXTURE
    });

    expect(lines).toEqual([
      "复盘周期：2026-07",
      "确认时间：2026-08-01T02:00:00.000Z",
      "本人论点命中率：67%（8/12）",
      "决策收益：平均 +8.50% vs 基准 +3.20%，超额 +5.30%",
      "纪律遵守率：80%（8/10）",
      "提醒误报率：50%（触发 4 / 误报 2）",
      "一句话教训：本月遵守率偏低，需复核高频违反的规则。",
      "复盘详情：/review/monthly_review_1（平台站内路径）",
      "以上改进建议仅供参考；任何策略/纪律变更须本人另行确认后生效。"
    ]);
  });

  it("degrades every metric honestly for a missing/malformed result - never NaN/undefined, lesson line omitted", () => {
    for (const result of [undefined, null, "not-an-object", { alertQuality: { sample: "none" } }]) {
      const lines = composeReviewConfirmCardLines({ id: "monthly_review_2", period: "2026-06", result });
      expect(lines).toContain("本人论点命中率：样本不足");
      expect(lines).toContain("决策收益：样本不足");
      expect(lines).toContain("纪律遵守率：暂无数据");
      expect(lines).toContain("提醒质量：本月无提醒触发");
      expect(lines).toContain("复盘详情：/review/monthly_review_2（平台站内路径）");
      const joined = lines.join("\n");
      expect(joined).not.toContain("NaN");
      expect(joined).not.toContain("undefined");
      expect(joined).not.toContain("一句话教训");
    }
  });
});

describe("createFeishuReviewNotifier (.mjs face)", () => {
  it("sends the interactive card to the member's feishu_open_id and reports {ok, messageId}", async () => {
    const db = makeDb();
    seedMember(db, { feishuOpenId: OPEN_ID });
    const { transport, calls } = fakeTransport();
    const notifier = createFeishuReviewNotifier({ db, transport });

    const lines = composeReviewConfirmCardLines({ id: "monthly_review_1", period: "2026-07", result: RESULT_FIXTURE });
    const result = await notifier({ ownerId: OWNER, title: "2026-07 月度复盘已确认", lines });

    expect(result).toEqual({ ok: true, messageId: "om_test_1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toEqual({ openId: OPEN_ID });

    // The card payload is buildFeishuCardPayload's shape (the exact payload
    // market-alerts cards ship today): schema 2.0, plain_text header title,
    // one markdown element per composed line.
    const payload = calls[0]?.cardJson as {
      schema: string;
      header: { title: { tag: string; content: string }; template: string };
      body: { elements: Array<{ tag: string; content: string }> };
    };
    expect(payload.schema).toBe("2.0");
    expect(payload.header.title).toEqual({ tag: "plain_text", content: "2026-07 月度复盘已确认" });
    expect(payload.body.elements.map((element) => element.content)).toEqual(lines);
  });

  it("degrades to {ok:false, reason} without touching the transport when the member has no feishu_open_id", async () => {
    const db = makeDb();
    seedMember(db); // no feishuOpenId
    const { transport, calls } = fakeTransport();
    const notifier = createFeishuReviewNotifier({ db, transport });

    const result = await notifier({ ownerId: OWNER, title: "t", lines: ["l"] });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("feishu_open_id");
    expect(calls).toHaveLength(0);
  });

  it("degrades to {ok:false, reason} without touching the transport for an unknown member", async () => {
    const db = makeDb();
    const { transport, calls } = fakeTransport();
    const notifier = createFeishuReviewNotifier({ db, transport });

    const result = await notifier({ ownerId: "member_ghost", title: "t", lines: ["l"] });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("成员不存在");
    expect(calls).toHaveLength(0);
  });

  it("surfaces a transport {ok:false} as {ok:false, reason} - never a throw", async () => {
    const db = makeDb();
    seedMember(db, { feishuOpenId: OPEN_ID });
    const { transport } = fakeTransport({ ok: false, error: "feishu rejected (fake)" });
    const notifier = createFeishuReviewNotifier({ db, transport });

    const result = await notifier({ ownerId: OWNER, title: "t", lines: ["l"] });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("feishu rejected (fake)");
  });

  it("a THROWING transport degrades the same way (sendInteractiveCard already catches it)", async () => {
    const db = makeDb();
    seedMember(db, { feishuOpenId: OPEN_ID });
    const transport: CardTransport = {
      async sendCard() {
        throw new Error("transport exploded (fake)");
      },
      async updateCard() {
        return { ok: true };
      }
    };
    const notifier = createFeishuReviewNotifier({ db, transport });

    const result = await notifier({ ownerId: OWNER, title: "t", lines: ["l"] });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("transport exploded (fake)");
  });
});
