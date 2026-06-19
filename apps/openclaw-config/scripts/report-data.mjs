export function normalizeQuotePayload(payload, expectedSymbol) {
  const quote = Array.isArray(payload) ? payload[0] : payload?.quotes?.[0] ?? payload ?? null;
  if (!quote || typeof quote !== "object") {
    throw new Error(`${expectedSymbol} 行情返回为空。`);
  }

  const symbol = String(quote.symbol ?? "").toUpperCase();
  const last = toNumber(quote.last ?? quote.last_done ?? quote.lastDone);
  if (symbol !== String(expectedSymbol).toUpperCase() || last === undefined) {
    throw new Error(`${expectedSymbol} 行情格式异常。`);
  }

  return quote;
}

export function assertOfficialPaperReportEnvironment(env = process.env) {
  const accountMode = String(env.LONGBRIDGE_ACCOUNT_MODE ?? "").trim().toLowerCase();
  const officialPaperEnabled = String(env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED ?? "").trim().toLowerCase();
  const liveExecution = String(env.ALLOW_LIVE_EXECUTION ?? "").trim().toLowerCase();
  if (accountMode !== "paper" || officialPaperEnabled !== "true" || liveExecution !== "false") {
    throw new Error("Longbridge 官方模拟盘报告要求 LONGBRIDGE_ACCOUNT_MODE=paper、LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true 且 ALLOW_LIVE_EXECUTION=false。");
  }
}

export function normalizeOfficialPaperSnapshot({ check, assets, positions, fetchedAt }) {
  const checkSummary = validateLongbridgeCheck(check);
  const assetRows = extractArrayPayload(assets, ["assets"], "Longbridge 官方模拟盘资产");
  const primaryAsset = assetRows[0] ?? null;
  validateOfficialPrimaryAsset(primaryAsset);
  const positionRows = extractArrayPayload(positions, ["positions"], "Longbridge 官方模拟盘持仓");

  return {
    source: "longbridge-official-paper",
    fetchedAt,
    accountMode: "paper",
    check: checkSummary,
    assets: assetRows,
    primaryAsset,
    positions: positionRows.map(normalizeOfficialPosition).filter(Boolean)
  };
}

export function buildDegradedOfficialPaperSnapshot({ fetchedAt = new Date().toISOString(), reason = "Longbridge 数据暂不可用" } = {}) {
  return {
    source: "longbridge-official-paper",
    degraded: true,
    degradedReason: String(reason ?? "Longbridge 数据暂不可用").trim(),
    fetchedAt,
    accountMode: "paper",
    check: {
      sessionStatus: "unknown",
      activeRegion: "",
      cachedRegion: "",
      okRegions: []
    },
    assets: [],
    primaryAsset: {
      net_assets: "0",
      total_cash: "0",
      buy_power: "0",
      currency: "USD",
      risk_level: "unknown"
    },
    positions: []
  };
}

export function buildDegradedQuoteSnapshot(symbol, { fetchedAt = new Date().toISOString(), reason = "行情数据暂不可用" } = {}) {
  return {
    symbol: normalizeSymbol(symbol),
    status: "degraded",
    degraded: true,
    degradedReason: String(reason ?? "行情数据暂不可用").trim(),
    timestamp: fetchedAt
  };
}

export function normalizeOfficialPosition(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const symbol = String(row.symbol ?? "").toUpperCase();
  const quantity = toNumber(row.quantity);
  if (!symbol || quantity === undefined || quantity <= 0) {
    return null;
  }

  return {
    symbol,
    name: String(row.name ?? symbol),
    market: String(row.market ?? ""),
    currency: String(row.currency ?? ""),
    quantity,
    available: toNumber(row.available),
    costPrice: toNumber(row.cost_price ?? row.costPrice),
    assetClass: inferAssetClass(symbol)
  };
}

export function buildTrackedSymbols(officialPositions, extraSymbols = []) {
  const candidates = [
    "QQQ.US",
    ...officialPositions.map((row) => row.symbol),
    ...extraSymbols
  ];
  const seen = new Set();
  return candidates
    .map((value) => normalizeSymbol(value))
    .filter(Boolean)
    .filter((symbol) => {
      if (seen.has(symbol)) {
        return false;
      }
      seen.add(symbol);
      return true;
    });
}

export function normalizeNewsPayload(symbol, payload) {
  const rows = extractArrayPayload(payload, ["list", "news"], `Longbridge 新闻 ${symbol}`);
  return rows
    .map((row) => normalizeNewsArticle(symbol, row))
    .filter(Boolean)
    .sort((a, b) => b.publishedAtMs - a.publishedAtMs);
}

export function normalizeNewsArticle(symbol, row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const id = String(row.id ?? row.news_id ?? row.url ?? "").trim();
  const title = String(row.title ?? "").replace(/\s+/gu, " ").trim();
  if (!id || !title) {
    return null;
  }

  const publishedAtMs = normalizeEpochMs(row.published_at ?? row.publishedAt ?? row.time);
  return {
    id,
    symbol: normalizeSymbol(symbol),
    title,
    url: String(row.url ?? ""),
    publishedAt: new Date(publishedAtMs).toISOString(),
    publishedAtMs,
    likes: toNumber(row.likes_count ?? row.likes),
    comments: toNumber(row.comments_count ?? row.comments),
    source: "longbridge-news"
  };
}

export function normalizeMacroCalendarPayload(payload) {
  const groups = extractArrayPayload(payload, ["list"], "Longbridge 美国宏观日历");
  const entries = [];
  for (const group of groups) {
    const groupDate = String(group?.date ?? "");
    const infos = Array.isArray(group?.infos) ? group.infos : [];
    for (const info of infos) {
      const normalized = normalizeMacroCalendarEntry(groupDate, info);
      if (normalized) {
        entries.push(normalized);
      }
    }
  }
  return entries.sort((a, b) => a.timestampMs - b.timestampMs);
}

export function normalizeMacroCalendarEntry(groupDate, row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const title = String(row.content ?? row.name ?? "").replace(/\s+/gu, " ").trim();
  const id = String(row.id ?? `${groupDate}:${title}`).trim();
  if (!title || !id) {
    return null;
  }

  const timestampMs = normalizeEpochMs(row.datetime, `${groupDate}T00:00:00+08:00`);
  return {
    id,
    title,
    date: groupDate,
    time: String(row.date ?? ""),
    market: String(row.market ?? ""),
    star: toNumber(row.star) ?? 0,
    type: String(row.type ?? "macrodata"),
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    values: Array.isArray(row.data_kv)
      ? row.data_kv.map((entry) => ({
          key: String(entry?.key ?? ""),
          type: String(entry?.type ?? ""),
          value: String(entry?.value ?? "")
        }))
      : []
  };
}

export function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!symbol) {
    return "";
  }
  if (/^[A-Z0-9.-]+\.[A-Z]{2,4}$/u.test(symbol) || symbol.startsWith(".")) {
    return symbol;
  }
  if (/^[A-Z]{1,6}$/u.test(symbol)) {
    return `${symbol}.US`;
  }
  return symbol;
}

export function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function validateLongbridgeCheck(check) {
  if (!check || typeof check !== "object") {
    throw new Error("Longbridge 连通性/令牌检查返回为空或格式异常。");
  }
  const tokenStatus = String(check.session?.token ?? "").trim().toLowerCase();
  if (tokenStatus !== "valid") {
    throw new Error("Longbridge 令牌检查未返回 valid。");
  }
  const connectivity = check.connectivity;
  if (!connectivity || typeof connectivity !== "object") {
    throw new Error("Longbridge 连通性检查缺少 connectivity。");
  }
  const okRegions = Object.entries(connectivity)
    .filter(([, value]) => value?.ok === true)
    .map(([region]) => normalizeRegion(region))
    .filter(Boolean);
  if (okRegions.length === 0) {
    throw new Error("Longbridge 连通性检查没有可用区域。");
  }
  return {
    sessionStatus: "valid",
    activeRegion: normalizeRegion(check.region?.active),
    cachedRegion: normalizeRegion(check.region?.cached),
    okRegions
  };
}

function validateOfficialPrimaryAsset(row) {
  if (!row || typeof row !== "object") {
    throw new Error("Longbridge 官方模拟盘资产返回为空。");
  }
  const netAssets = toNumber(row.net_assets ?? row.netAssets);
  const totalCash = toNumber(row.total_cash ?? row.totalCash);
  const currency = String(row.currency ?? "").trim();
  if (netAssets === undefined || totalCash === undefined || !currency) {
    throw new Error("Longbridge 官方模拟盘资产缺少 net_assets、total_cash 或 currency。");
  }
}

function extractArrayPayload(payload, keys, label) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      if (Array.isArray(payload[key])) {
        return payload[key];
      }
    }
  }
  throw new Error(`${label}返回格式异常。`);
}

function normalizeRegion(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "cn" || normalized === "global") {
    return normalized;
  }
  return normalized || "";
}

function inferAssetClass(symbol) {
  return /ETF|QQQ|SPY|DIA|IWM|SGOV|BNO|USO|SPUU|MSFU|FBL|TSLL/u.test(symbol) ? "etf" : "stock";
}

function normalizeEpochMs(value, fallbackDate) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number > 10_000_000_000 ? number : number * 1000;
  }
  const fallback = new Date(String(fallbackDate ?? Date.now())).getTime();
  return Number.isFinite(fallback) ? fallback : Date.now();
}
