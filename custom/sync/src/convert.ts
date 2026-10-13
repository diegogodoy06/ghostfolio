/**
 * Extratos da B3 (.xlsx) -> atividades desejadas no Ghostfolio.
 *
 * O Ghostfolio só conhece BUY / SELL / DIVIDEND, então os eventos societários calculados pelo
 * motor da B3 viram operações equivalentes, e as quantidades anteriores a cada split do Yahoo
 * (inclui bonificações) são expressas em "unidades de hoje" para casar com o histórico de preços.
 */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./b3/db";
import { importFile } from "./b3/import";
import { buildLedger, type LedgerEvent } from "./b3/ledger";
import { reconcile } from "./b3/recon";
import { getAssets } from "./b3/assets";
import type { AssetClass, ManualEventKind } from "./b3/types";
import { round, yahooHasQuote, yahooSplits } from "./util";

export interface DesiredAsset {
  dataSource: "YAHOO" | "MANUAL";
  /** YAHOO: símbolo; MANUAL: identificado pelo nome (o símbolo é gerado pelo Ghostfolio). */
  symbol?: string;
  name: string;
  profile?: { assetClass: string; assetSubClass: string; comment: string; marketData: { date: string; marketPrice: number }[] };
}

export interface DesiredActivity {
  account: string;
  asset: DesiredAsset;
  type: "BUY" | "SELL" | "DIVIDEND";
  date: string;
  quantity: number;
  unitPrice: number;
  comment: string | null;
}

/** Correções informadas pelo usuário em ajustes.json. */
export interface Ajuste {
  tipo: "ENTRADA" | "SUBSCRICAO" | "COMPRA" | "VENDA" | "CONVERSAO" | "PRECO";
  ativo: string;
  data: string;
  quantidade?: number;
  preco?: number;
  ativo_destino?: string;
  quantidade_destino?: number;
  sobra?: number;
  obs?: string;
}

const KIND: Record<Exclude<Ajuste["tipo"], "PRECO">, ManualEventKind> = {
  ENTRADA: "ENTRY",
  SUBSCRICAO: "SUBSCRIPTION",
  COMPRA: "BUY",
  VENDA: "SELL",
  CONVERSAO: "CONVERSION",
};

const iso = (d: string) => `${d}T00:00:00.000Z`;
const EPS = 1e-6;

export function listStatements(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".xlsx") && !f.startsWith("~$"))
    .sort()
    .map((f) => path.join(dir, f));
}

export async function buildDesired(files: string[], ajustes: Ajuste[]) {
  const warnings: string[] = [];

  // 1) Mesmo pipeline do TradeView: importa, aplica ajustes, concilia.
  const db = openDb(":memory:");
  for (const f of files) {
    try {
      importFile(db, fs.readFileSync(f), path.basename(f));
    } catch (err) {
      warnings.push(`${path.basename(f)}: ${(err as Error).message}`);
    }
  }
  const insertEvent = db.prepare(
    "INSERT INTO manual_events (date, kind, ticker, ticker_to, quantity, quantity_to, price, cash, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  for (const a of ajustes) {
    if (a.tipo === "PRECO") continue;
    insertEvent.run(a.data, KIND[a.tipo], a.ativo.toUpperCase(), a.ativo_destino?.toUpperCase() ?? null, a.quantidade ?? 0, a.quantidade_destino ?? null, a.preco ?? null, a.sobra ?? null, a.obs ?? "ajustes.json", now);
  }
  let ledger = buildLedger(db);
  for (const issue of reconcile(db, ledger)) {
    const s = issue.suggestion;
    if (!s) continue;
    if (s.kind === "CONVERSION") {
      // Troca de ticker / incorporação: identificada com segurança pela conciliação.
      insertEvent.run(s.date, s.kind, s.ticker, s.ticker_to ?? null, s.quantity, s.quantity_to ?? null, null, s.cash ?? 0, "auto", now);
    } else {
      insertEvent.run(s.date, s.kind === "SELL" ? "SELL" : "ENTRY", s.ticker, null, s.quantity, null, 0, null, "auto", now);
      warnings.push(
        `${issue.ticker}: ${issue.message} Entrou com custo 0. Para corrigir, adicione em ajustes.json: ` +
          JSON.stringify({ tipo: s.kind === "SUBSCRIPTION" ? "SUBSCRICAO" : s.kind === "SELL" ? "VENDA" : "ENTRADA", ativo: s.ticker, data: s.date, quantidade: s.quantity, preco: 0 }),
      );
    }
  }
  ledger = buildLedger(db);
  const assets = getAssets(db);

  // 2) Fonte de cotação de cada ticker: Yahoo quando existe, senão ativo manual.
  const symbolOf = (ticker: string, cls: AssetClass) => {
    const receipt = /^([A-Z]{4})1[2-5]$/.exec(ticker); // recibo de FII -> cota principal
    return receipt && cls === "fii" ? `${receipt[1]}11` : ticker;
  };
  const used = new Set(ledger.events.filter((e) => e.kind !== "IGNORED").map((e) => e.ticker));
  for (const e of ledger.events) if (e.kind === "CONVERSION") used.add(e.tickerTo);
  const snapshot = db.prepare("SELECT ticker, snapshot_date d, SUM(value) v, SUM(quantity) q FROM position_snapshots GROUP BY ticker, snapshot_date").all() as any[];

  const source = new Map<string, DesiredAsset>();
  await Promise.all(
    [...used].map(async (ticker) => {
      const cls = (assets.get(ticker)?.class ?? "acao") as AssetClass;
      const sym = `${symbolOf(ticker, cls)}.SA`;
      if (["acao", "fii", "etf", "bdr"].includes(cls) && (await yahooHasQuote(sym))) {
        source.set(ticker, { dataSource: "YAHOO", symbol: sym, name: sym });
        return;
      }
      const fixed = cls === "tesouro" || cls === "renda_fixa";
      source.set(ticker, {
        dataSource: "MANUAL",
        name: fixed ? ticker : `${ticker} – ${assets.get(ticker)?.name ?? ""}`.trim(),
        profile: {
          assetClass: fixed ? "FIXED_INCOME" : cls === "fii" ? "REAL_ESTATE" : "EQUITY",
          assetSubClass: fixed ? "BOND" : cls === "etf" ? "ETF" : "STOCK",
          comment: fixed ? "Preço atualizado pelo Tesouro Transparente" : "Ticker sem cotação no Yahoo (deslistado ou renomeado)",
          marketData: snapshot.filter((s) => s.ticker === ticker && s.q > 0 && s.v != null).map((s) => ({ date: iso(s.d), marketPrice: round(s.v / s.q, 6) })),
        },
      });
    }),
  );

  // 3) Splits do Yahoo para expressar quantidades em unidades de hoje.
  const splits = new Map<string, { date: string; factor: number }[]>();
  await Promise.all([...new Set([...source.values()].filter((s) => s.symbol).map((s) => s.symbol!))].map(async (s) => splits.set(s, await yahooSplits(s))));
  const factorAfter = (ticker: string, date: string) => {
    const s = source.get(ticker);
    return s?.symbol ? (splits.get(s.symbol) ?? []).filter((x) => x.date > date).reduce((f, x) => f * x.factor, 1) : 1;
  };
  const coveredBySplit = (ticker: string, date: string) => {
    const s = source.get(ticker);
    return !!s?.symbol && (splits.get(s.symbol) ?? []).some((x) => Math.abs(Date.parse(x.date) - Date.parse(date)) <= 20 * 86_400_000);
  };

  // 4) Conta por instituição; lançamentos manuais vão para a instituição onde o ativo estava.
  const tickerInst = new Map((db.prepare("SELECT ticker, institution FROM b3_movements GROUP BY ticker").all() as any[]).map((r) => [r.ticker, r.institution]));
  const firstInst = (db.prepare("SELECT institution FROM b3_movements LIMIT 1").get() as any)?.institution as string | undefined;
  const accountName = (inst: string | undefined) => (inst ? inst.replace(/ (CCTVM|DTVM|CTVM).*$/, "").replace(/\bINVESTIMENTOS\b/, "Investimentos").trim() : "B3");

  const precos = ajustes.filter((a) => a.tipo === "PRECO");
  const out: DesiredActivity[] = [];
  const cost = new Map<string, { qty: number; cost: number }>();
  const track = (t: string) => cost.get(t) ?? cost.set(t, { qty: 0, cost: 0 }).get(t)!;
  const push = (e: LedgerEvent, type: DesiredActivity["type"], ticker: string, quantity: number, unitPrice: number, comment: string | null = null) => {
    if (quantity < EPS && type !== "DIVIDEND") return;
    const f = type === "DIVIDEND" && quantity === 1 ? 1 : factorAfter(ticker, e.date);
    out.push({
      account: accountName((e as any).institution ?? tickerInst.get(ticker) ?? tickerInst.get(e.ticker) ?? firstInst),
      asset: source.get(ticker)!,
      type,
      date: iso(e.date),
      quantity: round(quantity * f),
      unitPrice: round(unitPrice / f, 6),
      comment,
    });
  };
  const fractionCash = (from: LedgerEvent) =>
    ledger.events.find((x) => x.kind === "FRACTION_CASH" && x.ticker === from.ticker && x.date >= from.date) as Extract<LedgerEvent, { kind: "FRACTION_CASH" }> | undefined;

  for (const e of ledger.events) {
    const t = track(e.ticker);
    switch (e.kind) {
      case "BUY": {
        let value = e.value;
        if (value === 0 && e.source.startsWith("b3:")) {
          const fix = precos.find((p) => p.ativo.toUpperCase() === e.ticker && p.data === e.date);
          if (fix?.preco != null) value = e.qty * fix.preco;
          else
            warnings.push(
              `${e.ticker}: entrada de ${e.qty} em ${e.date} sem preço no extrato (ex.: devolução de aluguel). Custo 0; para corrigir: ` +
                JSON.stringify({ tipo: "PRECO", ativo: e.ticker, data: e.date, preco: 0 }),
            );
        }
        push(e, "BUY", e.ticker, e.qty, e.qty > 0 ? value / e.qty : 0, e.source.startsWith("manual") ? "Lançamento manual" : null);
        t.qty += e.qty;
        t.cost += value;
        break;
      }
      case "SELL":
      case "MATURITY": {
        const avg = t.qty > EPS ? t.cost / t.qty : 0;
        const price = e.value != null && e.value > 0 ? e.value / e.qty : avg;
        push(e, "SELL", e.ticker, e.qty, price, e.kind === "MATURITY" ? "Vencimento/resgate" : null);
        t.cost -= avg * e.qty;
        t.qty -= e.qty;
        break;
      }
      case "BONUS":
      case "SPLIT_ADD":
        if (!coveredBySplit(e.ticker, e.date)) push(e, "BUY", e.ticker, e.qty, 0, e.kind === "BONUS" ? "Bonificação" : "Desdobro");
        t.qty += e.qty;
        break;
      case "REVERSE_SPLIT": {
        const removed = t.qty - e.newQty;
        if (removed > EPS && !coveredBySplit(e.ticker, e.date)) push(e, "SELL", e.ticker, removed, 0, `Grupamento (novo total ${e.newQty})`);
        t.qty = e.newQty;
        break;
      }
      case "FRACTION_OUT": {
        const cash = fractionCash(e);
        const avg = t.qty > EPS ? t.cost / t.qty : 0;
        push(e, "SELL", e.ticker, e.qty, cash ? cash.value / e.qty : 0, "Fração vendida em leilão");
        t.cost -= avg * e.qty;
        t.qty -= e.qty;
        break;
      }
      case "INCOME":
      case "AMORTIZATION": {
        const q = e.qty > EPS ? e.qty : 1;
        push(e, "DIVIDEND", e.ticker, q, e.value / q, e.kind === "AMORTIZATION" ? "Amortização" : e.type);
        break;
      }
      case "CONVERSION": {
        const avg = t.qty > EPS ? t.cost / t.qty : 0;
        const moved = avg * e.qty;
        push(e, "SELL", e.ticker, e.qty, (moved + e.cash) / e.qty, `Convertido em ${e.tickerTo}`);
        push(e, "BUY", e.tickerTo, e.qtyTo, moved / e.qtyTo, `Recebido de ${e.ticker}`);
        t.qty -= e.qty;
        t.cost -= moved;
        const to = track(e.tickerTo);
        to.qty += e.qtyTo;
        to.cost += moved;
        break;
      }
      case "FRACTION_CASH":
      case "IGNORED":
        break;
    }
  }

  // O Ghostfolio rejeita atividades idênticas: agrupa somando a quantidade.
  const merged = new Map<string, DesiredActivity>();
  for (const a of out) {
    const key = [a.account, a.date, a.type, a.asset.dataSource, a.asset.symbol ?? a.asset.name, a.unitPrice, a.comment].join("|");
    const m = merged.get(key);
    if (m) m.quantity = round(m.quantity + a.quantity);
    else merged.set(key, { ...a });
  }
  const coverageEnd = (db.prepare("SELECT MAX(date) d FROM b3_movements").get() as { d: string | null }).d;
  return { activities: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)), warnings, coverageEnd };
}
