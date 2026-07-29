// Task 14 (2026-07-28 spec-drift plan): 「PDF 已退役」 (2026-07-12 requirements
// §0.4). Nothing in this repo may render one again.
//
// WHY A SOURCE SCAN AND NOT A PIPELINE RUN
// ----------------------------------------
// The property is "generating a report leaves no .pdf on disk". The three
// producers that used to write one - scheduled-report.mjs, stock-analysis.mjs,
// official-paper-monitor.mjs - reach their write step only through a full live
// run (Longbridge CLI + OpenClaw gateway + Feishu), and their prepare/deliver
// orchestrators are not exported, so no test in this tree can call them. What
// IS testable directly is asserted where it belongs: resolveReportPaths returns
// only a markdownPath (stock-analysis.test.ts), the delivery payloads carry no
// pdfPath (stock-analysis.test.ts / official-paper-monitor.test.ts), and no
// channel uploads a file (notifications.test.ts).
//
// This file covers the remaining half: that no script can render one at all,
// because the renderer and every route to Chrome's print-to-pdf are gone. It is
// a grep, and it says so - it proves absence of a call, not behaviour of a run.
//
// The live evidence this replaces, from the deployed mini on 2026-07-30:
//   find reports -name '*.pdf' | wc -l   -> 28
//   report-delivery-state.json           -> "pdfUploaded": false on every entry
// i.e. Chrome was spawned for every daily, weekly and stock-analysis batch, the
// file was written, and nothing ever sent it.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/** Every .mjs in this directory - the production scripts. Tests (.test.ts) are
 * deliberately not scanned: they may name the retired artifact while explaining
 * its retirement, as this file does. */
function productionScripts(): string[] {
  return readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
}

/** The concrete ways this repo ever produced a PDF. Each pattern is a CALL or
 * an argument that only appears when something is really rendering one - not
 * the word "PDF" in prose, which is why a comment explaining the retirement
 * does not trip this. */
const PDF_RENDER_PATTERNS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /writeMarkdownPdf/u, what: "the retired markdown->PDF renderer" },
  { pattern: /runChromePdf|buildChromePdfArgs|buildChromePdfSpawnOptions/u, what: "the Chrome PDF driver" },
  { pattern: /--print-to-pdf/u, what: "Chrome's print-to-pdf flag" },
  { pattern: /report-rendering\.mjs/u, what: "the deleted HTML-for-PDF renderer module" }
];

describe("PDF retirement (§0.4 「PDF 已退役」)", () => {
  it("no production script renders, spawns or imports a PDF path", () => {
    const offenders: string[] = [];
    for (const name of productionScripts()) {
      const source = readFileSync(join(scriptsDir, name), "utf8");
      for (const { pattern, what } of PDF_RENDER_PATTERNS) {
        if (pattern.test(source)) {
          offenders.push(`${name}: ${what} (${pattern.source})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no production script writes a .pdf filename", () => {
    // Distinct from the patterns above: a script could build a path without
    // going through any of the named helpers.
    const offenders: string[] = [];
    for (const name of productionScripts()) {
      const source = readFileSync(join(scriptsDir, name), "utf8");
      // `.pdf` inside a template/string literal - the shape of a filename being
      // constructed. Matches `${label}.pdf`, "x.pdf", '-post-open.pdf'.
      if (/["'`][^"'`\n]*\.pdf\b/u.test(source)) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });
});
