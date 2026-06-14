export function loadStockAnalysisTemplate() {
  return {
    language: "zh-CN",
    market: "US",
    delivery: "pdf-summary-card",
    source: "Feishu trading-chat history plus knowledge/notes/stock-trading-notes",
    sections: [
      {
        title: "标的基本信息",
        requirements: [
          "公司/ETF 名称、代码、交易所、行业、主营业务和市值区间。",
          "最新价格、近 180 日均线、估值位置、成交额和流动性。",
          "标注事实来源和数据时间，不把推断写成事实。"
        ]
      },
      {
        title: "投资逻辑",
        requirements: [
          "说明为什么现在值得看，区分短线交易逻辑和中期基本面逻辑。",
          "按用户定义检查是否便宜：相对 180 日均线、同行 PE/PB、或被低估的盈利潜力。",
          "给出多路径概率，而不是单线预测。"
        ]
      },
      {
        title: "基本面分析",
        requirements: [
          "业务稳定性、盈利能力、同类公司位置、用户粘性和现金流质量。",
          "结合财报、指引、管理层表态、监管/诉讼/税务/组织变化。",
          "明确哪些信息会改变企业基本面，哪些只是价格噪声。"
        ]
      },
      {
        title: "催化剂",
        requirements: [
          "未来三十天、一个季度、半年内可能影响价格的事件。",
          "财报、产品、宏观政策、行业景气、重要新闻和同类股票连带影响。",
          "说明每个催化剂的方向、概率和触发条件。"
        ]
      },
      {
        title: "风险点",
        requirements: [
          "基本面、估值、流动性、宏观、政策、财报和市场情绪风险。",
          "写清楚失效条件和需要停止跟踪/重新评估的信号。",
          "不得给出自动实盘执行建议。"
        ]
      },
      {
        title: "市场表现与交易层面",
        requirements: [
          "过去走势、趋势结构、成交量、资金流和相对纳指/标普表现。",
          "区分大单/主动卖压/做空比例，不用单一盘口现象证明做空。",
          "给出未来可能方向和关键观察点。"
        ]
      },
      {
        title: "期权交割与阻力支撑",
        requirements: [
          "列出关键支撑位、阻力位、前高/前低、均线和成交密集区。",
          "关注近期权利金集中、期权到期/交割前后的潜在钉仓、Gamma 或流动性影响。",
          "只做信息分析，不触发期权自动化。"
        ]
      },
      {
        title: "结论与复盘标签",
        requirements: [
          "给出看多/看空/中性结论、置信度、观察期限和下一次复盘条件。",
          "记录预测路径，后续用实际走势验证方向和原因。",
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
    "- 交付：PDF + 摘要卡片",
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
