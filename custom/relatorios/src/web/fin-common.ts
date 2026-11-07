// Tipos, formatação e chamadas compartilhadas pelas telas da aba Finanças.
import { MONTHS, dateBR, esc } from "./ui";

export interface Account {
  id: string;
  name: string;
  card: boolean;
  balance: number;
  currency: string;
  paymentDay: number | null;
  netWorth?: boolean;
}
export interface Tx {
  id: string;
  type: string;
  date: string;
  amount: number;
  description: string;
  category: string | null;
  sourceId: string;
  sourceName: string;
  destinationId: string;
  destinationName: string;
}
export interface Planned {
  id: string;
  kind: "expense" | "income";
  description: string;
  amount: number;
  accountId: string | null;
  category: string | null;
  day: number;
  freq: "monthly" | "once";
  start: string;
  end?: string | null;
  match?: string | null;
}
export interface Occurrence {
  plannedId: string;
  kind: "expense" | "income";
  description: string;
  category: string | null;
  accountId: string | null;
  date: string;
  amount: number;
  matched: { id: string; date: string; amount: number; description: string; count: number } | null;
}
export interface InvoiceItem {
  id: string | null;
  date: string;
  description: string;
  category: string | null;
  amount: number;
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
  config: { closing: number; due: number; limit?: number } | null;
  invoices: Invoice[];
}
export interface ForecastMonth {
  month: string;
  income: number;
  expense: number;
  scheduled: number;
  variable: number;
  cards: { id: string; name: string; value: number }[];
  cardsTotal: number;
  net: number;
  balance: number;
  items: Occurrence[];
}
export interface MonthTotals {
  month: string;
  income: number;
  expense: number;
  categories: Record<string, number>;
  incomes: Record<string, number>;
}

export const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
export const thisMonth = () => todayIso().slice(0, 7);
export const shift = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
export const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]}/${ym.slice(0, 4)}`;
export const shortMonth = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]}/${ym.slice(2, 4)}`;
export const day = (iso: string) => dateBR(iso).slice(0, 5);
/** "Moradia - Aluguel" → "Moradia". */
export const groupOf = (cat: string) => cat.split(" - ")[0]!.trim();
export const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

let accCache: Promise<Account[]> | null = null;
let catCache: Promise<string[]> | null = null;
export const getAccounts = () => (accCache ??= api<Account[]>("/api/fin/accounts").catch((e) => ((accCache = null), Promise.reject(e))));
export const getCategories = () => (catCache ??= api<string[]>("/api/fin/categories").catch(() => ((catCache = null), [] as string[])));
export function clearListCaches() {
  accCache = null;
  catCache = null;
}

export const errorBox = (e: unknown) => `<div class="card"><p class="error">Não foi possível ler o Firefly III: ${esc((e as Error).message ?? String(e))}</p></div>`;
export const empty = (msg: string) => `<p class="muted small" style="margin:0">${msg}</p>`;
export const STATUS_LABEL: Record<Invoice["status"], string> = { paga: "vencida", fechada: "fechada", aberta: "aberta", futura: "futura" };
