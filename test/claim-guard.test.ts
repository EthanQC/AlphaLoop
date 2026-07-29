import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildRepoIndex,
  checkCountDirectives,
  checkFileReferences,
  checkIdentifierReferences,
  collectCountDirectives,
  declaredFindingCodes,
  findingCodeFragments,
  formatViolations,
  splitCommentsAndCode,
  trackedFiles,
  GUARD_OWN_FILES,
  type RepoIndex
} from "./claim-guard.js";

/**
 * The claim guard's own gate. `test/claim-guard.ts` explains WHY comments in
 * this repo rot (they assert things about OTHER files, which nothing rechecks);
 * this file is what makes the recheck happen on every `pnpm test`.
 *
 * Three kinds of assertion live here:
 *
 *   · the scan itself, over the whole working tree;
 *   · unit cases on the scanner, so it cannot pass by scanning nothing;
 *   · finding-code coverage, which needs no scanning - every code the doctor
 *     can emit must be named by some test.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DOCTOR = "apps/openclaw-config/scripts/openclaw-runtime-doctor-core.mjs";

let cached: RepoIndex | null = null;
function index(): RepoIndex {
  cached ??= buildRepoIndex(ROOT);
  return cached;
}

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A one-file RepoIndex over a scratch directory, for the negative controls. */
function scratchIndex(root: string, relative: string): RepoIndex {
  return {
    root,
    files: [relative],
    byBasename: new Map([[basename(relative), [relative]]]),
    codeWords: new Set<string>(),
    scanned: [splitCommentsAndCode(relative, readFileSync(join(root, relative), "utf8"))]
  };
}

describe("claim guard: the scanner does what it says", () => {
  it("keeps a wrapped filename in one piece", () => {
    const scanned = splitCommentsAndCode(
      "x.mjs",
      ["// the escalation state machine lives in market-alerts-", "// poll.mjs, next to the store.", "const a = 1;"].join(
        "\n"
      )
    );
    expect(scanned.paragraphs).toHaveLength(1);
    expect(scanned.paragraphs[0]?.text).toContain("market-alerts-poll.mjs");
    expect(scanned.codeLines).toEqual(["const a = 1;"]);
  });

  it("does not let a comment vouch for a name - comment text never becomes code text", () => {
    const scanned = splitCommentsAndCode("x.mjs", ["/**", " * see `judgeDeployAttempt`", " */", "export const q = 1;"].join("\n"));
    expect(scanned.codeLines.join("\n")).not.toContain("judgeDeployAttempt");
    expect(scanned.paragraphs[0]?.text).toContain("judgeDeployAttempt");
  });

  it("maps a violation back to the line it was written on, not the paragraph's first line", () => {
    const scanned = splitCommentsAndCode("x.mjs", ["// line one of the note,", "// and `someMissingSymbol` on line two."].join("\n"));
    const paragraph = scanned.paragraphs[0];
    expect(paragraph).toBeDefined();
    const at = paragraph?.text.indexOf("someMissingSymbol") ?? -1;
    expect(at).toBeGreaterThan(0);
    const segment = [...(paragraph?.segments ?? [])].reverse().find((entry) => entry.offset <= at);
    expect(segment?.line).toBe(2);
  });

  it("reads shell comments and markdown lines too", () => {
    expect(splitCommentsAndCode("x.sh", "# a note\nexit 0").paragraphs[0]?.text).toContain("a note");
    expect(splitCommentsAndCode("x.md", "one\ntwo").paragraphs).toHaveLength(2);
  });

  /**
   * The tree-wide @claim-count assertion below can only ever report that the
   * repo's five directives currently agree with the repo. That is not evidence
   * that a DISAGREEING directive would be caught - a directive checker that
   * returned an empty array unconditionally would look exactly the same, and
   * "the check passes" is precisely the kind of claim this file exists to
   * distrust. So: a scratch repo of one file, one directive, one number, moved
   * off by one.
   *
   * (This paragraph named the checker in backticks at first, and the guard
   * rejected it: the guard's own two files are excluded from the name corpus,
   * so nothing here can vouch for a symbol. Working as intended, on itself.)
   */
  it("fails a directive whose number is wrong, and says what the real count is", () => {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-claim-count-"));
    scratchDirs.push(dir);
    const relative = "counted.sh";
    writeFileSync(
      join(dir, relative),
      [
        "# there are two exits below",
        `# @claim-count 2 :: ${relative} :: ^\\s*exit [0-9]+`,
        "exit 1",
        "exit 2",
        "exit 3"
      ].join("\n")
    );

    const scratch = scratchIndex(dir, relative);
    expect(collectCountDirectives(scratch)).toHaveLength(1);

    const violations = checkCountDirectives(scratch);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("claim-count");
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.detail).toContain("but 3 do");

    // ...and the same directive with the right number is silent, so the
    // failure above is about the count and not about the directive existing.
    writeFileSync(
      join(dir, relative),
      [`# @claim-count 3 :: ${relative} :: ^\\s*exit [0-9]+`, "exit 1", "exit 2", "exit 3"].join("\n")
    );
    expect(checkCountDirectives(scratchIndex(dir, relative))).toEqual([]);
  });
});

describe("claim guard: the tree", () => {
  it("scans a corpus big enough to mean something (no vacuous pass)", () => {
    const scanned = index().scanned;
    expect(trackedFiles(ROOT).length, "git ls-files returned nothing - the guard went vacuous").toBeGreaterThan(300);
    expect(scanned.length, "no claim-bearing files were scanned").toBeGreaterThan(200);
    expect(
      scanned.reduce((total, file) => total + file.paragraphs.length, 0),
      "no comment paragraphs were collected"
    ).toBeGreaterThan(3000);
    expect(index().codeWords.size, "no identifiers were collected from code").toBeGreaterThan(5000);
  });

  it("cites no file that does not exist, and no line past the end of one", () => {
    const violations = checkFileReferences(index());
    expect(violations, `\n${formatViolations(violations)}\n`).toEqual([]);
  });

  it("cites no identifier that no source line defines or uses", () => {
    const violations = checkIdentifierReferences(index());
    expect(violations, `\n${formatViolations(violations)}\n`).toEqual([]);
  });

  it("re-counts every @claim-count quantity claim", () => {
    const directives = collectCountDirectives(index());
    // A directive syntax nobody uses is a mechanism, not a guard. If this drops
    // to zero, either the directives were deleted or CLAIM_COUNT_RE stopped
    // matching them - both make the check below vacuous.
    expect(directives.length, "no @claim-count directives found").toBeGreaterThan(0);
    const violations = checkCountDirectives(index());
    expect(violations, `\n${formatViolations(violations)}\n`).toEqual([]);
  });
});

/**
 * Round-6 shipped four new doctor checks - `deploy-ledger.absent`,
 * `.incomplete`, `.stale` and the `deployFootprint` severity switch under
 * them - and described them as the mechanism that would catch a half-finished
 * deploy. No test in the tree named any of them. That is a claim of coverage
 * that is not coverage, and unlike a wrong sentence it cannot be spotted by
 * reading the file it is written in.
 *
 * 2026-07-29: this check was doing the same thing to itself. The corpus it
 * searched was "every `*.test.ts` in the tree", and THIS FILE is a `*.test.ts`,
 * so the list below - `deploy-checkout.ahead_of_origin` and the rest, written
 * out as string literals - matched itself. `unasserted` came back empty, both
 * assertions below passed on nothing, and the guard reported full test coverage
 * of all 61 doctor finding codes while eight had none. Excluding the guard's
 * own two files (GUARD_OWN_FILES, exported for exactly this) is what makes the
 * answer measured; the same exclusion already existed on the name-corpus side,
 * for the same reason, and was not carried over to here.
 *
 * The list is the honest remainder AFTER that fix, and it is a ratchet: it may
 * shrink, and an entry naming a code the doctor no longer emits fails just as
 * loudly as a new gap. Every entry carries the reason it is still here.
 */
const FINDING_CODES_WITHOUT_TESTS = [
  // A label in install-launchd-ownership.txt with no LAUNCHD_SERVICE_HEALTH
  // entry. openclaw-runtime-doctor-core.test.ts pins that the two sets are
  // equal today, so reaching this branch means editing one of them - a fixture
  // that contradicts an assertion two files away.
  "launchd-jobs.${job.slug}.no_health_contract",
  // `launchctl print` output that parses but carries no `state` line. Not one
  // sample of that shape has been measured on any machine, and inventing one
  // would be a fixture no producer emits - the exact thing round-3 finding F2
  // rewrote this suite's launchd fixtures to stop doing.
  "launchd-jobs.${job.slug}.state_unknown",
  // official-paper poll/pnl judged in a year trading-schedule.mjs's hardcoded
  // NYSE calendar does not cover. Reachable only by moving `now` past the
  // calendar's last covered year, which every other case in the suite pins to
  // a fixed 2026 date.
  "official-paper-health.calendar_uncovered",
  // Local commits origin does not have. The behind / dirty / never_fetched
  // branches next to it are covered against a real local origin; ahead-only
  // needs a third repo state, and that whole check is being edited by another
  // agent in this working tree right now (round-8 finding L4) - a test written
  // against a function mid-rewrite pins the half-finished shape.
  "deploy-checkout.ahead_of_origin"
];

describe("claim guard: a doctor finding nobody asserts is not covered", () => {
  const codes = declaredFindingCodes(ROOT, DOCTOR);
  const coverageFiles = trackedFiles(ROOT).filter(
    (file) => file.endsWith(".test.ts") && !GUARD_OWN_FILES.has(file)
  );
  const testBlob = coverageFiles.map((file) => readFileSync(join(ROOT, file), "utf8")).join("\n");

  const unasserted = codes.filter((code) =>
    findingCodeFragments(code).some((fragment) => !testBlob.includes(fragment))
  );

  it("still finds the doctor's finding codes at all", () => {
    expect(codes.length, "no finding codes parsed out of the doctor - this check went vacuous").toBeGreaterThan(40);
  });

  it("does not let this file's own list vouch for the codes in it", () => {
    // The regression that made every assertion below vacuous. Asserted on the
    // corpus rather than on a comment, so it cannot come back by someone
    // dropping the filter and leaving the paragraph above in place.
    expect(coverageFiles.length, "no test files in the coverage corpus").toBeGreaterThan(100);
    for (const own of GUARD_OWN_FILES) {
      expect(coverageFiles, `${own} may not supply coverage evidence about itself`).not.toContain(own);
    }
    const declaredOnly = FINDING_CODES_WITHOUT_TESTS.find((code) => !code.includes("${"));
    expect(declaredOnly).toBeDefined();
    expect(
      testBlob.includes(declaredOnly ?? " "),
      `${declaredOnly} is listed as uncovered but appears in the corpus - the exclusion is not working`
    ).toBe(false);
  });

  it("names every uncovered code in the declared list, and nothing else", () => {
    const declared = new Set(FINDING_CODES_WITHOUT_TESTS);
    const undeclared = unasserted.filter((code) => !declared.has(code));
    expect(
      undeclared,
      "these doctor findings can fire on the deploy machine and no test asserts any of them - " +
        "write the test, or add the code to FINDING_CODES_WITHOUT_TESTS with a reason"
    ).toEqual([]);
  });

  it("keeps the uncovered list a ratchet (it may only shrink)", () => {
    const stale = FINDING_CODES_WITHOUT_TESTS.filter((code) => !unasserted.includes(code));
    expect(stale, "these are listed as uncovered but are now covered (or no longer emitted) - drop them").toEqual([]);
  });
});
