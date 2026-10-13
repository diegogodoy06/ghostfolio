// Preço diário (PU) dos títulos "Tesouro ..." manuais, pela base pública do Tesouro Transparente.
import type { Api, Activity } from "./ghostfolio";
import { DRY_RUN, UA, addDays, dry, isoDay, log } from "./util";

const TESOURO_CSV =
  "https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv";

export async function syncTesouro(api: Api, activities: Activity[], fullHistory: boolean) {
  const titles = new Map<string, { name: string; qty: number; first: string }>();
  for (const a of activities) {
    const p = a.assetProfile;
    if (p.dataSource !== "MANUAL" || !p.name?.startsWith("Tesouro ")) continue;
    const t = titles.get(p.symbol) ?? { name: p.name, qty: 0, first: isoDay(a.date) };
    if (a.type === "BUY") t.qty += a.quantity;
    if (a.type === "SELL") t.qty -= a.quantity;
    if (isoDay(a.date) < t.first) t.first = isoDay(a.date);
    titles.set(p.symbol, t);
  }
  // Títulos em carteira; na carga completa, também os já vendidos (para o histórico do gráfico).
  const targets = [...titles.entries()].filter(([, t]) => fullHistory || t.qty > 1e-9);
  if (!targets.length) return log("tesouro: nenhum título");

  const res = await fetch(TESOURO_CSV, { headers: UA, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Tesouro Transparente: ${res.status}`);
  const rows = new TextDecoder("latin1").decode(await res.arrayBuffer()).split(/\r?\n/).slice(1).map((l) => l.split(";"));

  for (const [symbol, t] of targets) {
    const m = /^(Tesouro .+?) (\d{4})$/.exec(t.name); // "Tesouro IPCA+ 2035"
    if (!m) {
      log(`tesouro: nome não reconhecido "${t.name}"`);
      continue;
    }
    const since = fullHistory ? t.first : addDays(isoDay(new Date()), -30);
    const marketData = rows
      .filter((c) => c[0] === m[1] && c[1]?.endsWith(`/${m[2]}`))
      .map((c) => {
        const [d, mo, y] = c[2]!.split("/");
        return { date: `${y}-${mo}-${d}T00:00:00.000Z`, marketPrice: Number(c[7]!.replace(/\./g, "").replace(",", ".")) };
      })
      .filter((x) => x.date.slice(0, 10) >= since && Number.isFinite(x.marketPrice));
    if (!marketData.length) {
      log(`tesouro: sem preços para ${t.name}`);
      continue;
    }
    const last = marketData.reduce((a, b) => (a.date > b.date ? a : b));
    dry(`tesouro ${t.name}: ${marketData.length} preços, último ${last.date.slice(0, 10)} = ${last.marketPrice}`);
    if (!DRY_RUN) await api("POST", `/v1/market-data/MANUAL/${encodeURIComponent(symbol)}`, { marketData });
  }
}
