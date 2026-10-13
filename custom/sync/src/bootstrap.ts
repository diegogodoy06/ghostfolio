/**
 * Configuração inicial de uma instalação nova, para o Brasil:
 * - BRL na lista de moedas (numa instalação nova só existe USD);
 * - moeda base do usuário em BRL (só na primeira execução, para não sobrescrever escolhas);
 * - histórico completo de câmbio e cotações depois de importar operações antigas.
 *   O Ghostfolio converte tudo internamente via USD, então sem o câmbio histórico a carteira
 *   em reais aparece zerada.
 */
import type { Api } from "./ghostfolio";
import type { State } from "./state";
import { DRY_RUN, dry } from "./util";

const BASE_CURRENCY = process.env.BASE_CURRENCY ?? "BRL";

export async function ensureCurrencySetup(api: Api, state: State) {
  const info = await api<{ currencies: string[] }>("GET", "/v1/info");
  if (!info.currencies.includes(BASE_CURRENCY)) {
    dry(`adicionando ${BASE_CURRENCY} às moedas do Ghostfolio`);
    if (!DRY_RUN) await api("PUT", "/v1/admin/settings/CURRENCIES", { value: JSON.stringify([BASE_CURRENCY]) });
  }
  if (!state.baseCurrencySet) {
    const user = await api<{ settings: { baseCurrency?: string } }>("GET", "/v1/user");
    if (user.settings.baseCurrency !== BASE_CURRENCY) {
      dry(`moeda base do usuário: ${user.settings.baseCurrency ?? "USD"} → ${BASE_CURRENCY}`);
      if (!DRY_RUN) await api("PUT", "/v1/user/setting", { baseCurrency: BASE_CURRENCY });
    }
    if (!DRY_RUN) state.baseCurrencySet = true;
  }
}

/** Coleta completa (câmbio + cotações) quando entram operações mais antigas que o já coletado. */
export async function ensureHistoricalData(api: Api, state: State, oldest: string | null) {
  if (!oldest) return;
  const day = oldest.slice(0, 10);
  if (state.gatheredSince && state.gatheredSince <= day) return;
  dry(`coleta completa de câmbio e cotações (operações desde ${day})`);
  if (!DRY_RUN) {
    await api("POST", "/v1/admin/gather/max");
    state.gatheredSince = day;
  }
}
