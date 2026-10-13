/**
 * Benchmarks para a tela Análise: Ibovespa, IFIX (ETF XFIX11) e dólar pelo Yahoo (o próprio
 * Ghostfolio coleta as cotações); CDI, IPCA e IPCA + 6% a.a. calculados com as séries do
 * Banco Central e mantidos como ativos manuais (símbolo com prefixo GF_).
 */
import type { Api } from "./ghostfolio";
import { buildRateIndexes } from "./indexes";
import { DRY_RUN, addDays, dry, log } from "./util";

const YAHOO_BENCHMARKS = [
  { symbol: "^BVSP", name: "Ibovespa" },
  { symbol: "XFIX11.SA", name: "IFIX (ETF XFIX11)" },
  { symbol: "USDBRL", name: "Dólar (USD/BRL)" },
];

export async function syncBenchmarks(api: Api, firstActivity: string | null) {
  // /v1/info lê a configuração direto (o /v1/benchmarks usa um cache que demora a refletir).
  const existing = new Set(((await api<{ benchmarks?: { symbol: string }[] }>("GET", "/v1/info")).benchmarks ?? []).map((b) => b.symbol));
  const ensure = async (dataSource: string, symbol: string, name: string) => {
    if (existing.has(symbol)) return false;
    dry(`benchmark novo: ${name}`);
    if (DRY_RUN) return true;
    await api("POST", `/v1/admin/profile-data/${dataSource}/${encodeURIComponent(symbol)}`).catch(() => undefined); // pode já existir
    await api("PATCH", `/v1/admin/profile-data/${dataSource}/${encodeURIComponent(symbol)}`, { name, currency: "BRL" }).catch((e) => log(`aviso ${symbol}:`, (e as Error).message));
    await api("POST", "/v1/benchmarks", { dataSource, symbol });
    return true;
  };
  const safe = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      log(`benchmark ${name}: erro`, (err as Error).message);
    }
  };

  for (const b of YAHOO_BENCHMARKS) {
    await safe(b.name, async () => {
      if ((await ensure("YAHOO", b.symbol, b.name)) && !DRY_RUN) await api("POST", `/v1/admin/gather/YAHOO/${encodeURIComponent(b.symbol)}`).catch(() => undefined);
    });
  }

  // Séries a partir do dia anterior à primeira atividade (mínimo de 1 ano de histórico).
  const oneYearAgo = addDays(new Date().toISOString().slice(0, 10), -366);
  const since = firstActivity && firstActivity < oneYearAgo ? addDays(firstActivity, -1) : oneYearAgo;
  for (const idx of await buildRateIndexes(since)) {
    await safe(idx.name, async () => {
      await ensure("MANUAL", idx.symbol, idx.name);
      const last = idx.series[idx.series.length - 1]!;
      dry(`${idx.name}: ${idx.series.length} dias desde ${since}, acumulado ${((last.value / 100 - 1) * 100).toFixed(2)}%`);
      if (!DRY_RUN) {
        await api("POST", `/v1/market-data/MANUAL/${idx.symbol}`, {
          marketData: idx.series.map((p) => ({ date: `${p.date}T00:00:00.000Z`, marketPrice: Math.round(p.value * 1e6) / 1e6 })),
        });
      }
    });
  }
}
