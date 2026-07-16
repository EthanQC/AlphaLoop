// Parity guard: strategy writes exist in TWO implementations that MUST stay
// byte-identical in what they persist -
//   - apps/openclaw-config/scripts/strategy-store.mjs  (the CLI face, T1)
//   - apps/platform-app/src/data/strategy-write.ts      (the bearer-API face, T4)
// The .ts is a hand port of the .mjs (platform-app can't import a sibling
// app's .mjs at build time - the same re-declare convention conclusion-box
// and news use). Nothing structural stops the two from drifting; this test
// does. It runs the SAME inputs through BOTH and asserts the resulting DB
// rows are column-for-column equal. If a future change touches one writer
// but not the other, this fails - exactly the writer-vs-writer seam class
// that produced real bugs earlier in this project (P2 CLI hysteresis, P4
// marker mismatch). A .test.ts CAN import the .mjs (news.seam.test.ts does),
// so this cross-boundary check is legitimate.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "@packages/shared-types";
import * as apiWrite from "./strategy-write.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: any = await import("../../../openclaw-config/scripts/strategy-store.mjs");

const dirs: string[] = [];
function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-parity-"));
  dirs.push(dir);
  const db = openTradingDatabase(join(dir, "trading.sqlite"));
  new MemberRepository(db).upsert({
    id: "m1", email: "m1@x.com", displayName: "M1", riskTags: [], stockTags: [],
    showPerformance: true, status: "active", createdAt: "2026-07-01T00:00:00.000Z"
  });
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

// Columns that are deterministic given the input (excludes id/created_at/
// updated_at which are generated per-call).
function stableThesisRow(db: DatabaseSync): Record<string, unknown> {
  const row = db.prepare("SELECT owner_id, symbol, direction, target_low, target_high, invalidation_price, visibility, status, memory_slug, bull_points, bear_points FROM theses LIMIT 1").get() as Record<string, unknown>;
  return row;
}

describe("strategy write parity: CLI store (.mjs) vs bearer-API port (.ts)", () => {
  it("createThesis persists identical columns from both writers", () => {
    const input = {
      ownerId: "m1", symbol: "NVDA.US", direction: "bull" as const,
      targetLow: 130, targetHigh: 180, invalidationPrice: 105,
      bullPoints: ["算力需求", "财报超预期"], bearPoints: ["估值偏高"],
      visibility: "public" as const
    };
    const dbA = freshDb();
    store.createThesis(dbA, input);
    const rowA = stableThesisRow(dbA);

    const dbB = freshDb();
    apiWrite.createThesis(dbB, input);
    const rowB = stableThesisRow(dbB);

    expect(rowB).toEqual(rowA);
  });

  it("createRule persists identical columns from both writers", () => {
    const input = { ownerId: "m1", ruleText: "仓位≤10%", enforcement: "hard" as const, linkedStrategy: "核心持有" };
    const dbA = freshDb();
    store.createRule(dbA, input);
    const rowA = dbA.prepare("SELECT owner_id, rule_text, enforcement, linked_strategy, enabled FROM discipline_rules LIMIT 1").get();

    const dbB = freshDb();
    apiWrite.createRule(dbB, input);
    const rowB = dbB.prepare("SELECT owner_id, rule_text, enforcement, linked_strategy, enabled FROM discipline_rules LIMIT 1").get();

    expect(rowB).toEqual(rowA);
  });

  it("createCard persists identical columns from both writers", () => {
    const input = {
      ownerId: "m1", name: "动量跟随", scene: "财报后", entryCondition: "放量突破",
      riskControl: "止损8%", exitRule: "跌破20日线", visibility: "system" as const
    };
    const dbA = freshDb();
    store.createCard(dbA, input);
    const rowA = dbA.prepare("SELECT owner_id, name, scene, entry_condition, risk_control, exit_rule, status, visibility FROM strategy_cards LIMIT 1").get();

    const dbB = freshDb();
    apiWrite.createCard(dbB, input);
    const rowB = dbB.prepare("SELECT owner_id, name, scene, entry_condition, risk_control, exit_rule, status, visibility FROM strategy_cards LIMIT 1").get();

    expect(rowB).toEqual(rowA);
  });
});

// Parity guard: memoryd record-type classification exists in TWO
// implementations that MUST stay key-for-key identical -
//   - apps/openclaw-config/scripts/memoryd-mirror.mjs  (the CLI face)
//   - apps/platform-app/src/data/memoryd-mirror.ts      (the bearer-API port)
// (2026-07 audit: the .mjs classifies monthly_review as "decision"; the .ts
// port was missing that key entirely and silently fell through to the
// DEFAULT "fact" type - the SAME record type written by reviews.mjs (CLI)
// vs routes/review.ts (bearer API) landed in memoryd under two different
// types.) Same cross-boundary-import precedent as the writer parity tests
// above: a .test.ts can import the sibling app's .mjs even though
// platform-app's own source cannot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const memorydMirrorMjs: any = await import("../../../openclaw-config/scripts/memoryd-mirror.mjs");
import { MEMORYD_TYPE_BY_RECORD as MEMORYD_TYPE_BY_RECORD_TS } from "./memoryd-mirror.js";

describe("memoryd type map parity: CLI mirror (.mjs) vs bearer-API port (.ts)", () => {
  it("classifies every record type identically, key-for-key", () => {
    expect(MEMORYD_TYPE_BY_RECORD_TS).toEqual(memorydMirrorMjs.MEMORYD_TYPE_BY_RECORD);
  });
});
