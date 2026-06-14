#!/usr/bin/env node
import { runLongbridgeJson } from "./_longbridge.mjs";

const [sideArg, symbolArg, quantityArg] = process.argv.slice(2);

if (!sideArg || !symbolArg || !quantityArg) {
  console.error("Usage: submit-official-paper-equity-order.mjs <buy|sell> <SYMBOL> <QUANTITY>");
  process.exit(1);
}

if (process.env.LONGBRIDGE_ACCOUNT_MODE !== "paper") {
  console.error("Refusing to submit: set LONGBRIDGE_ACCOUNT_MODE=paper after confirming this token is the official Longbridge paper account.");
  process.exit(1);
}

if (process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED !== "true") {
  console.error("Refusing to submit: set LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true after confirming Longbridge Demo A/C is selected.");
  process.exit(1);
}

if (process.env.ALLOW_LIVE_EXECUTION !== "false") {
  console.error("Refusing to submit: ALLOW_LIVE_EXECUTION=false is required for official paper automation.");
  process.exit(1);
}

const side = sideArg.toLowerCase();
if (!["buy", "sell"].includes(side)) {
  console.error("Side must be buy or sell.");
  process.exit(1);
}

const quantity = Number(quantityArg);
if (!Number.isInteger(quantity) || quantity <= 0) {
  console.error("Quantity must be a positive integer.");
  process.exit(1);
}

const quotePayload = await runLongbridgeJson("quote", ["quote", symbolArg]);
const quote = Array.isArray(quotePayload) ? quotePayload[0] : quotePayload?.quotes?.[0];
const [assetsPayload, positionsPayload] = await Promise.all([
  runLongbridgeJson("trade", ["assets"]),
  runLongbridgeJson("trade", ["positions"])
]);
const accountNetLiq = extractNetAssets(assetsPayload);
const officialPaperCurrentExposureUsd = estimateCurrentExposure(positionsPayload);
const price = side === "buy"
  ? toNumber(quote?.ask_price ?? quote?.askPrice ?? quote?.ask ?? quote?.last_done ?? quote?.last)
  : toNumber(quote?.bid_price ?? quote?.bidPrice ?? quote?.bid ?? quote?.last_done ?? quote?.last);

if (!price) {
  throw new Error(`No usable limit price returned for ${symbolArg}`);
}

if (side === "buy" && accountNetLiq > 0) {
  const projectedExposure = officialPaperCurrentExposureUsd + price * quantity;
  const budget = accountNetLiq * 0.1;
  if (projectedExposure > budget) {
    throw new Error(`Refusing to submit: projected OpenClaw official paper exposure ${projectedExposure.toFixed(2)} exceeds 10% budget ${budget.toFixed(2)}.`);
  }
}

const brokerExecutorUrl = process.env.BROKER_EXECUTOR_URL ?? "http://127.0.0.1:4312";
const ticket = {
  id: `manual_${Date.now()}`,
  source: "manual-official-paper",
  submittedAt: new Date().toISOString(),
  environment: "paper",
  assetClass: guessAssetClass(symbolArg, quote),
  symbol: symbolArg,
  side,
  quantity,
  conviction: "normal",
  notionalUsd: price * quantity,
  marketSnapshot: {
    bid: toNumber(quote?.bid_price ?? quote?.bidPrice ?? quote?.bid ?? quote?.last_done ?? quote?.last),
    ask: toNumber(quote?.ask_price ?? quote?.askPrice ?? quote?.ask ?? quote?.last_done ?? quote?.last),
    last: toNumber(quote?.last_done ?? quote?.lastDone ?? quote?.last),
    timestamp: new Date().toISOString()
  },
  metadata: {
    eventId: `manual_official_${Date.now()}`,
    accountMode: "paper",
    officialPaper: true,
    demoAccountGuard: "Longbridge Demo A/C plus LONGBRIDGE_ACCOUNT_MODE=paper required.",
    accountNetLiq,
    officialPaperCurrentExposureUsd,
    openclawPaperBudgetPercent: 10,
    currentOpenIdeas: 0,
    currentHighConvictionIdeas: 0,
    dailyNewRiskPercent: 0
  }
};

const response = await fetch(`${brokerExecutorUrl}/v1/tickets`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({ ticket })
});

const text = await response.text();
let result;
try {
  result = JSON.parse(text);
} catch {
  result = { raw: text };
}

console.log(JSON.stringify(result, null, 2));
if (!response.ok) {
  process.exit(1);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function guessAssetClass(symbol, quoteValue) {
  const name = String(quoteValue?.name ?? "").toLowerCase();
  if (name.includes("etf") || symbol.endsWith(".US") && ["SPY.US", "QQQ.US", "IWM.US", "DIA.US"].includes(symbol)) {
    return "etf";
  }
  return "stock";
}

function extractNetAssets(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.assets ?? [];
  const first = rows[0] ?? {};
  const value = toNumber(first.net_assets ?? first.netAssets);
  if (!value) {
    throw new Error("Unable to read official paper net assets from Longbridge assets.");
  }
  return value;
}

function estimateCurrentExposure(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.positions ?? [];
  return rows.reduce((sum, row) => {
    const quantity = toNumber(row?.quantity);
    if (!quantity) {
      return sum;
    }
    const price = toNumber(row?.market_price ?? row?.marketPrice ?? row?.last_price ?? row?.lastPrice ?? row?.cost_price ?? row?.costPrice);
    return sum + quantity * (price ?? 0);
  }, 0);
}
