/**
 * Task 24 (2026-07-28 spec-drift remediation): the control agent's 能力路由表.
 *
 * agents/control.md is the single source of the Feishu bot's persona, and its
 * route table is a list of shell commands the bot will really type at chat
 * time. A row naming a script that does not exist, or a subcommand the script
 * never implements, is invisible until a member asks for that capability and
 * gets a stack trace. installControlPersona already fails loud on an
 * unexpanded {{REPO_ROOT}} token for exactly this reason; this file extends
 * the same idea to the commands themselves.
 *
 * Everything here is checked against a producer: the script paths are resolved
 * on disk, and the newly added `analyze` route is proven by SPAWNING the real
 * CLI and reading what it says back.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const personaPath = join(repoRoot, "apps/openclaw-config/agents/control.md");
const persona = readFileSync(personaPath, "utf8");

/** Every `{{REPO_ROOT}}/...` script path the route table tells the agent to run. */
function routedScriptPaths(): string[] {
  const paths = new Set<string>();
  for (const match of persona.matchAll(/\{\{REPO_ROOT\}\}\/([\w./-]+\.mjs)/gu)) {
    paths.add(match[1] as string);
  }
  return [...paths];
}

describe("control agent 能力路由表", () => {
  it("only routes to scripts that exist in this checkout", () => {
    const routed = routedScriptPaths();
    expect(routed.length).toBeGreaterThan(0);
    for (const relative of routed) {
      expect(existsSync(join(repoRoot, relative)), `${relative} is routed but missing`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Subcommand COMPLETENESS, checked against the CLI's own dispatch table.
  //
  // The header above names "a subcommand the script never implements" as the
  // hazard, but the reverse was the one that actually shipped: strategy.mjs
  // grew `thesis demote` / `card demote` (§2.1 三档可见性 降档) and the route
  // table was never updated, so the bot - which types only what this table
  // tells it to - had no way to demote anything. A member asking "把这条降回
  // 圈内" would have been told the capability does not exist.
  //
  // `COMMANDS` in strategy.mjs is the producer: its keys ARE the accepted
  // subcommands. This reads them from the source rather than restating them,
  // so adding a subcommand without routing it fails here.
  // -------------------------------------------------------------------------
  function declaredSubcommands(scriptRelative: string, group: string): string[] {
    const source = readFileSync(join(repoRoot, scriptRelative), "utf8");
    const table = source.slice(source.indexOf("const COMMANDS = {"));
    const end = table.indexOf("};");
    return [...table.slice(0, end).matchAll(/"([\w-]+) ([\w-]+)":/gu)]
      .filter((match) => match[1] === group)
      .map((match) => match[2] as string);
  }

  /** The `<a|b|c>` alternation the route table offers for one command prefix. */
  function routedSubcommands(prefix: string): string[] {
    const row = persona.split("\n").find((line) => line.includes(prefix)) ?? "";
    const alternation = new RegExp(`${prefix} <([^>]+)>`, "u").exec(row);
    return alternation ? (alternation[1] as string).split(/\\?\|/u).map((part) => part.trim()) : [];
  }

  for (const group of ["thesis", "card"]) {
    it(`routes every strategy.mjs \`${group} …\` subcommand the CLI accepts`, () => {
      const declared = declaredSubcommands("apps/openclaw-config/scripts/strategy.mjs", group);
      expect(declared.length).toBeGreaterThan(1);
      const routed = routedSubcommands(`strategy.mjs ${group}`);
      for (const subcommand of declared) {
        expect(routed, `strategy.mjs ${group} ${subcommand} is implemented but not routed`).toContain(subcommand);
      }
    });
  }

  it("tells the agent a demote does not claw back what was already published", () => {
    // §2.1: 降档时已生成的历史内容不回收（如实告知）. The CLI returns that notice;
    // the agent has to relay it rather than implying a public thesis can be
    // un-published retroactively.
    const rows = persona.split("\n").filter((line) => line.includes("demote"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.includes("不会回收") || row.includes("不回收"))).toBe(true);
  });

  it("routes on-demand single-symbol analysis, so a member can ask for one in Feishu", () => {
    // req §3.4: 个股分析 is produced 每 3 天批量 + 按需 + 站内研究触发, and §4
    // lists 分析请求 among the conversation capabilities. Without this row the
    // bot has no command for "帮我看看 NVDA" at all.
    expect(persona).toMatch(/stock-analysis\.mjs analyze <SYMBOL>/u);
  });

  it("tells the agent the on-demand answer is unpublished and prose-free, not a public report", () => {
    const row = persona.split("\n").find((line) => line.includes("analyze <SYMBOL>")) ?? "";
    expect(row).toContain("不写入公共分析库");
    expect(row).toContain("没有叠加模型叙述");
    // Never answer a price question from memory - the whole reason this
    // capability exists is the operator finding a stale 398 quoted for TSM.
    expect(row).toContain("不要改用记忆里的旧价格作答");
  });

  it("the real stock-analysis CLI dispatches `analyze` and refuses a missing symbol in Chinese", () => {
    // Spawns the actual binary the route table names. A command the CLI does
    // not know falls through to the usage error instead, which is what this
    // distinguishes: the message below only exists inside runAnalyzeOnDemand.
    const run = spawnSync(process.execPath, [join(repoRoot, "apps/openclaw-config/scripts/stock-analysis.mjs"), "analyze"], {
      encoding: "utf8",
      timeout: 30_000
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("一次只分析一只标的");
  });

  it("the CLI's own usage line lists `analyze` alongside the other subcommands", () => {
    // An unknown command falls through to the branch that has already opened
    // a database, so this spawn is pointed at a throwaway file via the CLI's
    // own STOCK_ANALYSIS_DB_PATH override - the suite must never touch the
    // real runtime/trading.sqlite (test/runtime-write-guard.ts enforces it).
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-control-routing-"));
    try {
      const run = spawnSync(
        process.execPath,
        [join(repoRoot, "apps/openclaw-config/scripts/stock-analysis.mjs"), "definitely-not-a-command"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, STOCK_ANALYSIS_DB_PATH: join(dir, "trading.sqlite") }
        }
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("analyze");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
