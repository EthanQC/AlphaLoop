import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const store = await import("./strategy-store.mjs");

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-strategy-store-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  return openTradingDatabase(dbPath);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id = "owner_1"): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

// ---------------------------------------------------------------------------
// ThesisStore
// ---------------------------------------------------------------------------

describe("createThesis / getThesisById", () => {
  it("creates a thesis defaulting visibility to 'system', status to 'active', bull/bear points to []", () => {
    const db = makeDb();
    seedMember(db);

    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });

    expect(thesis.ownerId).toBe("owner_1");
    expect(thesis.symbol).toBe("AAPL.US");
    expect(thesis.direction).toBe("bull");
    expect(thesis.visibility).toBe("system");
    expect(thesis.status).toBe("active");
    expect(thesis.bullPoints).toEqual([]);
    expect(thesis.bearPoints).toEqual([]);
    expect(thesis.memorySlug).toBeNull();
    expect(thesis.id).toMatch(/^thesis_/);

    expect(store.getThesisById(db, thesis.id)).toEqual(thesis);
  });

  it("round-trips bullPoints/bearPoints/targetLow/targetHigh/invalidationPrice/visibility as supplied", () => {
    const db = makeDb();
    seedMember(db);

    const thesis = store.createThesis(db, {
      ownerId: "owner_1",
      symbol: "MSFT.US",
      direction: "bear",
      targetLow: 300,
      targetHigh: 350,
      invalidationPrice: 420,
      bullPoints: ["云业务增速超预期"],
      bearPoints: ["估值过高", "监管风险"],
      visibility: "public"
    });

    expect(thesis.targetLow).toBe(300);
    expect(thesis.targetHigh).toBe(350);
    expect(thesis.invalidationPrice).toBe(420);
    expect(thesis.bullPoints).toEqual(["云业务增速超预期"]);
    expect(thesis.bearPoints).toEqual(["估值过高", "监管风险"]);
    expect(thesis.visibility).toBe("public");

    // Stored as JSON text at the SQL layer, not some other representation.
    const raw = db.prepare("SELECT bull_points, bear_points FROM theses WHERE id = ?").get(thesis.id) as {
      bull_points: string;
      bear_points: string;
    };
    expect(raw.bull_points).toBe(JSON.stringify(["云业务增速超预期"]));
    expect(raw.bear_points).toBe(JSON.stringify(["估值过高", "监管风险"]));
  });

  it("getThesisById returns null for an unknown id", () => {
    const db = makeDb();
    expect(store.getThesisById(db, "thesis_nope")).toBeNull();
  });

  it("rejects an invalid direction via the theses CHECK constraint", () => {
    const db = makeDb();
    seedMember(db);
    expect(() =>
      store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "sideways" as never })
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("appendThesisJudgment / listThesisJudgments (append-only)", () => {
  it("appends a judgment and reads it back oldest-first", () => {
    const db = makeDb();
    seedMember(db);
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });

    store.appendThesisJudgment(db, thesis.id, { note: "突破年线", source: "self" });
    store.appendThesisJudgment(db, thesis.id, { note: "财报超预期", source: "conclusion_box" });

    const history = store.listThesisJudgments(db, thesis.id);
    expect(history).toHaveLength(2);
    expect(history[0].note).toBe("突破年线");
    expect(history[1].note).toBe("财报超预期");
    expect(history[1].source).toBe("conclusion_box");
  });

  it("a 'correction' is a NEW judgment row, never an edit of a prior one - the row count only grows", () => {
    const db = makeDb();
    seedMember(db);
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });

    store.appendThesisJudgment(db, thesis.id, { note: "原判断：目标价 200", source: "self" });
    store.appendThesisJudgment(db, thesis.id, { note: "更正：原判断数据有误，目标价应为 220", source: "self" });

    const history = store.listThesisJudgments(db, thesis.id);
    expect(history).toHaveLength(2);
    expect(history[0].note).toBe("原判断：目标价 200"); // untouched, not edited in place
    expect(history[1].note).toContain("更正");
  });

  it("this module exports NO delete/remove function for thesis judgments (append-only is structural, not just convention)", () => {
    const exportNames = Object.keys(store);
    const judgmentRelated = exportNames.filter((name) => /thesis.*hist|judgment/i.test(name));
    expect(judgmentRelated.length).toBeGreaterThan(0); // sanity: the append/list functions do exist
    for (const name of exportNames) {
      expect(name.toLowerCase()).not.toMatch(/delete|remove/);
    }
  });

  it("throws a FOREIGN KEY error appending to a nonexistent thesis id, rather than silently inserting an orphan row", () => {
    const db = makeDb();
    expect(() => store.appendThesisJudgment(db, "thesis_missing", { note: "x", source: "self" })).toThrow(
      /FOREIGN KEY constraint failed/
    );
  });
});

describe("promoteThesisVisibility (three-tier promote: system -> public)", () => {
  it("promotes system -> public for the owner", () => {
    const db = makeDb();
    seedMember(db);
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });
    expect(thesis.visibility).toBe("system");

    const promoted = store.promoteThesisVisibility(db, thesis.id, "owner_1");
    expect(promoted.visibility).toBe("public");
    expect(store.getThesisById(db, thesis.id)?.visibility).toBe("public");
  });

  it("rejects promotion by a non-owner, leaving visibility unchanged", () => {
    const db = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });

    expect(() => store.promoteThesisVisibility(db, thesis.id, "owner_2")).toThrow(/无权操作/);
    expect(store.getThesisById(db, thesis.id)?.visibility).toBe("system");
  });

  it("promoting an already-public thesis is idempotent (no throw, unchanged result)", () => {
    const db = makeDb();
    seedMember(db);
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull", visibility: "public" });

    const result = store.promoteThesisVisibility(db, thesis.id, "owner_1");
    expect(result.visibility).toBe("public");
  });

  it("throws for an unknown thesis id", () => {
    const db = makeDb();
    expect(() => store.promoteThesisVisibility(db, "thesis_missing", "owner_1")).toThrow(/未找到论点/);
  });
});

describe("withdrawThesis (status -> withdrawn, history preserved)", () => {
  it("withdraws an owner's own thesis, preserving thesis_history rows", () => {
    const db = makeDb();
    seedMember(db);
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });
    store.appendThesisJudgment(db, thesis.id, { note: "note 1", source: "self" });

    const withdrawn = store.withdrawThesis(db, thesis.id, "owner_1");
    expect(withdrawn.status).toBe("withdrawn");

    // History is NOT recalled/deleted just because the thesis was withdrawn -
    // "降档不回收已生成历史".
    expect(store.listThesisJudgments(db, thesis.id)).toHaveLength(1);
  });

  it("rejects withdrawal by a non-owner", () => {
    const db = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });

    expect(() => store.withdrawThesis(db, thesis.id, "owner_2")).toThrow(/无权操作/);
    expect(store.getThesisById(db, thesis.id)?.status).toBe("active");
  });
});

describe("setThesisMemorySlug", () => {
  it("sets memory_slug for the owner", () => {
    const db = makeDb();
    seedMember(db);
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });

    const updated = store.setThesisMemorySlug(db, thesis.id, "owner_1", "slug-abc");
    expect(updated.memorySlug).toBe("slug-abc");
  });

  it("rejects a non-owner", () => {
    const db = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const thesis = store.createThesis(db, { ownerId: "owner_1", symbol: "AAPL.US", direction: "bull" });

    expect(() => store.setThesisMemorySlug(db, thesis.id, "owner_2", "slug-abc")).toThrow(/无权操作/);
  });
});

// ---------------------------------------------------------------------------
// DisciplineStore
// ---------------------------------------------------------------------------

describe("createRule / listRulesForOwner", () => {
  it("creates a rule enabled by default", () => {
    const db = makeDb();
    seedMember(db);

    const rule = store.createRule(db, { ownerId: "owner_1", ruleText: "仓位≤30%", enforcement: "hard" });
    expect(rule.enabled).toBe(true);
    expect(rule.disabledAt).toBeNull();
    expect(rule.linkedStrategy).toBeNull();
    expect(rule.id).toMatch(/^discipline_rule_/);
  });

  it("rejects an invalid enforcement value via CHECK", () => {
    const db = makeDb();
    seedMember(db);
    expect(() =>
      store.createRule(db, { ownerId: "owner_1", ruleText: "x", enforcement: "not_real" as never })
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("disableRule / enableRule (disable preserves history, never deletes)", () => {
  it("disableRule sets enabled=0 and disabled_at, the row itself stays", () => {
    const db = makeDb();
    seedMember(db);
    const rule = store.createRule(db, { ownerId: "owner_1", ruleText: "仓位≤30%", enforcement: "hard" });

    const disabled = store.disableRule(db, rule.id, "owner_1");
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledAt).not.toBeNull();

    // The row still exists and is readable - "停用不可删".
    const stillThere = db.prepare("SELECT id FROM discipline_rules WHERE id = ?").get(rule.id);
    expect(stillThere).toBeDefined();
    expect(store.listRulesForOwner(db, "owner_1").map((r) => r.id)).toContain(rule.id);
  });

  it("enableRule re-arms a disabled rule and clears disabled_at", () => {
    const db = makeDb();
    seedMember(db);
    const rule = store.createRule(db, { ownerId: "owner_1", ruleText: "仓位≤30%", enforcement: "hard" });
    store.disableRule(db, rule.id, "owner_1");

    const enabled = store.enableRule(db, rule.id, "owner_1");
    expect(enabled.enabled).toBe(true);
    expect(enabled.disabledAt).toBeNull();
  });

  it("rejects disable/enable by a non-owner", () => {
    const db = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const rule = store.createRule(db, { ownerId: "owner_1", ruleText: "仓位≤30%", enforcement: "hard" });

    expect(() => store.disableRule(db, rule.id, "owner_2")).toThrow(/无权操作/);
    expect(() => store.enableRule(db, rule.id, "owner_2")).toThrow(/无权操作/);
  });

  it("listRulesForOwner includes disabled rules, flagged via enabled:false", () => {
    const db = makeDb();
    seedMember(db);
    const active = store.createRule(db, { ownerId: "owner_1", ruleText: "规则A", enforcement: "self" });
    const disabled = store.createRule(db, { ownerId: "owner_1", ruleText: "规则B", enforcement: "self" });
    store.disableRule(db, disabled.id, "owner_1");

    const rules = store.listRulesForOwner(db, "owner_1");
    expect(rules).toHaveLength(2);
    const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
    expect(byId[active.id].enabled).toBe(true);
    expect(byId[disabled.id].enabled).toBe(false);
  });

  it("this module exports NO delete/remove function for discipline rules", () => {
    for (const name of Object.keys(store)) {
      expect(name.toLowerCase()).not.toMatch(/delete|remove/);
    }
  });
});

// ---------------------------------------------------------------------------
// StrategyCardStore
// ---------------------------------------------------------------------------

describe("createCard / getCardById", () => {
  it("creates a card defaulting status to 'active', visibility to 'system'", () => {
    const db = makeDb();
    seedMember(db);

    const card = store.createCard(db, { ownerId: "owner_1", name: "趋势跟随" });
    expect(card.status).toBe("active");
    expect(card.visibility).toBe("system");
    expect(card.id).toMatch(/^strategy_card_/);
    expect(store.getCardById(db, card.id)).toEqual(card);
  });

  it("rejects an invalid status via CHECK", () => {
    const db = makeDb();
    seedMember(db);
    // setStatus is the write path that would surface this; exercised below.
    const card = store.createCard(db, { ownerId: "owner_1", name: "趋势跟随" });
    expect(() => store.setStatus(db, card.id, "owner_1", "not_a_status" as never)).toThrow(
      /CHECK constraint failed/
    );
  });
});

describe("setStatus (active|paused|retired - non-destructive stand-in for delete)", () => {
  it("transitions status for the owner", () => {
    const db = makeDb();
    seedMember(db);
    const card = store.createCard(db, { ownerId: "owner_1", name: "趋势跟随" });

    const retired = store.setStatus(db, card.id, "owner_1", "retired");
    expect(retired.status).toBe("retired");
    // The row still exists - retiring is not deleting.
    expect(store.getCardById(db, card.id)).not.toBeNull();
  });

  it("rejects a non-owner", () => {
    const db = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const card = store.createCard(db, { ownerId: "owner_1", name: "趋势跟随" });

    expect(() => store.setStatus(db, card.id, "owner_2", "paused")).toThrow(/无权操作/);
  });
});

describe("promoteVisibility (three-tier promote: system -> public)", () => {
  it("promotes system -> public for the owner", () => {
    const db = makeDb();
    seedMember(db);
    const card = store.createCard(db, { ownerId: "owner_1", name: "趋势跟随" });

    const promoted = store.promoteVisibility(db, card.id, "owner_1");
    expect(promoted.visibility).toBe("public");
  });

  it("rejects promotion by a non-owner", () => {
    const db = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const card = store.createCard(db, { ownerId: "owner_1", name: "趋势跟随" });

    expect(() => store.promoteVisibility(db, card.id, "owner_2")).toThrow(/无权操作/);
    expect(store.getCardById(db, card.id)?.visibility).toBe("system");
  });

  it("promoting an already-public card is idempotent", () => {
    const db = makeDb();
    seedMember(db);
    const card = store.createCard(db, { ownerId: "owner_1", name: "趋势跟随", visibility: "public" });

    const result = store.promoteVisibility(db, card.id, "owner_1");
    expect(result.visibility).toBe("public");
  });
});

describe("listCardsForOwner / listPublicCards (server-side isolation)", () => {
  it("listCardsForOwner returns every card owned by that owner, any status/visibility", () => {
    const db = makeDb();
    seedMember(db);
    const a = store.createCard(db, { ownerId: "owner_1", name: "卡A" });
    const b = store.createCard(db, { ownerId: "owner_1", name: "卡B", visibility: "public" });
    store.setStatus(db, b.id, "owner_1", "paused");

    const cards = store.listCardsForOwner(db, "owner_1");
    expect(cards.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("listPublicCards excludes the given owner's own cards and excludes non-public cards", () => {
    const db = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");

    const ownPublic = store.createCard(db, { ownerId: "owner_1", name: "自己的公开卡", visibility: "public" });
    store.createCard(db, { ownerId: "owner_1", name: "自己的系统卡" }); // system, not public
    const otherPublic = store.createCard(db, { ownerId: "owner_2", name: "别人的公开卡", visibility: "public" });
    store.createCard(db, { ownerId: "owner_2", name: "别人的系统卡" }); // system, not public - must never leak

    const circle = store.listPublicCards(db, "owner_1");
    expect(circle.map((c) => c.id)).toEqual([otherPublic.id]);
    expect(circle.map((c) => c.id)).not.toContain(ownPublic.id);
  });

  it("this module exports NO delete/remove function for strategy cards", () => {
    for (const name of Object.keys(store)) {
      expect(name.toLowerCase()).not.toMatch(/delete|remove/);
    }
  });
});
