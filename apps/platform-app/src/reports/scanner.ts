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

/**
 * Scans `reports/{daily,weekly,stock-analysis,official-paper}` under
 * `repoRoot` and returns every recognized report, newest first (ties broken
 * by type name for determinism). `.pdf` siblings are ignored outright (PDF
 * is retired per plan Global Constraints) and `README.md` is excluded from
 * every directory.
 */
export function scanReports(repoRoot: string): ReportIndexEntry[] {
  const all: ReportIndexEntry[] = [];
  for (const type of REPORT_TYPES) {
    all.push(...scanDirectory(repoRoot, type));
  }
  all.sort((a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type));
  return all;
}
