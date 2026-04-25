#!/usr/bin/env node
import { runLongbridgeJson } from "./_longbridge.mjs";

const payload = {
  generatedAt: new Date().toISOString(),
  check: await runLongbridgeJson("trade", ["check"]),
  balance: await runLongbridgeJson("trade", ["balance"]),
  positions: await runLongbridgeJson("trade", ["positions"]),
  watchlist: await runLongbridgeJson("trade", ["watchlist"])
};

console.log(JSON.stringify(payload, null, 2));
