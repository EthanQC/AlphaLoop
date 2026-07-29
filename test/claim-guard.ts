import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// ===========================================================================
// THE CLAIM GUARD - a mechanical check on what comments and READMEs ASSERT.
//
// WHY IT EXISTS
// -------------
// Seven rounds of drift remediation on this repo produced 46 + 14 + 19 + 15 +
// 15 + 18 + 24 confirmed findings. Round 6's split is the reason this file
// exists: 13 of its 24 findings were not defects in code at all. They were
// comments, file headers, README lines and commit messages asserting behaviour
// that does not exist. Among them:
//
//   · a comment promising a test file (`cache-headers.test.ts`) nobody wrote;
//   · a header pointing at `judgeDeployAttempt`, where the export is
//     `judgeDeployLedger`;
//   · a header saying `|| true` appears in exactly one place, where grep found
//     several (the replacement then enumerated eight live sites and there were
//     eleven - see install-system-daemons.sh, which now carries a directive
//     this file re-runs instead of a number a reader has to trust);
//   · two docs describing a rule as it was BEFORE the commit that changed it -
//     one of them edited in that same commit;
//   · four new doctor checks whose "this is covered" framing was not coverage:
//     no test in the tree named them.
//
// Telling agents "do not write false comments" has not worked once in seven
// rounds. The structural reason is visible in that list: almost every rotted
// claim is about ANOTHER file's behaviour. A claim about the neighbour is
// unverifiable at the moment it is written and stops being true the moment the
// neighbour changes, with nothing in between to notice. A claim about the code
// directly beneath it cannot rot that way, because the next reader is looking
// at both.
//
// So this guard does not try to read English. It takes the part of a
// cross-file claim that is MECHANICAL - the name it cites - and checks that the
// name is real:
//
//   1. dangling-file        a comment/README cites `foo/bar.mjs` and no file in
//                           the repo is called that.
//   2. line-out-of-range    it cites `foo.ts:1900` and foo.ts has 800 lines.
//   3. dangling-identifier  it cites `someFunction` in backticks and no source
//                           line in the repo defines or uses that name.
//   4. claim-count          an author opted a quantity claim in ("exactly one
//                           place", "the four of them") into a grep the guard
//                           re-runs. See CLAIM_COUNT_RE below.
//
// A fifth check lives in claim-guard.test.ts because it needs no scanning:
// every finding code the doctor can emit must be named by some test.
//
// HOW IT RUNS
// -----------
// It is a vitest file (claim-guard.test.ts, in the `main` project's
// `test/**/*.test.ts` glob), so `pnpm test` runs it with everything else - no
// separate command, no flag, nothing for an operator or an agent to remember.
// It takes ~250ms, reads the tree through `git ls-files` (tracked AND untracked
// -- an unstaged file's comments are checked before they are committed, not
// after), and writes nothing anywhere.
//
// Each of the four checks has a companion assertion that fails when its input
// set is EMPTY, because the failure mode of a scanner is not a false alarm, it
// is a silent zero: no files scanned, no directives found, no finding codes
// parsed. All four were written after watching this check pass on nothing.
//
// WHAT IT CANNOT CATCH - stated plainly, because a guard that is believed to
// do more than it does is itself a false claim:
//
//   · a semantic claim whose every token exists. "The doctor turns a missing
//     step into an error" cites nothing misspelled; it is simply wrong. Only a
//     test pins that, which is why the round-7 fixes add tests rather than
//     only rewriting prose.
//   · a right name in the wrong place. Resolution is by BASENAME (see
//     resolveFileToken), so `packages/shared-types/http.ts` passes while the
//     real file is `packages/shared-types/src/http.ts`. Tightening this was
//     measured against the tree and rejected: it turns ~30 existing shorthand
//     references into failures without finding one real defect.
//   · a cited line number that exists but no longer holds what is described.
//     Only the "past the end of the file" case is decidable.
//   · a dead name inside a long comment that mentions a removal ANYWHERE in
//     it. REMOVAL_MARKERS are matched against the whole paragraph, and a
//     paragraph here is a whole header - the one you are reading is 90 lines
//     and contains "rather than", so every identifier in it is exempt.
//     Measured before shipping: scoping the marker to the sentence instead
//     found 9 more citations and all 9 were in this file's own examples, i.e.
//     zero real defects in the rest of the tree for a real false-alarm risk.
//     Left paragraph-scoped deliberately, and written down here because a
//     reader would otherwise assume the check is tighter than it is.
//   · a quantity claim nobody annotated. @claim-count is opt-in. Four
//     directives sit in install-system-daemons.sh - the script whose numbers
//     were wrong twice - and this line is the fifth, counting those four:
//         @claim-count 4 :: apps/openclaw-config/scripts/install-system-daemons.sh :: ^#\s*@claim-count\s
//     That is the whole coverage of this check today. A wrong number in any
//     other file is invisible to it, and saying so is the point of this list.
//   · commit messages. They are immutable once written, so a guard could only
//     report, never prevent - and the receipts it would check are the same
//     ones checked here in the tree.
//   · anything under docs/ or knowledge/. Those are dated records: a plan from
//     2026-07-14 legitimately names files that were later renamed or never
//     built, and rewriting them would falsify the record.
// ===========================================================================

export interface ClaimViolation {
  file: string;
  line: number;
  kind: "dangling-file" | "line-out-of-range" | "dangling-identifier" | "claim-count";
  token: string;
  detail: string;
}

/** Files whose COMMENTS are scanned for claims. */
const CLAIM_SOURCE_RE = /\.(?:ts|mts|cts|mjs|cjs|js|sh|md|json)$/u;

/** Files whose CODE supplies the names a claim is allowed to cite. */
const NAME_SOURCE_RE = /\.(?:ts|mts|cts|mjs|cjs|js|sh|json|txt|plist)$/u;

/** Dated records, deliberately left alone - see the header. */
function isHistoricalRecord(relativePath: string): boolean {
  return relativePath.startsWith("docs/") || relativePath.startsWith("knowledge/");
}

/**
 * The guard's own files are scanned for claims like everything else, but they
 * may not SUPPLY evidence.
 *
 * They talk about rotted references by quoting them (`judgeDeployAttempt` is in
 * this file's header, and in a scanner fixture next door), so leaving them in
 * the name corpus would let the guard's own examples vouch for the exact names
 * it exists to reject. That is the same shape as a comment vouching for itself,
 * caught here by construction rather than by remembering.
 *
 * 2026-07-29: exported, because the SAME hole was open in the other direction
 * and nobody noticed. claim-guard.test.ts's finding-code coverage check reads
 * every `*.test.ts` in the tree and asks whether each doctor finding code is
 * spelled somewhere in it - and its own list of KNOWN-UNCOVERED codes is
 * `*.test.ts` text. Every code in that list therefore matched itself, the
 * "uncovered" set came back empty, and a check whose entire job is to catch
 * "claimed coverage that is not coverage" was claiming coverage of 61 doctor
 * findings while 8 had no test at all. Excluding these two files from the
 * corpus is what makes the answer measured rather than circular.
 */
export const GUARD_OWN_FILES = new Set(["test/claim-guard.ts", "test/claim-guard.test.ts"]);

/**
 * A path-shaped token: `apps/openclaw-config/scripts/deploy.sh`,
 * `market-alerts-poll.mjs`, `notifications.ts:1918`.
 *
 * The lookbehind is what keeps an ELIDED path (`.../deploy.sh`, written when a
 * comment is quoting a long command) from being read as a real reference: the
 * candidate would start right after a `/`, which this refuses.
 */
const FILE_TOKEN_RE =
  /(?<![\w~/$.-])((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]+)*?\.(?:ts|mjs|sh))(?![A-Za-z0-9_])(?::(\d+))?/gu;

/** A backticked identifier: `judgeDeployLedger`, `isHandoverHealthy()`. */
const IDENT_TOKEN_RE = /`([a-z][A-Za-z0-9_]*)(?:\(\))?`/gu;

/**
 * The opt-in for quantity claims.
 *
 *     @claim-count <n> :: <repo-relative path> :: <JS regex source>
 *
 * The guard re-runs the regex over that file and fails if the number of
 * MATCHING LINES is not <n>. It exists because "exactly one place" and "the
 * two refusals above" were both false when round 6 counted them, and neither
 * was checkable by anything but a human re-running grep. Writing the grep next
 * to the sentence makes the sentence fail the suite when it stops being true.
 */
const CLAIM_COUNT_RE = /@claim-count\s+(\d+)\s*::\s*([^\s:][^:]*?)\s*::\s*(.+?)\s*$/u;

/**
 * Names a claim may cite without the repo defining them.
 *
 * Kept deliberately tiny and itemised - an allowlist is where a guard goes to
 * die, so every entry has to be a name that belongs to somebody else's code.
 */
const FOREIGN_IDENTIFIERS = new Map<string, string>([
  ["valueOf", "JS prototype member, discussed in scheduled-report.mjs's prototype-pollution note"],
  ["teardownErrors", "vitest internal (Vitest.close), quoted in test/global-setup.ts's swallow analysis"]
]);

/**
 * Cited names the repo deliberately does NOT have.
 *
 * Only for sentences whose POINT is the absence ("there is no dedicated
 * members-store.mjs"). A removal described in the past tense does not need an
 * entry here - REMOVAL_MARKERS covers that shape generically.
 */
const DELIBERATE_ABSENCES = new Set<string>([
  "apps/openclaw-config/scripts/members.mjs::members-store.mjs"
]);

/**
 * A claim can legitimately name something that is gone - that is what a
 * "this used to be X" note is FOR, and deleting those notes to satisfy a guard
 * would destroy the only record of why the code looks the way it does.
 *
 * Measured against the tree: these markers cover 5 of the 6 historical
 * references that exist today (`writeEnv`, `findRecentTicketId`,
 * `renderDisabledChip`, `applyPrivateCacheHeaders`, `extraScript`) and leave
 * the one real defect (`judgeDeployAttempt`) reported.
 */
const REMOVAL_MARKERS = [
  "used to",
  "no longer",
  "is gone",
  "are gone",
  "the old",
  "removed",
  "renamed",
  "instead of",
  "rather than",
  "there is no",
  "no such",
  "would have",
  "never existed",
  "did not exist"
];

export interface CommentSegment {
  line: number;
  /** Offset of this line's text inside its paragraph. */
  offset: number;
  text: string;
}

export interface CommentParagraph {
  text: string;
  segments: CommentSegment[];
}

export interface ScannedFile {
  path: string;
  paragraphs: CommentParagraph[];
  codeLines: string[];
}

function stripCommentMarkers(line: string, shellStyle: boolean): string {
  let text = line;
  text = text.replace(/^\s*\/\*+/u, "");
  text = text.replace(/^\s*\/\//u, "");
  text = text.replace(/^\s*\*(?!\/)/u, "");
  if (shellStyle) {
    text = text.replace(/^\s*#+/u, "");
  }
  return text;
}

/**
 * Splits a file into comment paragraphs and code lines.
 *
 * Line-oriented on purpose. A real tokenizer would also catch comments that
 * TRAIL code on the same line (`foo(); // note`), which this misses; it would
 * also drag in a parser per language for a corpus that is half shell and half
 * markdown. The claims this guard exists for are prose paragraphs, and prose
 * paragraphs start their own lines.
 *
 * Paragraph joining is not cosmetic: comments wrap, so a long module name split
 * across a line break is still ONE token. Read line by line, its tail looks
 * like a reference to a file that does not exist - 19 of them in this tree,
 * every one a false alarm, before the paragraphs were stitched back together.
 */
export function splitCommentsAndCode(relativePath: string, text: string): ScannedFile {
  const shellStyle = relativePath.endsWith(".sh");
  const markdown = relativePath.endsWith(".md");
  const paragraphs: CommentParagraph[] = [];
  const codeLines: string[] = [];

  if (markdown) {
    // Markdown here is operator documentation, written one claim per line and
    // never hard-wrapped mid-token, so joining would only blur line numbers.
    text.split("\n").forEach((line, index) => {
      paragraphs.push({ text: line, segments: [{ line: index + 1, offset: 0, text: line }] });
    });
    return { path: relativePath, paragraphs, codeLines };
  }

  let inBlock = false;
  let current: CommentSegment[] = [];

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    let text_ = "";
    const segments: CommentSegment[] = [];
    for (const segment of current) {
      const piece = segment.text;
      if (text_.length === 0) {
        segments.push({ ...segment, offset: 0 });
        text_ = piece.trimStart();
        continue;
      }
      // A line that ended mid-word (`market-alerts-`) is rejoined without a
      // separator; anything else gets one space.
      const glue = /[A-Za-z0-9]-$/u.test(text_) ? "" : " ";
      const offset = text_.length + glue.length;
      segments.push({ ...segment, offset });
      text_ = `${text_}${glue}${piece.trimStart()}`;
    }
    paragraphs.push({ text: text_, segments });
    current = [];
  };

  text.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();

    if (inBlock) {
      const end = line.indexOf("*/");
      const body = end >= 0 ? line.slice(0, end) : line;
      if (end >= 0) {
        inBlock = false;
      }
      current.push({ line: lineNumber, offset: 0, text: stripCommentMarkers(body, shellStyle) });
      if (end >= 0) {
        flush();
      }
      return;
    }

    if (trimmed.startsWith("/*")) {
      const openAt = line.indexOf("/*");
      const closeAt = line.indexOf("*/", openAt + 2);
      inBlock = closeAt < 0;
      const body = closeAt >= 0 ? line.slice(openAt, closeAt) : line;
      current.push({ line: lineNumber, offset: 0, text: stripCommentMarkers(body, shellStyle) });
      if (!inBlock) {
        flush();
      }
      return;
    }

    if (trimmed.startsWith("//") || (shellStyle && trimmed.startsWith("#"))) {
      current.push({ line: lineNumber, offset: 0, text: stripCommentMarkers(line, shellStyle) });
      return;
    }

    flush();
    codeLines.push(line);
  });

  flush();
  return { path: relativePath, paragraphs, codeLines };
}

function lineForOffset(paragraph: CommentParagraph, offset: number): number {
  let line = paragraph.segments[0]?.line ?? 1;
  for (const segment of paragraph.segments) {
    if (segment.offset <= offset) {
      line = segment.line;
    } else {
      break;
    }
  }
  return line;
}

export interface RepoIndex {
  root: string;
  files: string[];
  byBasename: Map<string, string[]>;
  /** Every identifier that appears on a non-comment line anywhere in the repo. */
  codeWords: Set<string>;
  scanned: ScannedFile[];
}

export function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("node_modules/"));
}

export function buildRepoIndex(root: string): RepoIndex {
  const files = trackedFiles(root);
  const byBasename = new Map<string, string[]>();
  for (const file of files) {
    const base = basename(file);
    const bucket = byBasename.get(base);
    if (bucket) {
      bucket.push(file);
    } else {
      byBasename.set(base, [file]);
    }
  }

  const codeWords = new Set<string>();
  const scanned: ScannedFile[] = [];

  for (const file of files) {
    const claimSource = CLAIM_SOURCE_RE.test(file) && !isHistoricalRecord(file);
    const nameSource = NAME_SOURCE_RE.test(file) && !GUARD_OWN_FILES.has(file);
    if (!claimSource && !nameSource) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const split = splitCommentsAndCode(file, text);
    if (claimSource) {
      scanned.push(split);
    }
    if (nameSource) {
      // Comment prose must never be able to vouch for a name: that is exactly
      // how `judgeDeployAttempt` would have vouched for itself.
      const body = CLAIM_SOURCE_RE.test(file) ? split.codeLines.join("\n") : text;
      for (const match of body.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)) {
        codeWords.add(match[0]);
      }
    }
  }

  return { root, files, byBasename, codeWords, scanned };
}

/**
 * Resolves a cited path to the files it could mean.
 *
 * Basename resolution, deliberately - see the header's "what it cannot catch".
 */
function resolveFileToken(index: RepoIndex, fromFile: string, token: string): string[] {
  const direct = index.files.filter((file) => file === token);
  if (direct.length > 0) {
    return direct;
  }
  const relative = join(dirname(fromFile), token).replace(/\\/gu, "/");
  const nearby = index.files.filter((file) => file === relative);
  if (nearby.length > 0) {
    return nearby;
  }
  const suffix = index.files.filter((file) => file.endsWith(`/${token}`));
  if (suffix.length > 0) {
    return suffix;
  }
  return index.byBasename.get(basename(token)) ?? [];
}

function skippableFileToken(token: string): boolean {
  return (
    token.endsWith(".d.ts") ||
    token.startsWith("dist/") ||
    token.includes("/dist/") ||
    token.includes("node_modules") ||
    token.endsWith("-.mjs") ||
    token.endsWith("-.ts") ||
    token.endsWith("-.sh")
  );
}

function mentionsRemoval(paragraphText: string): boolean {
  const lowered = paragraphText.toLowerCase();
  return REMOVAL_MARKERS.some((marker) => lowered.includes(marker));
}

const lineCountCache = new Map<string, number>();

function lineCount(root: string, relativePath: string): number {
  const cached = lineCountCache.get(relativePath);
  if (cached !== undefined) {
    return cached;
  }
  let count = 0;
  try {
    count = readFileSync(join(root, relativePath), "utf8").split("\n").length;
  } catch {
    count = 0;
  }
  lineCountCache.set(relativePath, count);
  return count;
}

export function checkFileReferences(index: RepoIndex): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  for (const file of index.scanned) {
    for (const paragraph of file.paragraphs) {
      for (const match of paragraph.text.matchAll(FILE_TOKEN_RE)) {
        const token = match[1] ?? "";
        if (skippableFileToken(token)) {
          continue;
        }
        if (DELIBERATE_ABSENCES.has(`${file.path}::${token}`)) {
          continue;
        }
        const line = lineForOffset(paragraph, match.index ?? 0);
        const candidates = resolveFileToken(index, file.path, token);
        if (candidates.length === 0) {
          if (mentionsRemoval(paragraph.text)) {
            continue;
          }
          violations.push({
            file: file.path,
            line,
            kind: "dangling-file",
            token,
            detail: `cites ${token}, and no file in the repo is called that`
          });
          continue;
        }
        const cited = match[2] ? Number(match[2]) : null;
        if (cited !== null) {
          const longest = Math.max(...candidates.map((candidate) => lineCount(index.root, candidate)));
          if (cited > longest) {
            violations.push({
              file: file.path,
              line,
              kind: "line-out-of-range",
              token: `${token}:${cited}`,
              detail: `cites line ${cited} of ${token}, which is ${longest} lines long`
            });
          }
        }
      }
    }
  }
  return violations;
}

export function checkIdentifierReferences(index: RepoIndex): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  for (const file of index.scanned) {
    for (const paragraph of file.paragraphs) {
      for (const match of paragraph.text.matchAll(IDENT_TOKEN_RE)) {
        const identifier = match[1] ?? "";
        // Short or all-lowercase words are ordinary prose in backticks (`ok`,
        // `warn`, `launchctl`), not a citation of a symbol.
        if (identifier.length < 5 || !/[A-Z]/u.test(identifier)) {
          continue;
        }
        if (index.codeWords.has(identifier) || FOREIGN_IDENTIFIERS.has(identifier)) {
          continue;
        }
        if (mentionsRemoval(paragraph.text)) {
          continue;
        }
        violations.push({
          file: file.path,
          line: lineForOffset(paragraph, match.index ?? 0),
          kind: "dangling-identifier",
          token: identifier,
          detail:
            `cites \`${identifier}\`, which no source line in the repo defines or uses. ` +
            `If it was removed, say so in the same paragraph (${REMOVAL_MARKERS.slice(0, 4).join(", ")}, …).`
        });
      }
    }
  }
  return violations;
}

export interface CountDirective {
  file: string;
  line: number;
  expected: number;
  target: string;
  pattern: string;
}

export function collectCountDirectives(index: RepoIndex): CountDirective[] {
  const directives: CountDirective[] = [];
  for (const file of index.scanned) {
    for (const paragraph of file.paragraphs) {
      for (const segment of paragraph.segments) {
        const match = CLAIM_COUNT_RE.exec(segment.text);
        if (!match) {
          continue;
        }
        directives.push({
          file: file.path,
          line: segment.line,
          expected: Number(match[1]),
          target: (match[2] ?? "").trim(),
          pattern: (match[3] ?? "").trim()
        });
      }
    }
  }
  return directives;
}

export function checkCountDirectives(index: RepoIndex): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  for (const directive of collectCountDirectives(index)) {
    const target = index.files.includes(directive.target)
      ? directive.target
      : (index.byBasename.get(basename(directive.target)) ?? [])[0];
    if (!target) {
      violations.push({
        file: directive.file,
        line: directive.line,
        kind: "claim-count",
        token: directive.target,
        detail: `@claim-count names ${directive.target}, which is not a file in this repo`
      });
      continue;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(directive.pattern, "u");
    } catch (error) {
      violations.push({
        file: directive.file,
        line: directive.line,
        kind: "claim-count",
        token: directive.pattern,
        detail: `@claim-count pattern does not compile: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }
    const matched = readFileSync(join(index.root, target), "utf8")
      .split("\n")
      .filter((line) => regex.test(line)).length;
    if (matched !== directive.expected) {
      violations.push({
        file: directive.file,
        line: directive.line,
        kind: "claim-count",
        token: directive.pattern,
        detail:
          `claims ${directive.expected} line(s) of ${target} match /${directive.pattern}/, ` +
          `but ${matched} do. Re-count and rewrite the sentence this directive belongs to.`
      });
    }
  }
  return violations;
}

export function formatViolations(violations: ClaimViolation[]): string {
  return violations.map((entry) => `  ${entry.file}:${entry.line}  [${entry.kind}] ${entry.detail}`).join("\n");
}

/**
 * Every finding code the doctor can emit, with `${...}` interpolations left in
 * place so the caller can decide how strictly to match them.
 */
export function declaredFindingCodes(root: string, relativePath: string): string[] {
  const text = readFileSync(join(root, relativePath), "utf8");
  const codes = new Set<string>();
  for (const match of text.matchAll(/\b(?:error|warn|info|severity)\(\s*(?:"([^"]+)"|`([^`]+)`)/gu)) {
    const code = match[1] ?? match[2];
    if (code) {
      codes.add(code);
    }
  }
  return [...codes].sort();
}

/**
 * The literal fragments of a finding code - the parts a test has to spell out.
 * `launchd-jobs.${job.slug}.crash_looping` yields `launchd-jobs.` and
 * `.crash_looping`, so a test naming a DIFFERENT launchd finding cannot vouch
 * for this one.
 */
export function findingCodeFragments(code: string): string[] {
  return code
    .split(/\$\{[^}]*\}/u)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.replace(/[^A-Za-z0-9_.]/gu, "").length >= 4);
}
