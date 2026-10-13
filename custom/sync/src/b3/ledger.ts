import type { DB } from "./db";
import type { AssetClass, IncomeEntry, ManualEvent } from "./types";
import { getAssets } from "./assets";

/**
 * Motor de carteira: converte as linhas cruas da B3 e os lançamentos manuais numa sequência
 * de eventos normalizados e calcula quantidade, custo (preço médio), lucro realizado e proventos.
 *
 * Convenções da Movimentação da B3 (validadas contra os extratos reais):
 * - "Transferência - Liquidação" é a compra/venda em bolsa liquidada; traz preço.
 * - "Bonificação em Ativos" e "Desdobro" trazem a quantidade ADICIONAL recebida.
 * - "Grupamento" traz o NOVO TOTAL de ações após o grupamento.
 * - "Fração em Ativos" retira a fração; o "Leilão de Fração" posterior paga em dinheiro.
 * - "Atualização" é ambígua (às vezes troca de ticker/incorporação, às vezes só reinforma o
 *   saldo), por isso é ignorada aqui e tratada pela conciliação com sugestões ao usuário.
 */

export type LedgerEvent =
  | { kind: "BUY"; date: string; ticker: string; qty: number; value: number; source: string }
  | { kind: "SELL"; date: string; ticker: string; qty: number; value: number | null; source: string }
  | { kind: "BONUS"; date: string; ticker: string; qty: number; source: string }
  | { kind: "SPLIT_ADD"; date: string; ticker: string; qty: number; source: string }
  | { kind: "REVERSE_SPLIT"; date: string; ticker: string; newQty: number; institution: string; source: string }
  | { kind: "FRACTION_OUT"; date: string; ticker: string; qty: number; source: string }
  | { kind: "FRACTION_CASH"; date: string; ticker: string; value: number; source: string }
  | { kind: "MATURITY"; date: string; ticker: string; qty: number; value: number | null; source: string }
  | { kind: "AMORTIZATION"; date: string; ticker: string; qty: number; value: number; source: string }
  | { kind: "INCOME"; date: string; ticker: string; type: string; qty: number; unit: number | null; value: number; source: string }
  | { kind: "CONVERSION"; date: string; ticker: string; tickerTo: string; qty: number; qtyTo: number; cash: number; source: string }
  | { kind: "IGNORED"; date: string; ticker: string; movement: string; known: boolean; source: string };

export interface B3Row {
  id: number;
  direction: "in" | "out";
  date: string;
  movement: string;
  ticker: string;
  institution: string;
  quantity: number;
  unit_price: number | null;
  value: number | null;
}

const INCOME_TYPES: Record<string, string> = {
  rendimento: "Rendimento",
  dividendo: "Dividendo",
  "juros sobre capital próprio": "JCP",
  juros: "Juros",
};

// Movimentações sem efeito na quantidade/custo (informativas ou tratadas por outro evento).
const KNOWN_IGNORED = new Set([
  "atualização",
  "transferência",
  "direito de subscrição",
  "direitos de subscrição - não exercido",
  "direitos de subscrição - exercido",
  "cessão de direitos",
  "cessão de direitos - solicitada",
  "recibo de subscrição",
  "empréstimo",
]);

export function mapB3Row(r: B3Row, assetClass: AssetClass | undefined): LedgerEvent {
  const m = r.movement.trim().toLowerCase();
  const base = { date: r.date, ticker: r.ticker, source: `b3:${r.id}` };
  const value = r.value ?? (r.unit_price != null ? r.unit_price * r.quantity : null);
  const ignored = (known: boolean): LedgerEvent => ({ ...base, kind: "IGNORED", movement: r.movement, known });

  if (INCOME_TYPES[m]) {
    return { ...base, kind: "INCOME", type: INCOME_TYPES[m]!, qty: r.quantity, unit: r.unit_price, value: value ?? 0 };
  }
  if (m === "empréstimo" && (r.value ?? 0) > 0) {
    return { ...base, kind: "INCOME", type: "Aluguel", qty: r.quantity, unit: r.unit_price, value: r.value! };
  }
  if (r.quantity === 0 && m !== "amortização") return ignored(true);

  switch (m) {
    case "transferência - liquidação":
    case "compra":
    case "compra / venda":
    case "venda":
      if (r.direction === "in") return { ...base, kind: "BUY", qty: r.quantity, value: value ?? 0 };
      return { ...base, kind: "SELL", qty: r.quantity, value };
    case "bonificação em ativos":
      return { ...base, kind: "BONUS", qty: r.quantity };
    case "desdobro":
      return { ...base, kind: "SPLIT_ADD", qty: r.quantity };
    case "grupamento":
      return { ...base, kind: "REVERSE_SPLIT", newQty: r.quantity, institution: r.institution };
    case "fração em ativos":
      return { ...base, kind: "FRACTION_OUT", qty: r.quantity };
    case "leilão de fração":
      return { ...base, kind: "FRACTION_CASH", value: value ?? 0 };
    case "vencimento":
      return { ...base, kind: "MATURITY", qty: r.quantity, value };
    case "resgate":
      // Em renda fixa é o resgate do título; em fundos listados é a sobra de uma incorporação,
      // coberta pelo evento de conversão confirmado pelo usuário.
      if (assetClass === "renda_fixa" || assetClass === "tesouro") return { ...base, kind: "MATURITY", qty: r.quantity, value };
      return ignored(true);
    case "amortização":
      return { ...base, kind: "AMORTIZATION", qty: r.quantity, value: value ?? 0 };
  }
  return ignored(KNOWN_IGNORED.has(m));
}

export function mapManualEvent(e: ManualEvent): LedgerEvent {
  const base = { date: e.date, ticker: e.ticker, source: `manual:${e.id}` };
  const price = e.price ?? 0;
  switch (e.kind) {
    case "ENTRY":
    case "BUY":
    case "SUBSCRIPTION":
      return { ...base, kind: "BUY", qty: e.quantity, value: e.quantity * price };
    case "SELL":
      return { ...base, kind: "SELL", qty: e.quantity, value: e.price == null ? null : e.quantity * price };
    case "CONVERSION":
      return { ...base, kind: "CONVERSION", tickerTo: e.ticker_to!, qty: e.quantity, qtyTo: e.quantity_to ?? e.quantity, cash: e.cash ?? 0 };
  }
}

// Ordem dentro do mesmo dia: entradas, eventos societários, saídas, dinheiro.
const RANK: Record<LedgerEvent["kind"], number> = {
  BUY: 0,
  BONUS: 1,
  SPLIT_ADD: 1,
  REVERSE_SPLIT: 1,
  CONVERSION: 2,
  FRACTION_OUT: 3,
  SELL: 4,
  MATURITY: 4,
  FRACTION_CASH: 5,
  AMORTIZATION: 5,
  INCOME: 5,
  IGNORED: 6,
};

export interface Holding {
  ticker: string;
  qty: number;
  cost: number;
  realized: number;
  income: number;
  amortized: number;
  byInstitution: Map<string, number>;
  pendingFractionCost: number;
}

export interface LedgerResult {
  holdings: Map<string, Holding>;
  timeline: Map<string, { date: string; qty: number }[]>;
  incomes: IncomeEntry[];
  events: LedgerEvent[];
  /** Quantidade ao fim do dia `date`. */
  qtyAt(ticker: string, date: string): number;
}

const EPS = 1e-6;

export function runLedger(input: LedgerEvent[]): LedgerResult {
  const events = [...input].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : RANK[a.kind] - RANK[b.kind]));
  const holdings = new Map<string, Holding>();
  const timeline = new Map<string, { date: string; qty: number }[]>();
  const incomes: IncomeEntry[] = [];

  const h = (ticker: string): Holding => {
    let x = holdings.get(ticker);
    if (!x) {
      x = { ticker, qty: 0, cost: 0, realized: 0, income: 0, amortized: 0, byInstitution: new Map(), pendingFractionCost: 0 };
      holdings.set(ticker, x);
    }
    return x;
  };
  const avg = (x: Holding) => (x.qty > EPS ? x.cost / x.qty : 0);
  const removeQty = (x: Holding, q: number) => {
    const take = Math.min(q, x.qty);
    const c = avg(x) * take;
    x.qty -= take;
    x.cost -= c;
    return c;
  };
  const settle = (x: Holding, date: string) => {
    if (Math.abs(x.qty) < EPS) {
      // Posição zerada: qualquer custo residual vira resultado realizado.
      x.realized -= x.cost;
      x.qty = 0;
      x.cost = 0;
    }
    const tl = timeline.get(x.ticker) ?? [];
    const last = tl[tl.length - 1];
    if (last && last.date === date) last.qty = x.qty;
    else if (!last || Math.abs(last.qty - x.qty) > EPS) tl.push({ date, qty: x.qty });
    timeline.set(x.ticker, tl);
  };

  for (const e of events) {
    const x = h(e.ticker);
    switch (e.kind) {
      case "BUY":
        x.qty += e.qty;
        x.cost += e.value;
        settle(x, e.date);
        break;
      case "SELL":
      case "MATURITY": {
        const c = removeQty(x, e.qty);
        // Sem valor de venda conhecido (ex.: vencimento de CDB sem valor no extrato), assume custo.
        x.realized += e.value != null && e.value > 0 ? e.value - c : 0;
        settle(x, e.date);
        break;
      }
      case "BONUS":
      case "SPLIT_ADD":
        x.qty += e.qty;
        settle(x, e.date);
        break;
      case "REVERSE_SPLIT": {
        const before = x.byInstitution.get(e.institution) ?? x.qty;
        x.qty += e.newQty - before;
        x.byInstitution.set(e.institution, e.newQty);
        settle(x, e.date);
        break;
      }
      case "FRACTION_OUT":
        x.pendingFractionCost += removeQty(x, e.qty);
        settle(x, e.date);
        break;
      case "FRACTION_CASH":
        x.realized += e.value - x.pendingFractionCost;
        x.pendingFractionCost = 0;
        break;
      case "AMORTIZATION": {
        // Amortização devolve capital: reduz o custo, não é provento.
        const cut = Math.min(x.cost, e.value);
        x.cost -= cut;
        x.realized += e.value - cut;
        x.amortized += e.value;
        incomes.push({ date: e.date, ticker: e.ticker, type: "Amortização", quantity: e.qty, unitValue: null, value: e.value, status: "recebido" });
        break;
      }
      case "INCOME":
        x.income += e.value;
        incomes.push({ date: e.date, ticker: e.ticker, type: e.type, quantity: e.qty, unitValue: e.unit, value: e.value, status: "recebido" });
        break;
      case "CONVERSION": {
        const to = h(e.tickerTo);
        const moved = removeQty(x, e.qty);
        x.realized += e.cash;
        to.qty += e.qtyTo;
        to.cost += moved;
        settle(x, e.date);
        settle(to, e.date);
        break;
      }
      case "IGNORED":
        break;
    }
    // Mantém a quantidade por instituição coerente para grupamentos futuros.
    if (e.source.startsWith("b3:") && (e.kind === "BUY" || e.kind === "SELL" || e.kind === "BONUS" || e.kind === "SPLIT_ADD" || e.kind === "FRACTION_OUT")) {
      const inst = (e as any).institution ?? "";
      if (inst) x.byInstitution.set(inst, (x.byInstitution.get(inst) ?? 0) + (e.kind === "SELL" || e.kind === "FRACTION_OUT" ? -e.qty : e.qty));
    }
  }

  return {
    holdings,
    timeline,
    incomes,
    events,
    qtyAt(ticker, date) {
      const tl = timeline.get(ticker);
      if (!tl) return 0;
      let q = 0;
      for (const p of tl) {
        if (p.date > date) break;
        q = p.qty;
      }
      return q;
    },
  };
}

export function loadB3Rows(db: DB): B3Row[] {
  return db.prepare("SELECT id, direction, date, movement, ticker, institution, quantity, unit_price, value FROM b3_movements").all() as unknown as B3Row[];
}

export function loadManualEvents(db: DB): ManualEvent[] {
  return db.prepare("SELECT * FROM manual_events ORDER BY date, id").all() as unknown as ManualEvent[];
}

export function buildLedger(db: DB): LedgerResult {
  const assets = getAssets(db);
  const events: LedgerEvent[] = [
    ...loadB3Rows(db).map((r) => {
      const ev = mapB3Row(r, assets.get(r.ticker)?.class);
      return Object.assign(ev, { institution: r.institution });
    }),
    ...loadManualEvents(db).map(mapManualEvent),
  ];
  return runLedger(events);
}
