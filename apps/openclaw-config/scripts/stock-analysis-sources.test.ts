import { describe, expect, it } from "vitest";

import { buildYahooOptionChainUrls } from "./stock-analysis-sources.mjs";

describe("stock analysis external sources", () => {
  it("uses both Yahoo option-chain hosts to reduce single-endpoint rate-limit failures", () => {
    expect(buildYahooOptionChainUrls("AAPL.US").map(String)).toEqual([
      "https://query2.finance.yahoo.com/v7/finance/options/AAPL",
      "https://query1.finance.yahoo.com/v7/finance/options/AAPL"
    ]);
  });
});
