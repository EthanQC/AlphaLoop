/**
 * TS port of apps/openclaw-config/scripts/conclusion-box.mjs's
 * `parseConclusionBox` + `CONFIDENCE_LABELS` (Phase 5 Task 5, 2026-07-15
 * plan). That .mjs file is the SINGLE source of truth for the "### 结论框"
 * render+parse+confidence-label contract - three independent call sites read
 * this exact shape back out of rendered markdown: stock-analysis.mjs's own
 * predictions-persistence step, report-quality.mjs's `stock.conclusion_box`
 * gate, and (via this file) the platform's `/stock/<code>` summary card.
 *
 * This is a from-scratch RE-IMPLEMENTATION, NOT an import: apps/openclaw-
 * config/scripts is plain .mjs with no build step/dist of its own, and this
 * codebase's established convention (P3; see data/news.ts's own doc comment,
 * and routes/stock.ts's `normalizeStockSymbol` re-declaring report-data.mjs's
 * `normalizeSymbol`) is to re-declare a source-of-truth shape/parser locally
 * with a comment pointing back at the original, rather than reach across an
 * app boundary. Only `parseConclusionBox` + `CONFIDENCE_LABELS` (+ the small
 * `confidenceFromLabel` reverse map it needs internally) are ported -
 * `renderConclusionBox` is NOT, because the platform never renders a new box,
 * only ever reads one back out of an already-rendered report.
 *
 * ANTI-DRIFT: any change to conclusion-box.mjs's bullet keys, heading text,
 * value-range/review-trigger sub-parse regexes, or null-on-missing-key
 * contract MUST be mirrored here (or vice versa). The shared fixture at
 * apps/openclaw-config/scripts/__fixtures__/conclusion-box-samples.json is
 * read by BOTH sides' test suites (conclusion-box.test.ts there,
 * conclusion-box.test.ts here) and asserts they parse the exact same inputs
 * to the exact same outputs - that test is the enforcement mechanism for
 * this comment, not just documentation of intent.
 */

export type ConfidenceTier = "high" | "medium" | "low";

export interface ConclusionBoxValueRange {
  low: number;
  high: number;
  basis: string;
}

export interface ConclusionBox {
  coreConclusion: string;
  confidence: ConfidenceTier;
  valueRange: ConclusionBoxValueRange;
  pricePosition: string;
  reviewTrigger: string;
  reviewDate: string;
}

// Single source for the Chinese label text - matches conclusion-box.mjs's
// own CONFIDENCE_LABELS export exactly (DDL CHECK on analysis_predictions.
// confidence, packages/shared-types/src/database.ts's v1 migration).
export const CONFIDENCE_LABELS: Record<ConfidenceTier, string> = { high: "高", medium: "中", low: "低" };

const LABEL_TO_CONFIDENCE: Record<string, ConfidenceTier> = Object.fromEntries(
  (Object.entries(CONFIDENCE_LABELS) as Array<[ConfidenceTier, string]>).map(([confidence, label]) => [label, confidence])
);

/** Reverse of CONFIDENCE_LABELS - returns undefined (never throws, never
 * guesses) for anything that is not exactly one of 高/中/低. */
export function confidenceFromLabel(label: string): ConfidenceTier | undefined {
  return LABEL_TO_CONFIDENCE[label];
}

const BOX_HEADING = "### 结论框";

// Fixed bullet keys, in render order - mirrors conclusion-box.mjs's KEYS
// object exactly. Both parsers key off these same literal Chinese strings.
const KEYS = {
  coreConclusion: "核心结论",
  confidence: "置信度",
  valueRange: "合理价值区间",
  pricePosition: "当前价格位置",
  reviewTrigger: "复盘触发"
} as const;

/**
 * Parses a rendered "### 结论框" block back into a structured object, or
 * `null` if EITHER the heading itself, or any one of the five required
 * bullets, is missing or fails its own sub-parse - "缺任一必填键→null，绝不猜"
 * (mirrors conclusion-box.mjs's parseConclusionBox contract exactly).
 *
 * `sectionMarkdown` may be a whole document, a whole `## SYMBOL` section, or
 * just the box itself - only the substring from "### 结论框" up to the next
 * heading (or end of string) is read. A document containing MULTIPLE boxes
 * must be pre-scoped to one symbol's section by the caller first (this
 * platform does that via routes/stock.ts's own findSymbolSection) - this
 * function always reads only the FIRST box it finds.
 */
export function parseConclusionBox(sectionMarkdown: string): ConclusionBox | null {
  const text = String(sectionMarkdown ?? "");
  const headingIndex = text.indexOf(BOX_HEADING);
  if (headingIndex === -1) {
    return null;
  }

  const afterHeading = text.slice(headingIndex + BOX_HEADING.length);
  const nextHeadingMatch = afterHeading.match(/\n#{1,6}\s+/u);
  const box = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;

  const coreConclusion = matchBullet(box, KEYS.coreConclusion);
  const confidenceLabel = matchBullet(box, KEYS.confidence);
  const valueRangeRaw = matchBullet(box, KEYS.valueRange);
  const pricePosition = matchBullet(box, KEYS.pricePosition);
  const reviewTriggerRaw = matchBullet(box, KEYS.reviewTrigger);

  if (
    coreConclusion === null ||
    confidenceLabel === null ||
    valueRangeRaw === null ||
    pricePosition === null ||
    reviewTriggerRaw === null
  ) {
    return null;
  }

  const confidence = confidenceFromLabel(confidenceLabel);
  if (!confidence) {
    return null;
  }

  const valueRange = parseValueRange(valueRangeRaw);
  if (!valueRange) {
    return null;
  }

  const reviewTriggerParsed = parseReviewTrigger(reviewTriggerRaw);
  if (!reviewTriggerParsed) {
    return null;
  }

  return {
    coreConclusion,
    confidence,
    valueRange,
    pricePosition,
    reviewTrigger: reviewTriggerParsed.reviewTrigger,
    reviewDate: reviewTriggerParsed.reviewDate
  };
}

function matchBullet(box: string, key: string): string | null {
  const pattern = new RegExp(`^-\\s*${escapeRegExp(key)}：(.+)$`, "mu");
  const match = box.match(pattern);
  return match ? (match[1] ?? "").trim() : null;
}

// Accepts either an en dash ("–") or a plain hyphen between low/high, same
// as conclusion-box.mjs's parseValueRange.
function parseValueRange(raw: string): ConclusionBoxValueRange | null {
  const match = raw.match(/^([\d.]+)[-–]([\d.]+)\s*美元（依据：(.+)）$/u);
  if (!match) {
    return null;
  }
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return null;
  }
  return { low, high, basis: (match[3] ?? "").trim() };
}

function parseReviewTrigger(raw: string): { reviewTrigger: string; reviewDate: string } | null {
  const match = raw.match(/^(.+?)（复盘日期：(\d{4}-\d{2}-\d{2})）$/u);
  if (!match) {
    return null;
  }
  return { reviewTrigger: (match[1] ?? "").trim(), reviewDate: match[2] ?? "" };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
