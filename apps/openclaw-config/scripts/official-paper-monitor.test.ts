// Task H4 (phase2.5 hardening): first direct test coverage official-paper-
// monitor.mjs has ever had. Covers three things from the task brief:
//   1. snapshot writes now carry owner_id (exactly 1 active member -> that
//      member; 0 or >1 -> the '__shared__' sentinel).
//   2. audit item (a): a per-symbol quote failure is marked with an explicit
//      priceSource ('cost'|'zero') on the position and a `degraded` flag on
//      the snapshot, instead of silently folding into a cost/0 valuation
//      that looks identical to a real quote everywhere downstream.
//   3. audit item (b): the manual `snapshot` path now asserts the paper-
//      account environment, same as poll/pnl, instead of skipping it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemberRepository,
  buildDeepLink,
  openTradingDatabase,
  type DeepLinkKind,
  type ReportDeliveryPayload
} from "../../../packages/shared-types/dist/index.js";

const officialPaperMonitor = await import("./official-paper-monitor.mjs");

const tempDirs: string[] = [];

/**
 * H3 (2026-07-28, round-5): this file left the typecheck backlog, and four of
 * its errors were one thing - `buildPnlDeliveryPayload` is plain JS, so its
 * return type is inferred from a dynamically built object literal and
 * `reportKind` widens to `string`, which is not the `DeepLinkKind` that
 * `ReportDeliveryPayload` declares.
 *
 * Casting that away would delete the check. This asserts the producer's value
 * instead: buildDeepLink throws a TypeError for any kind the router cannot
 * address, so a payload whose reportKind is not a real page fails HERE, in the
 * test that hands it to the delivery layer, rather than silently type-widening.
 */
function asDeliveryPayload(payload: Record<string, unknown>): ReportDeliveryPayload {
  const kind = payload.reportKind;
  expect(typeof kind, "the payload carries no reportKind").toBe("string");
  expect(
    () => buildDeepLink(kind as DeepLinkKind, "2026-07-01"),
    `reportKind ${String(kind)} is not a page the platform can address`
  ).not.toThrow();
  return payload as unknown as ReportDeliveryPayload;
}

function makeDb(): { db: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-official-paper-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(
  db: DatabaseSync,
  id: string,
  overrides: Partial<{ status: string; feishuOpenId: string }> = {}
): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: (overrides.status as "active" | "revoked") ?? "active",
    ...(overrides.feishuOpenId === undefined ? {} : { feishuOpenId: overrides.feishuOpenId }),
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

describe("resolveSnapshotOwnerId", () => {
  it("resolves to the single active member's id", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    expect(officialPaperMonitor.resolveSnapshotOwnerId(db)).toBe("member_1");
  });

  it("falls back to the shared sentinel when there are 0 active members", () => {
    const { db } = makeDb();

    expect(officialPaperMonitor.resolveSnapshotOwnerId(db)).toBe(officialPaperMonitor.SHARED_OWNER_SENTINEL);
  });

  it("falls back to the shared sentinel when there is more than 1 active member", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");

    expect(officialPaperMonitor.resolveSnapshotOwnerId(db)).toBe(officialPaperMonitor.SHARED_OWNER_SENTINEL);
  });

  it("ignores a revoked member when counting active members", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_revoked", { status: "revoked" });

    expect(officialPaperMonitor.resolveSnapshotOwnerId(db)).toBe("member_1");
  });
});

/**
 * G5 (2026-07-28 round 4): this fixture used to be a hand-written object
 * literal - `{fetchedAt, primaryAsset:{net_assets,total_cash}, positions:[...],
 * quotes:[...]}` - and every renderPnlReport assertion in this file, including
 * the round-3 收支变化表 evidence, was measured against it. It was a shape the
 * real pipeline cannot produce: no `source`, no `accountMode`, no `check`, no
 * `assets`, positions with none of the fields normalizeOfficialPosition adds,
 * and a primaryAsset with no `currency` - which validateOfficialPrimaryAsset
 * rejects outright, so a real fetch could never have handed the renderer this.
 *
 * It is now assembled by running the same chain production runs, end to end:
 * apps/longbridge-cli's own shape.ts builders emit the check / assets /
 * positions / quote payloads (those functions ARE what `longbridge-cli trade
 * check|assets|positions` prints), report-data.mjs's
 * normalizeOfficialPaperSnapshot and normalizeQuotePayload consume them, and
 * official-paper-monitor.mjs's own attachPriceSource decides priceSource/price
 * - rather than this file asserting what it would have decided.
 *
 * WHAT `overrides` DOES AND DOES NOT PROVE (corrected 2026-07-28, I9)
 * ------------------------------------------------------------------
 * The original wording here - "`overrides` still replaces VALUES ... what it no
 * longer does is invent the snapshot's shape" - was false, and false for the
 * one block G5 was written for. `buildSnapshot` spreads `...overrides` at the
 * TOP level, so an override of `primaryAsset` / `positions` / `quotes` does not
 * adjust a produced value: it REPLACES the produced object with a literal this
 * file typed out. The 收支变化表 block below (R4/F8) overrode exactly those three
 * fields - the only three its table reads - so its evidence was still measured
 * against hand-written input. It now calls producedSnapshot directly.
 *
 * The remaining override call sites are honest only about what they claim:
 * `buildSnapshot({fetchedAt})` shifts a timestamp and keeps every produced
 * field; `buildSnapshot({primaryAsset: {net_assets: null, ...}})` and
 * NO_ASSET_SNAPSHOT deliberately inject shapes a fetch DEGRADES into, to
 * exercise the renderer's missing-value branches. Those are renderer-branch
 * tests, not evidence about what the pipeline emits. Any NEW assertion about
 * what a reader sees for a NORMAL account should call producedSnapshot, not
 * buildSnapshot-with-an-override.
 */
const reportData = await import("./report-data.mjs");
const longbridgeShape = await import("../../longbridge-cli/src/shape.ts");

function producedSnapshot(input: {
  fetchedAt: string;
  assets: Parameters<typeof longbridgeShape.buildAssetsPayload>[0];
  positions: Parameters<typeof longbridgeShape.buildPositionsPayload>[0];
  quotes: Parameters<typeof longbridgeShape.buildQuoteRows>[1];
}) {
  const normalized = reportData.normalizeOfficialPaperSnapshot({
    check: longbridgeShape.buildCheckPayload({
      resolution: { active: "global", cached: "global", source: "default" },
      probes: { global: { ok: true, latencyMs: 12 }, cn: { ok: true, latencyMs: 30 } }
    }),
    // `longbridge-cli trade assets|positions` prints a bare array (run.ts's
    // `case "assets"` returns buildAssetsPayload(...) directly), which is what
    // extractArrayPayload receives.
    assets: longbridgeShape.buildAssetsPayload(input.assets),
    positions: longbridgeShape.buildPositionsPayload(input.positions),
    fetchedAt: input.fetchedAt
  });
  // Mirrors fetchOfficialPaperSnapshot's own per-symbol loop, catch included
  // (official-paper-monitor.mjs:381-388): a symbol whose quote never arrives
  // becomes `{symbol, error}` and lets attachPriceSource decide the degradation,
  // instead of a test typing `priceSource: "cost"` into a position by hand (H2).
  const quotes = normalized.positions.map((position: { symbol: string } | null) => {
    // normalizeOfficialPaperSnapshot's positions element type includes null
    // (normalizeOfficialPosition returns null for a row with no symbol). A null
    // here would mean the fixture fed the normalizer a row it dropped, which is
    // a broken fixture, not a case worth rendering.
    if (position === null) {
      throw new Error("the position rows this fixture supplied did not survive normalizeOfficialPosition");
    }
    try {
      return reportData.normalizeQuotePayload(
        longbridgeShape.buildQuoteRows([position.symbol], input.quotes),
        position.symbol
      );
    } catch (error) {
      return { symbol: position.symbol, error: String((error as Error)?.message ?? error).slice(0, 160) };
    }
  });
  const { positions, degradedSymbols } = officialPaperMonitor.attachPriceSource(normalized.positions, quotes);
  return {
    ...normalized,
    positions,
    quotes,
    degraded: degradedSymbols.length > 0,
    degradedReason: degradedSymbols.length > 0 ? `行情读取失败：${degradedSymbols.join("、")}` : null
  };
}

/**
 * H2 (2026-07-28, round-5): a produced snapshot with the balances a case needs.
 *
 * I9 moved the 收支变化表 block off `buildSnapshot({primaryAsset: ...})` but left
 * the same hand-shaped literal in the blocks below it: `{net_assets: "1200",
 * total_cash: "140"}` has no `currency`, which is exactly what
 * report-data.mjs's validateOfficialPrimaryAsset throws on - a fetch cannot
 * produce it. The reader-facing figures (1200.00 USD / 140.00 USD / +200.00 USD
 * / -60.00 USD) were riding on that.
 *
 * Going through buildAssetsPayload -> normalizeOfficialPaperSnapshot means the
 * asset row is one `longbridge-cli trade assets` really prints and one the
 * validator really accepts; positions and quotes default to the same NVDA row
 * buildSnapshot uses, so only the balances differ from the shared fixture.
 *
 * What this does NOT establish, so that no later reader assumes it: the "USD"
 * in those strings is still not the row's `currency`. formatMoney/formatDelta
 * (official-paper-monitor.mjs:834-848) and the remaining-budget clause (:493)
 * append the literal "USD" and read no currency field anywhere, so setting this
 * row's currency to HKD leaves every assertion in this file passing (probed
 * 2026-07-28). The currency is carried and validated, and then ignored by the
 * renderer.
 */
type ProducedSnapshotInput = Parameters<typeof producedSnapshot>[0];

function producedSnapshotWithBalances(
  netAssets: string,
  totalCash: string,
  options: {
    fetchedAt?: string;
    positions?: ProducedSnapshotInput["positions"];
    quotes?: ProducedSnapshotInput["quotes"];
  } = {}
) {
  return producedSnapshot({
    fetchedAt: options.fetchedAt ?? "2026-07-01T14:00:00.000Z",
    assets: [{ netAssets, totalCash, currency: "USD", buyPower: totalCash, riskLevel: 1 }],
    positions: options.positions ?? [
      { symbol: "NVDA.US", name: "NVIDIA", market: "US", currency: "USD", quantity: "10", available: "10", costPrice: "100" }
    ],
    quotes: options.quotes ?? [{ symbol: "NVDA.US", lastDone: "106" }]
  });
}

function buildSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    ...producedSnapshot({
      fetchedAt: "2026-07-01T14:00:00.000Z",
      assets: [{ netAssets: "1000", totalCash: "500", currency: "USD", buyPower: "500", riskLevel: 1 }],
      positions: [
        { symbol: "NVDA.US", name: "NVIDIA", market: "US", currency: "USD", quantity: "10", available: "10", costPrice: "100" }
      ],
      quotes: [{ symbol: "NVDA.US", lastDone: "106" }]
    }),
    ...overrides
  };
}

describe("the snapshot fixture these tests render is one the real pipeline produces", () => {
  it("carries what only the real check/assets/positions chain puts there", () => {
    const snapshot = buildSnapshot();
    // Fields the hand-written literal never carried, each one written by a
    // producer rather than by this file.
    expect(snapshot.source).toBe("longbridge-official-paper");
    expect(snapshot.accountMode).toBe("paper");
    expect(snapshot.check).toMatchObject({ sessionStatus: "valid", okRegions: ["global", "cn"] });
    // validateOfficialPrimaryAsset REJECTS an asset row with no currency, so
    // the old fixture's `{net_assets, total_cash}` could not have come off a
    // real fetch at all.
    expect(snapshot.primaryAsset).toMatchObject({ currency: "USD", buy_power: "500" });
    // normalizeOfficialPosition's own output, then attachPriceSource's verdict.
    expect(snapshot.positions[0]).toMatchObject({
      symbol: "NVDA.US",
      assetClass: "stock",
      costPrice: 100,
      priceSource: "live",
      price: 106
    });
  });
});

describe("saveSnapshot: writes owner_id", () => {
  it("writes the single active member's id as owner_id", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    const id = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "manual");

    const row = db.prepare("SELECT owner_id FROM official_paper_snapshots WHERE id = ?").get(id) as { owner_id: string };
    expect(row.owner_id).toBe("member_1");
  });

  it("writes the shared sentinel when there is no single active member", () => {
    const { db } = makeDb();

    const id = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "manual");

    const row = db.prepare("SELECT owner_id FROM official_paper_snapshots WHERE id = ?").get(id) as { owner_id: string };
    expect(row.owner_id).toBe(officialPaperMonitor.SHARED_OWNER_SENTINEL);
  });
});

describe("attachPriceSource: audit item (a) - degraded price marking", () => {
  it("marks a position with a usable quote as priceSource 'live'", () => {
    const positions = [{ symbol: "NVDA.US", quantity: 10, costPrice: 100 }];
    const quotes = [{ symbol: "NVDA.US", last: 120 }];

    const { positions: priced, degradedSymbols } = officialPaperMonitor.attachPriceSource(positions, quotes);

    expect(priced[0]).toMatchObject({ priceSource: "live", price: 120 });
    expect(degradedSymbols).toEqual([]);
  });

  it("marks a position whose quote failed but has a cost basis as priceSource 'cost'", () => {
    const positions = [{ symbol: "NVDA.US", quantity: 10, costPrice: 100 }];
    const quotes = [{ symbol: "NVDA.US", error: "timeout" }];

    const { positions: priced, degradedSymbols } = officialPaperMonitor.attachPriceSource(positions, quotes);

    expect(priced[0]).toMatchObject({ priceSource: "cost", price: 100 });
    expect(degradedSymbols).toEqual(["NVDA.US(按成本估值)"]);
  });

  it("marks a position with no quote and no cost basis as priceSource 'zero'", () => {
    const positions = [{ symbol: "NVDA.US", quantity: 10, costPrice: undefined }];
    const quotes: unknown[] = [];

    const { positions: priced, degradedSymbols } = officialPaperMonitor.attachPriceSource(positions, quotes);

    expect(priced[0]).toMatchObject({ priceSource: "zero", price: 0 });
    expect(degradedSymbols).toEqual(["NVDA.US(按0估值)"]);
  });
});

describe("estimateMarketValue", () => {
  it("uses each position's resolved price (live/cost/zero)", () => {
    const snapshot = {
      positions: [
        { symbol: "NVDA.US", quantity: 10, priceSource: "live", price: 100 },
        { symbol: "TSLA.US", quantity: 5, priceSource: "cost", price: 50 },
        { symbol: "AMD.US", quantity: 2, priceSource: "zero", price: 0 }
      ]
    };

    expect(officialPaperMonitor.estimateMarketValue(snapshot)).toBe(10 * 100 + 5 * 50 + 2 * 0);
  });

  it("falls back to costPrice for legacy positions with no .price field (pre-H4 raw snapshots)", () => {
    const snapshot = { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 90 }] };

    expect(officialPaperMonitor.estimateMarketValue(snapshot)).toBe(900);
  });
});

describe("buildStrategyReflection: discloses degradation instead of trusting the value", () => {
  it("does not mention degradation when the snapshot is not degraded", () => {
    const snapshot = buildSnapshot({ degraded: false });
    const reflection = officialPaperMonitor.buildStrategyReflection(snapshot);

    expect(reflection.degraded).toBe(false);
    expect(reflection.summary).not.toMatch(/估计值|按成本|按0/);
  });

  it("discloses the number of degraded positions in the summary when the snapshot is degraded", () => {
    // H2 (2026-07-28): the three priceSource values used to be typed in here.
    // They are attachPriceSource's verdicts, so the run now earns them: NVDA has
    // a cost basis and no quote (-> cost), TSLA has neither (-> zero), AMD has a
    // live quote (-> live). 2 of 3 degraded, which is what the summary must say.
    const snapshot = producedSnapshotWithBalances("1000", "500", {
      positions: [
        { symbol: "NVDA.US", name: "NVIDIA", market: "US", currency: "USD", quantity: "10", available: "10", costPrice: "100" },
        { symbol: "TSLA.US", name: "Tesla", market: "US", currency: "USD", quantity: "5", available: "5" },
        { symbol: "AMD.US", name: "AMD", market: "US", currency: "USD", quantity: "2", available: "2", costPrice: "120" }
      ],
      quotes: [{ symbol: "AMD.US", lastDone: "150" }]
    });
    expect(snapshot.positions.map((position: { priceSource: string }) => position.priceSource)).toEqual([
      "cost",
      "zero",
      "live"
    ]);

    const reflection = officialPaperMonitor.buildStrategyReflection(snapshot);

    expect(reflection.degraded).toBe(true);
    expect(reflection.summary).toMatch(/2 笔持仓/);
    expect(reflection.summary).toMatch(/估计值/);
  });
});

describe("renderPnlReport: report reading discloses per-position degradation", () => {
  it("annotates a degraded position's line in the rendered markdown", () => {
    // H2 (2026-07-28): this used to override `degraded`, `positions` and
    // `quotes` with literals - the position already carrying `priceSource:
    // "cost"` and `price: 100`, which are attachPriceSource's OUTPUT, and
    // `degraded: true`, which is fetchOfficialPaperSnapshot's. It asserted the
    // renderer reacts to a verdict this file had written for it. With no quote
    // for the symbol, the real chain reaches that verdict on its own.
    const snapshot = producedSnapshotWithBalances("1000", "500", { quotes: [] });
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.positions[0]).toMatchObject({ priceSource: "cost", price: 100 });

    const markdown = officialPaperMonitor.renderPnlReport(snapshot, null, null);

    expect(markdown).toMatch(/NVDA\.US[^\n]*估值降级/);
  });

  it("does not annotate a live-priced position", () => {
    const snapshot = buildSnapshot();
    const markdown = officialPaperMonitor.renderPnlReport(snapshot, null, null);

    expect(markdown).not.toMatch(/估值降级/);
  });
});

// 2026-07-28 (spec drift R4/F8). Every row of the 收支变化表 printed the CURRENT
// snapshot's net assets/cash/market value in columns 2-4 - so 「跟前一日 |
// 100123.45 USD | ...」 put today's balances under headings a reader takes for
// the comparison point - and a row with no baseline printed 「基准」 in the delta
// columns, i.e. announced a reference point that does not exist.
//
// These assert the rendered LINES, so they fail on the text a reader actually
// gets rather than on a helper's return value.
describe("renderPnlReport 收支变化表: every row says what it actually is (spec drift R4/F8)", () => {
  // I9 (2026-07-28, round-4 verifier): these two used to be
  // `buildSnapshot({primaryAsset, positions, quotes})`, and buildSnapshot
  // spreads `...overrides` at the TOP level - so the three fields the 收支变化表
  // actually reads were replaced wholesale by hand-written literals, including
  // a primaryAsset with no `currency` (the exact shape
  // validateOfficialPrimaryAsset rejects) and positions carrying none of the
  // fields normalizeOfficialPosition adds. G5's fix had not reached the block
  // it was written for. They now go through producedSnapshot, so every figure
  // the table prints came out of the real chain: the balances are what
  // buildAssetsPayload emitted, the 持仓估值 is what attachPriceSource computed
  // from a real quote row, and 663.88/600 are quote prices rather than numbers
  // this file typed into a `price` field.
  const CURRENT = producedSnapshot({
    fetchedAt: "2026-07-28T14:00:00.000Z",
    assets: [{ netAssets: "100123.45", totalCash: "40000", currency: "USD", buyPower: "40000", riskLevel: 1 }],
    positions: [
      { symbol: "QQQ.US", name: "Invesco QQQ", market: "US", currency: "USD", quantity: "1", available: "1", costPrice: "663.88" }
    ],
    quotes: [{ symbol: "QQQ.US", lastDone: "663.88" }]
  });
  const PREVIOUS_DAY = producedSnapshot({
    fetchedAt: "2026-07-27T14:00:00.000Z",
    assets: [{ netAssets: "99000", totalCash: "40000", currency: "USD", buyPower: "40000", riskLevel: 1 }],
    positions: [
      { symbol: "QQQ.US", name: "Invesco QQQ", market: "US", currency: "USD", quantity: "1", available: "1", costPrice: "663.88" }
    ],
    quotes: [{ symbol: "QQQ.US", lastDone: "600" }]
  });

  function tableLines(markdown: string): string[] {
    return markdown.split("\n").filter((line) => line.startsWith("| "));
  }

  it("gives the comparison row the BASELINE's own figures, not a repeat of the current ones", () => {
    const markdown = officialPaperMonitor.renderPnlReport(CURRENT, PREVIOUS_DAY, null);
    const lines = tableLines(markdown);

    expect(lines).toContain(
      "| 前一日（2026-07-27 22:00） | 99000.00 USD | 40000.00 USD | 600.00 USD | +1123.45 USD | +0.00 USD |"
    );
    // The exact defect: the previous-day row carrying the current snapshot's
    // 100123.45/40000.00/663.88 under 净资产/现金/持仓估值.
    expect(markdown).not.toContain("| 前一日（2026-07-27 22:00） | 100123.45 USD");
    // And the column headings now name whose figures they are.
    expect(lines[0]).toBe(
      "| 对比项 | 该行净资产 | 该行现金 | 该行持仓估值 | 净资产变化（当前 − 该行） | 现金变化（当前 − 该行） |"
    );
  });

  it("says 无可比快照 with the reason - never 基准 - for a baseline that does not exist", () => {
    const markdown = officialPaperMonitor.renderPnlReport(CURRENT, PREVIOUS_DAY, null);

    expect(tableLines(markdown)).toContain(
      "| 上一周最后一个交易日 | 无可比快照 | 无可比快照 | 无可比快照 | 无可比快照 | 无可比快照 |"
    );
    expect(markdown).toContain(
      "- 上一周最后一个交易日：无可比快照（本次快照之前最近 80 条记录里，没有比它早 7 天以上的快照），本次不计算变化。"
    );
    // 基准 announced a reference point; there is none.
    expect(markdown).not.toContain("基准 |");
    // And a missing baseline is never rendered as a computed change.
    expect(markdown).not.toContain("| 上一周最后一个交易日 | 100123.45 USD");
  });

  it("marks the 当前 row's delta cells as the row itself, not as a comparison", () => {
    const markdown = officialPaperMonitor.renderPnlReport(CURRENT, null, null);

    expect(tableLines(markdown)).toContain(
      "| 当前 | 100123.45 USD | 40000.00 USD | 663.88 USD | —（本行即当前快照） | —（本行即当前快照） |"
    );
  });

  it("states the same missing-baseline reason in the card bullet as in the report", () => {
    const bullets = officialPaperMonitor.buildPnlDeliveryPayload({
      current: CURRENT,
      previousDay: null,
      previousWeek: null,
      markdown: officialPaperMonitor.renderPnlReport(CURRENT, null, null),
      markdownPath: "/tmp/x.md",
      pdfPath: "/tmp/x.pdf",
      scope: { visibility: "owner-private", ownerOpenId: "ou_paper_owner" }
    }).conclusion.bullets.join("\n");

    expect(bullets).toContain(
      "跟前一日：无可比快照（本次快照之前最近 80 条记录里，没有比它早 24 小时以上的快照），本次不计算变化。"
    );
    expect(bullets).toContain(
      "跟上一周最后一个交易日：无可比快照（本次快照之前最近 80 条记录里，没有比它早 7 天以上的快照），本次不计算变化。"
    );
  });

  it("names the baseline snapshot in the card bullet when one exists", () => {
    const bullets = officialPaperMonitor.buildPnlDeliveryPayload({
      current: CURRENT,
      previousDay: PREVIOUS_DAY,
      previousWeek: null,
      markdown: officialPaperMonitor.renderPnlReport(CURRENT, PREVIOUS_DAY, null),
      markdownPath: "/tmp/x.md",
      pdfPath: "/tmp/x.pdf",
      scope: { visibility: "owner-private", ownerOpenId: "ou_paper_owner" }
    }).conclusion.bullets.join("\n");

    expect(bullets).toContain("跟前一日（基准快照 2026-07-27 22:00）：净资产 +1123.45 USD，现金 +0.00 USD");
  });
});

describe("runManualSnapshot: audit item (b) - environment assertion is no longer skipped", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws before ever writing a snapshot row when the paper-account environment is not asserted", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    delete process.env.LONGBRIDGE_ACCOUNT_MODE;
    delete process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED;
    delete process.env.ALLOW_LIVE_EXECUTION;

    await expect(officialPaperMonitor.runManualSnapshot(db)).rejects.toThrow(/官方模拟盘/);

    const count = db.prepare("SELECT COUNT(*) AS c FROM official_paper_snapshots").get() as { c: number };
    expect(count.c).toBe(0);
  });
});

// Phase 6 Task 6 (2026-07-15 plan): per-member polling loop. `fetchImpl` is
// the injection seam named in the task brief ("长桥抓取本身保持可注入
// (fetchImpl/execFn)...真实多账户 = P10") - every test here supplies a fixture
// function, never touching a real longbridge CLI/subprocess.
describe("pollOfficialPaperPerMember", () => {
  const credentialsRoots: string[] = [];

  function makeCredentialsRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-official-paper-creds-"));
    credentialsRoots.push(dir);
    return dir;
  }

  function seedMemberCredentials(root: string, memberId: string): void {
    const memberDir = join(root, memberId);
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, "longbridge.env"), `LONGBRIDGE_ACCESS_TOKEN=token-${memberId}\n`, "utf8");
  }

  afterEach(() => {
    while (credentialsRoots.length > 0) {
      const dir = credentialsRoots.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("returns null (H4 single-account fallback signal) when zero active members have credentials", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const root = makeCredentialsRoot(); // empty - nobody has a longbridge.env file

    const result = await officialPaperMonitor.pollOfficialPaperPerMember(db, { credentialsRootDir: root });

    expect(result).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS c FROM official_paper_snapshots").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("returns null when there are zero active members at all", async () => {
    const { db } = makeDb();
    const root = makeCredentialsRoot();

    const result = await officialPaperMonitor.pollOfficialPaperPerMember(db, { credentialsRootDir: root });

    expect(result).toBeNull();
  });

  it("2 credentialed members -> 2 owner-tagged snapshot rows, each with THAT member's fetch result", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const root = makeCredentialsRoot();
    seedMemberCredentials(root, "member_1");
    seedMemberCredentials(root, "member_2");

    const fetchImpl = async (member: { id: string }) =>
      buildSnapshot({
        fetchedAt: `2026-07-15T14:00:00.000Z`,
        primaryAsset: { net_assets: member.id === "member_1" ? "1000" : "2000", total_cash: "0" }
      });

    const result = await officialPaperMonitor.pollOfficialPaperPerMember(db, { fetchImpl, credentialsRootDir: root });

    expect(result).toHaveLength(2);
    expect(result?.map((entry: { ownerId: string }) => entry.ownerId).sort()).toEqual(["member_1", "member_2"]);

    const rows = db
      .prepare("SELECT owner_id, net_assets FROM official_paper_snapshots ORDER BY owner_id ASC")
      .all() as Array<{ owner_id: string; net_assets: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ owner_id: "member_1", net_assets: 1000 });
    expect(rows[1]).toMatchObject({ owner_id: "member_2", net_assets: 2000 });
  });

  it("a member with no credentials file is skipped entirely (no snapshot row, not an error)", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_no_account");
    const root = makeCredentialsRoot();
    seedMemberCredentials(root, "member_1");
    // member_no_account intentionally gets no longbridge.env file.

    const fetchImpl = async () => buildSnapshot();
    const result = await officialPaperMonitor.pollOfficialPaperPerMember(db, { fetchImpl, credentialsRootDir: root });

    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ ownerId: "member_1" });
    const rows = db.prepare("SELECT owner_id FROM official_paper_snapshots").all() as Array<{ owner_id: string }>;
    expect(rows).toEqual([{ owner_id: "member_1" }]);
  });

  it("passes each member's own env/creds into fetchImpl (never leaks another member's credentials)", async () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const root = makeCredentialsRoot();
    seedMemberCredentials(root, "member_1");
    seedMemberCredentials(root, "member_2");

    const seenTokens: string[] = [];
    const fetchImpl = async (_member: { id: string }, creds: { env: Record<string, string> }) => {
      // Recorded rather than asserted here so the failure names the member whose
      // env arrived without a token, instead of throwing inside the poll loop.
      seenTokens.push(creds.env.LONGBRIDGE_ACCESS_TOKEN ?? "<no LONGBRIDGE_ACCESS_TOKEN in this member's env>");
      return buildSnapshot();
    };

    await officialPaperMonitor.pollOfficialPaperPerMember(db, { fetchImpl, credentialsRootDir: root });

    expect(seenTokens.sort()).toEqual(["token-member_1", "token-member_2"]);
  });
});

// 2026-07 audit fix: main() had no try/catch and openTradingDatabase sat
// outside any try, so an unknown command produced a multi-line raw Node
// stack trace instead of the {ok:false,error} single-line JSON envelope
// every other CLI in this package uses (stock-analysis.mjs, market-alerts.
// mjs). Spawned as a real subprocess (not an in-process import) because the
// top-level `if (isMainModule)` block only runs under that condition, and an
// unknown command is validated BEFORE any db is opened - see main()'s
// KNOWN_COMMANDS check - so this never touches the real trading.sqlite.
const scriptPath = fileURLToPath(new URL("./official-paper-monitor.mjs", import.meta.url));

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stderr: "", stdout };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? 1, stderr: err.stderr ?? "", stdout: err.stdout ?? "" };
  }
}

describe("official-paper-monitor.mjs CLI entry: unknown command -> JSON envelope, not a raw stack trace", () => {
  it("exits non-zero with a single-line {ok:false,error} JSON on stderr for an unknown subcommand", () => {
    const result = runScript(["bogus-command"]);

    expect(result.status).not.toBe(0);
    const stderrLines = result.stderr.trim().split("\n");
    expect(stderrLines).toHaveLength(1);
    const parsed = JSON.parse(stderrLines[0]!);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toMatch(/poll\|pnl\|snapshot/);
  });
});

// 2026-07-28 (spec drift R2). The 模拟盘收支变化 report is owner-private -
// /official-paper/<date> 403s anyone who is not the snapshot's attributed
// owner - but it declared nothing, so the misdelivery guard (which keyed on
// `payload.openId`) let it through and the legacy shared-chat channel
// published the account's positions to the whole circle, recorded sent:true.
//
// resolvePnlReportScope answers the question the platform's own 403 answers,
// from the SAME row: official_paper_snapshots.owner_id for this run's
// post_open_pnl snapshot.
describe("resolvePnlReportScope: the card's recipient is the page's owner (spec drift R2)", () => {
  it("declares owner-private to the member the snapshot was actually attributed to", () => {
    const { db } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    const snapshotId = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "post_open_pnl");

    expect(officialPaperMonitor.resolvePnlReportScope(db, snapshotId)).toEqual({
      visibility: "owner-private",
      ownerOpenId: "ou_member_1"
    });
  });

  it("declares owner-unresolved for a __shared__ snapshot, which the platform shows to nobody", () => {
    const { db } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    seedMember(db, "member_2", { feishuOpenId: "ou_member_2" });
    // Two active members -> the writer cannot attribute the account.
    const snapshotId = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "post_open_pnl");

    const scope = officialPaperMonitor.resolvePnlReportScope(db, snapshotId);
    expect(scope.visibility).toBe("owner-unresolved");
    expect(scope.reason).toContain(officialPaperMonitor.SHARED_OWNER_SENTINEL);
  });

  it("declares owner-unresolved - not a fallback recipient - when the owner has no Feishu binding", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    const snapshotId = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "post_open_pnl");

    const scope = officialPaperMonitor.resolvePnlReportScope(db, snapshotId);
    expect(scope.visibility).toBe("owner-unresolved");
    expect(scope.reason).toContain("飞书 open_id");
  });

  // 2026-07-28 (spec drift R4/F9). This function used to read ONE row - this
  // run's - while routes/reports.ts decides the 403 from EVERY post_open_pnl row
  // on the date. Two same-date rows with different owners therefore produced a
  // card addressed to member_1 for a page that 403s member_1 too, and the doc
  // above it claimed the two "cannot disagree".
  it("refuses to name an owner when the same date carries two differently-owned post_open_pnl rows", () => {
    const { db } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    // The reproduction: a __shared__ row at 14:00Z and member_1's row at 14:05Z.
    officialPaperMonitor.saveSnapshot(
      db,
      buildSnapshot({ fetchedAt: "2026-07-01T14:00:00.000Z" }),
      "post_open_pnl",
      officialPaperMonitor.SHARED_OWNER_SENTINEL
    );
    const snapshotId = officialPaperMonitor.saveSnapshot(
      db,
      buildSnapshot({ fetchedAt: "2026-07-01T14:05:00.000Z" }),
      "post_open_pnl",
      "member_1"
    );

    const scope = officialPaperMonitor.resolvePnlReportScope(db, snapshotId);
    expect(scope.visibility).toBe("owner-unresolved");
    expect(scope.reason).toContain("2026-07-01");
    expect(scope.reason).toContain("归属不同");
    // The date-level rule the platform runs agrees, on the same rows.
    expect(officialPaperMonitor.resolveOfficialPaperDateAttribution(db, "2026-07-01").kind).toBe("unattributable");
  });

  it("ignores rows on OTHER dates - a different day's owner does not make today ambiguous", () => {
    const { db } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    officialPaperMonitor.saveSnapshot(
      db,
      buildSnapshot({ fetchedAt: "2026-06-30T14:00:00.000Z" }),
      "post_open_pnl",
      "member_2"
    );
    const snapshotId = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "post_open_pnl", "member_1");

    expect(officialPaperMonitor.resolvePnlReportScope(db, snapshotId)).toEqual({
      visibility: "owner-private",
      ownerOpenId: "ou_member_1"
    });
  });

  it("ignores same-date rows from other run kinds, exactly as the platform's query does", () => {
    const { db } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    officialPaperMonitor.saveSnapshot(
      db,
      buildSnapshot({ fetchedAt: "2026-07-01T15:00:00.000Z" }),
      "hourly_poll_per_member",
      "member_2"
    );
    const snapshotId = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "post_open_pnl", "member_1");

    expect(officialPaperMonitor.resolvePnlReportScope(db, snapshotId).visibility).toBe("owner-private");
  });

  it("refuses a snapshot whose reason the platform never attributes, rather than claiming an owner for it", () => {
    const { db } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    const snapshotId = officialPaperMonitor.saveSnapshot(db, buildSnapshot(), "manual");

    const scope = officialPaperMonitor.resolvePnlReportScope(db, snapshotId);
    expect(scope.visibility).toBe("owner-unresolved");
    expect(scope.reason).toContain("post_open_pnl");
  });
});

// The end-to-end version of the same defect, driven through the REAL producer
// and the REAL delivery function rather than a hand-written payload: the
// verifier reproduced the leak by executing renderPnlReport's own output and
// captured `send_message_as_bot chat_id="oc_shared_group_chat" ... sent = true`.
// This asserts the shared chat is never even contacted.
describe("the PnL report cannot reach the shared group chat (spec drift R2)", () => {
  const envKeys = [
    "LARK_APP_ID",
    "LARK_APP_SECRET",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ACCOUNT_ID",
    "FEISHU_USER_PLUGIN_BOT_CHAT_ID",
    "FEISHU_USER_PLUGIN_COMMAND",
    "FEISHU_USER_PLUGIN_ARGS",
    "FEISHU_NOTIFICATION_RETRY_ATTEMPTS",
    "FEISHU_USER_PLUGIN_DISABLED"
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  /** Forces the legacy user-plugin channel (the one with a single shared chat)
   * and returns the path of a marker the fake plugin writes if it is spawned at
   * all. App credentials are made genuinely unresolvable so the machine running
   * the suite cannot decide which channel is exercised. */
  function useSharedChatChannel(dir: string): string {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
    const spawnMarkerPath = join(dir, "plugin-was-spawned.log");
    const scriptPath = join(dir, "fake-plugin.mjs");
    writeFileSync(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(spawnMarkerPath)}, "spawned", "utf8");\n`,
      "utf8"
    );

    process.env.LARK_APP_ID = "test_app_id";
    process.env.LARK_APP_SECRET = "test_app_secret";
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_ACCOUNT_ID = "__no_such_account__";
    process.env.FEISHU_USER_PLUGIN_BOT_CHAT_ID = "oc_shared_group_chat";
    process.env.FEISHU_USER_PLUGIN_COMMAND = process.execPath;
    process.env.FEISHU_USER_PLUGIN_ARGS = JSON.stringify([scriptPath]);
    process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS = "1";
    delete process.env.FEISHU_USER_PLUGIN_DISABLED;
    return spawnMarkerPath;
  }

  /** The payload sendPnlReport itself builds, from a snapshot this run
   * persisted.
   *
   * H2 (2026-07-28): "not a fixture shaped to be convenient" is only true since
   * this stopped calling buildSnapshot with `primaryAsset` / `positions` /
   * `quotes` overrides. Those replaced the produced objects wholesale with
   * literals - an asset row with no `currency` that validateOfficialPrimaryAsset
   * rejects, and positions carrying `priceSource: "live"` and `price: 731.42`,
   * which are attachPriceSource's OUTPUT typed in by hand. 731.42 is now a quote
   * price the real chain resolved, and the priceSource is its verdict. */
  function realPnlPayload(db: DatabaseSync) {
    const snapshot = producedSnapshotWithBalances("1200", "140", {
      positions: [
        { symbol: "QQQ.US", name: "Invesco QQQ Trust", market: "US", currency: "USD", quantity: "1", available: "1", costPrice: "663.88" }
      ],
      quotes: [{ symbol: "QQQ.US", lastDone: "731.42" }]
    });
    const snapshotId = officialPaperMonitor.saveSnapshot(db, snapshot, "post_open_pnl");
    const markdown = officialPaperMonitor.renderPnlReport(snapshot, null, null);
    return officialPaperMonitor.buildPnlDeliveryPayload({
      current: snapshot,
      previousDay: null,
      previousWeek: null,
      markdown,
      markdownPath: "/tmp/reports/2026-07-01-post-open.md",
      pdfPath: "/tmp/reports/2026-07-01-post-open.pdf",
      scope: officialPaperMonitor.resolvePnlReportScope(db, snapshotId)
    });
  }

  it("is refused, not published, when the only channel is the shared group chat", async () => {
    const notifications = await import("../../../packages/shared-types/dist/index.js");
    const { db } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    const payload = realPnlPayload(db);
    const spawnMarkerPath = useSharedChatChannel(tempDirs[tempDirs.length - 1] as string);

    // The exact content the verifier saw arrive in the group.
    expect(payload.markdown).toContain("QQQ.US：数量 1，成本 663.88 USD");

    const result = await notifications.deliverReportToFeishu(asDeliveryPayload(payload));

    expect(result.sent).toBe(false);
    expect(existsSync(spawnMarkerPath)).toBe(false);
    expect(result.reason).toContain("ou_member_1");
    expect(result.deliveries).toEqual([]);
  });

  it("is refused with the attribution reason when the snapshot belongs to nobody in particular", async () => {
    const notifications = await import("../../../packages/shared-types/dist/index.js");
    const { db } = makeDb();
    // No members at all -> the writer stamps the __shared__ sentinel, and the
    // platform page is closed to everyone.
    const payload = realPnlPayload(db);
    const spawnMarkerPath = useSharedChatChannel(tempDirs[tempDirs.length - 1] as string);

    const result = await notifications.deliverReportToFeishu(asDeliveryPayload(payload));

    expect(result.sent).toBe(false);
    expect(existsSync(spawnMarkerPath)).toBe(false);
    expect(result.reason).toContain(officialPaperMonitor.SHARED_OWNER_SENTINEL);
  });
});

// 2026-07-28 (spec drift A3). sendPnlReport handed deliverReportToFeishu only
// {title, markdown, markdownPath, pdfPath}. Under the one-card delivery path
// that produced a card with neither the numbers nor a link: the 收支变化表 is a
// markdown TABLE, and the bullet extractor only picks up "- " lines, so the
// whole point of the report - net assets and what changed - never reached the
// reader. There is no /official-paper deep-link page to fall back on either
// (and it is being made owner-private), so the payload carries the numbers in
// its own conclusion and states plainly that there is no link.
describe("official-paper PnL Feishu delivery payload (spec drift A3)", () => {
  function pnlPayload(overrides: {
    current?: Record<string, unknown>;
    previousDay?: Record<string, unknown> | null;
    previousWeek?: Record<string, unknown> | null;
    scope?: Record<string, unknown>;
  } = {}) {
    // H2 (2026-07-28): both defaults used to be
    // `buildSnapshot({primaryAsset: {net_assets, total_cash}})`, i.e. an asset
    // row with no `currency` - the shape validateOfficialPrimaryAsset throws on,
    // so no fetch could ever produce it - and the card figures asserted below
    // (1200.00 USD / +200.00 USD / -60.00 USD) were measured against it.
    const current = overrides.current ?? producedSnapshotWithBalances("1200", "140");
    return officialPaperMonitor.buildPnlDeliveryPayload({
      scope: overrides.scope ?? { visibility: "owner-private", ownerOpenId: "ou_paper_owner" },
      current,
      previousDay: overrides.previousDay === undefined
        ? producedSnapshotWithBalances("1000", "200", { fetchedAt: "2026-06-30T14:00:00.000Z" })
        : overrides.previousDay,
      previousWeek: overrides.previousWeek === undefined ? null : overrides.previousWeek,
      markdown: officialPaperMonitor.renderPnlReport(current, null, null),
      markdownPath: "/tmp/reports/2026-07-01-post-open.md",
      pdfPath: "/tmp/reports/2026-07-01-post-open.pdf"
    });
  }

  it("keeps the PnL card in the owner's DM and out of the shared group", () => {
    const payload = pnlPayload();

    // /official-paper is owner-private: the account's balances must never be
    // routed to the circle's group chat.
    expect(payload.audience).toBe("dm");
    // R2: and it SAYS so, rather than leaving the delivery layer to infer it
    // from `audience` (a channel hint) or from an openId that isn't there.
    expect(payload.scope).toEqual({ visibility: "owner-private", ownerOpenId: "ou_paper_owner" });
  });

  it("refuses to build a payload with no declared scope rather than defaulting to one", () => {
    // Omitting `scope` is the point of the case, so the argument deliberately
    // does not satisfy the shape TypeScript infers from the .mjs destructuring.
    // The cast says that out loud rather than the file being excluded from the
    // checker so that nobody has to (H3).
    const noScope = {
      current: buildSnapshot(),
      previousDay: null,
      previousWeek: null,
      markdown: "# x",
      markdownPath: "/tmp/x.md",
      pdfPath: "/tmp/x.pdf"
    } as unknown as Parameters<typeof officialPaperMonitor.buildPnlDeliveryPayload>[0];

    expect(() => officialPaperMonitor.buildPnlDeliveryPayload(noScope)).toThrow(/scope/);
  });

  // 2026-07-28 (spec drift R3/N4). `summarizeAsset` coerced a missing
  // primaryAsset to 0, which was survivable while the figures only appeared in
  // the markdown table and became a lie once they were promoted into the card
  // HEADLINE: 「净资产 0.00 USD，现金 0.00 USD，持仓估值 0.00 USD」 describes a
  // wiped-out account, not a snapshot whose asset fetch returned nothing.
  describe("a snapshot with no account figures says so instead of reporting zeros", () => {
    const NO_ASSET_SNAPSHOT = { primaryAsset: undefined, positions: [], quotes: [] };

    it("headlines 暂无 with the reason, never 0.00 USD", () => {
      const payload = pnlPayload({ current: buildSnapshot(NO_ASSET_SNAPSHOT) });

      expect(payload.conclusion.headline).toContain("净资产 暂无");
      expect(payload.conclusion.headline).toContain("现金 暂无");
      expect(payload.conclusion.headline).toContain("不是 0");
      expect(payload.conclusion.headline).not.toContain("净资产 0.00 USD");
      expect(payload.conclusion.headline).not.toContain("现金 0.00 USD");
    });

    it("does not compute an exposure ratio or a remaining budget off the missing net assets", () => {
      const payload = pnlPayload({ current: buildSnapshot(NO_ASSET_SNAPSHOT) });
      const bullets = payload.conclusion.bullets.join("\n");

      expect(bullets).toContain("无法计算暴露比例与剩余预算");
      expect(bullets).not.toMatch(/暴露 0\.00%/u);
      expect(bullets).not.toMatch(/预算约 0\.00 USD/u);
      // An unknown balance cannot clear a budget check.
      expect(bullets).toContain("暂停新增");
    });

    it("reports 无法计算 for a change against a baseline, not a 0 change", () => {
      const payload = pnlPayload({
        current: buildSnapshot(NO_ASSET_SNAPSHOT),
        previousDay: producedSnapshotWithBalances("1000", "200")
      });

      expect(payload.conclusion.bullets.join("\n")).toContain("无法计算（缺少账户资金数据）");
      expect(payload.conclusion.bullets.join("\n")).not.toContain("+0.00 USD");
    });

    it("keeps the same honesty in the markdown table the report writes to disk", () => {
      const markdown = officialPaperMonitor.renderPnlReport(buildSnapshot(NO_ASSET_SNAPSHOT), null, null);

      expect(markdown).toContain("| 当前 | 暂无 | 暂无 |");
    });

    it("persists NULL rather than a 0 balance for a broker field that came back null", () => {
      const { db } = makeDb();
      const id = officialPaperMonitor.saveSnapshot(
        db,
        buildSnapshot({ primaryAsset: { net_assets: null, total_cash: null } }),
        "manual"
      );

      const row = db.prepare("SELECT net_assets, total_cash FROM official_paper_snapshots WHERE id = ?").get(id);
      expect(row).toEqual({ net_assets: null, total_cash: null });
    });

    // A real zero still reads as a real zero - the fix must not turn every 0
    // into 暂无.
    it("still reports a genuine zero balance as 0.00 USD", () => {
      // A zero balance is something the broker really returns, so it comes off
      // the real chain here rather than from a literal (H2).
      const payload = pnlPayload({
        current: producedSnapshotWithBalances("0", "0", { positions: [], quotes: [] })
      });

      expect(payload.conclusion.headline).toContain("净资产 0.00 USD");
      expect(payload.conclusion.headline).not.toContain("不是 0");
    });
  });

  it("carries the numbers the markdown table hides from the card", () => {
    const payload = pnlPayload();
    const text = [payload.conclusion.headline, ...payload.conclusion.bullets].join("\n");

    expect(text).toContain("1200.00 USD");
    expect(text).toContain("140.00 USD");
    // 1200 - 1000 = +200 net assets, 140 - 200 = -60 cash.
    expect(text).toContain("+200.00 USD");
    expect(text).toContain("-60.00 USD");
  });

  it("discloses a missing comparison snapshot instead of reporting a 0 change", () => {
    const payload = pnlPayload({ previousDay: null, previousWeek: null });
    const bullets = payload.conclusion.bullets.join("\n");

    expect(bullets).toContain("无可比快照");
    // A computed 0 here would be a fabrication: no baseline exists.
    expect(bullets).not.toContain("+0.00 USD");
  });

  it("discloses a degraded valuation rather than presenting a fallback price as a real one", () => {
    // No quote comes back for the position, exactly as when the quote call
    // throws in production - so `priceSource: "cost"` is attachPriceSource's
    // verdict here rather than an input this file wrote (H2).
    const payload = pnlPayload({ current: producedSnapshotWithBalances("1200", "140", { quotes: [] }) });

    expect(payload.conclusion.bullets.join("\n")).toContain("估值降级");
  });

  // 2026-07-28 (R1). The card shipped button-free because `official-paper` was
  // missing from DeepLinkKind, and that omission was then cited as proof that
  // no such page existed. /official-paper/<date> has always been served
  // (routes/reports.ts) and is now owner-gated, so the button is back.
  //
  // Asserted on the JSON Feishu actually parses, not on our own InteractiveCard
  // type: a card 1.0 `url` inside a schema-2.0 payload passed every type-level
  // test in this repo once already while the live API rejected it outright.
  async function pnlCardJson(baseUrl: string | undefined) {
    const notifications = await import("../../../packages/shared-types/dist/index.js");
    const previousBaseUrl = process.env.PLATFORM_PUBLIC_BASE_URL;
    if (baseUrl === undefined) {
      delete process.env.PLATFORM_PUBLIC_BASE_URL;
    } else {
      process.env.PLATFORM_PUBLIC_BASE_URL = baseUrl;
    }
    try {
      const card = notifications.buildReportConclusionCard(asDeliveryPayload(pnlPayload()));
      return { card, payload: notifications.buildFeishuCardPayload(card) as Record<string, unknown> };
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.PLATFORM_PUBLIC_BASE_URL;
      } else {
        process.env.PLATFORM_PUBLIC_BASE_URL = previousBaseUrl;
      }
    }
  }

  it("links the card at the owner-gated /official-paper page for this snapshot's date", async () => {
    const { card, payload } = await pnlCardJson("https://reports.qingverse.com");

    // The date is the snapshot's own fetchedAt day - the key routes/reports.ts
    // matches - not today's date and not a guessed id.
    expect(card.url).toEqual({
      text: "查看完整报告",
      href: "https://reports.qingverse.com/official-paper/2026-07-01"
    });
    const elements = (payload as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    expect(elements).toContainEqual({
      tag: "button",
      text: { tag: "plain_text", content: "查看完整报告" },
      type: "default",
      behaviors: [{
        type: "open_url",
        default_url: "https://reports.qingverse.com/official-paper/2026-07-01",
        pc_url: "https://reports.qingverse.com/official-paper/2026-07-01",
        ios_url: "https://reports.qingverse.com/official-paper/2026-07-01",
        android_url: "https://reports.qingverse.com/official-paper/2026-07-01"
      }]
    });
    // The link is the full text, not a replacement for the conclusion: the
    // 收支变化表 is a markdown TABLE the bullet extractor cannot read.
    expect(card.lines.join("\n")).toContain("1200.00 USD");
    expect(card.lines.join("\n")).not.toContain("未指定平台页面");
  });

  it("blames the missing base url - not a missing page - when the deployment has no public origin", async () => {
    const { card } = await pnlCardJson(undefined);

    expect(card.url).toBeUndefined();
    const text = card.lines.join("\n");
    expect(text).toContain("PLATFORM_PUBLIC_BASE_URL");
    expect(text).not.toContain("未指定平台页面");
    // The reader still gets the substance.
    expect(text).toContain("1200.00 USD");
  });
});
