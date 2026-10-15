// Cotação de ativos fora da carteira (Yahoo), para a simulação e o MCP.
import { categorize } from "./categories";

// ---- Cotação de ativos fora da carteira (Yahoo), para a simulação. ----
type QuoteData = { ticker: string; price: number | null; name: string | null; category: string | null };
const quoteCache = new Map<string, { at: number; data: QuoteData }>();
export async function quote(ticker: string) {
  const hit = quoteCache.get(ticker);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.data;
  const symbol = /^[A-Z]{4}\d{1,2}$/.test(ticker) ? `${ticker}.SA` : ticker;
  let data: QuoteData = { ticker, price: null, name: null, category: null };
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, {
      headers: { "User-Agent": "Mozilla/5.0 (ghostfolio-relatorios)" },
      signal: AbortSignal.timeout(10_000),
    });
    const meta = ((await r.json()) as any)?.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice) {
      const name = meta.longName ?? meta.shortName ?? null;
      // Mesma categorização da carteira (FII, ação, ETF, BDR, exterior...).
      const { category } = categorize({ dataSource: "YAHOO", symbol, name, currency: meta.currency ?? "BRL", assetSubClass: meta.instrumentType === "ETF" ? "ETF" : null });
      data = { ticker, price: meta.regularMarketPrice, name, category };
    }
  } catch {
    // sem cotação: a simulação mostra só o valor em R$
  }
  quoteCache.set(ticker, { at: Date.now(), data });
  return data;
}

