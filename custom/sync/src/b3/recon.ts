import type { DB } from "./db";
import type { ManualEvent, ReconIssue } from "./types";
import { getAssets, parseProduct } from "./assets";
import type { LedgerResult } from "./ledger";

/**
 * Concilia a quantidade calculada pelo ledger com o último retrato de Posição da B3 e
 * propõe o lançamento que explica cada divergência (troca de ticker, incorporação,
 * subscrição, entrada sem histórico).
 */

const EPS = 1e-4;
const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
const normName = (s: string) => s.toUpperCase().normalize("NFD").replace(/[^A-Z0-9]/g, "");
const fmtQty = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 6 });
const fmtDate = (iso: string) => iso.split("-").reverse().join("/");

interface Ignored {
  date: string;
  ticker: string;
  movement: string;
  quantity: number;
  value: number | null;
}

export function latestSnapshotDate(db: DB): string | null {
  const r = db.prepare("SELECT MAX(snapshot_date) d FROM position_snapshots").get() as { d: string | null };
  return r.d;
}

export function reconcile(db: DB, ledger: LedgerResult): ReconIssue[] {
  const snapshotDate = latestSnapshotDate(db);
  if (!snapshotDate) return [];
  const assets = getAssets(db);
  const posRows = db.prepare("SELECT ticker, SUM(quantity) q FROM position_snapshots WHERE snapshot_date = ? GROUP BY ticker").all(snapshotDate) as {
    ticker: string;
    q: number;
  }[];
  const pos = new Map(posRows.map((r) => [r.ticker, r.q]));
  const b3Tickers = new Set((db.prepare("SELECT DISTINCT ticker FROM b3_movements").all() as { ticker: string }[]).map((r) => r.ticker));
  const dismissed = new Set((db.prepare("SELECT key FROM dismissed_issues").all() as { key: string }[]).map((r) => r.key));

  const raw = db.prepare("SELECT date, ticker, movement, quantity, value FROM b3_movements WHERE movement IN ('Atualização', 'Resgate', 'Direito de Subscrição') ORDER BY date").all() as unknown as Ignored[];
  // Nomes que cada ticker já teve nos extratos (a Posição traz só o nome atual, ex.: TRPL4/ISAE4).
  const names = new Map<string, Set<string>>();
  for (const r of db.prepare("SELECT DISTINCT ticker, product FROM b3_movements").all() as { ticker: string; product: string }[]) {
    const n = normName(parseProduct(r.product).name);
    if (n) names.set(r.ticker, (names.get(r.ticker) ?? new Set()).add(n));
  }
  const sharesName = (a: string, b: string) => [...(names.get(a) ?? [])].some((n) => names.get(b)?.has(n));
  const byTicker = (t: string, mov: string) => raw.filter((r) => r.ticker === t && r.movement === mov);
  const lastTradeDate = (t: string) =>
    ledger.events.filter((e) => e.ticker === t && e.kind !== "IGNORED" && e.kind !== "INCOME").reduce((d, e) => (e.date > d ? e.date : d), "");

  const candidates = new Set<string>([...pos.keys(), ...[...ledger.holdings.values()].filter((h) => h.qty > EPS).map((h) => h.ticker)]);
  const diffs: { ticker: string; ledgerQty: number; positionQty: number }[] = [];
  for (const t of candidates) {
    const cls = assets.get(t)?.class;
    if (cls === "cripto" || cls === "internacional") continue;
    // Ativo só lançado manualmente e fora da B3 não entra na conciliação.
    if (!pos.has(t) && !b3Tickers.has(t)) continue;
    const ledgerQty = ledger.qtyAt(t, snapshotDate);
    const positionQty = pos.get(t) ?? 0;
    if (Math.abs(ledgerQty - positionQty) > EPS) diffs.push({ ticker: t, ledgerQty, positionQty });
  }

  const orphans = diffs.filter((d) => d.positionQty < EPS && d.ledgerQty > EPS);
  const deficits = diffs.filter((d) => d.positionQty - d.ledgerQty > EPS);
  const used = new Set<string>();
  const issues: ReconIssue[] = [];

  for (const d of deficits) {
    const missing = d.positionQty - d.ledgerQty;
    const updates = byTicker(d.ticker, "Atualização");

    // 1) Conversão: outro ticker sumiu da posição e (a) tem o mesmo nome ou (b) recebeu
    //    "Atualização"/"Resgate" no mesmo dia de uma "Atualização" deste ticker.
    let best: { orphan: (typeof orphans)[number]; date: string; score: number } | null = null;
    for (const o of orphans) {
      if (used.has(o.ticker)) continue;
      const sameName = sharesName(o.ticker, d.ticker);
      const oMarks = [...byTicker(o.ticker, "Atualização"), ...byTicker(o.ticker, "Resgate")];
      const coDated = updates.find((u) => oMarks.some((m) => daysBetween(m.date, u.date) <= 7));
      const after = updates.find((u) => u.date >= lastTradeDate(o.ticker));
      const score = (sameName ? 2 : 0) + (coDated ? 3 : 0);
      const date = coDated?.date ?? after?.date;
      if (score > 0 && date && (!best || score > best.score)) best = { orphan: o, date, score };
    }
    if (best) {
      used.add(best.orphan.ticker);
      const fromQty = ledger.qtyAt(best.orphan.ticker, best.date) || best.orphan.ledgerQty;
      const resgate = byTicker(best.orphan.ticker, "Resgate").find((r) => daysBetween(r.date, best!.date) <= 30);
      const cash = resgate?.value ?? 0;
      const suggestion: ManualEvent = {
        date: best.date,
        kind: "CONVERSION",
        ticker: best.orphan.ticker,
        ticker_to: d.ticker,
        quantity: fromQty,
        quantity_to: missing,
        cash,
        note: "Sugerido pela conciliação",
      };
      const ratio = missing / fromQty;
      issues.push({
        key: `conv:${best.orphan.ticker}>${d.ticker}:${fmtQty(fromQty)}>${fmtQty(missing)}`,
        ticker: d.ticker,
        ledgerQty: d.ledgerQty,
        positionQty: d.positionQty,
        message: `${best.orphan.ticker} sumiu da carteira e ${d.ticker} tem ${fmtQty(missing)} cota(s) sem origem.`,
        suggestionText:
          Math.abs(ratio - 1) < EPS
            ? `Troca de ticker em ${fmtDate(best.date)}: ${fmtQty(fromQty)} ${best.orphan.ticker} → ${fmtQty(missing)} ${d.ticker}, mantendo o custo.`
            : `Incorporação em ${fmtDate(best.date)}: ${fmtQty(fromQty)} ${best.orphan.ticker} → ${fmtQty(missing)} ${d.ticker} (fator ${ratio.toFixed(4)})` +
              (cash ? `, com ${cash.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} de frações em dinheiro` : "") +
              ". O custo é transferido.",
        suggestion,
        needsInput: [],
      });
      continue;
    }

    // 2) Recibo de subscrição exercido: a B3 registra o direito, mas não o preço pago.
    const rights = byTicker(d.ticker, "Direito de Subscrição").filter((r) => r.quantity > EPS);
    if (rights.length) {
      const date = rights[rights.length - 1]!.date;
      issues.push({
        key: `sub:${d.ticker}:${fmtQty(missing)}`,
        ticker: d.ticker,
        ledgerQty: d.ledgerQty,
        positionQty: d.positionQty,
        message: `${fmtQty(missing)} ${d.ticker} na posição vieram de subscrição, mas o extrato não traz o preço pago.`,
        suggestionText: `Registrar subscrição de ${fmtQty(missing)} ${d.ticker}. Informe o preço por cota.`,
        suggestion: { date, kind: "SUBSCRIPTION", ticker: d.ticker, quantity: missing, price: null, note: "Subscrição" },
        needsInput: ["price"],
      });
      continue;
    }

    // 3) Entrada sem histórico (compra anterior ao extrato, evento societário sem par etc.).
    const firstUpdate = updates.find((u) => Math.abs(u.quantity - missing) < EPS) ?? updates[0];
    const sameDay = firstUpdate
      ? raw.filter((r) => r.movement === "Atualização" && r.date === firstUpdate.date && r.ticker !== d.ticker).map((r) => r.ticker)
      : [];
    issues.push({
      key: `entry:${d.ticker}:${fmtQty(missing)}`,
      ticker: d.ticker,
      ledgerQty: d.ledgerQty,
      positionQty: d.positionQty,
      message:
        `${fmtQty(missing)} ${d.ticker} na posição não aparecem nas movimentações` +
        (firstUpdate ? ` (houve uma "Atualização" em ${fmtDate(firstUpdate.date)}${sameDay.length ? `, no mesmo dia de ${[...new Set(sameDay)].join(", ")}` : ""})` : "") +
        ".",
      suggestionText: `Registrar entrada de ${fmtQty(missing)} ${d.ticker}. Informe o preço médio (custo por cota); use 0 se foi recebido sem custo.`,
      suggestion: { date: firstUpdate?.date ?? snapshotDate, kind: "ENTRY", ticker: d.ticker, quantity: missing, price: null, note: "Entrada sem histórico" },
      needsInput: ["price"],
    });
  }

  // Sobras: ledger com mais do que a posição (venda/baixa não registrada).
  for (const d of diffs) {
    if (used.has(d.ticker) || d.positionQty - d.ledgerQty > EPS) continue;
    const extra = d.ledgerQty - d.positionQty;
    issues.push({
      key: `out:${d.ticker}:${fmtQty(extra)}`,
      ticker: d.ticker,
      ledgerQty: d.ledgerQty,
      positionQty: d.positionQty,
      message: `O histórico tem ${fmtQty(extra)} ${d.ticker} a mais do que a posição da B3.`,
      suggestionText: `Registrar baixa de ${fmtQty(extra)} ${d.ticker}. Informe o preço de venda, ou deixe vazio para baixar pelo custo.`,
      suggestion: { date: snapshotDate, kind: "SELL", ticker: d.ticker, quantity: extra, price: null, note: "Baixa sem histórico" },
      needsInput: [],
    });
  }

  return issues.filter((i) => !dismissed.has(i.key));
}
