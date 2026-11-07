/**
 * Planejamento das finanças: lançamentos previstos (contas fixas, assinaturas, salário), faturas
 * dos cartões mês a mês (passadas e futuras, com parcelas e assinaturas já comprometidas),
 * projeção de caixa dos próximos meses e lançamentos manuais no Firefly.
 */
import crypto from "node:crypto";
import {
  type CardConfig,
  type FinAccount,
  type FinConfig,
  type Tx,
  INSTALLMENT,
  PAYMENT,
  accountTransactions,
  accounts,
  addDays,
  ff,
  installmentOf,
  iso,
  monthRange,
  today,
  transactions,
  ymd,
} from "./financas";

export interface Planned {
  id: string;
  kind: "expense" | "income";
  description: string;
  amount: number;
  /** Conta ou cartão (id do Firefly); vazio = qualquer conta. */
  accountId: string | null;
  category: string | null;
  /** Dia do mês em que costuma cair. */
  day: number;
  freq: "monthly" | "once";
  /** Primeiro mês ("YYYY-MM"). */
  start: string;
  /** Último mês ("YYYY-MM"), opcional. */
  end?: string | null;
  /** Texto que identifica o lançamento no extrato (nome de quem recebe/paga). */
  match?: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const normTxt = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9*]+/g, " ")
    .trim();
export const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const monthOf = (d: Date) => iso(d).slice(0, 7);
const counterpartyOf = (t: Tx) => (t.type === "deposit" ? t.sourceName : t.destinationName) ?? "";

// ---------- ciclos das faturas ----------

/** Ciclo da fatura que vence no mês `ym`. */
export function cycleForDue(c: CardConfig, ym: string) {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const due = ymd(y, m - 1, c.due);
  // Vencimento depois do fechamento no mesmo mês; senão o fechamento foi no mês anterior.
  const close = c.due > c.closing ? ymd(y, m - 1, c.closing) : ymd(y, m - 2, c.closing);
  const prev = ymd(close.getUTCFullYear(), close.getUTCMonth() - 1, c.closing);
  return { month: ym, start: iso(addDays(prev, 1)), end: iso(close), due: iso(due) };
}

/** Mês de vencimento da fatura em que cai uma compra feita em `date` ("YYYY-MM-DD"). */
export function dueMonthOf(c: CardConfig, date: string) {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const closeThis = iso(ymd(y, m - 1, c.closing));
  const closeMonth = date <= closeThis ? date.slice(0, 7) : addMonths(date.slice(0, 7), 1);
  return c.due > c.closing ? closeMonth : addMonths(closeMonth, 1);
}

// ---------- previstos: ocorrências e conferência com o extrato ----------

export interface Occurrence {
  plannedId: string;
  kind: Planned["kind"];
  description: string;
  category: string | null;
  accountId: string | null;
  date: string;
  amount: number;
  matched: { id: string; date: string; amount: number; description: string; count: number } | null;
}

const activeIn = (p: Planned, ym: string) => (p.freq === "once" ? p.start === ym : p.start <= ym && (!p.end || ym <= p.end));

/** Ocorrências dos previstos no mês, cada uma ligada (ou não) a um lançamento de verdade. */
export function occurrencesIn(planned: Planned[], ym: string, txs: Tx[]): Occurrence[] {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const used = new Set<string>();
  const list = planned.filter((p) => activeIn(p, ym));
  // Primeiro os que têm texto de identificação (mais seguros), depois os por categoria e valor.
  const order = [...list].sort((a, b) => Number(!a.match) - Number(!b.match));
  const found = new Map<string, Tx[]>();
  const uid = (t: Tx) => `${t.id}|${t.amount}|${t.description}`;
  for (const p of order) {
    const key = normTxt(p.match || p.description);
    const pool = txs.filter((t) => {
      if (used.has(uid(t)) || t.date.slice(0, 7) !== ym) return false;
      if (p.kind === "expense" ? t.type !== "withdrawal" : t.type !== "deposit") return false;
      return !p.accountId || (p.kind === "expense" ? t.sourceId : t.destinationId) === p.accountId;
    });
    // Pelo texto: todos os do mês contam (salário em dois Pix, assinatura em duas cobranças).
    let hits = key ? pool.filter((t) => normTxt(`${t.description} ${counterpartyOf(t)}`).includes(key)) : [];
    if (!hits.length && !p.match && p.category) {
      const best = pool
        .filter((t) => t.category === p.category && Math.abs(t.amount - p.amount) <= p.amount * 0.15)
        .sort((a, b) => Math.abs(a.amount - p.amount) - Math.abs(b.amount - p.amount))[0];
      hits = best ? [best] : [];
    }
    if (hits.length) {
      hits.forEach((t) => used.add(uid(t)));
      found.set(p.id, hits);
    }
  }
  return list
    .map((p) => {
      const hits = found.get(p.id);
      return {
        plannedId: p.id,
        kind: p.kind,
        description: p.description,
        category: p.category,
        accountId: p.accountId,
        date: iso(ymd(y, m - 1, p.day)),
        amount: p.amount,
        matched: hits ? { id: hits[0]!.id, date: hits[0]!.date, amount: r2(hits.reduce((a, t) => a + t.amount, 0)), description: hits[0]!.description, count: hits.length } : null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- faturas mês a mês ----------

export interface InvoiceItem {
  id: string | null;
  date: string;
  description: string;
  category: string | null;
  amount: number;
  /** posted = lançado no Firefly; installment = parcela que ainda vai cair; planned = assinatura/conta prevista. */
  source: "posted" | "installment" | "planned";
}
export interface Invoice {
  month: string;
  start: string;
  end: string;
  due: string;
  status: "paga" | "fechada" | "aberta" | "futura";
  posted: number;
  installments: number;
  planned: number;
  total: number;
  paid: number;
  items: InvoiceItem[];
}
export interface CardBook {
  id: string;
  name: string;
  balance: number;
  config: CardConfig | null;
  invoices: Invoice[];
}


/** Faturas de cada cartão de `back` meses atrás até `ahead` meses à frente (pelo mês do vencimento). */
export async function cardBooks(token: string, cfg: FinConfig, accs: FinAccount[], back = 12, ahead = 12): Promise<CardBook[]> {
  const now = today();
  const todayIso = iso(now);
  const cur = monthOf(now);
  const planned = cfg.planned ?? [];
  return Promise.all(
    accs
      .filter((a) => a.card)
      .map(async (a): Promise<CardBook> => {
        const c = cfg.cards?.[a.id];
        if (!c) return { id: a.id, name: a.name, balance: a.balance, config: null, invoices: [] };
        const months = Array.from({ length: back + ahead + 1 }, (_, i) => addMonths(cur, i - back));
        const cycles = months.map((m) => cycleForDue(c, m));
        const txs = await accountTransactions(token, a.id, cycles[0]!.start, cycles.at(-1)!.end);
        const inv = new Map<string, Invoice>(
          cycles.map((cy) => [
            cy.month,
            {
              ...cy,
              status: cy.due < todayIso ? "paga" : cy.end < todayIso ? "fechada" : cy.start <= todayIso ? "aberta" : "futura",
              posted: 0,
              installments: 0,
              planned: 0,
              total: 0,
              paid: 0,
              items: [],
            },
          ]),
        );
        const invoiceOf = (date: string) => cycles.find((cy) => date >= cy.start && date <= cy.end)?.month;

        // Lançado: compras menos estornos; pagamentos contam à parte.
        // Parcelas: séries pela descrição e total de parcelas; a 1ª costuma vir com centavos diferentes.
        interface Series { key: string; amount: number; n: number; month: string; description: string; category: string | null; seen: Set<number> }
        const series: Series[] = [];
        const seriesOf = (desc: string, total: number, amount: number) => {
          const key = `${normTxt(desc.replace(INSTALLMENT, ""))}|${total}`;
          const same = series.filter((x) => x.key === key);
          return same.find((x) => Math.abs(x.amount - amount) <= Math.max(1, x.amount * 0.03)) ?? null;
        };
        for (const t of [...txs].sort((x, y) => x.date.localeCompare(y.date))) {
          const m = invoiceOf(t.date);
          if (!m) continue;
          const i = inv.get(m)!;
          const isPayment = t.type === "transfer" ? t.destinationId === a.id : t.type === "deposit" && t.destinationId === a.id && PAYMENT.test(t.description);
          if (isPayment) {
            // O pagamento feito no ciclo seguinte quita a fatura anterior.
            const prev = inv.get(addMonths(m, -1));
            if (prev) prev.paid += t.amount;
            continue;
          }
          let v = 0;
          if (t.type === "withdrawal" && t.sourceId === a.id) v = t.amount;
          else if (t.type === "deposit" && t.destinationId === a.id) v = -t.amount;
          else continue;
          i.posted += v;
          i.items.push({ id: t.id, date: t.date, description: t.description, category: t.category, amount: r2(v), source: "posted" });
          const p = t.type === "withdrawal" ? installmentOf(t.description) : null;
          if (p) {
            let s = seriesOf(t.description, p.total, t.amount);
            if (!s) {
              s = { key: `${normTxt(t.description.replace(INSTALLMENT, ""))}|${p.total}`, amount: t.amount, n: 0, month: m, description: t.description, category: t.category, seen: new Set() };
              series.push(s);
            }
            s.seen.add(p.n);
            if (p.n >= s.n) Object.assign(s, { n: p.n, month: m, amount: t.amount, description: t.description, category: t.category });
          }
        }
        // Parcelas que ainda vão cair.
        for (const s of series) {
          const total = Number(s.key.split("|").at(-1));
          for (let k = s.n + 1; k <= total; k++) {
            const i = inv.get(addMonths(s.month, k - s.n));
            if (!i || s.seen.has(k)) continue;
            i.installments += s.amount;
            i.items.push({ id: null, date: i.start, description: s.description.replace(INSTALLMENT, `${k}/${total}`), category: s.category, amount: s.amount, source: "installment" });
          }
        }
        // Assinaturas e contas previstas neste cartão, ainda não lançadas.
        for (const p of planned.filter((x) => x.kind === "expense" && x.accountId === a.id)) {
          for (let k = -1; k <= ahead + 1; k++) {
            const ym = addMonths(cur, k);
            if (!activeIn(p, ym)) continue;
            const occ = occurrencesIn([p], ym, txs)[0]!;
            if (occ.matched) continue;
            const m = dueMonthOf(c, occ.date);
            const i = inv.get(m);
            if (!i || i.status === "paga" || i.status === "fechada") continue;
            i.planned += p.amount;
            i.items.push({ id: null, date: occ.date, description: p.description, category: p.category, amount: p.amount, source: "planned" });
          }
        }
        for (const i of inv.values()) {
          i.posted = r2(i.posted);
          i.installments = r2(i.installments);
          i.planned = r2(i.planned);
          i.paid = r2(i.paid);
          i.total = r2(i.posted + i.installments + i.planned);
          i.items.sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
        }
        return { id: a.id, name: a.name, balance: a.balance, config: c, invoices: [...inv.values()] };
      }),
  );
}

// ---------- projeção de caixa ----------

export async function forecast(token: string, cfg: FinConfig, ahead = 12) {
  const accs = await accounts(token);
  const now = today();
  const todayIso = iso(now);
  const cur = monthOf(now);
  const planned = cfg.planned ?? [];
  const [books, txs, past] = await Promise.all([
    cardBooks(token, cfg, accs, 1, ahead),
    transactions(token, monthRange(cur).start, monthRange(addMonths(cur, ahead)).end),
    transactions(token, monthRange(addMonths(cur, -3)).start, monthRange(addMonths(cur, -1)).end),
  ]);
  const cardIds = new Set(accs.filter((a) => a.card).map((a) => a.id));
  const cashIds = new Set(accs.filter((a) => !a.card && a.netWorth).map((a) => a.id));
  const cash = r2(accs.filter((a) => cashIds.has(a.id)).reduce((s, a) => s + a.balance, 0));

  // Gastos do dia a dia: média dos 3 meses anteriores do que não é previsto nem parcela nem transferência.
  const pastMonths = [1, 2, 3].map((k) => addMonths(cur, -k));
  const matchedIds = new Set(pastMonths.flatMap((m) => occurrencesIn(planned, m, past).flatMap((o) => (o.matched ? [o.matched.id] : []))));
  const varOf = (m: string, onCard: boolean) =>
    past
      .filter((t) => t.type === "withdrawal" && t.date.startsWith(m) && cardIds.has(t.sourceId) === onCard && (onCard || cashIds.has(t.sourceId)))
      .filter((t) => !matchedIds.has(t.id) && !installmentOf(t.description))
      .reduce((s, t) => s + t.amount, 0);
  // Mediana dos meses com dado: uma viagem ou compra grande num mês não distorce a projeção.
  const median = (onCard: boolean) => {
    const vals = pastMonths.map((m) => varOf(m, onCard)).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) return 0;
    const h = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[h]! : (vals[h - 1]! + vals[h]!) / 2;
  };
  const dailyParts = { bank: r2(median(false)), card: r2(median(true)), months: pastMonths.reverse().map((m) => ({ month: m, bank: r2(varOf(m, false)), card: r2(varOf(m, true)) })) };
  const daily = r2(dailyParts.bank + dailyParts.card);
  const [cy, cm] = cur.split("-").map(Number) as [number, number];
  const daysIn = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
  const leftFraction = (daysIn - now.getUTCDate() + 1) / daysIn;

  // Lançamentos já feitos com data futura (salário agendado, conta programada…).
  const scheduledOf = (ym: string) =>
    r2(
      txs
        .filter((t) => t.date > todayIso && t.date.startsWith(ym))
        .reduce((s, t) => s + (cashIds.has(t.destinationId) ? t.amount : 0) - (cashIds.has(t.sourceId) ? t.amount : 0), 0),
    );

  let balance = cash;
  const months = Array.from({ length: ahead + 1 }, (_, i) => addMonths(cur, i)).map((ym) => {
    const occ = occurrencesIn(planned, ym, txs).filter((o) => !o.matched && !(o.accountId && cardIds.has(o.accountId)));
    const income = r2(occ.filter((o) => o.kind === "income").reduce((s, o) => s + o.amount, 0));
    const expense = r2(occ.filter((o) => o.kind === "expense").reduce((s, o) => s + o.amount, 0));
    const cards = books.map((b) => {
      const i = b.invoices.find((x) => x.month === ym);
      // Fatura deste mês já vencida: considera paga (o pagamento sai do saldo das contas).
      const open = i && !(ym === cur && i.due < todayIso) ? Math.max(0, r2(i.total - i.paid)) : 0;
      return { id: b.id, name: b.name, value: open };
    });
    const cardsTotal = r2(cards.reduce((s, x) => s + x.value, 0));
    const variable = r2(ym === cur ? daily * leftFraction : daily);
    const scheduled = scheduledOf(ym);
    const net = r2(income + scheduled - expense - cardsTotal - variable);
    balance = r2(balance + net);
    return { month: ym, income, expense, scheduled, variable, cards, cardsTotal, net, balance, items: occ };
  });
  return { cash, daily, dailyParts, months };
}

// ---------- sugestões de previstos a partir do histórico ----------

const GENERIC = /^(pix|compra no debito|compra elo debito vista|pix qr code|pix recebido|pix enviado|transf|ted|saque|deposito)/;

export async function suggestPlanned(token: string, cfg: FinConfig) {
  const cur = monthOf(today());
  const from = addMonths(cur, -4);
  const txs = await transactions(token, monthRange(from).start, monthRange(addMonths(cur, -1)).end);
  const planned = cfg.planned ?? [];
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    if (t.type !== "withdrawal" && t.type !== "deposit") continue;
    if (installmentOf(t.description)) continue;
    const who = normTxt(counterpartyOf(t));
    if (!who || who.length < 3 || GENERIC.test(who)) continue;
    const acc = t.type === "withdrawal" ? t.sourceId : t.destinationId;
    const k = `${t.type}|${acc}|${who}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const out: (Omit<Planned, "id" | "start" | "freq"> & { months: number })[] = [];
  for (const [k, list] of groups) {
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    const exact = new Set(list.map((t) => t.amount.toFixed(2))).size === 1;
    if (months.size < 3 && !(months.size === 2 && exact)) continue;
    // Um por mês: o maior (salário e aluguel não se repetem no mês).
    const perMonth = [...months].map((m) => list.filter((t) => t.date.startsWith(m)).sort((a, b) => b.amount - a.amount)[0]!);
    const amounts = perMonth.map((t) => t.amount);
    if (Math.max(...amounts) / Math.min(...amounts) > 1.35) continue;
    const [type, acc, who] = k.split("|") as [string, string, string];
    const last = perMonth.sort((a, b) => b.date.localeCompare(a.date))[0]!;
    const text = normTxt(`${last.description} ${counterpartyOf(last)}`);
    if (planned.some((p) => text.includes(normTxt(p.match || p.description)))) continue;
    const days = perMonth.map((t) => Number(t.date.slice(8))).sort((a, b) => a - b);
    out.push({
      kind: type === "withdrawal" ? "expense" : "income",
      description: counterpartyOf(last).slice(0, 80),
      amount: r2(last.amount),
      accountId: acc,
      category: last.category,
      day: days[Math.floor(days.length / 2)]!,
      match: who,
      months: months.size,
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export function validPlanned(v: any): Planned | null {
  const ym = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!v || typeof v !== "object") return null;
  const p: Planned = {
    id: typeof v.id === "string" && /^[\w-]{6,40}$/.test(v.id) ? v.id : crypto.randomUUID(),
    kind: v.kind === "income" ? "income" : "expense",
    description: String(v.description ?? "").trim().slice(0, 120),
    amount: r2(Math.abs(Number(v.amount))),
    accountId: v.accountId && /^\d+$/.test(String(v.accountId)) ? String(v.accountId) : null,
    category: v.category ? String(v.category).slice(0, 120) : null,
    day: Math.min(31, Math.max(1, Math.round(Number(v.day) || 1))),
    freq: v.freq === "once" ? "once" : "monthly",
    start: ym.test(v.start) ? v.start : monthOf(today()),
    end: v.end && ym.test(v.end) ? v.end : null,
    match: v.match ? String(v.match).trim().slice(0, 80) || null : null,
  };
  if (!p.description || !Number.isFinite(p.amount) || p.amount <= 0) return null;
  return p;
}

// ---------- lançamentos manuais ----------

export interface NewTx {
  kind: "expense" | "income" | "transfer";
  date: string;
  amount: number;
  description: string;
  accountId: string;
  toAccountId?: string;
  category?: string | null;
  counterparty?: string | null;
  installments?: number;
  notes?: string | null;
}

/** Cria o lançamento; compra parcelada no cartão vira uma transação por parcela, cada uma na sua fatura. */
export async function createTx(token: string, cfg: FinConfig, t: NewTx) {
  const n = Math.min(48, Math.max(1, Math.round(t.installments ?? 1)));
  const card = cfg.cards?.[t.accountId];
  const base = { notes: t.notes || "Lançado pelos relatórios", tags: ["lancado-no-app"] };
  const parts: { date: string; amount: number; description: string }[] = [];
  if (n > 1 && t.kind === "expense") {
    const each = Math.floor((t.amount / n) * 100) / 100;
    const first = r2(t.amount - each * (n - 1));
    const firstDue = card ? dueMonthOf(card, t.date) : t.date.slice(0, 7);
    for (let k = 1; k <= n; k++) {
      const date = k === 1 ? t.date : card ? cycleForDue(card, addMonths(firstDue, k - 1)).start : `${addMonths(t.date.slice(0, 7), k - 1)}-${t.date.slice(8)}`;
      parts.push({ date, amount: k === 1 ? first : each, description: `${t.description} - Parcela ${k}/${n}` });
    }
  } else parts.push({ date: t.date, amount: t.amount, description: t.description });

  const ids: string[] = [];
  for (const p of parts) {
    const common = { ...base, date: p.date, amount: p.amount.toFixed(2), description: p.description.slice(0, 1000), ...(t.category ? { category_name: t.category } : {}) };
    const tx =
      t.kind === "transfer"
        ? { ...common, type: "transfer", source_id: t.accountId, destination_id: t.toAccountId }
        : t.kind === "expense"
          ? { ...common, type: "withdrawal", source_id: t.accountId, destination_name: t.counterparty || t.description }
          : { ...common, type: "deposit", source_name: t.counterparty || t.description, destination_id: t.accountId };
    const r = await ff(token, "/transactions", { method: "POST", body: { error_if_duplicate_hash: false, apply_rules: !t.category, transactions: [tx] } });
    ids.push(String(r.data.id));
  }
  return { ids };
}

export async function updateTx(token: string, id: string, patch: { description?: string; amount?: number; date?: string; category?: string | null }) {
  const g = await ff(token, `/transactions/${id}`);
  const j = g.data.attributes.transactions[0];
  const body: Record<string, unknown> = { transaction_journal_id: j.transaction_journal_id };
  if (patch.description) body.description = patch.description.slice(0, 1000);
  if (patch.amount != null) body.amount = Math.abs(patch.amount).toFixed(2);
  if (patch.date) body.date = patch.date;
  if (patch.category !== undefined) body.category_name = patch.category ?? "";
  await ff(token, `/transactions/${id}`, { method: "PUT", body: { apply_rules: false, transactions: [body] } });
}

export async function deleteTx(token: string, id: string) {
  await ff(token, `/transactions/${id}`, { method: "DELETE" });
}

/** Todos os lançamentos do mês (para a lista com filtros). */
export async function monthTransactions(token: string, ym: string) {
  const { start, end } = monthRange(ym);
  return (await transactions(token, start, end)).filter((t) => t.type !== "opening balance").sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));
}
