import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MemberRepository, createId, migrate, type Member } from "@packages/shared-types";

import {
  loadDisciplineRules,
  loadLatestSnapshotForOwner,
  loadPendingProposals,
  loadPreviousDaySnapshotForOwner,
  loadRecentAlertEvents
} from "./overview.js";

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

function seedSnapshot(
  db: DatabaseSync,
  opts: {
    ownerId: string | null;
    fetchedAt?: string;
    netAssets?: number | null;
    marketValue?: number;
    positions?: unknown[];
    degraded?: boolean;
    degradedReason?: string | null;
  }
): void {
  const fetchedAt = opts.fetchedAt ?? "2026-07-14T02:00:00.000Z";
  const positions = opts.positions ?? [];
  const raw = {
    fetchedAt,
    degraded: opts.degraded ?? false,
    degradedReason: opts.degradedReason ?? null
  };
  db.prepare(`
    INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?)
  `).run(
    createId("snapshot"),
    fetchedAt,
    opts.netAssets === undefined ? null : opts.netAssets,
    null,
    opts.marketValue ?? 0,
    JSON.stringify(positions),
    JSON.stringify(raw),
    opts.ownerId
  );
}

function seedAlertRule(
  db: DatabaseSync,
  opts: { id: string; ownerId: string; symbol: string; ruleType?: string }
): void {
  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
    VALUES (?, ?, ?, ?, 5, 'both', 'continuous', 0, 1, '2026-07-01T00:00:00.000Z')
  `).run(opts.id, opts.ownerId, opts.symbol, opts.ruleType ?? "daily_move");
}

function seedAlertEvent(
  db: DatabaseSync,
  opts: { ruleId: string; ownerId: string; triggeredAt: string; value: number }
): void {
  db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value)
    VALUES (?, ?, ?, ?, ?)
  `).run(createId("alert_event"), opts.ruleId, opts.ownerId, opts.triggeredAt, opts.value);
}

function seedProposal(db: DatabaseSync, opts: { ownerId: string; symbol: string; status?: string }): void {
  db.prepare(`
    INSERT INTO proposals (id, owner_id, symbol, side, quantity, order_type, reason, status, created_at, expires_at)
    VALUES (?, ?, ?, 'buy', 1, 'limit', 'test reason', ?, '2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
  `).run(createId("proposal"), opts.ownerId, opts.symbol, opts.status ?? "pending");
}

function seedDisciplineRule(db: DatabaseSync, opts: { ownerId: string; ruleText: string; enabled?: boolean }): void {
  db.prepare(`
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, enabled, created_at)
    VALUES (?, ?, ?, 'self', ?, '2026-07-01T00:00:00.000Z')
  `).run(createId("discipline_rule"), opts.ownerId, opts.ruleText, opts.enabled === false ? 0 : 1);
}

describe("loadLatestSnapshotForOwner", () => {
  it("returns the owner's own row when there is no fallback row", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "member_1", positions: [{ symbol: "NVDA.US" }] });

    const row = loadLatestSnapshotForOwner(db, "member_1");

    expect(row).not.toBeNull();
    expect(row?.positions).toEqual([{ symbol: "NVDA.US" }]);
  });

  it("falls back to a NULL-owner row when the owner has none of their own", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: null, positions: [{ symbol: "MSFT.US" }] });

    const row = loadLatestSnapshotForOwner(db, "member_1");

    expect(row).not.toBeNull();
    expect(row?.positions).toEqual([{ symbol: "MSFT.US" }]);
  });

  it("falls back to a '__shared__'-owner row when the owner has none of their own", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "__shared__", positions: [{ symbol: "TSLA.US" }] });

    const row = loadLatestSnapshotForOwner(db, "member_1");

    expect(row).not.toBeNull();
    expect(row?.positions).toEqual([{ symbol: "TSLA.US" }]);
  });

  it("prefers the owner's OWN row even when it is OLDER than a shared/NULL row (adjudicated precedence)", () => {
    const db = memoryDb();
    seedSnapshot(db, {
      ownerId: "member_1",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      positions: [{ symbol: "OWN.US" }]
    });
    seedSnapshot(db, {
      ownerId: "__shared__",
      fetchedAt: "2026-07-10T00:00:00.000Z",
      positions: [{ symbol: "POOL.US" }]
    });
    seedSnapshot(db, {
      ownerId: null,
      fetchedAt: "2026-07-12T00:00:00.000Z",
      positions: [{ symbol: "POOL2.US" }]
    });

    const row = loadLatestSnapshotForOwner(db, "member_1");

    expect(row?.positions).toEqual([{ symbol: "OWN.US" }]);
  });

  it("returns null when there is no snapshot at all", () => {
    const db = memoryDb();
    expect(loadLatestSnapshotForOwner(db, "member_1")).toBeNull();
  });

  it("parses the degraded/degradedReason markers from the raw blob", () => {
    const db = memoryDb();
    seedSnapshot(db, {
      ownerId: "member_1",
      degraded: true,
      degradedReason: "行情读取失败：NVDA.US(按成本估值)",
      positions: [{ symbol: "NVDA.US", priceSource: "cost", price: 100 }]
    });

    const row = loadLatestSnapshotForOwner(db, "member_1");

    expect(row?.degraded).toBe(true);
    expect(row?.degradedReason).toBe("行情读取失败：NVDA.US(按成本估值)");
    expect(row?.positions[0]?.priceSource).toBe("cost");
  });

  it("two-member isolation: member A's own row never leaks to member B when B has none (falls back to shared only)", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "member_a", positions: [{ symbol: "A_ONLY.US" }] });

    const rowForB = loadLatestSnapshotForOwner(db, "member_b");

    // B has no own row and no shared/NULL row either -> null, NOT A's row.
    expect(rowForB).toBeNull();
  });
});

describe("loadPreviousDaySnapshotForOwner", () => {
  it("returns the most recent row strictly before the Beijing calendar day of `now`", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-13T05:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-14T02:00:00.000Z", netAssets: 1100 });

    // 2026-07-14T12:00:00Z is 2026-07-14 20:00 Beijing time.
    const row = loadPreviousDaySnapshotForOwner(db, "member_1", new Date("2026-07-14T12:00:00.000Z"));

    expect(row?.netAssets).toBe(1000);
  });

  it("returns null when the owner has no row before today", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-14T02:00:00.000Z", netAssets: 1100 });

    const row = loadPreviousDaySnapshotForOwner(db, "member_1", new Date("2026-07-14T12:00:00.000Z"));

    expect(row).toBeNull();
  });
});

function seedMembers(db: DatabaseSync, ids: string[]): void {
  const repo = new MemberRepository(db);
  for (const id of ids) {
    repo.upsert(makeMember({ id, email: `${id}@example.com` }));
  }
}

describe("loadRecentAlertEvents", () => {
  it("returns only this owner's events, newest first, with symbol/rule_type joined in", () => {
    const db = memoryDb();
    seedMembers(db, ["member_a", "member_b"]);
    seedAlertRule(db, { id: "rule_a", ownerId: "member_a", symbol: "NVDA.US", ruleType: "daily_move" });
    seedAlertRule(db, { id: "rule_b", ownerId: "member_b", symbol: "TSLA.US", ruleType: "spike_5m" });
    seedAlertEvent(db, { ruleId: "rule_a", ownerId: "member_a", triggeredAt: "2026-07-14T01:00:00.000Z", value: -4.3 });
    seedAlertEvent(db, { ruleId: "rule_a", ownerId: "member_a", triggeredAt: "2026-07-14T03:00:00.000Z", value: -6.2 });
    seedAlertEvent(db, { ruleId: "rule_b", ownerId: "member_b", triggeredAt: "2026-07-14T02:00:00.000Z", value: 2.1 });

    const eventsForA = loadRecentAlertEvents(db, "member_a", 10);

    expect(eventsForA).toHaveLength(2);
    expect(eventsForA[0]?.value).toBe(-6.2); // newest first
    expect(eventsForA[0]?.symbol).toBe("NVDA.US");
    expect(eventsForA[0]?.ruleType).toBe("daily_move");
    expect(eventsForA.every((event) => event.ownerId === "member_a")).toBe(true);
  });

  it("two-member isolation: A's alert events never appear in B's results", () => {
    const db = memoryDb();
    seedMembers(db, ["member_a", "member_b"]);
    seedAlertRule(db, { id: "rule_a", ownerId: "member_a", symbol: "NVDA.US" });
    seedAlertEvent(db, { ruleId: "rule_a", ownerId: "member_a", triggeredAt: "2026-07-14T01:00:00.000Z", value: 1 });

    const eventsForB = loadRecentAlertEvents(db, "member_b", 10);

    expect(eventsForB).toEqual([]);
  });

  it("respects the limit", () => {
    const db = memoryDb();
    seedMembers(db, ["member_a"]);
    seedAlertRule(db, { id: "rule_a", ownerId: "member_a", symbol: "NVDA.US" });
    for (let i = 0; i < 5; i += 1) {
      seedAlertEvent(db, { ruleId: "rule_a", ownerId: "member_a", triggeredAt: `2026-07-14T0${i}:00:00.000Z`, value: i });
    }

    expect(loadRecentAlertEvents(db, "member_a", 2)).toHaveLength(2);
  });
});

describe("loadPendingProposals", () => {
  it("two-member isolation: A's proposals never appear in B's results", () => {
    const db = memoryDb();
    seedMembers(db, ["member_a", "member_b"]);
    seedProposal(db, { ownerId: "member_a", symbol: "NVDA.US" });

    expect(loadPendingProposals(db, "member_b")).toEqual([]);
    expect(loadPendingProposals(db, "member_a")).toHaveLength(1);
  });

  it("excludes non-pending proposals", () => {
    const db = memoryDb();
    seedMembers(db, ["member_a"]);
    seedProposal(db, { ownerId: "member_a", symbol: "NVDA.US", status: "approved" });

    expect(loadPendingProposals(db, "member_a")).toEqual([]);
  });

  it("returns an empty array when there are no proposals at all", () => {
    const db = memoryDb();
    seedMembers(db, ["member_a"]);
    expect(loadPendingProposals(db, "member_a")).toEqual([]);
  });
});

describe("loadDisciplineRules", () => {
  it("two-member isolation: A's rules never appear in B's results", () => {
    const db = memoryDb();
    seedMembers(db, ["member_a", "member_b"]);
    seedDisciplineRule(db, { ownerId: "member_a", ruleText: "财报周不加仓" });

    expect(loadDisciplineRules(db, "member_b")).toEqual([]);
    expect(loadDisciplineRules(db, "member_a")).toHaveLength(1);
  });

  it("excludes disabled rules", () => {
    const db = memoryDb();
    seedMembers(db, ["member_a"]);
    seedDisciplineRule(db, { ownerId: "member_a", ruleText: "已停用规则", enabled: false });

    expect(loadDisciplineRules(db, "member_a")).toEqual([]);
  });
});
