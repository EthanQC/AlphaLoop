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
const price = side === "buy"
  ? toNumber(quote?.ask_price ?? quote?.askPrice ?? quote?.ask ?? quote?.last_done ?? quote?.last)
  : toNumber(quote?.bid_price ?? quote?.bidPrice ?? quote?.bid ?? quote?.last_done ?? quote?.last);

if (!price) {
  throw new Error(`No usable limit price returned for ${symbolArg}`);
}

const result = await runLongbridgeJson("trade", [
  "order",
  side,
  symbolArg,
  String(quantity),
  "--price",
  price.toFixed(2),
  "--order-type",
  "LO",
  "--tif",
  "Day",
  "--remark",
  `OpenClaw official paper smoke ${Date.now()}`.slice(0, 255),
  "--yes"
]);

console.log(JSON.stringify(result, null, 2));

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
