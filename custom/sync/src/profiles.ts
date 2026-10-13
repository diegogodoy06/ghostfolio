/**
 * Preenche o país dos ativos sem essa informação, para o mapa de regiões da tela Alocações.
 * O Yahoo não informa país para FIIs, ETFs da B3 e ativos manuais (Tesouro, CDB).
 *
 * Regras: ETFs da B3 que replicam índice estrangeiro usam o país do índice; BDRs, os EUA;
 * demais ativos da B3 e ativos manuais em BRL, o Brasil; ativos em USD, os EUA.
 * Só altera perfis com a lista de países vazia, então nunca sobrescreve um ajuste manual.
 */
import type { Api, Activity } from "./ghostfolio";
import { DRY_RUN, dry, log } from "./util";

// ETFs da B3 com exposição estrangeira (ticker sem .SA -> país ISO).
const FOREIGN_ETFS: Record<string, string> = {
  IVVB11: "US", // S&P 500
  ALUG11: "US", // MSCI US REIT
  NASD11: "US", // Nasdaq-100
  SPXI11: "US",
  BBSD11: "US",
  WRLD11: "US", // MSCI World (maioria EUA)
  ACWI11: "US",
  EURP11: "DE", // MSCI Europe (aproximação)
  XINA11: "CN",
  ASIA11: "CN",
};
// ETFs de cripto não têm país: ficam sem, em vez de receber um país errado.
const NO_COUNTRY = new Set(["HASH11", "QBTC11", "BITH11", "ETHE11", "QETH11"]);

function countryFor(p: Activity["assetProfile"]): string | null {
  if (p.dataSource === "MANUAL") return p.currency === "BRL" ? "BR" : null;
  const b3 = /^([A-Z]{4}\d{1,2})\.SA$/.exec(p.symbol);
  if (b3) {
    const ticker = b3[1]!;
    if (NO_COUNTRY.has(ticker)) return null;
    if (FOREIGN_ETFS[ticker]) return FOREIGN_ETFS[ticker]!;
    if (/^[A-Z]{4}3[2-9]$/.test(ticker)) return "US"; // BDR
    return "BR";
  }
  if (p.currency === "USD") return "US";
  return null;
}

export async function syncProfiles(api: Api, activities: Activity[]) {
  const profiles = new Map<string, Activity["assetProfile"] & { countries?: unknown[] }>();
  for (const a of activities) profiles.set(`${a.assetProfile.dataSource}:${a.assetProfile.symbol}`, a.assetProfile as any);

  let updated = 0;
  for (const p of profiles.values()) {
    if (Array.isArray(p.countries) && p.countries.length) continue;
    const code = countryFor(p);
    if (!code) continue;
    dry(`país ${code}: ${p.name ?? p.symbol}`);
    if (!DRY_RUN) {
      await api("PATCH", `/v1/admin/profile-data/${p.dataSource}/${encodeURIComponent(p.symbol)}`, { countries: [{ code, weight: 1 }] }).catch((e) =>
        log(`aviso país ${p.symbol}:`, (e as Error).message),
      );
    }
    updated++;
  }
  log(`países: ${updated} ativo(s) atualizado(s)`);
}
