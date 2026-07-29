import { normalizeMacroCalendarPayload } from "./report-data.mjs";

const EMPTY_MACRO_WARNING = "Longbridge 美国宏观日历在本窗口没有返回二星或三星事件";

export function normalizeReportMacroCalendarPayload(payload) {
  const entries = normalizeMacroCalendarPayload(payload);
  return {
    entries,
    warnings: entries.length === 0 ? [EMPTY_MACRO_WARNING] : []
  };
}

// ---------------------------------------------------------------------------
// 宏观日历行的中文化 (Task 23, 2026-07-30)
// ---------------------------------------------------------------------------
//
// VERIFIED AGAINST THE REAL PRODUCER, not assumed: the titles below are the
// literal `content` values Longbridge's US macro calendar returned in
// reports/daily/2026-07-30.md on the live mini, which rendered as
//
//   - 2026-07-30  美国 United States, Jobless Claims, National, Initial（Previous187 / Estimate200 / Actual--）
//
// i.e. an all-English indicator name in an otherwise all-Chinese report
// (Global Constraint: 用户可见文案中文), and value pairs glued together with
// no separator ("Previous187"), which reads as a single token.
//
// Two rules this module holds to:
//   1. A mapped indicator renders "中文名（English original）" - the English
//      is KEPT in parentheses because that is the string the reader will find
//      if they go look the release up.
//   2. An UNMAPPED indicator is never guessed at and never machine-mangled:
//      it renders `暂无中文名（英文原名：<original>）`, an explicit statement
//      that we do not have a translation for this one, which is the honest
//      alternative to silently printing English as if it were the label.
//
// The title Longbridge sends is prefixed with the country ("United States,
// ..."), and the report line already prints 美国 from `entry.market`, so the
// leading country clause is dropped to avoid saying it twice.

const COUNTRY_PREFIX_RE = /^(United States|USA|US)\s*,\s*/iu;

/** Longest-pattern-first: the four-week moving average of initial claims must
 * match before plain "Initial", and core PCE before plain PCE. Order in this
 * array IS the precedence - the first `match` that hits wins. */
const MACRO_LABEL_RULES = [
  { match: /Jobless Claims.*Initial.*four week moving average/iu, zh: "初请失业金人数四周移动均值" },
  { match: /Jobless Claims.*Continued/iu, zh: "续请失业金人数" },
  { match: /Jobless Claims.*Initial/iu, zh: "初请失业金人数" },
  { match: /Fed Funds Target Rate/iu, zh: "联邦基金目标利率" },
  { match: /Int On Excess Reserves/iu, zh: "超额准备金利率" },
  { match: /Policy Rates/iu, zh: "政策利率" },
  { match: /PCE prices.*excluding/iu, zh: "核心 PCE 物价指数" },
  { match: /Core PCE/iu, zh: "核心 PCE 物价指数" },
  { match: /PCE prices/iu, zh: "PCE 物价指数" },
  { match: /Personal Consumption Expenditure/iu, zh: "个人消费支出（PCE）" },
  { match: /Personal Income/iu, zh: "个人收入" },
  { match: /Implicit Price Deflator/iu, zh: "GDP 平减指数" },
  { match: /Gross Domestic Product|\bGDP\b/iu, zh: "国内生产总值（GDP）" },
  { match: /Consumer Price Index|\bCPI\b/iu, zh: "消费者物价指数（CPI）" },
  { match: /Producer Price Index|\bPPI\b/iu, zh: "生产者物价指数（PPI）" },
  { match: /Nonfarm Payroll|Non-farm Payroll/iu, zh: "非农就业人数" },
  { match: /Unemployment Rate/iu, zh: "失业率" },
  { match: /Average Hourly Earnings/iu, zh: "平均时薪" },
  { match: /Retail Sales/iu, zh: "零售销售" },
  { match: /Durable Goods/iu, zh: "耐用品订单" },
  { match: /Industrial Production/iu, zh: "工业产出" },
  { match: /Capacity Utilization/iu, zh: "产能利用率" },
  { match: /ISM.*(Non-Manufacturing|Services)/iu, zh: "ISM 非制造业指数" },
  { match: /ISM.*Manufacturing/iu, zh: "ISM 制造业指数" },
  { match: /Purchasing Managers|\bPMI\b/iu, zh: "采购经理人指数（PMI）" },
  { match: /Consumer Confidence/iu, zh: "消费者信心指数" },
  { match: /Michigan.*Sentiment|Consumer Sentiment/iu, zh: "密歇根大学消费者信心指数" },
  { match: /Housing Starts/iu, zh: "新屋开工" },
  { match: /Building Permits/iu, zh: "营建许可" },
  { match: /Existing Home Sales/iu, zh: "成屋销售" },
  { match: /New Home Sales/iu, zh: "新屋销售" },
  { match: /Trade Balance/iu, zh: "贸易帐" },
  { match: /Factory Orders/iu, zh: "工厂订单" },
  { match: /Crude Oil Inventories|Crude Oil Stocks/iu, zh: "原油库存" },
  { match: /Treasury.*(Auction|Bill|Note|Bond)/iu, zh: "美国国债发行" }
];

/** The exact prefix an untranslated indicator carries. Exported so the test
 * asserts the literal the renderer actually emits rather than a copy. */
export const UNMAPPED_MACRO_LABEL_PREFIX = "暂无中文名";

/**
 * `"United States, Jobless Claims, National, Initial"` ->
 * `"初请失业金人数（United States, Jobless Claims, National, Initial）"`.
 *
 * An unmapped title -> `"暂无中文名（英文原名：<original>）"`. An empty/absent
 * title returns "" - the caller decides what to do with a title-less row
 * rather than getting a fabricated label.
 */
export function localizeMacroTitle(title) {
  const original = String(title ?? "").replace(/\s+/gu, " ").trim();
  if (!original) {
    return "";
  }
  const searchable = original.replace(COUNTRY_PREFIX_RE, "");
  const rule = MACRO_LABEL_RULES.find((candidate) => candidate.match.test(searchable));
  return rule ? `${rule.zh}（${original}）` : `${UNMAPPED_MACRO_LABEL_PREFIX}（英文原名：${original}）`;
}

/** Longbridge's `data_kv` keys, as they arrive. Anything not listed keeps its
 * own key verbatim - guessing at an unknown key's meaning would be a
 * fabrication, and the raw key at least stays checkable. */
const MACRO_VALUE_KEY_LABELS = {
  previous: "前值",
  estimate: "预期",
  forecast: "预期",
  actual: "实际",
  revised: "修正值"
};

/**
 * `{key:"Previous", value:"3.625"}` -> `"前值 3.625"`.
 *
 * The old renderer concatenated key and value with NO separator
 * ("Previous3.625"), which reads as one token; the space is not cosmetic.
 */
export function formatMacroValuePair(pair) {
  const key = String(pair?.key ?? "").trim();
  const value = String(pair?.value ?? "").trim();
  if (!key || !value) {
    return "";
  }
  const label = MACRO_VALUE_KEY_LABELS[key.toLowerCase()] ?? key;
  return `${label} ${value}`;
}
