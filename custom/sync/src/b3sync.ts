/**
 * Mantém as contas da B3 no Ghostfolio iguais ao que os extratos dizem.
 *
 * As contas que aparecem nos extratos (ex.: "XP Investimentos") são "gerenciadas": a cada
 * execução o conjunto desejado é recalculado e só a diferença é aplicada (cria o que falta,
 * remove o que sobrou). Contas que não vêm da B3 (ex.: Nomad) nunca são tocadas, e os
 * proventos automáticos ("Auto (Yahoo)") são responsabilidade de dividends.ts.
 */
import crypto from "node:crypto";
import type { DesiredActivity } from "./convert";
import { type Api, type Activity, getAccounts, isAuto } from "./ghostfolio";
import { DRY_RUN, dry, log } from "./util";

const MAX_DELETE_RATIO = Number(process.env.MAX_DELETE_RATIO ?? 0.3);

const assetKey = (dataSource: string, symbol: string | undefined, name: string | null | undefined) =>
  dataSource === "MANUAL" ? `MANUAL:${name}` : `${dataSource}:${symbol}`;
const keyOf = (account: string, asset: string, type: string, date: string, quantity: number, unitPrice: number) =>
  [account, asset, type, date.slice(0, 10), quantity.toFixed(6), unitPrice.toFixed(4)].join("|");

export async function syncB3Accounts(api: Api, desired: DesiredActivity[], existing: Activity[]) {
  const accounts = await getAccounts(api);
  const managedNames = [...new Set(desired.map((d) => d.account))];

  // Garante as contas.
  const accountId = new Map(accounts.map((a) => [a.name, a.id]));
  for (const name of managedNames) {
    if (accountId.has(name)) continue;
    dry(`conta nova: ${name}`);
    if (!DRY_RUN) {
      const created = await api<{ id: string }>("POST", "/v1/account", { balance: 0, comment: "Gerenciada pelo ghostfolio-sync (extratos da B3)", currency: "BRL", isExcluded: false, name, platformId: null });
      accountId.set(name, created.id);
    } else accountId.set(name, `novo:${name}`);
  }
  const managedIds = new Set(managedNames.map((n) => accountId.get(n)!));
  const nameById = new Map([...accountId.entries()].map(([n, id]) => [id, n]));

  // Conjunto atual (contas gerenciadas, sem os proventos automáticos).
  const current = existing.filter((a) => a.accountId && managedIds.has(a.accountId) && !isAuto(a));
  const pool = new Map<string, Activity[]>();
  for (const a of current) {
    const k = keyOf(nameById.get(a.accountId!)!, assetKey(a.assetProfile.dataSource, a.assetProfile.symbol, a.assetProfile.name), a.type, a.date, a.quantity, a.unitPrice);
    pool.set(k, [...(pool.get(k) ?? []), a]);
  }
  const toCreate: DesiredActivity[] = [];
  for (const d of desired) {
    const k = keyOf(d.account, assetKey(d.asset.dataSource, d.asset.symbol, d.asset.name), d.type, d.date, d.quantity, d.unitPrice);
    const match = pool.get(k);
    if (match?.length) match.pop();
    else toCreate.push(d);
  }
  const toDelete = [...pool.values()].flat();

  log(`extratos: ${desired.length} atividades esperadas, ${current.length} no Ghostfolio → criar ${toCreate.length}, remover ${toDelete.length}`);
  if (!toCreate.length && !toDelete.length) return { created: 0, oldestCreated: null as string | null };

  // Proteção contra apagar muita coisa por engano (ex.: extrato faltando na pasta).
  if (current.length > 20 && toDelete.length > current.length * MAX_DELETE_RATIO && process.env.FORCE_RESYNC !== "1") {
    throw new Error(
      `a sincronização removeria ${toDelete.length} de ${current.length} atividades. Confira a pasta de extratos; ` +
        `se estiver certo, rode uma vez com FORCE_RESYNC=1.`,
    );
  }

  for (const a of toDelete) {
    dry(`remover ${a.date.slice(0, 10)} ${a.type} ${a.assetProfile.symbol} ${a.quantity} × ${a.unitPrice}`);
    if (!DRY_RUN) await api("DELETE", `/v1/activities/${a.id}`);
  }

  // Criação em lote pela importação, que também cria/reaproveita (pelo nome) os ativos manuais.
  const manualSymbol = new Map<string, string>();
  for (const a of existing) if (a.assetProfile.dataSource === "MANUAL" && a.assetProfile.name) manualSymbol.set(a.assetProfile.name, a.assetProfile.symbol);
  const assetProfiles: any[] = [];
  const symbolFor = (d: DesiredActivity) => {
    if (d.asset.dataSource === "YAHOO") return d.asset.symbol!;
    let s = manualSymbol.get(d.asset.name);
    if (!s) {
      s = crypto.randomUUID();
      manualSymbol.set(d.asset.name, s);
      assetProfiles.push({ ...d.asset.profile, countries: [], currency: "BRL", dataSource: "MANUAL", holdings: [], isActive: true, name: d.asset.name, sectors: [], symbol: s });
    }
    return s;
  };
  const activities = toCreate.map((d) => ({
    accountId: accountId.get(d.account),
    comment: d.comment,
    currency: "BRL",
    dataSource: d.asset.dataSource,
    date: d.date,
    fee: 0,
    quantity: d.quantity,
    symbol: symbolFor(d),
    type: d.type,
    unitPrice: d.unitPrice,
  }));
  for (const a of toCreate.slice(0, 20)) dry(`criar ${a.date.slice(0, 10)} ${a.type} ${a.asset.symbol ?? a.asset.name} ${a.quantity} × ${a.unitPrice}`);
  if (toCreate.length > 20) dry(`… e mais ${toCreate.length - 20}`);
  // Uma única importação: o Ghostfolio pode remapear o símbolo de um ativo manual novo, e o
  // mapeamento só vale dentro da mesma chamada.
  if (!DRY_RUN) await api("POST", "/v1/import", { activities, assetProfiles });
  return { created: toCreate.length, oldestCreated: toCreate.reduce<string | null>((m, d) => (!m || d.date < m ? d.date : m), null) };
}
