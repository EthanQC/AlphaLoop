export function buildYahooOptionChainUrls(symbol) {
  const yahooSymbol = String(symbol ?? "").toUpperCase().replace(/\.US$/u, "");
  if (!yahooSymbol) {
    throw new Error("symbol is required for Yahoo option-chain URLs.");
  }
  return [
    new URL(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(yahooSymbol)}`),
    new URL(`https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(yahooSymbol)}`)
  ];
}
