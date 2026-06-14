import { normalizeSymbol, toNumber } from "./report-data.mjs";

const SOURCE_NAMES = {
  "longbridge-news": "Longbridge",
  "yahoo-finance-search": "Yahoo Finance",
  "yahoo-finance-rss": "Yahoo Finance"
};

const COMPANY_NAMES = new Map([
  ["APPLE", "苹果公司"],
  ["APPLE INC", "苹果公司"],
  ["MICROSOFT", "微软"],
  ["MICROSOFT CORP", "微软"],
  ["ALPHABET", "谷歌母公司 Alphabet"],
  ["GOOGLE", "谷歌"],
  ["AMAZON", "亚马逊"],
  ["NVIDIA", "英伟达"],
  ["TESLA", "特斯拉"],
  ["META", "Meta"],
  ["QQQ", "纳指 100 ETF"],
  ["NASDAQ", "纳斯达克"]
]);

export function normalizeYahooSearchNews(symbol, payload) {
  const rows = Array.isArray(payload?.news) ? payload.news : [];
  return rows
    .map((row) => normalizeYahooSearchArticle(symbol, row))
    .filter(Boolean);
}

export function mergeNewsArticles(articles) {
  const byKey = new Map();
  for (const rawArticle of articles.flat().filter(Boolean)) {
    const article = decorateNewsArticle(rawArticle);
    const key = newsIdentity(article);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...article,
        sourceEvidence: collectSourceEvidence(article)
      });
      continue;
    }

    const sourceEvidence = Array.from(new Set([
      ...(existing.sourceEvidence ?? collectSourceEvidence(existing)),
      ...collectSourceEvidence(article)
    ]));
    const preferred = preferRicherNewsArticle(existing, article);
    byKey.set(key, {
      ...existing,
      ...preferred,
      sourceEvidence,
      relatedTickers: Array.from(new Set([
        ...(existing.relatedTickers ?? []),
        ...(article.relatedTickers ?? [])
      ]))
    });
  }

  return Array.from(byKey.values())
    .sort((left, right) => (right.publishedAtMs ?? 0) - (left.publishedAtMs ?? 0));
}

export function selectDiverseNewsArticles(articles, limit = 6) {
  const max = Math.max(0, Number(limit) || 0);
  if (max === 0) {
    return [];
  }

  const ranked = mergeNewsArticles(Array.isArray(articles) ? articles : []);
  const selected = ranked.slice(0, max);
  if (selected.length === 0 || selected.some(hasNonLongbridgeEvidence)) {
    return selected;
  }

  const externalCandidate = ranked.find(hasNonLongbridgeEvidence);
  if (!externalCandidate) {
    return selected;
  }

  const externalKey = newsIdentity(externalCandidate);
  const withoutDuplicate = selected.filter((article) => newsIdentity(article) !== externalKey);
  const replacementIndex = withoutDuplicate.length >= max ? withoutDuplicate.length - 1 : withoutDuplicate.length;
  withoutDuplicate.splice(replacementIndex, withoutDuplicate.length >= max ? 1 : 0, externalCandidate);
  return withoutDuplicate
    .slice(0, max)
    .sort((left, right) => (right.publishedAtMs ?? 0) - (left.publishedAtMs ?? 0));
}

export function decorateNewsArticle(article) {
  const source = String(article?.source ?? "unknown-news").trim() || "unknown-news";
  const sourceName = article?.sourceName ?? SOURCE_NAMES[source] ?? source;
  const publisher = String(article?.publisher ?? article?.provider ?? article?.media ?? sourceName).trim();
  const title = singleLine(article?.title, 360);
  const summary = singleLine(article?.summary ?? article?.description ?? article?.contentSnippet ?? article?.content, 420);
  const publishedAtMs = Number.isFinite(article?.publishedAtMs)
    ? article.publishedAtMs
    : normalizeEpochMs(article?.publishedAt ?? article?.providerPublishTime ?? article?.time);
  const publishedAt = article?.publishedAt ?? new Date(publishedAtMs).toISOString();
  return {
    ...article,
    id: String(article?.id ?? article?.uuid ?? article?.url ?? title).trim(),
    symbol: normalizeSymbol(article?.symbol),
    title,
    summary,
    titleZh: article?.titleZh ?? translateFinancialHeadlineToChinese(title, article?.symbol),
    source,
    sourceName,
    publisher,
    url: String(article?.url ?? article?.link ?? "").trim(),
    publishedAt,
    publishedAtMs,
    relatedTickers: Array.isArray(article?.relatedTickers) ? article.relatedTickers.map(String) : []
  };
}

export function renderDetailedNewsLine(article, formatTime = defaultFormatTime) {
  const normalized = decorateNewsArticle(article);
  const impact = summarizeNewsImpact(normalized);
  const shouldShowOriginalTitle = !hasCjk(normalized.title)
    && (normalized.summary || /媒体报道与/u.test(normalized.titleZh));
  const pieces = [
    `- ${formatTime(normalized.publishedAt)} ${normalized.symbol || "市场"}：${normalized.titleZh}`,
    `媒体：${normalized.publisher || normalized.sourceName}`,
    `渠道：${normalized.sourceName}`,
    normalized.summary ? `标题要点：${summarizeNewsSnippetToChinese(normalized.summary)}` : null,
    shouldShowOriginalTitle ? `原始标题：${normalized.title}` : null,
    `影响：${impact}`,
    normalized.url ? `链接：${normalized.url}` : `来源索引：${normalized.source}:${normalized.id}`
  ].filter(Boolean);
  return `${pieces.join("；")}。`;
}

export function summarizeNewsSourceBreakdown(articles) {
  const counts = new Map();
  for (const article of articles.map(decorateNewsArticle)) {
    const label = article.publisher && article.publisher !== article.sourceName
      ? `${article.sourceName}/${article.publisher}`
      : article.sourceName;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => `${label} ${count} 条`)
    .join("；") || "暂无新闻来源";
}

export function translateFinancialHeadlineToChinese(title, symbol = "") {
  const text = singleLine(title, 360);
  if (!text || hasCjk(text)) {
    return text;
  }

  const company = resolveCompanyName(symbol, text);
  const cleaned = text
    .replace(/\s*\$[A-Z.]+\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  const acquirer = cleaned.match(/^(.+?)\s+Acquires?\s+New\s+Shares?\s+in\s+(.+?)$/iu);
  if (acquirer) {
    return `${cleanEntity(acquirer[1])} 新建或增持${resolveCompanyName(acquirer[2], cleaned)}持仓`;
  }

  const largestPosition = cleaned.match(/^(.+?)\s+is\s+(.+?)'s\s+\d*(?:st|nd|rd|th)?\s*Largest\s+Position/iu);
  if (largestPosition) {
    return `${resolveCompanyName(largestPosition[1], cleaned)} 成为 ${cleanEntity(largestPosition[2])} 的重要持仓`;
  }

  if (/price target|target price/iu.test(cleaned) && /raise|raises|raised|boost|lifts/iu.test(cleaned)) {
    return `华尔街分析师上调${company}目标价`;
  }
  if (/price target|target price/iu.test(cleaned) && /cut|lower|reduce|trim/iu.test(cleaned)) {
    return `华尔街分析师下调${company}目标价`;
  }
  if (/upgrade|upgraded/iu.test(cleaned)) {
    return `${company}评级被上调`;
  }
  if (/downgrade|downgraded/iu.test(cleaned)) {
    return `${company}评级被下调`;
  }
  if (/earnings|revenue|profit|guidance/iu.test(cleaned)) {
    return `${company} 业绩、收入或指引相关更新`;
  }
  if (/agentic ai|artificial intelligence|system-level ai|siri|ai\b/iu.test(cleaned)) {
    return `${company} 人工智能产品与增长叙事更新`;
  }
  if (/stock performance|compared to|technology stocks/iu.test(cleaned)) {
    return `${company} 相对科技板块表现对比`;
  }
  if (/launch|plans to launch|roll out|unveil/iu.test(cleaned)) {
    return `${company} 产品、交易机制或业务计划更新`;
  }
  if (/rises|rally|gains|jumps|surges/iu.test(cleaned)) {
    return `${company} 股价上涨或市场情绪改善`;
  }
  if (/falls|drops|slumps|declines|underperform/iu.test(cleaned)) {
    return `${company} 股价走弱或相对表现偏弱`;
  }
  if (/analyst|wall street/iu.test(cleaned)) {
    return `${company} 分析师观点更新`;
  }

  return `媒体报道与${company}相关的公司新闻`;
}

function normalizeYahooSearchArticle(symbol, row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const id = String(row.uuid ?? row.id ?? row.link ?? "").trim();
  const title = singleLine(row.title, 360);
  if (!id || !title) {
    return null;
  }
  const publishedAtMs = normalizeEpochMs(row.providerPublishTime ?? row.published_at ?? row.time);
  return decorateNewsArticle({
    id,
    symbol: normalizeSymbol(symbol),
    title,
    url: String(row.link ?? row.url ?? "").trim(),
    publishedAt: new Date(publishedAtMs).toISOString(),
    publishedAtMs,
    publisher: String(row.publisher ?? "Yahoo Finance").trim(),
    summary: singleLine(row.summary ?? row.description ?? "", 420),
    source: "yahoo-finance-search",
    sourceName: "Yahoo Finance",
    relatedTickers: Array.isArray(row.relatedTickers) ? row.relatedTickers.map(String) : []
  });
}

function preferRicherNewsArticle(left, right) {
  const leftScore = newsRichnessScore(left);
  const rightScore = newsRichnessScore(right);
  if (rightScore > leftScore) {
    return right;
  }
  if (rightScore === leftScore && (right.publishedAtMs ?? 0) > (left.publishedAtMs ?? 0)) {
    return right;
  }
  return left;
}

function newsRichnessScore(article) {
  return [
    article.url ? 3 : 0,
    article.publisher && article.publisher !== article.sourceName ? 2 : 0,
    article.titleZh && !/媒体报道与/u.test(article.titleZh) ? 2 : 0,
    article.relatedTickers?.length ? 1 : 0
  ].reduce((sum, value) => sum + value, 0);
}

function collectSourceEvidence(article) {
  return Array.from(new Set([
    String(article.source ?? "").trim(),
    ...(Array.isArray(article.sourceEvidence) ? article.sourceEvidence.map(String) : [])
  ].filter(Boolean)));
}

function hasNonLongbridgeEvidence(article) {
  return collectSourceEvidence(article).some((source) => source !== "longbridge-news");
}

function newsIdentity(article) {
  if (article.url) {
    return `url:${article.url.toLowerCase()}`;
  }
  return `title:${article.symbol}:${article.title.toLowerCase().replace(/\W+/gu, " ").trim()}`;
}

function summarizeNewsImpact(article) {
  const text = `${article.title} ${article.titleZh}`.toLowerCase();
  if (/earnings|revenue|profit|guidance|业绩|收入|利润|指引/u.test(text)) {
    return "可能影响盈利预期，需要核对公司公告和财报原文";
  }
  if (/ai|artificial intelligence|siri|人工智能/u.test(text)) {
    return "影响科技股增长叙事和估值情绪，需验证是否转化为收入";
  }
  if (/price target|analyst|upgrade|downgrade|目标价|评级|分析师/u.test(text)) {
    return "影响市场预期和短线估值锚，但不能单独作为交易触发";
  }
  if (/acquires new shares|largest position|持仓/u.test(text)) {
    return "反映机构持仓变化，需结合持仓规模和披露滞后性判断权重";
  }
  if (/rally|gains|rises|上涨|改善/u.test(text)) {
    return "偏利好风险偏好，但仍需成交量和基本面确认";
  }
  if (/falls|drops|declines|下调|走弱|偏弱/u.test(text)) {
    return "偏谨慎，观察是否扩散为基本面或行业风险";
  }
  return "作为新闻线索纳入观察，先不直接提高仓位";
}

function summarizeNewsSnippetToChinese(value) {
  const text = singleLine(value, 220);
  if (!text || hasCjk(text)) {
    return text;
  }

  if (/analysts?\s+cited\s+stronger\s+iphone\s+demand\s+and\s+services\s+growth/iu.test(text)) {
    return "分析师提到 iPhone 需求和服务业务增长";
  }
  if (/analysts?\s+said.+ai.+support.+services\s+revenue/iu.test(text)) {
    return "分析师认为新的 AI 功能可能支撑未来服务收入";
  }

  const topics = [];
  if (/analyst|wall street/iu.test(text)) {
    topics.push("分析师观点");
  }
  if (/iphone/iu.test(text)) {
    topics.push("iPhone 需求");
  }
  if (/services?/iu.test(text)) {
    topics.push("服务业务");
  }
  if (/\bai\b|artificial intelligence|siri/iu.test(text)) {
    topics.push("AI 产品");
  }
  if (/revenue|sales/iu.test(text)) {
    topics.push("收入");
  }
  if (/growth|stronger|improve|boost/iu.test(text)) {
    topics.push("增长或改善");
  }
  if (/demand/iu.test(text) && !topics.includes("iPhone 需求")) {
    topics.push("需求变化");
  }
  if (/price target|target price/iu.test(text)) {
    topics.push("目标价变化");
  }

  return topics.length > 0
    ? `摘要提到${Array.from(new Set(topics)).join("、")}`
    : "英文摘要已读取，需回到原文核对具体细节";
}

function resolveCompanyName(symbolOrName, text = "") {
  const candidates = [
    String(symbolOrName ?? "").replace(/\.US$/iu, ""),
    ...String(text ?? "").match(/[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,2}/gu) ?? []
  ];
  for (const candidate of candidates) {
    const key = candidate
      .replace(/\b(?:INC|CORP|CORPORATION|LLC|PLC|LTD)\b\.?/giu, "")
      .trim()
      .toUpperCase();
    if (COMPANY_NAMES.has(key)) {
      return COMPANY_NAMES.get(key);
    }
    if (key === "AAPL") {
      return "苹果公司";
    }
    if (key === "MSFT") {
      return "微软";
    }
    if (key === "NVDA") {
      return "英伟达";
    }
  }
  return normalizeSymbol(symbolOrName) || "该标的";
}

function cleanEntity(value) {
  return singleLine(value, 80)
    .replace(/\s*\$[A-Z.]+\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeEpochMs(value) {
  const number = toNumber(value);
  if (number !== undefined && number > 0) {
    return number > 10_000_000_000 ? number : number * 1000;
  }
  const parsed = new Date(String(value ?? "")).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function singleLine(value, maxChars = 260) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/u.test(String(value ?? ""));
}

function defaultFormatTime(value) {
  return new Date(String(value)).toISOString().slice(0, 16).replace("T", " ");
}
