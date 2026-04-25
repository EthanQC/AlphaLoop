#!/usr/bin/env node
import { runLongbridgeJson } from "./_longbridge.mjs";

const [sideArg, symbolArg, quantityArg] = process.argv.slice(2);

if (!sideArg || !symbolArg || !quantityArg) {
  console.error("Usage: submit-paper-equity-order.mjs <buy|sell> <SYMBOL> <QUANTITY>");
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

if (!quote) {
  throw new Error(`No quote returned for ${symbolArg}`);
}

const brokerExecutorUrl = process.env.BROKER_EXECUTOR_URL ?? "http://127.0.0.1:4312";
const ticket = {
  id: `manual_${Date.now()}`,
  source: "manual-feishu-paper",
  submittedAt: new Date().toISOString(),
  environment: "paper",
  assetClass: guessAssetClass(symbolArg, quote),
  symbol: symbolArg,
  side,
  quantity,
  conviction: "normal",
  notionalUsd: Number(quote.last_done ?? quote.lastDone ?? quote.last ?? 0) * quantity,
  marketSnapshot: {
    bid: toNumber(quote.bid_price ?? quote.bidPrice ?? quote.bid ?? quote.last_done ?? quote.last),
    ask: toNumber(quote.ask_price ?? quote.askPrice ?? quote.ask ?? quote.last_done ?? quote.last),
    last: toNumber(quote.last_done ?? quote.lastDone ?? quote.last),
    timestamp: new Date().toISOString()
  },
  metadata: {
    eventId: `manual_${Date.now()}`,
    accountNetLiq: 100000,
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

const result = await response.text();
console.log(result);
if (!response.ok) {
  process.exit(1);
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function guessAssetClass(symbol, quote) {
  const name = String(quote?.name ?? "").toLowerCase();
  if (name.includes("etf") || symbol.endsWith(".US") && ["SPY.US", "QQQ.US", "IWM.US", "DIA.US"].includes(symbol)) {
    return "etf";
  }
  return "stock";
}
