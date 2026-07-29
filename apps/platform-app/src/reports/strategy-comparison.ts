/**
 * §9 「我的策略对照」 of a stock-analysis reading page (req §3.4: "正文 1-8 段
 * 公共；第 9 段为登录者动态渲染「我的论点 vs 本次分析」（无论点显示引导）").
 *
 * The eight sections a stock-analysis report carries on disk are circle-wide
 * material; the ninth exists only per reader and only in this process. It is
 * built from the VIEWER'S OWN theses (`loadOwnTheses`, whose `owner_id = ?`
 * is in the WHERE clause) against the report's own `### 结论框` blocks. No
 * other member's thesis reaches this module - the route hands it one owner's
 * rows and there is no parameter through which a second owner's could arrive.
 *
 * WHY THE STANCE VOCABULARY IS WHAT IT IS - CHECKED AGAINST THE PRODUCER AND
 * AGAINST PRODUCTION BYTES, NOT ASSUMED. The 核心结论 line of every
 * stock-analysis box is written by `computeCoreConclusion`
 * (apps/openclaw-config/scripts/stock-analysis.mjs), which has three literal
 * templates and no others: 短线偏上行 / 短线偏回撤 / 短线震荡. Nothing it
 * emits contains 看多, 看空, 买入 or 卖出 - so a matcher keyed on those words
 * (which is what apps/openclaw-config/scripts/strategy.mjs's own
 * `inferDirectionFromConclusion` keys on) classifies EVERY real report as
 * neutral. That is the exact failure this module was written to avoid, so its
 * primary matcher is the producer's three literals - and rather than restate
 * those literals in a fixture this file's author wrote, strategy-comparison
 * .test.ts imports stock-analysis.mjs itself, runs `buildDeterministicAnalysis`
 * + `renderBatchStockAnalysis` to produce a real report, and asserts the
 * classification of the bytes THAT produced. A phrasing change on the producer
 * side fails this module's own test, with no fixture in between to go stale.
 *
 * The directional keyword set below is a SECONDARY matcher for a box that was
 * not written by that generator (a hand-edited or future report). It is tried
 * only after the three literals miss, and it refuses to guess when a text
 * carries both directions.
 *
 * NEVER SILENTLY DEGRADE (Global Constraints): every outcome this module can
 * produce that is NOT 一致/冲突 carries a `reason` string naming why, and the
 * page renders that reason. An unrecognisable box, an uncovered symbol and a
 * neutral thesis are three different facts and read as three different lines;
 * none of them is allowed to look like agreement.
 */
import { parseConclusionBox, type ConclusionBox } from "./conclusion-box.js";

/** The direction a run's 核心结论 takes on a symbol. */
export type ConclusionStance = "bull" | "bear" | "neutral";

/** The producer's three literal openings (stock-analysis.mjs
 * `computeCoreConclusion`), in the order it declares them. */
const STANCE_BY_PRODUCER_PREFIX: ReadonlyArray<readonly [string, ConclusionStance]> = [
  ["短线偏上行", "bull"],
  ["短线偏回撤", "bear"],
  ["短线震荡", "neutral"]
];

/** Secondary matcher - see the module header. Same word lists
 * strategy.mjs's `inferDirectionFromConclusion` uses, so a box those two
 * disagree about does not exist. */
const BULL_KEYWORDS = ["看多", "看涨", "买入", "增持", "做多"] as const;
const BEAR_KEYWORDS = ["看空", "看跌", "卖出", "减持", "做空"] as const;

/**
 * Classifies a 核心结论 line, or returns `null` when its wording carries no
 * determinable direction - never a fabricated "neutral", because "the report
 * says hold" and "we could not read the report" are different statements and
 * the page prints them differently.
 */
export function inferConclusionStance(coreConclusion: string): ConclusionStance | null {
  const text = String(coreConclusion ?? "");
  for (const [prefix, stance] of STANCE_BY_PRODUCER_PREFIX) {
    if (text.includes(prefix)) {
      return stance;
    }
  }
  const bull = BULL_KEYWORDS.some((keyword) => text.includes(keyword));
  const bear = BEAR_KEYWORDS.some((keyword) => text.includes(keyword));
  if (bull && bear) {
    return null;
  }
  if (bull) {
    return "bull";
  }
  if (bear) {
    return "bear";
  }
  return null;
}

/** The thesis fields this comparison reads. A structural subset of
 * data/strategy.ts's `ThesisEvidenceRow` so this module stays pure and the
 * route does the loading. */
export interface ComparableThesis {
  id: string;
  symbol: string;
  direction: "bull" | "bear" | "neutral";
  targetLow: number | null;
  targetHigh: number | null;
  invalidationPrice: number | null;
  visibility: "system" | "public";
}

export type ComparisonVerdict = "aligned" | "conflict" | "none";

export interface ThesisComparison {
  thesisId: string;
  symbol: string;
  verdict: ComparisonVerdict;
  /** Always non-empty. For `none` it is the disclosure of WHY there is no
   * comparison; for the other two it is the sentence the reader is shown. */
  reason: string;
  /** The run's stance where it could be read; `null` otherwise. */
  reportStance: ConclusionStance | null;
  /** The run's box, when this symbol had a parseable one. */
  box: ConclusionBox | null;
  /** Target-range vs 合理价值区间, when BOTH exist; `null` when either side
   * is unset (a thesis may legally have no target range - the column is
   * nullable). */
  rangeNote: string | null;
}

const STANCE_TEXT: Record<ConclusionStance, string> = {
  bull: "看多",
  bear: "看空",
  neutral: "震荡观望"
};

const DIRECTION_TEXT: Record<ComparableThesis["direction"], string> = {
  bull: "看多",
  bear: "看空",
  neutral: "中性"
};

/**
 * Slices a whole stock-analysis document down to ONE `## <SYMBOL>` section.
 *
 * Heading line equal to `## <symbol>`, body up to the next `## `. A report
 * carries several boxes and `parseConclusionBox` reads the FIRST one it is
 * given, so a caller that skips this step would compare every symbol against
 * the first symbol's verdict. routes/stock.ts's summary card had its own
 * copy of this function and now imports this one - two implementations of
 * "which bytes belong to this symbol" is a drift seam nothing was watching.
 */
export function findSymbolSection(markdown: string, symbol: string): string | null {
  const lines = String(markdown ?? "").replace(/\r\n/gu, "\n").split("\n");
  const heading = `## ${symbol}`;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === heading) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/u.test((lines[i] ?? "").trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Same charset routes/stock.ts's `SYMBOL_CHARSET_RE` accepts. */
const SYMBOL_HEADING_RE = /^##\s+([A-Z0-9.-]+)\s*$/u;

/**
 * The symbols a stock-analysis document actually analysed.
 *
 * A `## ` heading is not proof of a symbol section - `renderBatchStockAnalysis`
 * opens every report with a `## 本批次结论` summary heading. The evidence used
 * here is the section's own content: a symbol section is one whose heading is
 * symbol-shaped AND which contains a `### 结论框` block, which is the very
 * thing this comparison reads. Nothing is inferred from the heading alone.
 */
export function listAnalysedSymbols(markdown: string): string[] {
  const lines = String(markdown ?? "").replace(/\r\n/gu, "\n").split("\n");
  const symbols: string[] = [];
  for (const line of lines) {
    const match = SYMBOL_HEADING_RE.exec(line.trim());
    if (!match) {
      continue;
    }
    const symbol = match[1] ?? "";
    const section = findSymbolSection(markdown, symbol);
    if (section !== null && section.includes("### 结论框")) {
      symbols.push(symbol);
    }
  }
  return symbols;
}

function describeRange(low: number, high: number): string {
  return `${low.toFixed(2)}–${high.toFixed(2)}`;
}

function buildRangeNote(thesis: ComparableThesis, box: ConclusionBox): string | null {
  if (thesis.targetLow === null || thesis.targetHigh === null) {
    return null;
  }
  const thesisLow = Math.min(thesis.targetLow, thesis.targetHigh);
  const thesisHigh = Math.max(thesis.targetLow, thesis.targetHigh);
  const boxLow = Math.min(box.valueRange.low, box.valueRange.high);
  const boxHigh = Math.max(box.valueRange.low, box.valueRange.high);
  const overlaps = thesisLow <= boxHigh && boxLow <= thesisHigh;
  const mine = describeRange(thesisLow, thesisHigh);
  const theirs = describeRange(boxLow, boxHigh);
  return overlaps
    ? `你的目标区间 ${mine} 与本次合理价值区间 ${theirs} 有重叠。`
    : `你的目标区间 ${mine} 完全落在本次合理价值区间 ${theirs} 之外。`;
}

/**
 * Compares ONE of the viewer's theses against this run's section for the same
 * symbol. `section` is `null` when the run did not analyse that symbol.
 */
export function compareThesisWithSection(
  thesis: ComparableThesis,
  section: string | null
): ThesisComparison {
  const base = { thesisId: thesis.id, symbol: thesis.symbol, box: null, reportStance: null, rangeNote: null };

  if (section === null) {
    return {
      ...base,
      verdict: "none",
      reason: `本次批次没有分析 ${thesis.symbol}，无从对照（个股分析按标的池并集分批生产，把它加入标的池后下一轮会覆盖）。`
    };
  }

  const box = parseConclusionBox(section);
  if (!box) {
    return {
      ...base,
      verdict: "none",
      reason: `本次 ${thesis.symbol} 段的结论框缺少必填项、未能解析，不拿它做对照。`
    };
  }

  const stance = inferConclusionStance(box.coreConclusion);
  const rangeNote = buildRangeNote(thesis, box);
  const withBox = { ...base, box, reportStance: stance, rangeNote };

  if (stance === null) {
    return {
      ...withBox,
      verdict: "none",
      reason: "本次核心结论没有用可判定方向的措辞，不替它猜方向。"
    };
  }
  if (thesis.direction === "neutral") {
    return {
      ...withBox,
      verdict: "none",
      reason: `你这条论点记的是中性，本次结论是${STANCE_TEXT[stance]}，两者不构成一致或冲突。`
    };
  }
  if (stance === "neutral") {
    return {
      ...withBox,
      verdict: "none",
      reason: `本次结论是短线震荡，与你的${DIRECTION_TEXT[thesis.direction]}论点不构成一致或冲突。`
    };
  }

  return stance === thesis.direction
    ? {
        ...withBox,
        verdict: "aligned",
        reason: `你${DIRECTION_TEXT[thesis.direction]}，本次结论也是${STANCE_TEXT[stance]}。`
      }
    : {
        ...withBox,
        verdict: "conflict",
        reason: `你${DIRECTION_TEXT[thesis.direction]}，本次结论是${STANCE_TEXT[stance]}。`
      };
}

/**
 * The whole §9 for one viewer: one row per own thesis, symbols this run
 * analysed first (in the run's own order), the rest after.
 */
export function compareThesesWithReport(
  theses: readonly ComparableThesis[],
  markdown: string
): ThesisComparison[] {
  const analysed = listAnalysedSymbols(markdown);
  const order = new Map(analysed.map((symbol, index) => [symbol, index]));
  const sectionCache = new Map<string, string | null>();
  const sectionFor = (symbol: string): string | null => {
    if (!sectionCache.has(symbol)) {
      sectionCache.set(symbol, order.has(symbol) ? findSymbolSection(markdown, symbol) : null);
    }
    return sectionCache.get(symbol) ?? null;
  };

  return [...theses]
    .sort((a, b) => (order.get(a.symbol) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.symbol) ?? Number.MAX_SAFE_INTEGER))
    .map((thesis) => compareThesisWithSection(thesis, sectionFor(thesis.symbol)));
}
