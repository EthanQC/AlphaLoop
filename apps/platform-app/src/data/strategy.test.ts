import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MemberRepository, createId, migrate, type Member } from "@packages/shared-types";

import {
  computeComplianceStats,
  groupThesesByOwner,
  loadCirclePublicTheses,
  loadLatestPriceForSymbol,
  loadOwnTheses,
  loadPublicStrategyCards,
  loadStrategyCardsForOwner,
  loadSubjectStrategyCards,
  loadSubjectTheses,
  loadThesesForSymbol,
  loadThesisHistory
} from "./strategy.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member_1",
    email: "member1@example.com",
    displayName: "Member One",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function seedMembers(db: DatabaseSync, members: Array<Partial<Member> & { id: string }>): void {
  const repo = new MemberRepository(db);
  for (const member of members) {
    repo.upsert(makeMember({ ...member, email: member.email ?? `${member.id}@example.com` }));
  }
}

function seedThesis(
  db: DatabaseSync,
  opts: {
    ownerId: string;
    symbol: string;
    direction?: "bull" | "bear" | "neutral";
    visibility?: "system" | "public";
    bullPoints?: string[];
    bearPoints?: string[];
    targetLow?: number;
    targetHigh?: number;
    invalidationPrice?: number;
    createdAt?: string;
  }
): string {
  const id = createId("thesis");
  db.prepare(`
    INSERT INTO theses
      (id, owner_id, symbol, direction, target_low, target_high, invalidation_price,
       visibility, created_at, updated_at, bull_points, bear_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.ownerId,
    opts.symbol,
    opts.direction ?? "bull",
    opts.targetLow ?? null,
    opts.targetHigh ?? null,
    opts.invalidationPrice ?? null,
    opts.visibility ?? "system",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z",
    JSON.stringify(opts.bullPoints ?? []),
    JSON.stringify(opts.bearPoints ?? [])
  );
  return id;
}

function seedStrategyCard(
  db: DatabaseSync,
  opts: {
    ownerId: string;
    name: string;
    status?: "active" | "paused" | "retired";
    visibility?: "system" | "public";
    createdAt?: string;
  }
): string {
  const id = createId("strategy_card");
  db.prepare(`
    INSERT INTO strategy_cards (id, owner_id, name, status, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.ownerId,
    opts.name,
    opts.status ?? "active",
    opts.visibility ?? "system",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z"
  );
  return id;
}

function seedProposal(
  db: DatabaseSync,
  opts: { ownerId: string; symbol?: string; createdAt: string; disciplineReport: unknown[] }
): void {
  db.prepare(`
    INSERT INTO proposals (id, owner_id, symbol, side, quantity, order_type, reason, discipline_report, status, created_at, expires_at)
    VALUES (?, ?, ?, 'buy', 1, 'limit', 'test reason', ?, 'pending', ?, ?)
  `).run(
    createId("proposal"),
    opts.ownerId,
    opts.symbol ?? "NVDA.US",
    JSON.stringify(opts.disciplineReport),
    opts.createdAt,
    opts.createdAt
  );
}

function seedStockFact(db: DatabaseSync, opts: { symbol: string; tradingDay: string; valueNum: number }): void {
  db.prepare(`
    INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES (?, ?, ?, 'quote.last', ?, NULL, 'USD', 'test', ?, ?)
  `).run(createId("stock_fact"), opts.tradingDay, opts.symbol, opts.valueNum, opts.tradingDay, opts.tradingDay);
}

describe("theses readers: bull_points/bear_points evidence", () => {
  it("loadOwnTheses parses bull_points/bear_points JSON arrays", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    seedThesis(db, {
      ownerId: "member_a",
      symbol: "NVDA.US",
      bullPoints: ["算力需求旺盛", "财报超预期"],
      bearPoints: ["估值偏高"]
    });

    const [thesis] = loadOwnTheses(db, "member_a");
    expect(thesis?.bullPoints).toEqual(["算力需求旺盛", "财报超预期"]);
    expect(thesis?.bearPoints).toEqual(["估值偏高"]);
  });

  it("defaults to an empty array for a malformed/missing bull_points column value (never throws)", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    const id = seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US" });
    db.prepare(`UPDATE theses SET bull_points = 'not json' WHERE id = ?`).run(id);

    const [thesis] = loadOwnTheses(db, "member_a");
    expect(thesis?.bullPoints).toEqual([]);
  });
});

describe("theses readers: isolation (服务端强制隔离)", () => {
  it("loadCirclePublicTheses: A's 'system' thesis is invisible to B; A's 'public' thesis is visible", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a", displayName: "甲" }, { id: "member_b" }]);
    seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US", visibility: "system" });
    seedThesis(db, { ownerId: "member_a", symbol: "TSLA.US", visibility: "public" });

    const circle = loadCirclePublicTheses(db, "member_b");
    expect(circle).toHaveLength(1);
    expect(circle[0]?.symbol).toBe("TSLA.US");
  });

  it("loadCirclePublicTheses excludes a revoked member's public thesis", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a", status: "revoked" }, { id: "member_b" }]);
    seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US", visibility: "public" });

    expect(loadCirclePublicTheses(db, "member_b")).toEqual([]);
  });

  it("loadThesesForSymbol: viewer sees their own thesis of any visibility plus others' public ones only", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }, { id: "member_b" }]);
    seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US", visibility: "system", direction: "bear" });
    seedThesis(db, { ownerId: "member_b", symbol: "NVDA.US", visibility: "system", direction: "bull" });

    const forA = loadThesesForSymbol(db, "member_a", "NVDA.US");
    expect(forA).toHaveLength(1);
    expect(forA[0]?.ownerId).toBe("member_a");

    seedThesis(db, { ownerId: "member_b", symbol: "NVDA.US", visibility: "public", direction: "neutral" });
    const forAAfterPublic = loadThesesForSymbol(db, "member_a", "NVDA.US");
    expect(forAAfterPublic.map((t) => t.direction).sort()).toEqual(["bear", "neutral"]);
  });

  it("loadSubjectTheses: only public when viewer is not the subject; every visibility when viewer IS the subject", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US", visibility: "public" });
    seedThesis(db, { ownerId: "member_a", symbol: "TSLA.US", visibility: "system" });

    expect(loadSubjectTheses(db, "member_a", false)).toHaveLength(1);
    expect(loadSubjectTheses(db, "member_a", true)).toHaveLength(2);
  });
});

describe("groupThesesByOwner", () => {
  it("groups by owner preserving first-seen order", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a", displayName: "甲" }, { id: "member_b", displayName: "乙" }]);
    seedThesis(db, { ownerId: "member_b", symbol: "NVDA.US", visibility: "public", createdAt: "2026-07-02T00:00:00.000Z" });
    seedThesis(db, { ownerId: "member_a", symbol: "TSLA.US", visibility: "public", createdAt: "2026-07-01T00:00:00.000Z" });

    const groups = groupThesesByOwner(loadCirclePublicTheses(db, "member_z_not_a_real_member"));
    // SQL orders by display_name ASC under SQLite's default BINARY collation
    // (byte order, not locale-aware pinyin) - "乙" (U+4E59) sorts before "甲"
    // (U+7532) in UTF-8 byte order regardless of insertion order.
    expect(groups.map((g) => g.ownerDisplayName)).toEqual(["乙", "甲"]);
  });
});

describe("loadThesisHistory", () => {
  it("returns append-only history oldest-first", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    const thesisId = seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US" });
    db.prepare(`INSERT INTO thesis_history (id, thesis_id, note, source, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      createId("thesis_hist"),
      thesisId,
      "第二次",
      "self",
      "2026-07-05T00:00:00.000Z"
    );
    db.prepare(`INSERT INTO thesis_history (id, thesis_id, note, source, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      createId("thesis_hist"),
      thesisId,
      "第一次",
      "self",
      "2026-07-01T00:00:00.000Z"
    );

    const history = loadThesisHistory(db, thesisId);
    expect(history.map((h) => h.note)).toEqual(["第一次", "第二次"]);
  });
});

describe("strategy_cards readers", () => {
  it("loadStrategyCardsForOwner returns the owner's own cards regardless of visibility", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    seedStrategyCard(db, { ownerId: "member_a", name: "动量策略", visibility: "system", status: "active" });
    seedStrategyCard(db, { ownerId: "member_a", name: "价值策略", visibility: "public", status: "paused" });

    const cards = loadStrategyCardsForOwner(db, "member_a");
    expect(cards).toHaveLength(2);
  });

  it("loadPublicStrategyCards: isolation - only OTHER members' public cards, never system-tier or the excluded owner's own", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a", displayName: "甲" }, { id: "member_b" }]);
    seedStrategyCard(db, { ownerId: "member_a", name: "系统内策略", visibility: "system" });
    seedStrategyCard(db, { ownerId: "member_a", name: "公开策略", visibility: "public", status: "retired" });

    const publicCards = loadPublicStrategyCards(db, "member_b");
    expect(publicCards).toHaveLength(1);
    expect(publicCards[0]?.name).toBe("公开策略");
    expect(publicCards[0]?.status).toBe("retired");

    // The excluded owner never sees their OWN card back out of this reader.
    expect(loadPublicStrategyCards(db, "member_a")).toEqual([]);
  });

  it("loadPublicStrategyCards excludes a revoked member's public card", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a", status: "revoked" }, { id: "member_b" }]);
    seedStrategyCard(db, { ownerId: "member_a", name: "公开策略", visibility: "public" });

    expect(loadPublicStrategyCards(db, "member_b")).toEqual([]);
  });

  it("loadSubjectStrategyCards: only public when viewer is not the subject; every visibility when viewer IS the subject", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    seedStrategyCard(db, { ownerId: "member_a", name: "公开策略", visibility: "public" });
    seedStrategyCard(db, { ownerId: "member_a", name: "系统策略", visibility: "system" });

    expect(loadSubjectStrategyCards(db, "member_a", false)).toHaveLength(1);
    expect(loadSubjectStrategyCards(db, "member_a", true)).toHaveLength(2);
  });
});

describe("computeComplianceStats: 近30天遵守 from proposals.discipline_report", () => {
  const NOW = new Date("2026-07-14T12:00:00.000Z");

  it("no proposal at all in the window -> {sample: 'none'}", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    expect(computeComplianceStats(db, "member_a", "rule_1", NOW)).toEqual({ sample: "none" });
  });

  it("no proposal mentions this rule id -> {sample: 'none'}", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    seedProposal(db, {
      ownerId: "member_a",
      createdAt: "2026-07-10T00:00:00.000Z",
      disciplineReport: [{ ruleId: "some_other_rule", pass: true }]
    });
    expect(computeComplianceStats(db, "member_a", "rule_1", NOW)).toEqual({ sample: "none" });
  });

  it("tallies pass/fail across proposals within the last 30 days for this rule id", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    seedProposal(db, {
      ownerId: "member_a",
      createdAt: "2026-07-10T00:00:00.000Z",
      disciplineReport: [{ ruleId: "rule_1", pass: true }]
    });
    seedProposal(db, {
      ownerId: "member_a",
      createdAt: "2026-07-11T00:00:00.000Z",
      disciplineReport: [{ ruleId: "rule_1", pass: false }]
    });
    seedProposal(db, {
      ownerId: "member_a",
      createdAt: "2026-07-12T00:00:00.000Z",
      disciplineReport: [{ ruleId: "rule_1", pass: true }]
    });

    expect(computeComplianceStats(db, "member_a", "rule_1", NOW)).toEqual({ sample: "ok", checked: 3, passed: 2, failed: 1 });
  });

  it("pass: null ('无法判定') entries count toward neither bucket", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    seedProposal(db, {
      ownerId: "member_a",
      createdAt: "2026-07-10T00:00:00.000Z",
      disciplineReport: [{ ruleId: "rule_1", pass: null }]
    });

    expect(computeComplianceStats(db, "member_a", "rule_1", NOW)).toEqual({ sample: "none" });
  });

  it("excludes proposals older than 30 days", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    seedProposal(db, {
      ownerId: "member_a",
      createdAt: "2026-05-01T00:00:00.000Z", // more than 30 days before NOW
      disciplineReport: [{ ruleId: "rule_1", pass: true }]
    });

    expect(computeComplianceStats(db, "member_a", "rule_1", NOW)).toEqual({ sample: "none" });
  });

  it("two-member isolation: A's proposals never count toward B's compliance stats", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }, { id: "member_b" }]);
    seedProposal(db, {
      ownerId: "member_a",
      createdAt: "2026-07-10T00:00:00.000Z",
      disciplineReport: [{ ruleId: "rule_1", pass: true }]
    });

    expect(computeComplianceStats(db, "member_b", "rule_1", NOW)).toEqual({ sample: "none" });
  });

  it("malformed discipline_report JSON on one row is skipped, not thrown", () => {
    const db = memoryDb();
    seedMembers(db, [{ id: "member_a" }]);
    const id = createId("proposal");
    db.prepare(`
      INSERT INTO proposals (id, owner_id, symbol, side, quantity, order_type, reason, discipline_report, status, created_at, expires_at)
      VALUES (?, 'member_a', 'NVDA.US', 'buy', 1, 'limit', 'test', 'not json', 'pending', '2026-07-10T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
    `).run(id);

    expect(() => computeComplianceStats(db, "member_a", "rule_1", NOW)).not.toThrow();
    expect(computeComplianceStats(db, "member_a", "rule_1", NOW)).toEqual({ sample: "none" });
  });
});

describe("loadLatestPriceForSymbol", () => {
  it("returns the value_num of the most recent trading_day's quote.last fact", () => {
    const db = memoryDb();
    seedStockFact(db, { symbol: "NVDA.US", tradingDay: "2026-07-10", valueNum: 120 });
    seedStockFact(db, { symbol: "NVDA.US", tradingDay: "2026-07-13", valueNum: 135.5 });

    expect(loadLatestPriceForSymbol(db, "NVDA.US")).toBe(135.5);
  });

  it("returns null when no fact exists for the symbol", () => {
    const db = memoryDb();
    expect(loadLatestPriceForSymbol(db, "GHOST.US")).toBeNull();
  });
});
