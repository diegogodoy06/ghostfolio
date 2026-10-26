/**
 * Metas de patrimônio: chegar a um valor até uma data, independente da simulação de aportes.
 *
 * Simulação mês a mês, a partir do mês que vem: a cada mês o patrimônio rende a taxa mensal i
 * e recebe o aporte mensal P mais os aportes extras daquele mês (ex.: R$ 2.000 em dezembro,
 * ou o 13º todo ano). Como o valor final é linear em P, o aporte necessário sai direto:
 *   final(P) = final(0) + P·((1+i)^n − 1)/i   →   P = (meta − final(0)) / fator
 * Com "valores de hoje" ligado, tudo é calculado
 * em termos reais (rentabilidade descontada de uma inflação assumida), então a meta mantém o
 * poder de compra de hoje.
 */
import type { Report } from "./shared";

export interface Goal {
  id: string;
  name: string;
  /** Valor a atingir, em R$ (de hoje, se `real`). */
  target: number;
  /** Mês-limite, "AAAA-MM". */
  date: string;
  /** Carteira (sem a reserva) ou tudo (com a reserva de emergência). */
  base: "carteira" | "tudo";
  /** Rentabilidade esperada, em % ao ano (nominal). */
  annualReturn: number;
  /** Aporte mensal planejado, em R$. */
  monthly: number;
  /** Meta em valores de hoje: desconta a inflação assumida. */
  real: boolean;
  /** Aportes fora do padrão já programados (além do mensal). */
  extras?: GoalExtra[];
  createdAt: string;
}

/** Aporte extra programado: num mês específico ou, com `yearly`, nesse mês todo ano. */
export interface GoalExtra {
  id: string;
  /** "AAAA-MM": o mês do aporte (ou o primeiro, se repetir todo ano). */
  month: string;
  amount: number;
  yearly?: boolean;
  /** Ex.: "13º salário", "bônus". */
  note?: string;
}

export interface GoalsFile {
  version: 1;
  goals: Goal[];
  updatedAt?: string;
}

/** Inflação assumida para metas em valores de hoje (% ao ano). */
export const INFLATION = 4.5;

export type GoalStatus = "atingida" | "no-ritmo" | "abaixo" | "vencida";

export interface GoalPlan {
  months: number;
  monthlyRate: number;
  progress: number;
  missing: number;
  /** Aporte mensal necessário para chegar na data. */
  required: number;
  /** Patrimônio na data com o aporte planejado. */
  projected: number;
  /** Mês ("AAAA-MM") em que a meta é atingida com o aporte planejado, ou null se passar de 50 anos. */
  reach: string | null;
  status: GoalStatus;
  /** Soma (sem rendimento) dos aportes extras programados até a data da meta. */
  extrasTotal: number;
}

export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
export function addMonths(ym: string, n: number) {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return monthKey(new Date(Date.UTC(y, m - 1 + n, 1)));
}
export function monthsBetween(from: string, to: string) {
  const [y1, m1] = from.split("-").map(Number) as [number, number];
  const [y2, m2] = to.split("-").map(Number) as [number, number];
  return (y2 - y1) * 12 + (m2 - m1);
}

export function monthlyRate(g: Pick<Goal, "annualReturn" | "real">) {
  const a = g.annualReturn / 100;
  const annual = g.real ? (1 + a) / (1 + INFLATION / 100) - 1 : a;
  return Math.pow(1 + annual, 1 / 12) - 1;
}

export function futureValue(value: number, monthly: number, i: number, n: number) {
  if (n <= 0) return value;
  const f = Math.pow(1 + i, n);
  return value * f + (Math.abs(i) < 1e-12 ? monthly * n : (monthly * (f - 1)) / i);
}

/** Soma dos aportes extras programados para um mês. */
export function extraIn(g: Pick<Goal, "extras">, ym: string) {
  let sum = 0;
  for (const e of g.extras ?? []) {
    if (!(e.amount > 0) || ym < e.month) continue;
    if (e.month === ym || (e.yearly && e.month.slice(5) === ym.slice(5))) sum += e.amount;
  }
  return sum;
}

/** Patrimônio mês a mês (índice 0 = hoje) com aporte mensal + extras, por `n` meses. */
export function projectPath(g: Pick<Goal, "extras">, value: number, monthly: number, i: number, n: number, today = monthKey(new Date())) {
  const out = [value];
  let v = value;
  for (let k = 1; k <= n; k++) {
    v = v * (1 + i) + monthly + extraIn(g, addMonths(today, k));
    out.push(v);
  }
  return out;
}

/** Fator do aporte mensal: quanto R$ 1 por mês vira em n meses. */
const annuity = (i: number, n: number) => (Math.abs(i) < 1e-12 ? n : (Math.pow(1 + i, n) - 1) / i);

export function planGoal(g: Goal, value: number, today = monthKey(new Date())): GoalPlan {
  const months = monthsBetween(today, g.date);
  const i = monthlyRate(g);
  const n = Math.max(0, months);
  const progress = g.target > 0 ? Math.min(1, Math.max(0, value / g.target)) : 0;
  const missing = Math.max(0, g.target - value);
  // Valor na data só com os extras (sem aporte mensal) e com o aporte planejado.
  const withExtrasOnly = projectPath(g, value, 0, i, n, today)[n]!;
  const projected = withExtrasOnly + g.monthly * annuity(i, n);
  let required = 0;
  if (missing > 0) required = n === 0 ? missing : Math.max(0, (g.target - withExtrasOnly) / annuity(i, n));
  let reach: string | null = null;
  if (value >= g.target) reach = today;
  else {
    let v = value;
    for (let k = 1; k <= 600; k++) {
      v = v * (1 + i) + g.monthly + extraIn(g, addMonths(today, k));
      if (v >= g.target) {
        reach = addMonths(today, k);
        break;
      }
    }
  }
  const extrasTotal = projectPath(g, 0, 0, 0, n, today)[n]!; // soma simples dos extras até a data
  const status: GoalStatus = value >= g.target ? "atingida" : months <= 0 ? "vencida" : projected >= g.target - 0.005 ? "no-ritmo" : "abaixo";
  return { months, monthlyRate: i, progress, missing, required, projected, reach, status, extrasTotal };
}

/** "R$ 2.000 em dez/2026 · R$ 1.500 todo dez (13º)" */
export function extrasLabel(g: Pick<Goal, "extras">, brl: (n: number) => string, monthName: (ym: string) => string) {
  return (g.extras ?? [])
    .filter((e) => e.amount > 0)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((e) => `${brl(e.amount)} ${e.yearly ? `todo ${monthName(e.month).split("/")[0]} (desde ${e.month.slice(0, 4)})` : `em ${monthName(e.month)}`}${e.note ? ` (${e.note})` : ""}`)
    .join(" · ");
}

export const STATUS_LABEL: Record<GoalStatus, string> = {
  atingida: "Atingida",
  "no-ritmo": "No ritmo",
  abaixo: "Abaixo do ritmo",
  vencida: "Prazo vencido",
};

/** Patrimônio que conta para a meta, a partir do recorte do relatório (tudo / carteira / reserva). */
export function goalBaseValue(r: Pick<Report, "scope" | "summary" | "reserve">, base: Goal["base"]) {
  if (r.scope === "reserva") return null;
  const carteira = r.summary.value - (r.scope === "tudo" ? r.reserve.value : 0);
  return base === "tudo" ? carteira + r.reserve.value : carteira;
}

/** Metas em texto, para o contexto do Claude. */
export function goalsMarkdown(r: Report, goals: Goal[], hide = false): string[] {
  if (!goals.length) return [];
  const brl = (n: number) => (hide ? "(oculto)" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
  const pct = (n: number) => `${(n * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  const lines = ["## Metas de patrimônio (independentes da simulação)"];
  for (const g of goals) {
    const value = goalBaseValue(r, g.base);
    if (value == null) continue;
    const p = planGoal(g, value);
    lines.push(
      `- **${g.name}**: ${brl(g.target)}${g.real ? " em valores de hoje" : ""} até ${g.date} (${g.base === "tudo" ? "carteira + reserva" : "só a carteira"}) · progresso ${pct(p.progress)} · ${STATUS_LABEL[p.status]} · premissas: ${g.annualReturn}% a.a., aporte ${brl(g.monthly)}/mês${g.extras?.length ? ` + extras programados: ${extrasLabel(g, brl, (ym) => ym)}` : ""} · aporte necessário ${brl(p.required)}/mês · com o aporte atual: ${p.reach ? `atinge em ${p.reach}` : "não atinge em 50 anos"}`,
    );
  }
  lines.push("");
  return lines;
}
