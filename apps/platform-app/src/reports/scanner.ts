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
  /** See ALL_CURRENT_REPORTS_ARE_LEGACY below. */
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

/**
 * Every report file scanReports can see today predates the public/personal
 * report split (P4 news engine / P5 confidence-tier writes) - the current
 * `reports/` tree is entirely 2026-05~06 material written before that format
 * existed, some of it (daily/weekly) embedding what was then a single shared
 * paper-trading account's positions. There is no per-file marker yet that
 * could distinguish "old format" from "new format" - P4 owns defining that
 * marker (frontmatter field or similar) when it starts writing the new
 * format. Until then, the simplest CORRECT rule is "everything is legacy",
 * encoded as this named constant (never a scattered `true` literal) so the
 * day P4 lands a real marker, this is the one place that needs to become a
 * per-file check instead of a blanket value.
 */
const ALL_CURRENT_REPORTS_ARE_LEGACY = true;

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

function extractTitle(mdPath: string, fallback: string): string {
  let content: string;
  try {
    content = readFileSync(mdPath, "utf8");
  } catch {
    return fallback;
  }
  for (const line of content.split(/\r?\n/u)) {
    const match = HEADING_RE.exec(line.trim());
    if (match) {
      return (match[1] ?? "").trim();
    }
  }
  return fallback;
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
    entries.push({
      type,
      date,
      mdPath,
      title: extractTitle(mdPath, fallbackTitle),
      legacy: ALL_CURRENT_REPORTS_ARE_LEGACY
    });
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
