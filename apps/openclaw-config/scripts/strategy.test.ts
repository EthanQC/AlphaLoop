import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

import { renderConclusionBox } from "./conclusion-box.mjs";

const cli = await import("./strategy.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string; options: { dbPath: string; memorydBackend: (args: unknown) => Promise<{ ok: boolean; memoryId?: string; reason?: string }> } } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-strategy-cli-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  const { backend } = fakeBackend();
  return { db, dbPath, options: { dbPath, memorydBackend: backend } };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id = "owner_1", status: "active" | "revoked" = "active"): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status,
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function fakeBackend(): {
  backend: (args: { scope: string; type: string; title: string; content: string; tags: string[] }) => Promise<{ ok: boolean; memoryId?: string }>;
  calls: Array<{ scope: string; type: string; title: string; content: string; tags: string[] }>;
} {
  const calls: Array<{ scope: string; type: string; title: string; content: string; tags: string[] }> = [];
  let counter = 0;
  const backend = vi.fn(async (args: { scope: string; type: string; title: string; content: string; tags: string[] }) => {
    calls.push(args);
    counter += 1;
    return { ok: true, memoryId: `mem_${counter}` };
  });
  return { backend, calls };
}

function throwingBackend(): (args: unknown) => Promise<never> {
  return vi.fn(async () => {
    throw new Error("memoryd unreachable (fake)");
  });
}

function auditRows(db: DatabaseSync, action?: string): Array<{ action: string; payload: string }> {
  const rows = action
    ? (db.prepare(`SELECT action, payload FROM audit_log WHERE category = 'strategy_memory' AND action = ?`).all(action) as Array<{ action: string; payload: string }>)
    : (db.prepare(`SELECT action, payload FROM audit_log WHERE category = 'strategy_memory'`).all() as Array<{ action: string; payload: string }>);
  return rows;
}

// ===========================================================================
// thesis create
// ===========================================================================

describe("runThesisCreate", () => {
  it("creates a thesis with bull/bear points split on ';' and mirrors it", async () => {
    const { db, options } = makeDb();
    seedMember(db);

    const result = await cli.runThesisCreate(
      {
        owner: "owner_1",
        symbol: "AAPL.US",
        direction: "bull",
        "target-low": "180",
        "target-high": "220",
        invalidation: "150",
        bull: "云业务增速超预期;现金流稳健",
        bear: "估值过高"
      },
      options
    );

    expect(result.ok).toBe(true);
    expect(result.thesis.symbol).toBe("AAPL.US");
    expect(result.thesis.direction).toBe("bull");
    expect(result.thesis.targetLow).toBe(180);
    expect(result.thesis.targetHigh).toBe(220);
    expect(result.thesis.invalidationPrice).toBe(150);
    expect(result.thesis.bullPoints).toEqual(["云业务增速超预期", "现金流稳健"]);
    expect(result.thesis.bearPoints).toEqual(["估值过高"]);
    expect(result.mirror.mirrored).toBe(true);
    // Mirror succeeded -> memory_slug backfilled onto the SQL row.
    expect(result.thesis.memorySlug).toBe(result.mirror.memoryId);
  });

  it("defaults visibility to 'system' when --visibility is omitted", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const result = await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "neutral" }, options);
    expect(result.thesis.visibility).toBe("system");
  });

  it("rejects an invalid --direction", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const result = await cli.buildCliResult(
      ["thesis", "create", "--owner", "owner_1", "--symbol", "AAPL.US", "--direction", "sideways"],
      options
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/--direction 必须是/);
  });

  it("rejects an invalid --visibility", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    await expect(
      cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull", visibility: "private" }, options)
    ).rejects.toThrow(/--visibility 必须是/);
  });

  it("rejects a nonexistent owner", async () => {
    const { options } = makeDb();
    await expect(cli.runThesisCreate({ owner: "member_ghost", symbol: "AAPL.US", direction: "bull" }, options)).rejects.toThrow(
      /成员不存在/
    );
  });

  it("rejects a revoked owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, "owner_1", "revoked");
    await expect(cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).rejects.toThrow(
      /吊销/
    );
  });

  it("writes an audit_log row with category strategy_memory", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const result = await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options);

    const rows = auditRows(db, "thesis create");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).thesisId).toBe(result.thesis.id);
  });

  // Mirror degradation MUST NOT fail the create - the SQL row is already
  // committed by the time mirrorRecord is even called.
  it("mirror degradation (backend throws) does NOT fail the create - the SQL row still exists", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db);
    const options = { dbPath, memorydBackend: throwingBackend() };

    const result = await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options);

    expect(result.ok).toBe(true);
    expect(result.mirror.mirrored).toBe(false);
    expect(result.thesis.memorySlug).toBeNull(); // never backfilled when mirror fails

    const row = db.prepare(`SELECT id, symbol FROM theses WHERE id = ?`).get(result.thesis.id);
    expect(row).toBeDefined();
  });

  // Same guarantee using the REAL default backend (createMemorydBackend(),
  // P10-gated throw) - no memorydBackend option supplied at all.
  it("with the default (unconfigured) memoryd backend, the create still succeeds and the row is written", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, { dbPath });

    expect(result.ok).toBe(true);
    expect(result.mirror.mirrored).toBe(false);
    expect(result.mirror.reason).toMatch(/P10 ignition/);
    const row = db.prepare(`SELECT id FROM theses WHERE id = ?`).get(result.thesis.id);
    expect(row).toBeDefined();
    warnSpy.mockRestore();
  });
});

// ===========================================================================
// thesis judge
// ===========================================================================

describe("runThesisJudge", () => {
  it("appends a judgment and mirrors it, defaulting --source to 'self'", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const thesis = (await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).thesis;

    const result = await cli.runThesisJudge({ owner: "owner_1", thesis: thesis.id, note: "突破年线" }, options);

    expect(result.ok).toBe(true);
    expect(result.judgment.note).toBe("突破年线");
    expect(result.judgment.source).toBe("self");
    expect(result.mirror.mirrored).toBe(true);
  });

  it("accepts an explicit --source", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const thesis = (await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).thesis;

    const result = await cli.runThesisJudge(
      { owner: "owner_1", thesis: thesis.id, note: "财报超预期", source: "news:xyz" },
      options
    );
    expect(result.judgment.source).toBe("news:xyz");
  });

  it("rejects judging a nonexistent thesis", async () => {
    const { options } = makeDb();
    await expect(cli.runThesisJudge({ owner: "owner_1", thesis: "thesis_ghost", note: "x" }, options)).rejects.toThrow(
      /未找到论点/
    );
  });

  it("rejects a non-owner attempting to judge", async () => {
    const { db, options } = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const thesis = (await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).thesis;

    await expect(cli.runThesisJudge({ owner: "owner_2", thesis: thesis.id, note: "x" }, options)).rejects.toThrow(
      /非本人操作被拒/
    );
  });

  it("requires --note", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const thesis = (await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).thesis;
    await expect(cli.runThesisJudge({ owner: "owner_1", thesis: thesis.id }, options)).rejects.toThrow(/--note/);
  });
});

// ===========================================================================
// thesis promote / withdraw
// ===========================================================================

describe("runThesisPromote / runThesisWithdraw", () => {
  it("promotes system -> public for the owner", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const thesis = (await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).thesis;

    const result = await cli.runThesisPromote({ owner: "owner_1", thesis: thesis.id }, options);
    expect(result.thesis.visibility).toBe("public");

    const rows = auditRows(db, "thesis promote");
    expect(rows).toHaveLength(1);
  });

  it("rejects promotion by a non-owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const thesis = (await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).thesis;

    await expect(cli.runThesisPromote({ owner: "owner_2", thesis: thesis.id }, options)).rejects.toThrow(/无权操作/);
  });

  it("withdraws a thesis, preserving history", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const thesis = (await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).thesis;
    await cli.runThesisJudge({ owner: "owner_1", thesis: thesis.id, note: "note" }, options);

    const result = await cli.runThesisWithdraw({ owner: "owner_1", thesis: thesis.id }, options);
    expect(result.thesis.status).toBe("withdrawn");
  });

  it("rejects withdrawal by a non-owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const thesis = (await cli.runThesisCreate({ owner: "owner_1", symbol: "AAPL.US", direction: "bull" }, options)).thesis;

    await expect(cli.runThesisWithdraw({ owner: "owner_2", thesis: thesis.id }, options)).rejects.toThrow(/无权操作/);
  });
});

// ===========================================================================
// thesis from-conclusion
// ===========================================================================

function writeReport(dir: string, sections: Record<string, { coreConclusion: string; reviewTrigger: string }>): string {
  const parts = ["# 复盘报告", ""];
  for (const [symbol, section] of Object.entries(sections)) {
    parts.push(`## ${symbol}`, "", "正文分析...", "", renderConclusionBox({
      coreConclusion: section.coreConclusion,
      confidence: "high",
      valueRange: { low: 180, high: 220, basis: "DCF" },
      pricePosition: "接近区间下沿",
      reviewTrigger: section.reviewTrigger,
      reviewDate: "2026-08-01"
    }), "");
  }
  const reportPath = join(dir, "report.md");
  writeFileSync(reportPath, parts.join("\n"), "utf8");
  return reportPath;
}

describe("runThesisFromConclusion", () => {
  it("drafts a bull thesis from a report's conclusion box (keyword-based direction)", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-report-"));
    tempDirs.push(dir);
    const reportPath = writeReport(dir, {
      "AAPL.US": { coreConclusion: "基本面强劲，看多后市", reviewTrigger: "跌破 150 美元" }
    });

    const result = await cli.runThesisFromConclusion({ owner: "owner_1", report: reportPath, symbol: "AAPL.US" }, options);

    expect(result.ok).toBe(true);
    expect(result.thesis.symbol).toBe("AAPL.US");
    expect(result.thesis.direction).toBe("bull");
    expect(result.thesis.targetLow).toBe(180);
    expect(result.thesis.targetHigh).toBe(220);
    expect(result.thesis.invalidationPrice).toBe(150);
    expect(result.judgment.source).toBe("conclusion_box");
    expect(result.source).toBe("conclusion_box");
  });

  it("drafts a bear thesis when the conclusion contains a bear keyword", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-report-"));
    tempDirs.push(dir);
    const reportPath = writeReport(dir, {
      "MSFT.US": { coreConclusion: "估值过高，看空", reviewTrigger: "突破 250 美元" }
    });

    const result = await cli.runThesisFromConclusion({ owner: "owner_1", report: reportPath, symbol: "MSFT.US" }, options);
    expect(result.thesis.direction).toBe("bear");
  });

  it("defaults to neutral when no directional keyword is present", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-report-"));
    tempDirs.push(dir);
    const reportPath = writeReport(dir, {
      "NVDA.US": { coreConclusion: "维持观察，等待更多数据", reviewTrigger: "季度财报公布" }
    });

    const result = await cli.runThesisFromConclusion({ owner: "owner_1", report: reportPath, symbol: "NVDA.US" }, options);
    expect(result.thesis.direction).toBe("neutral");
    // No digit in the review trigger text -> invalidationPrice stays unset.
    expect(result.thesis.invalidationPrice).toBeNull();
  });

  it("fails with a Chinese error when the report file does not exist", async () => {
    const { options } = makeDb();
    await expect(
      cli.runThesisFromConclusion({ owner: "owner_1", report: "/no/such/report.md", symbol: "AAPL.US" }, options)
    ).rejects.toThrow(/找不到复盘报告文件/);
  });

  it("fails with a Chinese error when the report has no '## <symbol>' section", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-report-"));
    tempDirs.push(dir);
    const reportPath = writeReport(dir, { "AAPL.US": { coreConclusion: "看多", reviewTrigger: "跌破 150" } });

    await expect(
      cli.runThesisFromConclusion({ owner: "owner_1", report: reportPath, symbol: "TSLA.US" }, options)
    ).rejects.toThrow(/未找到 TSLA\.US 的分析小节/);
  });

  it("fails with a Chinese error when the symbol section has no parseable conclusion box", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-report-"));
    tempDirs.push(dir);
    const reportPath = join(dir, "report.md");
    writeFileSync(reportPath, "# 复盘报告\n\n## AAPL.US\n\n只有正文，没有结论框。\n", "utf8");

    await expect(
      cli.runThesisFromConclusion({ owner: "owner_1", report: reportPath, symbol: "AAPL.US" }, options)
    ).rejects.toThrow(/结论框解析失败/);
  });
});

// ===========================================================================
// rule create / disable / enable / list
// ===========================================================================

describe("runRuleCreate / runRuleDisable / runRuleEnable / runRuleList", () => {
  it("creates a rule and mirrors it as a discipline_rule record", async () => {
    const { db, options } = makeDb();
    seedMember(db);

    const result = await cli.runRuleCreate({ owner: "owner_1", text: "仓位≤30%", enforcement: "hard" }, options);

    expect(result.ok).toBe(true);
    expect(result.rule.enforcement).toBe("hard");
    expect(result.rule.enabled).toBe(true);
    expect(result.mirror.mirrored).toBe(true);
  });

  it("rejects an invalid --enforcement", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    await expect(cli.runRuleCreate({ owner: "owner_1", text: "x", enforcement: "bogus" }, options)).rejects.toThrow(
      /--enforcement 必须是/
    );
  });

  it("rejects a nonexistent owner on create", async () => {
    const { options } = makeDb();
    await expect(cli.runRuleCreate({ owner: "member_ghost", text: "x", enforcement: "self" }, options)).rejects.toThrow(
      /成员不存在/
    );
  });

  it("disable/enable round-trip, rejecting a non-owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const rule = (await cli.runRuleCreate({ owner: "owner_1", text: "x", enforcement: "self" }, options)).rule;

    await expect(cli.runRuleDisable({ owner: "owner_2", rule: rule.id }, options)).rejects.toThrow(/无权操作/);

    const disabled = await cli.runRuleDisable({ owner: "owner_1", rule: rule.id }, options);
    expect(disabled.rule.enabled).toBe(false);

    const enabled = await cli.runRuleEnable({ owner: "owner_1", rule: rule.id }, options);
    expect(enabled.rule.enabled).toBe(true);
  });

  it("lists rules for the owner without writing an audit_log row", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    await cli.runRuleCreate({ owner: "owner_1", text: "x", enforcement: "self" }, options);

    const result = await cli.runRuleList({ owner: "owner_1" }, options);
    expect(result.rules).toHaveLength(1);
    expect(auditRows(db, "rule list")).toHaveLength(0);
  });
});

// ===========================================================================
// card create / status / promote / list
// ===========================================================================

describe("runCardCreate / runCardStatus / runCardPromote / runCardList", () => {
  const cardFlags = { owner: "owner_1", name: "趋势跟随", scene: "单边趋势", entry: "突破20日线", risk: "止损5%", exit: "跌破10日线" };

  it("creates a card and mirrors it as a strategy_card (playbook) record", async () => {
    const { db, options } = makeDb();
    seedMember(db);

    const result = await cli.runCardCreate(cardFlags, options);

    expect(result.ok).toBe(true);
    expect(result.card.status).toBe("active");
    expect(result.card.visibility).toBe("system");
    expect(result.mirror.mirrored).toBe(true);
  });

  it("rejects an invalid --visibility", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    await expect(cli.runCardCreate({ ...cardFlags, visibility: "private" }, options)).rejects.toThrow(/--visibility 必须是/);
  });

  it("rejects a nonexistent owner", async () => {
    const { options } = makeDb();
    await expect(cli.runCardCreate({ ...cardFlags, owner: "member_ghost" }, options)).rejects.toThrow(/成员不存在/);
  });

  it("card status transitions and rejects an invalid --to value", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const card = (await cli.runCardCreate(cardFlags, options)).card;

    await expect(cli.runCardStatus({ owner: "owner_1", card: card.id, to: "bogus" }, options)).rejects.toThrow(
      /--to 必须是/
    );

    const result = await cli.runCardStatus({ owner: "owner_1", card: card.id, to: "paused" }, options);
    expect(result.card.status).toBe("paused");
  });

  it("rejects card status change by a non-owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const card = (await cli.runCardCreate(cardFlags, options)).card;

    await expect(cli.runCardStatus({ owner: "owner_2", card: card.id, to: "paused" }, options)).rejects.toThrow(
      /无权操作/
    );
  });

  it("card promote: system -> public, rejecting a non-owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, "owner_1");
    seedMember(db, "owner_2");
    const card = (await cli.runCardCreate(cardFlags, options)).card;

    await expect(cli.runCardPromote({ owner: "owner_2", card: card.id }, options)).rejects.toThrow(/无权操作/);

    const result = await cli.runCardPromote({ owner: "owner_1", card: card.id }, options);
    expect(result.card.visibility).toBe("public");
  });

  it("lists cards for the owner without writing an audit_log row", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    await cli.runCardCreate(cardFlags, options);

    const result = await cli.runCardList({ owner: "owner_1" }, options);
    expect(result.cards).toHaveLength(1);
    expect(auditRows(db, "card list")).toHaveLength(0);
  });
});

// ===========================================================================
// dispatch / per-command flag allowlist (H6 pattern) / buildCliResult
// ===========================================================================

describe("dispatch: thesis/rule/card are two-word commands", () => {
  it("routes 'thesis create' through buildCliResult", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const result = await cli.buildCliResult(
      ["thesis", "create", "--owner", "owner_1", "--symbol", "AAPL.US", "--direction", "bull"],
      options
    );
    expect(result.ok).toBe(true);
    expect(result.thesis.symbol).toBe("AAPL.US");
  });

  it("rejects a bare 'thesis' with no subcommand", async () => {
    const { options } = makeDb();
    const result = await cli.buildCliResult(["thesis"], options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });

  it("rejects an unrecognized top-level command", async () => {
    const { options } = makeDb();
    const result = await cli.buildCliResult(["frobnicate"], options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });
});

describe("per-command flag allowlist (H6 pattern: cross-command flags rejected)", () => {
  it("rejects a card-only flag (--scene) on thesis create", () => {
    expect(() =>
      cli.parseFlags(["--owner", "o", "--symbol", "s", "--direction", "bull", "--scene", "x"], "thesis create")
    ).toThrow(/未知参数：--scene/);
  });

  it("rejects a thesis-only flag (--symbol) on rule create", () => {
    expect(() => cli.parseFlags(["--owner", "o", "--text", "t", "--enforcement", "self", "--symbol", "x"], "rule create")).toThrow(
      /未知参数：--symbol/
    );
  });

  it("rejects any flag at all on 'rule list'", () => {
    expect(() => cli.parseFlags(["--owner", "o", "--all"], "rule list")).toThrow(/未知参数：--all/);
  });
});

describe("buildCliResult: JSON envelope for the whole pre-dispatch + dispatch path", () => {
  it("converts an unknown-flag parseFlags throw into {ok:false, error}", async () => {
    const { options } = makeDb();
    const result = await cli.buildCliResult(["rule", "list", "--owner", "o", "--bogus", "1"], options);
    expect(result).toEqual({ ok: false, error: "未知参数：--bogus。" });
  });

  it("a successful command round-trips through the envelope", async () => {
    const { db, options } = makeDb();
    seedMember(db);
    const result = await cli.buildCliResult(["rule", "create", "--owner", "owner_1", "--text", "x", "--enforcement", "self"], options);
    expect(result.ok).toBe(true);
    expect(result.rule.ruleText).toBe("x");
  });
});
