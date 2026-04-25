#!/usr/bin/env node
import { runLongbridgeJson } from "./_longbridge.mjs";

const symbols = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
if (symbols.length === 0) {
  console.error("Usage: longbridge-quote.mjs <SYMBOL> [SYMBOL...]");
  process.exit(1);
}

const payload = await runLongbridgeJson("quote", ["quote", ...symbols]);
console.log(JSON.stringify(payload, null, 2));
