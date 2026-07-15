// Phase 5 Task 2 (2026-07-15 plan): the "结论框" (conclusion box) is the
// ONE structured, machine-parseable block embedded inside each per-symbol
// stock analysis section. Three different call sites need to read this
// exact same shape back out of rendered markdown - stock-analysis.mjs's own
// predictions-persistence step (parses its OWN rendered output straight
// into analysis_predictions rows, this task), report-quality.mjs's
// stock.conclusion_box gate (Task 4), and the platform stock.ts summary
// card (Task 5, via a fixture-tested TS port of this same parser) - so this
// module owns the render+parse+confidence-label mapping as the SINGLE
// source of truth. Three independently-written regexes for "the same
// thing" is exactly the seam this plan's Architecture section calls out as
// forbidden.
//
// Kept as a zero-dependency, pure-function module (no node: imports, no
// project imports, nothing but string/number logic) specifically so it
// stays portable: Task 5 either imports this .mjs directly from the
// platform app, or ports it verbatim to
// apps/platform-app/src/reports/conclusion-box.ts with a shared-fixture
// cross-check test - either path requires this file to never grow a
// dependency that would block it.

// Confidence is a closed three-value enum matching the DDL CHECK on
// analysis_predictions.confidence (packages/shared-types/src/database.ts's
// v1 migration - NOT reopened by this phase: outcome stays NULL here, the
// hit|miss|invalidated enum is reserved for P9). CONFIDENCE_LABELS is the
// SINGLE source for the Chinese label text rendered into the box; every
// other module that needs the label (or its reverse mapping) must import
// these two exports rather than re-declaring the mapping.
export const CONFIDENCE_LABELS = { high: "高", medium: "中", low: "低" };

const LABEL_TO_CONFIDENCE = Object.fromEntries(
  Object.entries(CONFIDENCE_LABELS).map(([confidence, label]) => [label, confidence])
);

// Reverse of CONFIDENCE_LABELS - returns undefined (never throws, never
// guesses a fallback) for anything that is not exactly one of 高/中/低,
// e.g. a corrupted or hand-edited "很高". parseConclusionBox below treats
// an undefined confidence as a missing/invalid required key (-> null).
export function confidenceFromLabel(label) {
  return LABEL_TO_CONFIDENCE[label];
}

const BOX_HEADING = "### 结论框";

// Fixed bullet keys, in render order - both renderConclusionBox and
// parseConclusionBox key off these same literal Chinese strings so the two
// can never drift into slightly different label text.
const KEYS = {
  coreConclusion: "核心结论",
  confidence: "置信度",
  valueRange: "合理价值区间",
  pricePosition: "当前价格位置",
  reviewTrigger: "复盘触发"
};

// renderConclusionBox({coreConclusion, confidence, valueRange:{low,high,basis},
// pricePosition, reviewTrigger, reviewDate}) -> fixed-bullet markdown block.
// `confidence` must be one of 'high'|'medium'|'low' (the enum, matching the
// DDL) - the RENDERED text uses the Chinese label via CONFIDENCE_LABELS;
// callers never hand-format the label themselves.
export function renderConclusionBox({ coreConclusion, confidence, valueRange, pricePosition, reviewTrigger, reviewDate }) {
  const label = CONFIDENCE_LABELS[confidence];
  const { low, high, basis } = valueRange ?? {};
  return [
    BOX_HEADING,
    "",
    `- ${KEYS.coreConclusion}：${coreConclusion}`,
    `- ${KEYS.confidence}：${label}`,
    `- ${KEYS.valueRange}：${formatValue(low)}–${formatValue(high)} 美元（依据：${basis}）`,
    `- ${KEYS.pricePosition}：${pricePosition}`,
    `- ${KEYS.reviewTrigger}：${reviewTrigger}（复盘日期：${reviewDate}）`
  ].join("\n");
}

function formatValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : String(value ?? "");
}

// Parses a rendered box back into the same shape renderConclusionBox takes,
// or null if EITHER the "### 结论框" heading itself, or any one of the five
// required bullets, is missing or fails its own sub-parse (bad confidence
// label, unparseable value range, missing review date) - per this task's
// "缺任一必填键→null，绝不猜" contract: a partially-parseable box (a
// hand-edited line, a truncated render, a stray '很高') must never be
// silently treated as "good enough" by a caller writing to
// analysis_predictions or rendering a summary card.
//
// `sectionMarkdown` may be a whole document, a whole `## SYMBOL` section, or
// just the box itself - only the substring from "### 结论框" up to the next
// heading (or end of string) is actually read. A document containing
// MULTIPLE boxes (multiple symbols) must be pre-scoped to one symbol's
// section by the caller first - this function always reads only the FIRST
// box it finds in the text handed to it.
export function parseConclusionBox(sectionMarkdown) {
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

function matchBullet(box, key) {
  const pattern = new RegExp(`^-\\s*${escapeRegExp(key)}：(.+)$`, "mu");
  const match = box.match(pattern);
  return match ? match[1].trim() : null;
}

// Accepts either an en dash ("–", what renderConclusionBox emits) or a
// plain hyphen between low/high, so a hand-edited or platform-normalized
// variant of the range separator still parses.
function parseValueRange(raw) {
  const match = raw.match(/^([\d.]+)[-–]([\d.]+)\s*美元（依据：(.+)）$/u);
  if (!match) {
    return null;
  }
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return null;
  }
  return { low, high, basis: match[3].trim() };
}

function parseReviewTrigger(raw) {
  const match = raw.match(/^(.+?)（复盘日期：(\d{4}-\d{2}-\d{2})）$/u);
  if (!match) {
    return null;
  }
  return { reviewTrigger: match[1].trim(), reviewDate: match[2] };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
