#!/usr/bin/env node
import { runLongbridgeJson } from "./_longbridge.mjs";

const assets = await runLongbridgeJson("trade", ["assets"]);

const payload = {
  generatedAt: new Date().toISOString(),
  check: await runLongbridgeJson("trade", ["check"]),
  assets,
  balance: assets,
  positions: await runLongbridgeJson("trade", ["positions"]),
  watchlist: await runLongbridgeJson("trade", ["watchlist"])
};

console.log(JSON.stringify(payload, null, 2));
