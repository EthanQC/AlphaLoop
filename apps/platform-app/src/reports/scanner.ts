/**
 * Disk-backed report index for platform-app's report library (Task 4).
 *
 * DDL is frozen this phase (plan Global Constraints: "本阶段无迁移授权") -
 * there is no reports table. The index is built by scanning `reports/<type>`
 * on disk every time it is asked for, with a per-directory mtime cache so
 * repeated requests (e.g. every page load) don't re-stat and re-read every
 * markdown file's contents on every hit.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { detectReportFormatEra } from "./format-era.js";

/** The four report kinds this task scans. `official-paper` is the disk name
 * for what the UI labels "模拟盘快照" (see routes/reports.ts's TYPE_LABELS). */
export type ReportType = "daily" | "weekly" | "stock-analysis" | "official-paper";

/**
 * Report types whose ARTIFACTS ARE ONE MEMBER'S ACCOUNT STATEMENT rather than
 * circle-wide material. `reports/official-paper/<date>-post-open.md` is
 * renderPnlReport's output: 净资产 / 现金 / 持仓估值 / 持仓明细 of the paper
 * account it was fetched from (official-paper-monitor.mjs sendPnlReport).
 *
 * Defect B1 (2026-07-28 adversarial review) was exactly that these entries
 * came back from `scanReports` like any other report, so the /reports list
 * linked them and the reading page served them to any logged-in member. The
 * structural half of the fix lives here: `scanReports` NO LONGER RETURNS THEM
 * AT ALL. A surface that shows report material without resolving ownership
 * (routes/home.ts's latest-daily card, routes/stock.ts's analysis list, the
 * /reports library list) therefore cannot surface one by accident - the only
 * way to obtain these entries is `scanOwnerScopedReports`, whose single
 * caller (routes/reports.ts) resolves the artifact's owner first.
 */
export const OWNER_SCOPED_REPORT_TYPES: readonly ReportType[] = ["official-paper"];

export interface ReportIndexEntry {
  type: ReportType;
  /** `YYYY-MM-DD`, parsed from the filename. */
  date: string;
  /** Absolute path to the report's markdown source. */
  mdPath: string;
  /** First `# ` heading line in the file, else the filename (without ext). */
  title: string;
  /**
   * `true` ONLY when this file's own contents were read and found to LACK its
   * report family's current-format marker (reports/format-era.ts). It is a
   * positive, evidence-backed claim - every surface that renders 历史存档
   * keys off it - so the one case with no evidence either way (the file could
   * not be read at all) is `false`: no claim, no banner. See `scanDirectory`.
   */
  legacy: boolean;
}

const REPORT_TYPES: readonly ReportType[] = ["daily", "weekly", "stock-analysis", "official-paper"];

/** The types `scanReports` walks: every scannable type MINUS the owner-scoped
 * ones. Derived from the two lists above (never a third hand-written literal)
 * so adding a type to OWNER_SCOPED_REPORT_TYPES removes it from the
 * unrestricted scan in the same edit. */
const CIRCLE_VISIBLE_REPORT_TYPES: readonly ReportType[] = REPORT_TYPES.filter(
  (type) => !OWNER_SCOPED_REPORT_TYPES.includes(type)
);

const PLAIN_DATE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/u;
const OFFICIAL_PAPER_RE = /^(\d{4}-\d{2}-\d{2})-post-open\.md$/u;
const HEADING_RE = /^#\s+(.+)$/u;

interface DirCacheEntry {
  mtimeMs: number;
  entries: ReportIndexEntry[];
}

// Module-level, keyed by absolute directory path - safe across multiple
// scanReports(repoRoot) callers/repo roots because the key already includes
// the full path, and safe across test files because each test uses its own
// unique temp directory (mkdtempSync), never colliding with another test's
// key or with the real repo's reports/ directory.
const dirCache = new Map<string, DirCacheEntry>();

function parseFilename(type: ReportType, filename: string): string | undefined {
  if (filename === "README.md") {
    return undefined;
  }
  if (type === "official-paper") {
    return OFFICIAL_PAPER_RE.exec(filename)?.[1];
  }
  return PLAIN_DATE_RE.exec(filename)?.[1];
}

function extractTitle(content: string, fallback: string): string {
  for (const line of content.split(/\r?\n/u)) {
    const match = HEADING_RE.exec(line.trim());
    if (match) {
      return (match[1] ?? "").trim();
    }
  }
  return fallback;
}

/**
 * Title + era from ONE read of the file (Task 12). Both derive from the same
 * bytes, so reading twice would only create a window in which they could
 * disagree about the same file.
 *
 * Unreadable file -> filename as the title and `legacy: false`. `legacy` is
 * the positive claim "this file lacks its family's format marker", and a file
 * whose contents could not be read is not evidence for that claim (nor
 * against it); the honest response is to make no era claim at all, which is
 * what `false` renders as - no pill, no banner, no 旧格式 note.
 */
function readEntryMetadata(
  type: ReportType,
  mdPath: string,
  fallbackTitle: string
): { title: string; legacy: boolean } {
  let content: string;
  try {
    content = readFileSync(mdPath, "utf8");
  } catch {
    return { title: fallbackTitle, legacy: false };
  }
  return { title: extractTitle(content, fallbackTitle), legacy: detectReportFormatEra(type, content) === "legacy" };
}

function scanDirectory(repoRoot: string, type: ReportType): ReportIndexEntry[] {
  const dir = join(repoRoot, "reports", type);

  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch {
    // Directory doesn't exist (e.g. a repo checkout missing a report type) -
    // treat as empty rather than throwing; other report types may still be
    // scannable.
    dirCache.delete(dir);
    return [];
  }

  const cached = dirCache.get(dir);
  if (cached && cached.mtimeMs === dirStat.mtimeMs) {
    return cached.entries;
  }

  const entries: ReportIndexEntry[] = [];
  for (const filename of readdirSync(dir)) {
    const date = parseFilename(type, filename);
    if (!date) {
      continue;
    }
    const mdPath = join(dir, filename);
    const fallbackTitle = filename.replace(/\.md$/u, "");
    const { title, legacy } = readEntryMetadata(type, mdPath, fallbackTitle);
    entries.push({ type, date, mdPath, title, legacy });
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));
  dirCache.set(dir, { mtimeMs: dirStat.mtimeMs, entries });
  return entries;
}

function scanTypes(repoRoot: string, types: readonly ReportType[]): ReportIndexEntry[] {
  const all: ReportIndexEntry[] = [];
  for (const type of types) {
    all.push(...scanDirectory(repoRoot, type));
  }
  all.sort((a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type));
  return all;
}

/**
 * Scans the CIRCLE-VISIBLE report directories (`reports/{daily,weekly,
 * stock-analysis}`) under `repoRoot` and returns every recognized report,
 * newest first (ties broken by type name for determinism). `.pdf` siblings
 * are ignored outright (PDF is retired per plan Global Constraints) and
 * `README.md` is excluded from every directory.
 *
 * Deliberately EXCLUDES the owner-scoped types - see
 * OWNER_SCOPED_REPORT_TYPES above (defect B1). Callers that want those must
 * ask for them via `scanOwnerScopedReports` and gate them on ownership.
 */
export function scanReports(repoRoot: string): ReportIndexEntry[] {
  return scanTypes(repoRoot, CIRCLE_VISIBLE_REPORT_TYPES);
}

/**
 * Scans ONLY the owner-scoped report directories (`reports/official-paper`),
 * same entry shape and ordering as `scanReports`. Every entry returned here
 * is one member's account statement, so the caller MUST establish which member
 * each entry belongs to before rendering, listing or linking it (routes/
 * reports.ts's resolveOfficialPaperAttributions) - "identity-gated" is not
 * sufficient for this material.
 */
export function scanOwnerScopedReports(repoRoot: string): ReportIndexEntry[] {
  return scanTypes(repoRoot, OWNER_SCOPED_REPORT_TYPES);
}
