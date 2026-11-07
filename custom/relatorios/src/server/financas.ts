/**
 * Finanças do dia a dia (contas, cartões, gastos) guardadas no Firefly III, mostradas e importadas
 * pelos relatórios. Cada usuário conecta o próprio Firefly com um token de acesso pessoal, guardado
 * cifrado em /data/users/<id>/financas.json junto das preferências (fechamento dos cartões etc.).
 *
 * Variáveis: FIREFLY_URL (endereço interno, ex.: http://host.docker.internal:3335) e
 * FIREFLY_PUBLIC_URL (endereço público, usado nos links).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { seal, unseal } from "./users";

export const FIREFLY_URL = (process.env.FIREFLY_URL ?? "http://host.docker.internal:3335").replace(/\/$/, "");
export const FIREFLY_PUBLIC_URL = (process.env.FIREFLY_PUBLIC_URL ?? "").replace(/\/$/, "");

// ---------- configuração por usuário ----------

export interface CardConfig {
  /** Dia do fechamento da fatura (compras depois dele vão para a fatura seguinte). */
  closing: number;
  /** Dia do vencimento. */
  due: number;
}
interface FinConfig {
  token?: string;
  connectedAt?: string;
  cards?: Record<string, CardConfig>;
  /** Conta do arquivo (banco/agência/conta do OFX) → conta do Firefly escolhida na última importação. */
  accounts?: Record<string, string>;
}
const cfgFile = (dir: string) => path.join(dir, "financas.json");
export function readConfig(dir: string): FinConfig {
  try {
    return JSON.parse(fs.readFileSync(cfgFile(dir), "utf8")) as FinConfig;
  } catch {
    return {};
  }
}
export function writeConfig(dir: string, cfg: FinConfig) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cfgFile(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cfgFile(dir));
}
export const tokenOf = (cfg: FinConfig) => (cfg.token ? unseal(cfg.token) : null);
export const sealToken = (t: string) => seal(t);

// ---------- API do Firefly ----------

export class FireflyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function ff<T = any>(token: string, p: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${FIREFLY_URL}/api/v1${p}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.api+json", "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new FireflyError(503, "Firefly III fora do ar ou inacessível");
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as any) : null;
  if (!res.ok) {
    const detail = json?.errors ? Object.values(json.errors).flat().join(" ") : json?.message;
    throw new FireflyError(res.status, detail || `Firefly ${res.status}`);
  }
  return json as T;
}

/** Todas as páginas de uma listagem. */
async function ffAll(token: string, p: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await ff(token, `${p}${p.includes("?") ? "&" : "?"}limit=500&page=${page}`);
    out.push(...(r.data ?? []));
    if (page >= (r.meta?.pagination?.total_pages ?? 1)) break;
  }
  return out;
}

export interface FinAccount {
  id: string;
  name: string;
  role: string;
  card: boolean;
  balance: number;
  currency: string;
  /** Dia do vencimento cadastrado no Firefly (cartões). */
  paymentDay: number | null;
  netWorth: boolean;
}

export async function accounts(token: string): Promise<FinAccount[]> {
  const data = await ffAll(token, "/accounts?type=asset");
  return data
    .filter((a) => a.attributes.active !== false)
    .map((a) => {
      const at = a.attributes;
      return {
        id: String(a.id),
        name: at.name,
        role: at.account_role ?? "defaultAsset",
        card: at.account_role === "ccAsset",
        balance: Number(at.current_balance ?? 0),
        currency: at.currency_code ?? "BRL",
        paymentDay: at.monthly_payment_date ? new Date(at.monthly_payment_date).getUTCDate() : null,
        netWorth: at.include_net_worth !== false,
      };
    })
    .sort((a, b) => Number(a.card) - Number(b.card) || a.name.localeCompare(b.name, "pt-BR"));
}

export interface Tx {
  id: string;
  type: "withdrawal" | "deposit" | "transfer" | string;
  date: string;
  amount: number;
  description: string;
  category: string | null;
  sourceId: string;
  sourceName: string;
  destinationId: string;
  destinationName: string;
}

const flat = (groups: any[]): Tx[] =>
  groups.flatMap((g) =>
    (g.attributes.transactions as any[]).map((t) => ({
      id: String(g.id),
      type: t.type,
      date: String(t.date).slice(0, 10),
      amount: Number(t.amount),
      description: t.description,
      category: t.category_name ?? null,
      sourceId: String(t.source_id),
      sourceName: t.source_name,
      destinationId: String(t.destination_id),
      destinationName: t.destination_name,
    })),
  );

export const transactions = async (token: string, start: string, end: string) => flat(await ffAll(token, `/transactions?type=all&start=${start}&end=${end}`));
export const accountTransactions = async (token: string, id: string, start: string, end: string) =>
  flat(await ffAll(token, `/accounts/${encodeURIComponent(id)}/transactions?start=${start}&end=${end}`));

// ---------- datas ----------

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ymd = (y: number, m: number, d: number) => {
  // Dia além do fim do mês cai no último dia (fechamento dia 31 em fevereiro…).
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last)));
};
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
export function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return { start: iso(ymd(y, m - 1, 1)), end: iso(ymd(y, m, 0)) };
}
const today = () => {
  // Data de hoje no fuso de São Paulo.
  const s = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  return new Date(`${s}T00:00:00Z`);
};

/**
 * Ciclos da fatura no padrão brasileiro: a fatura que fecha no dia C cobre do dia seguinte ao
 * fechamento anterior até C, e vence no dia V seguinte ao fechamento.
 */
export function invoiceCycles(cfg: CardConfig, ref = today()) {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  // Próximo fechamento a partir de hoje (inclusive).
  let close = ymd(y, m, cfg.closing);
  if (close < ref) close = ymd(y, m + 1, cfg.closing);
  const cycle = (c: Date) => {
    const prev = ymd(c.getUTCFullYear(), c.getUTCMonth() - 1, cfg.closing);
    let due = ymd(c.getUTCFullYear(), c.getUTCMonth(), cfg.due);
    if (due <= c) due = ymd(c.getUTCFullYear(), c.getUTCMonth() + 1, cfg.due);
    return { start: iso(addDays(prev, 1)), end: iso(c), due: iso(due) };
  };
  const open = cycle(close);
  const closed = cycle(ymd(close.getUTCFullYear(), close.getUTCMonth() - 1, cfg.closing));
  return { open, closed };
}

// ---------- visão geral ----------

const PAYMENT = /pagamento|pagto|pgto|pag\.? ?fatura|fatura paga|cr[eé]dito de pagamento/i;
/** "PARC 03/10", "03/10", "3 de 10", "Parcela 3/10" na descrição. */
const INSTALLMENT = /(?:parc(?:ela)?\.?\s*)?\b(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b(?!\/)/i;
export function installmentOf(desc: string) {
  const m = INSTALLMENT.exec(desc);
  if (!m) return null;
  const n = Number(m[1]);
  const total = Number(m[2]);
  return n >= 1 && total >= 2 && total <= 48 && n <= total ? { n, total } : null;
}

/** Valor de uma fatura: compras menos estornos; pagamentos (transferências ou "PAGAMENTO") ficam de fora. */
function invoiceTotal(txs: Tx[], cardId: string) {
  let total = 0;
  for (const t of txs) {
    if (t.type === "transfer") continue;
    if (t.type === "withdrawal" && t.sourceId === cardId) total += t.amount;
    else if (t.type === "deposit" && t.destinationId === cardId && !PAYMENT.test(t.description)) total -= t.amount;
  }
  return Math.round(total * 100) / 100;
}

export async function overview(token: string, cfg: FinConfig, ym: string) {
  const accs = await accounts(token);
  const { start, end } = monthRange(ym);
  const [y, m] = ym.split("-").map(Number) as [number, number];

  // Mês escolhido: entradas, saídas e categorias.
  const txs = await transactions(token, start, end);
  let income = 0;
  let expense = 0;
  const cats = new Map<string, number>();
  const cardIds = new Set(accs.filter((a) => a.card).map((a) => a.id));
  for (const t of txs) {
    if (t.type === "withdrawal") {
      expense += t.amount;
      const c = t.category ?? "Sem categoria";
      cats.set(c, (cats.get(c) ?? 0) + t.amount);
    } else if (t.type === "deposit") {
      // Estorno no cartão abate o gasto em vez de contar como entrada.
      if (cardIds.has(t.destinationId) && !PAYMENT.test(t.description)) {
        expense -= t.amount;
        const c = t.category ?? "Sem categoria";
        cats.set(c, (cats.get(c) ?? 0) - t.amount);
      } else income += t.amount;
    }
  }

  // Últimos 6 meses (entradas × saídas) pelo resumo do Firefly.
  const history = await Promise.all(
    Array.from({ length: 6 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 1 - (5 - i), 1));
      const k = d.toISOString().slice(0, 7);
      const r = monthRange(k);
      return ff(token, `/summary/basic?start=${r.start}&end=${r.end}`).then((s: Record<string, any>) => {
        const pick = (prefix: string) =>
          Object.entries(s)
            .filter(([key, v]) => key.startsWith(prefix) && v.currency_code === "BRL")
            .reduce((a, [, v]) => a + Math.abs(Number(v.monetary_value)), 0);
        return { month: k, income: pick("earned-in-"), expense: pick("spent-in-") };
      });
    }),
  );

  // Cartões: fatura aberta, última fechada e parcelas que ainda vão cair.
  const cards = await Promise.all(
    accs
      .filter((a) => a.card)
      .map(async (a) => {
        const c = cfg.cards?.[a.id];
        if (!c) return { ...a, config: null, open: null, closed: null, future: [] as { month: string; value: number }[] };
        const cy = invoiceCycles(c);
        const recent = await accountTransactions(token, a.id, cy.closed.start, cy.open.end);
        const inRange = (t: Tx, r: { start: string; end: string }) => t.date >= r.start && t.date <= r.end;
        // Parcelas: da última ocorrência de cada compra parcelada, o que falta pagar, mês a mês.
        // Cada parcela seguinte cai na fatura do mês seguinte à da parcela vista.
        const last = new Map<string, { n: number; total: number; amount: number; due: string }>();
        for (const t of recent) {
          if (t.type !== "withdrawal") continue;
          const p = installmentOf(t.description);
          if (!p) continue;
          const key = `${t.description.replace(INSTALLMENT, "").trim().toLowerCase()}|${t.amount}|${p.total}`;
          const prev = last.get(key);
          const due = t.date <= cy.closed.end ? cy.closed.due : cy.open.due;
          if (!prev || p.n > prev.n) last.set(key, { ...p, amount: t.amount, due });
        }
        const future = new Map<string, number>();
        const first = cy.open.due.slice(0, 7);
        for (const p of last.values()) {
          const base = new Date(`${p.due}T00:00:00Z`);
          for (let k = 1; k <= p.total - p.n; k++) {
            const month = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + k, 1)).toISOString().slice(0, 7);
            if (month >= first) future.set(month, (future.get(month) ?? 0) + p.amount);
          }
        }
        return {
          ...a,
          config: c,
          open: { ...cy.open, total: invoiceTotal(recent.filter((t) => inRange(t, cy.open)), a.id) },
          closed: { ...cy.closed, total: invoiceTotal(recent.filter((t) => inRange(t, cy.closed)), a.id) },
          future: [...future].sort(([a1], [b1]) => a1.localeCompare(b1)).map(([month, value]) => ({ month, value: Math.round(value * 100) / 100 })),
        };
      }),
  );

  return {
    month: ym,
    publicUrl: FIREFLY_PUBLIC_URL,
    accounts: accs.filter((a) => !a.card),
    cards,
    income: Math.round(income * 100) / 100,
    expense: Math.round(expense * 100) / 100,
    categories: [...cats].map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 })).sort((a, b) => b.value - a.value),
    history,
    recent: txs
      .filter((t) => t.type !== "opening balance")
      .sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id))
      .slice(0, 40),
  };
}

// ---------- importação de extratos (OFX e CSV) ----------

export interface ParsedRow {
  date: string;
  amount: number;
  description: string;
  /** Identificador estável da linha no arquivo (FITID do OFX ou hash). */
  uid: string;
}
export interface ParsedFile {
  format: "ofx" | "csv";
  kind: "bank" | "card" | "unknown";
  /** Identificação da conta no arquivo, para lembrar a conta do Firefly escolhida. */
  accountKey: string | null;
  bank: string | null;
  rows: ParsedRow[];
  /** Arquivos de fatura em CSV costumam trazer compras como valores positivos. */
  suggestInvert: boolean;
}

function decode(buf: Buffer) {
  const utf8 = buf.toString("utf8");
  const head = buf.subarray(0, 400).toString("latin1");
  if (/CHARSET:\s*1252|ENCODING:\s*USASCII/i.test(head) && !/ENCODING:\s*UTF-8/i.test(head)) return buf.toString("latin1");
  return utf8.includes("�") ? buf.toString("latin1") : utf8;
}
const clean = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
const uidOf = (...parts: (string | number)[]) => crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);

function parseOfx(text: string): ParsedFile {
  const tag = (block: string, name: string) => new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block)?.[1]?.trim() ?? "";
  const card = /<CCSTMTRS>/i.test(text);
  const bankId = tag(text, "BANKID") || tag(text, "ORG");
  const acct = tag(text, "ACCTID");
  const rows: ParsedRow[] = [];
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)) {
    const b = m[1]!;
    const d = tag(b, "DTPOSTED");
    const amount = Number(tag(b, "TRNAMT").replace(",", "."));
    if (!/^\d{8}/.test(d) || !Number.isFinite(amount) || amount === 0) continue;
    const name = clean(tag(b, "NAME"));
    const memo = clean(tag(b, "MEMO"));
    const description = memo && name && !memo.toLowerCase().includes(name.toLowerCase()) ? `${name} - ${memo}` : memo || name || tag(b, "TRNTYPE");
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    rows.push({ date, amount, description, uid: tag(b, "FITID") || uidOf(date, amount, description, rows.length) });
  }
  return { format: "ofx", kind: card ? "card" : "bank", accountKey: acct ? `ofx:${bankId}:${acct}` : null, bank: bankId || null, rows, suggestInvert: false };
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

function splitCsv(line: string, sep: string) {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === sep && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** "1.234,56", "-1234.56", "R$ 1.234,56-", "(12,00)" → número. */
export function parseMoney(v: string): number | null {
  let t = v.replace(/R\$|\s| /g, "");
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t) || t.endsWith("-")) {
    neg = true;
    t = t.replace(/[()]/g, "").replace(/-$/, "");
  }
  if (t.startsWith("-")) {
    neg = !neg;
    t = t.slice(1);
  } else if (t.startsWith("+")) t = t.slice(1);
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", ".");
  else if (lastDot > lastComma && lastComma >= 0) t = t.replace(/,/g, "");
  else if (lastComma < 0 && /^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) && /\d/.test(t) ? (neg ? -n : n) : null;
}

export function parseDate(v: string): string | null {
  const t = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    const d = m[1]!.padStart(2, "0");
    const mo = m[2]!.padStart(2, "0");
    if (Number(mo) > 12 || Number(d) > 31) return null;
    return `${y}-${mo}-${d}`;
  }
  return null;
}

function parseCsv(text: string, filename: string): ParsedFile {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sample = lines.slice(0, 15).join("\n");
  const sep = [";", "\t", ","].map((s) => [s, sample.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  // Linha de cabeçalho: a primeira que tem uma coluna de data e uma de valor.
  const isDate = (h: string) => /^(data|date|dt)\b|data (da )?(compra|lancamento|transacao|movimento)|release_date/.test(h);
  const isAmount = (h: string) => /valor|amount|montante|net_amount|quantia|value/.test(h) && !/saldo|balance|dolar|us\$|usd/.test(h);
  const isCredit = (h: string) => /^credito|entrada/.test(h);
  const isDebit = (h: string) => /^debito|saida/.test(h);
  let hi = -1;
  let header: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const h = splitCsv(lines[i]!, sep).map(norm);
    if (h.some(isDate) && (h.some(isAmount) || (h.some(isCredit) && h.some(isDebit)))) {
      hi = i;
      header = h;
      break;
    }
  }
  if (hi < 0) throw new Error("Não reconheci as colunas do CSV (preciso de uma coluna de data e uma de valor).");
  const col = (f: (h: string) => boolean) => header.findIndex(f);
  const cDate = col(isDate);
  const cAmount = col(isAmount);
  const cCredit = col(isCredit);
  const cDebit = col(isDebit);
  const cDesc = col((h) => /descri|historico|estabelecimento|lancamento|detalhe|titulo|transaction_type|memo|nome|loja/.test(h) && !isDate(h));
  const cParcel = col((h) => /parcela|installment/.test(h));
  const cId = col((h) => /^(id|reference_id|identificador|documento|dcto|docto)/.test(h));
  const rows: ParsedRow[] = [];
  const seen = new Map<string, number>();
  for (const line of lines.slice(hi + 1)) {
    const c = splitCsv(line, sep);
    const date = parseDate(c[cDate] ?? "");
    if (!date) continue;
    let amount: number | null;
    if (cAmount >= 0) amount = parseMoney(c[cAmount] ?? "");
    else {
      const cr = parseMoney(c[cCredit] ?? "") ?? 0;
      const db = parseMoney(c[cDebit] ?? "") ?? 0;
      amount = Math.abs(cr) - Math.abs(db);
    }
    if (amount == null || amount === 0) continue;
    let description = clean(cDesc >= 0 ? (c[cDesc] ?? "") : "") || "Sem descrição";
    const parcel = cParcel >= 0 ? clean(c[cParcel] ?? "") : "";
    if (parcel && !/^(-|—|0|única|unica|a vista|à vista)$/i.test(parcel)) {
      const p = /(\d{1,2})\D+(\d{1,2})/.exec(parcel);
      if (p && !installmentOf(description)) description += ` (${p[1]!.padStart(2, "0")}/${p[2]!.padStart(2, "0")})`;
    }
    const base = `${date}|${amount}|${description}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    rows.push({ date, amount, description, uid: cId >= 0 && c[cId] ? `id:${c[cId]}` : uidOf(base, n) });
  }
  const card = /fatura|cartao|cartão|card|credit/i.test(norm(filename)) || header.some((h) => /estabelecimento|portador|parcela/.test(h));
  if (card) {
    // Fatura (XP, Bradesco…) traz a parcela 2 em diante com a data da compra original (meses atrás).
    // Para cair na fatura certa, a parcela vai para o primeiro dia de compras da própria fatura.
    const firstOwn = rows
      .filter((r) => (installmentOf(r.description)?.n ?? 1) === 1 && !PAYMENT.test(r.description))
      .map((r) => r.date)
      .sort()[0];
    if (firstOwn)
      for (const r of rows) {
        const p = installmentOf(r.description);
        if (p && p.n > 1 && r.date < firstOwn) r.date = firstOwn;
      }
  }
  const positives = rows.filter((r) => r.amount > 0).length;
  return {
    format: "csv",
    kind: card ? "card" : "unknown",
    accountKey: `csv:${header.join(",")}`.slice(0, 200),
    bank: null,
    rows,
    suggestInvert: card && positives > rows.length / 2,
  };
}

export function parseStatement(buf: Buffer, filename: string): ParsedFile {
  const text = decode(buf).replace(/^﻿/, "");
  if (/<OFX>|OFXHEADER/i.test(text.slice(0, 2000))) return parseOfx(text);
  if (/\.pdf$/i.test(filename) || text.startsWith("%PDF")) throw new Error("PDF ainda não é aceito. Exporte em OFX ou CSV no app ou site do banco.");
  if (/\.xlsx?$/i.test(filename) || buf.subarray(0, 2).toString("latin1") === "PK") throw new Error("Planilha Excel ainda não é aceita. Exporte em OFX ou CSV.");
  const parsed = parseCsv(text, filename);
  if (!parsed.rows.length) throw new Error("Nenhum lançamento encontrado no arquivo.");
  return parsed;
}

// ---------- gravação no Firefly ----------

export interface ImportRow {
  date: string;
  amount: number;
  description: string;
  uid: string;
  /** Pagamento de fatura: transferência da conta para este cartão (em vez de despesa). */
  transferTo?: string;
}

/** Nome da contraparte a partir da descrição do banco (sem prefixos de meio de pagamento e parcelas). */
const PREFIXES = [
  /^compra (no |com )?(cartao|cartão|debito|débito|credito|crédito)( visa| master(card)?| elo)?\s*[-:]?\s*/i,
  /^pagamento (com |via )?(qr ?code |qr )?pix\s*[-:]?\s*/i,
  /^(pix|ted|doc|transf(erencia|erência|\.)?)( pix)?( (enviad[oa]|recebid[oa]|emitid[oa]|qr ?code|qr))?\s*[-:]?\s*/i,
  /^(deb(ito)?\.? aut(om(atico|ático)?)?\.?|dep[oó]sito|pagto\.?|pgto\.?|pagamento( de)?)\s+/i,
];
/** Nome da contraparte a partir da descrição do banco (sem prefixos de meio de pagamento e parcelas). */
export function counterparty(desc: string) {
  let s = desc.replace(INSTALLMENT, "").replace(/\(\s*\)/g, "");
  for (let i = 0; i < 3; i++) for (const p of PREFIXES) s = s.replace(p, "");
  s = s
    .replace(/\s+\d{2}\/\d{2}(\s+\d{2}:\d{2})?$/, "")
    .replace(/\s+-\s*$/, "")
    .trim();
  return (s.length >= 2 ? s : desc).slice(0, 255);
}

export async function importRows(token: string, accountId: string, accountKey: string | null, rows: ImportRow[]) {
  const result = { created: 0, duplicates: 0, errors: [] as string[] };
  const queue = [...rows];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const amount = Math.abs(r.amount).toFixed(2);
      const base = {
        date: r.date,
        amount,
        description: r.description.slice(0, 1000),
        external_id: `rel:${accountKey ?? accountId}:${r.uid}`.slice(0, 255),
        notes: "Importado pelos relatórios",
      };
      const tx =
        r.transferTo && r.amount < 0
          ? { ...base, type: "transfer", source_id: accountId, destination_id: r.transferTo }
          : r.amount < 0
            ? { ...base, type: "withdrawal", source_id: accountId, destination_name: counterparty(r.description) }
            : { ...base, type: "deposit", source_name: counterparty(r.description), destination_id: accountId };
      try {
        await ff(token, "/transactions", { method: "POST", body: { error_if_duplicate_hash: true, apply_rules: true, fire_webhooks: true, transactions: [tx] } });
        result.created++;
      } catch (e) {
        if (e instanceof FireflyError && /duplicate|duplicad/i.test(e.message)) result.duplicates++;
        else if (result.errors.length < 5) result.errors.push(`${r.date} ${r.description}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return result;
}

/** Linhas que já existem na conta (mesma data e valor), para marcar na prévia. */
export async function existing(token: string, accountId: string, rows: ParsedRow[]) {
  if (!rows.length) return [];
  const dates = rows.map((r) => r.date).sort();
  const txs = await accountTransactions(token, accountId, dates[0]!, dates.at(-1)!);
  const pool = new Map<string, number>();
  for (const t of txs) {
    const signed = t.sourceId === accountId ? -t.amount : t.amount;
    const k = `${t.date}|${signed.toFixed(2)}`;
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  return rows.map((r) => {
    const k = `${r.date}|${r.amount.toFixed(2)}`;
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    return n > 0;
  });
}

// ---------- totais mês a mês (plano do ano) ----------

/** Entradas, saídas e gastos por categoria de cada mês entre `from` e `to` ("YYYY-MM"). */
export async function monthlyTotals(token: string, from: string, to: string) {
  const accs = await accounts(token);
  const cardIds = new Set(accs.filter((a) => a.card).map((a) => a.id));
  const txs = await transactions(token, monthRange(from).start, monthRange(to).end);
  const out = new Map<string, { month: string; income: number; expense: number; categories: Record<string, number> }>();
  for (let m = from; m <= to; ) {
    out.set(m, { month: m, income: 0, expense: 0, categories: {} });
    const [y, mo] = m.split("-").map(Number) as [number, number];
    m = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
  }
  for (const t of txs) {
    const row = out.get(t.date.slice(0, 7));
    if (!row) continue;
    const cat = t.category ?? "Sem categoria";
    if (t.type === "withdrawal") {
      row.expense += t.amount;
      row.categories[cat] = (row.categories[cat] ?? 0) + t.amount;
    } else if (t.type === "deposit") {
      if (cardIds.has(t.destinationId) && !PAYMENT.test(t.description)) {
        row.expense -= t.amount;
        row.categories[cat] = (row.categories[cat] ?? 0) - t.amount;
      } else row.income += t.amount;
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return [...out.values()].map((m) => ({ ...m, income: r2(m.income), expense: r2(m.expense), categories: Object.fromEntries(Object.entries(m.categories).map(([k, v]) => [k, r2(v)])) }));
}

export async function categoryNames(token: string) {
  const data = await ffAll(token, "/categories");
  return data.map((c) => String(c.attributes.name)).sort((a, b) => a.localeCompare(b, "pt-BR"));
}
