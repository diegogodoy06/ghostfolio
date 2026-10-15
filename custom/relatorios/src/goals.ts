/**
 * Metas de patrimônio: chegar a um valor até uma data, independente da simulação de aportes.
 *
 * Com rentabilidade mensal i, patrimônio atual V e aporte mensal P, depois de n meses:
 *   FV = V·(1+i)^n + P·((1+i)^n − 1)/i
 * O aporte necessário é o P que faz FV = meta. Com "valores de hoje" ligado, tudo é calculado
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
  createdAt: string;
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

export function planGoal(g: Goal, value: number, today = monthKey(new Date())): GoalPlan {
  const months = monthsBetween(today, g.date);
  const i = monthlyRate(g);
  const progress = g.target > 0 ? Math.min(1, Math.max(0, value / g.target)) : 0;
  const missing = Math.max(0, g.target - value);
  let required = 0;
  if (missing > 0) {
    if (months <= 0) required = missing;
    else {
      const f = Math.pow(1 + i, months);
      required = Math.max(0, Math.abs(i) < 1e-12 ? (g.target - value) / months : ((g.target - value * f) * i) / (f - 1));
    }
  }
  const projected = futureValue(value, g.monthly, i, Math.max(0, months));
  let reach: string | null = null;
  if (value >= g.target) reach = today;
  else for (let n = 1; n <= 600; n++) if (futureValue(value, g.monthly, i, n) >= g.target) { reach = addMonths(today, n); break; }
  const status: GoalStatus = value >= g.target ? "atingida" : months <= 0 ? "vencida" : projected >= g.target ? "no-ritmo" : "abaixo";
  return { months, monthlyRate: i, progress, missing, required, projected, reach, status };
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
      `- **${g.name}**: ${brl(g.target)}${g.real ? " em valores de hoje" : ""} até ${g.date} (${g.base === "tudo" ? "carteira + reserva" : "só a carteira"}) · progresso ${pct(p.progress)} · ${STATUS_LABEL[p.status]} · premissas: ${g.annualReturn}% a.a., aporte ${brl(g.monthly)}/mês · aporte necessário ${brl(p.required)}/mês · com o aporte atual: ${p.reach ? `atinge em ${p.reach}` : "não atinge em 50 anos"}`,
    );
  }
  lines.push("");
  return lines;
}
