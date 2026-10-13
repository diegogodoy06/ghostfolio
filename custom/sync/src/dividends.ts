/**
 * Proventos automáticos: para cada ativo do Yahoo, lança os eventos (data ex) que ainda não
 * aparecem como recebidos. Quando um extrato da B3 traz o valor real, o estimado é removido.
 * Só mexe em atividades marcadas "Auto (Yahoo)".
 */
import { type Api, type Activity, isAuto } from "./ghostfolio";
import { DRY_RUN, addDays, dry, isoDay, log, round, yahooDividends } from "./util";

const JCP_TAX = Number(process.env.JCP_TAX ?? 0.15);
const US_WITHHOLDING = Number(process.env.US_WITHHOLDING ?? 0.3);

export async function syncDividends(api: Api, activities: Activity[]) {
  const today = isoDay(new Date());
  const bySymbol = new Map<string, Activity[]>();
  for (const a of activities) {
    if (a.assetProfile.dataSource !== "YAHOO") continue;
    bySymbol.set(a.assetProfile.symbol, [...(bySymbol.get(a.assetProfile.symbol) ?? []), a]);
  }

  // Até onde os extratos já trazem proventos recebidos.
  const received = activities.filter((a) => a.type === "DIVIDEND" && !isAuto(a));
  const coverageEnd = received.reduce((m, a) => (isoDay(a.date) > m ? isoDay(a.date) : m), "");
  const globalSince = coverageEnd ? addDays(coverageEnd, -45) : "";

  const desired: { symbol: string; accountId: string | null; currency: string; date: string; quantity: number; unitPrice: number; comment: string }[] = [];
  for (const [symbol, acts] of bySymbol) {
    const trades = acts.filter((a) => a.type === "BUY" || a.type === "SELL").sort((a, b) => a.date.localeCompare(b.date));
    if (!trades.length) continue;
    const qtyAt = (day: string) => trades.filter((t) => isoDay(t.date) <= day).reduce((q, t) => q + (t.type === "BUY" ? t.quantity : -t.quantity), 0);
    const real = acts.filter((a) => a.type === "DIVIDEND" && !isAuto(a));
    const firstBuy = isoDay(trades[0]!.date);
    const since = real.length && globalSince ? (globalSince > firstBuy ? globalSince : firstBuy) : firstBuy;

    const currency = acts[0]!.assetProfile.currency;
    const jcpShare = real.length ? real.filter((d) => /JCP/i.test(d.comment ?? "")).length / real.length : 0;
    const net = currency === "USD" ? 1 - US_WITHHOLDING : jcpShare > 0.5 ? 1 - JCP_TAX : 1;
    const label = currency === "USD" ? `líquido de ${US_WITHHOLDING * 100}% retido nos EUA` : net < 1 ? `JCP líquido de ${JCP_TAX * 100}% IR` : "bruto";
    const accountId = [...trades].reverse().find((t) => t.type === "BUY")?.accountId ?? null;

    for (const ev of await yahooDividends(symbol, addDays(since, -10))) {
      if (ev.exDate < since || ev.exDate > today) continue;
      const qty = qtyAt(addDays(ev.exDate, -1));
      if (qty < 1e-9) continue;
      const unit = ev.amount * net;
      const paid = real.some((d) => {
        const day = isoDay(d.date);
        const tol = Math.max(0.15 * ev.amount, 0.006);
        return day >= addDays(ev.exDate, -5) && day <= addDays(ev.exDate, 120) && (Math.abs(d.unitPrice - ev.amount) <= tol || Math.abs(d.unitPrice - unit) <= tol);
      });
      if (paid) continue;
      desired.push({ symbol, accountId, currency, date: `${ev.exDate}T00:00:00.000Z`, quantity: round(qty), unitPrice: round(unit, 6), comment: `Auto (Yahoo): provento estimado, data ex, ${label}` });
    }
  }

  // Diferença só entre os automáticos.
  const key = (s: string, d: string, q: number, u: number) => `${s}|${d.slice(0, 10)}|${q.toFixed(6)}|${u.toFixed(4)}`;
  const existing = new Map<string, Activity>();
  for (const a of activities.filter((x) => x.type === "DIVIDEND" && isAuto(x))) existing.set(key(a.assetProfile.symbol, a.date, a.quantity, a.unitPrice), a);
  let created = 0;
  for (const d of desired) {
    const k = key(d.symbol, d.date, d.quantity, d.unitPrice);
    if (existing.delete(k)) continue;
    dry(`provento ${d.symbol} ex ${d.date.slice(0, 10)}: ${d.quantity} × ${d.unitPrice} ${d.currency} = ${(d.quantity * d.unitPrice).toFixed(2)}`);
    if (!DRY_RUN) await api("POST", "/v1/activities", { ...d, dataSource: "YAHOO", fee: 0, type: "DIVIDEND" });
    created++;
  }
  for (const a of existing.values()) {
    dry(`remover provento estimado ${a.assetProfile.symbol} ${a.date.slice(0, 10)} (já recebido pelo extrato ou não se aplica mais)`);
    if (!DRY_RUN) await api("DELETE", `/v1/activities/${a.id}`);
  }
  log(`proventos automáticos: +${created} / -${existing.size}`);
}
