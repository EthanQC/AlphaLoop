import { normalizeSymbol, toNumber } from "./report-data.mjs";

const SOURCE_NAMES = {
  "longbridge-news": "Longbridge",
  "yahoo-finance-search": "Yahoo Finance",
  "yahoo-finance-rss": "Yahoo Finance",
  "google-news-rss": "Google News",
  "bing-news-rss": "Bing News"
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

export function normalizeExternalRssNews(symbol, xml, options = {}) {
  const source = String(options.source ?? "external-rss").trim();
  const sourceName = String(options.sourceName ?? SOURCE_NAMES[source] ?? source).trim();
  return Array.from(String(xml ?? "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu))
    .map((match, index) => {
      const item = match[1];
      const title = xmlText(extractXmlTag(item, "title"));
      const url = xmlText(extractXmlTag(item, "link"));
      const publisher = xmlText(extractXmlTag(item, "source") || extractXmlTag(item, "dc:creator")) || sourceName;
      const summary = xmlText(extractXmlTag(item, "description"));
      const publishedAtRaw = xmlText(extractXmlTag(item, "pubDate") || extractXmlTag(item, "published"));
      const publishedAtMs = normalizeEpochMs(publishedAtRaw);
      if (!title || !url) {
        return null;
      }
      return decorateNewsArticle({
        id: `${source}:${url || title}:${index}`,
        symbol,
        title,
        url,
        publishedAt: new Date(publishedAtMs).toISOString(),
        publishedAtMs,
        publisher,
        summary,
        source,
        sourceName
      });
    })
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
  const shouldShowOriginalTitle = !hasCjk(normalized.title);
  const titlePoint = summarizeDetailedNewsPoint(normalized);
  const pieces = [
    `- ${formatTime(normalized.publishedAt)} ${normalized.symbol || "市场"}：${normalized.titleZh}`,
    `媒体：${normalized.publisher || normalized.sourceName}`,
    `渠道：${normalized.sourceName}`,
    `标题要点：${titlePoint}`,
    shouldShowOriginalTitle ? `原始标题：${normalized.title}` : null,
    `影响：${impact}`,
    normalized.url ? `链接：${normalized.url}` : `来源索引：${normalized.source}:${normalized.id}`
  ].filter(Boolean);
  return `${pieces.join("；")}。`;
}

function summarizeDetailedNewsPoint(article) {
  const combined = `${article.summary ?? ""} ${article.title ?? ""}`.trim();
  const firstPass = summarizeNewsSnippetToChinese(combined);
  if (firstPass && !/英文摘要已读取|需回到原文核对具体细节|英文来源摘要未提供可抽取细节/u.test(firstPass)) {
    return firstPass;
  }
  return summarizeNewsSnippetToChinese(article.title) || firstPass;
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

  const positionIncrease = cleaned.match(/^(.+?)\s+(?:Increases?|Raises?|Boosts?)\s+Position\s+in\s+(.+?)(?:\s+\$[A-Z.]+)?$/iu);
  if (positionIncrease) {
    return `${cleanEntity(positionIncrease[1])} 增持${resolveCompanyName(positionIncrease[2], cleaned)}持仓`;
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
  if (/agentic ai|artificial intelligence|system-level ai|siri|\bai\b/iu.test(cleaned)) {
    return `${company} 人工智能产品与增长叙事更新`;
  }
  if (/stock performance|compared to|technology stocks/iu.test(cleaned)) {
    return `${company} 相对科技板块表现对比`;
  }
  if (/week in review|marketbeat/iu.test(cleaned)) {
    return "美股周度复盘和风险偏好变化";
  }
  if (/productive conversation|council president|president costa|officials?/iu.test(cleaned)) {
    return "政策官员沟通和地缘风险线索";
  }
  if (/iphone parts factory|contaminated|pollution|farmland water/iu.test(cleaned)) {
    return `${company}供应链环保与监管风险`;
  }
  if (/stock double|double to|\$\d+|5 years?/iu.test(cleaned) && /stock|shares?/iu.test(cleaned)) {
    return `${company}长期上涨空间和估值讨论`;
  }
  if (/stock market week ahead|week ahead/iu.test(cleaned) && /fed|rate|rates|inflation/iu.test(cleaned)) {
    return "美股下周关注美联储、利率和风险偏好变化";
  }
  if (/stock market week ahead|week ahead/iu.test(cleaned)) {
    return "美股下周关注财报、宏观数据和板块轮动";
  }
  if (/nasdaq|s&p 500|dow|stocks?/iu.test(cleaned) && /rall(?:y|ies)|gains?|higher|blast off/iu.test(cleaned)) {
    return "美股和纳指上涨，风险偏好改善";
  }
  if (/fed/iu.test(cleaned) && /tech.*sell-off|sell-off.*tech|sharp.*sell-off/iu.test(cleaned)) {
    return "美联储相关利率预期引发科技板块调整讨论";
  }
  if (/chip|semiconductor/iu.test(cleaned) && /\bai\b|artificial intelligence/iu.test(cleaned)) {
    return "芯片需求和 AI 资本开支支撑科技龙头";
  }
  if (/tokeni[sz]ed|on-chain|uniswap|crypto/iu.test(cleaned)) {
    return "科技股代币化交易与链上化讨论";
  }
  if (/anthropic|claude/iu.test(cleaned)) {
    return "Anthropic/Claude 模型访问调整影响 AI 生态线索";
  }
  if (/peace signals?|truce|iran|middle east/iu.test(cleaned) && /s&p|nasdaq|dow|stocks?/iu.test(cleaned)) {
    return "美股上涨与地缘风险缓和信号";
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

  return `${company}新闻：${summarizeEnglishHeadlineTopics(cleaned)}`;
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
  if (/anthropic|claude/iu.test(text) && !topics.includes("AI 产品")) {
    topics.push("AI 产品");
  }
  if (/stock market|stocks?|nasdaq|s&p 500|dow|week ahead|blast off|rall(?:y|ies)|higher/iu.test(text)) {
    topics.push("美股风险偏好");
  }
  if (/revenue|sales/iu.test(text)) {
    topics.push("收入");
  }
  if (/record high|all-time high|valuation|expensive|buy/iu.test(text)) {
    topics.push("估值位置和追高风险");
  }
  if (/qqq|nasdaq-100|nasdaq 100|etf|expense ratio|fee|17%\s+less/iu.test(text)) {
    topics.push("QQQ 或纳指 100 ETF");
  }
  if (/spacex|ipo/iu.test(text)) {
    topics.push("SpaceX 或 IPO 曝光");
  }
  if (/week in review|marketbeat/iu.test(text)) {
    topics.push("市场周度复盘");
  }
  if (/productive conversation|council president|president costa|officials?/iu.test(text)) {
    topics.push("政策官员沟通");
  }
  if (/increases? position|raises? position|boosts? position|stake|holdings?/iu.test(text)) {
    topics.push("机构持仓变化");
  }
  if (/iphone parts factory|contaminated|pollution|farmland water|factory/iu.test(text)) {
    topics.push("供应链环保或监管风险");
  }
  if (/stock double|double to|\$\d+|5 years?/iu.test(text)) {
    topics.push("长期上涨空间和估值讨论");
  }
  if (/capital spending|capex/iu.test(text)) {
    topics.push("资本开支");
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
    ? `摘要提到 ${Array.from(new Set(topics)).join("、")}`
    : `英文来源摘要未提供可抽取细节；标题关键词：${extractEnglishKeywords(text).join("、") || "待人工复核"}`;
}

function summarizeEnglishHeadlineTopics(value) {
  const text = String(value ?? "");
  const topics = [];
  if (/fed|fomc|rate|rates|yield|inflation/iu.test(text)) {
    topics.push("利率和通胀预期");
  }
  if (/nasdaq|s&p|dow|stocks?|market/iu.test(text)) {
    topics.push("美股风险偏好");
  }
  if (/\bai\b|artificial intelligence|anthropic|claude|chip|semiconductor/iu.test(text)) {
    topics.push("AI 与半导体");
  }
  if (/earnings|revenue|profit|guidance/iu.test(text)) {
    topics.push("业绩和指引");
  }
  if (/target|analyst|upgrade|downgrade/iu.test(text)) {
    topics.push("分析师预期");
  }
  if (/crypto|token|uniswap|on-chain/iu.test(text)) {
    topics.push("加密资产和代币化交易");
  }
  if (/productive conversation|council president|president costa|officials?/iu.test(text)) {
    topics.push("政策官员沟通");
  }
  if (/increases? position|raises? position|boosts? position|stake|holdings?/iu.test(text)) {
    topics.push("机构持仓变化");
  }
  if (/iphone parts factory|contaminated|pollution|farmland water|factory/iu.test(text)) {
    topics.push("供应链环保或监管风险");
  }
  if (/week in review|marketbeat/iu.test(text)) {
    topics.push("市场周度复盘");
  }
  if (/stock double|double to|\$\d+|5 years?/iu.test(text)) {
    topics.push("长期上涨空间和估值讨论");
  }
  if (/oil|crude|gold|dollar|currency|fx/iu.test(text)) {
    topics.push("大宗商品或汇率");
  }
  return topics.length ? `${Array.from(new Set(topics)).join("、")}线索` : `英文新闻线索，关键词：${extractEnglishKeywords(text).join("、") || "待人工复核"}`;
}

function extractEnglishKeywords(value) {
  const stopWords = new Set([
    "after",
    "again",
    "articles",
    "could",
    "color",
    "font",
    "from",
    "google",
    "href",
    "html",
    "http",
    "https",
    "into",
    "news",
    "rss",
    "said",
    "says",
    "that",
    "the",
    "their",
    "this",
    "will",
    "with"
  ]);
  const cleaned = String(value ?? "")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\b(?:href|src|color|style|class|target|rel)=["']?[^"'\s>]+/giu, " ")
    .replace(/&[a-z0-9#]+;/giu, " ");
  return Array.from(cleaned.toLowerCase().matchAll(/\b[a-z][a-z-]{3,}\b/gu))
    .map((match) => match[0])
    .filter((word) => !stopWords.has(word))
    .slice(0, 4);
}

function extractXmlTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "iu");
  return String(xml ?? "").match(pattern)?.[1] ?? "";
}

function xmlText(value) {
  return decodeXmlEntities(String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim());
}

function decodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;|&apos;/gu, "'");
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
