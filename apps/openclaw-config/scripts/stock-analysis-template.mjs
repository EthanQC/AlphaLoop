import { REPORT_DELIVERY_DESCRIPTION } from "../../../packages/shared-types/dist/index.js";
import { STOCK_NEWS_SECTION_TITLE } from "./report-quality.mjs";

// 2026-07-30 - spec r2 §3.4 names the nine sections a per-symbol analysis must
// have: 报价技术面 / 估值 / 基本面 / 分析师与情绪 / 期权链只读 / 新闻事件 /
// 多路径推演 / 结论框[置信度三档] / 策略对照. Until this change the sections were
// still the 07-11 shape (标的基本信息 / 投资逻辑 / 基本面分析 / 催化剂 / 风险点 /
// 市场表现与交易层面 / 期权交割与阻力支撑 / 结论与复盘标签 / 近期新闻), which had
// no 估值 section at all (PE/PB/EPS were buried in the 基本面分析 narrative), no
// 分析师与情绪 section at all (the target price appeared only as an inline
// clause), and 多路径推演 as three bullets inside the conclusion section.
//
// Section 9 (策略对照) is deliberately NOT here: it is rendered per-viewer by the
// platform app, not by this batch renderer, because it compares the reader's own
// theses against the analysis and this markdown is one public document.
//
// Two titles deviate from the spec's shorthand, both for a mechanical reason:
//   - 结论与置信度, not "结论框". conclusion-box.mjs locates the structured box
//     with `indexOf("### 结论框")`, and that box is rendered INSIDE this section.
//     A section heading starting with the same literal would be found first, so
//     the slice would run from the section heading to the box heading, contain
//     none of the five required bullets, and parseConclusionBox would return
//     null - silently breaking the platform summary card, the
//     analysis_predictions rows and the stock.conclusion_box gate at once. The
//     spec's "[置信度三档]" is what the heading names instead.
//   - The news section's title is imported from report-quality.mjs rather than
//     typed here, because that module's news gates key on the same literal.
//
// ORDER MATTERS and is declared here, once: the news section sits sixth, between
// 期权链只读 and 多路径推演, per the spec's order. `kind: "news"` marks the one
// section whose body renderBatchStockAnalysis builds from the news feed instead
// of from a buildDeterministicAnalysis array - previously the news block was
// pushed in after the template loop had finished, which made the template unable
// to express where it goes.
export function loadStockAnalysisTemplate() {
  return {
    language: "zh-CN",
    market: "US",
    delivery: "conclusion-card-plus-platform-page",
    source: "Feishu trading-chat history plus knowledge/notes/stock-trading-notes",
    sections: [
      {
        title: "报价技术面",
        requirements: [
          "最新价格、涨跌幅、成交量、日内区间、开盘与前收，全部标注数据时点。",
          "趋势结构与均线（20/60/长窗口），窗口标签必须等于真实取到的样本长度。",
          "支撑位、阻力位与日内强弱；区分大单/主动卖压/做空比例，不用单一盘口现象证明做空。"
        ]
      },
      {
        title: "估值",
        requirements: [
          "PE/PB/EPS/市值/一年目标价逐项给出，缺失项写明不可得或不适用及原因。",
          "金额必须带来源自报的计价货币；无法核实货币的金额按不可得处理，不做汇率换算。",
          "便宜程度需要口径：相对长窗口均线、同行 PE/PB 分位、或被低估的盈利潜力。"
        ]
      },
      {
        title: "基本面",
        requirements: [
          "业务稳定性、盈利能力、同类公司位置、现金流质量与财报/指引口径。",
          "未来三十天、一个季度、半年内的催化剂：方向、触发条件与影响路径。",
          "明确哪些信息会改变企业基本面，哪些只是价格噪声；已验证与待验证分层列出。"
        ]
      },
      {
        title: "分析师与情绪",
        requirements: [
          "卖方评级分布与覆盖机构数，标注统计期与数据源实际解析到的上市地。",
          "一年目标价与目标价隐含空间；金额同样必须带已核实的计价货币。",
          "情绪只用可测代理（如 Put/Call 未平仓比、新闻条数）并明确标注是代理不是指数；未接入的情绪源按不可得点名。"
        ]
      },
      {
        title: "期权链只读",
        requirements: [
          "最近到期日的未平仓分布、钉仓与流动性影响，只读不执行。",
          "月度交割日前后的价格影响只作为现货波动因素。",
          "不执行、不模拟、不建议任何期权自动化。"
        ]
      },
      {
        kind: "news",
        title: STOCK_NEWS_SECTION_TITLE,
        requirements: [
          "多源新闻标题、媒体、发布时间与可点击链接，来源分布可核。",
          "券商源占比与中文源占比达标，链接可达。",
          "新闻只作为事件输入，不改写成结论。"
        ]
      },
      {
        title: "多路径推演",
        requirements: [
          "上行/震荡/回撤三条路径，各带触发价位与概率。",
          "概率口径必须自陈：是启发式还是模型概率，输入是什么。",
          "写清失效条件与需要停止跟踪/重新评估的信号；不得给出自动实盘执行建议。"
        ]
      },
      {
        title: "结论与置信度",
        requirements: [
          "给出看多/看空/中性结论、置信度三档、观察期限和下一次复盘条件。",
          "结论框为结构化必填块：核心结论/置信度/合理价值区间/当前价格位置/复盘触发。",
          "生成复盘标签，便于后续沉淀到 SQLite 和报告。"
        ]
      }
    ]
  };
}

export function renderStockAnalysisTemplateMarkdown(template = loadStockAnalysisTemplate()) {
  const lines = [
    "# 个股分析模板",
    "",
    "- 语言：中文",
    "- 市场：仅美股",
    `- 交付：${REPORT_DELIVERY_DESCRIPTION}`,
    "- 规则：事实、推断、预测必须分层；预测必须可复盘。",
    ""
  ];

  for (const [index, section] of template.sections.entries()) {
    lines.push(`## ${index + 1}. ${section.title}`, "");
    for (const item of section.requirements) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
