// Cálculos por período feitos no navegador sobre as séries diárias do relatório.
import type { DailyPoint, Report } from "../shared";

export type Series = [string, number][];

export const PERIODS = [
  { id: "1M", label: "1 mês" },
  { id: "MTD", label: "No mês" },
  { id: "6M", label: "6 meses" },
  { id: "YTD", label: "No ano" },
  { id: "12M", label: "12 meses" },
  { id: "24M", label: "24 meses" },
  { id: "MAX", label: "Desde o início" },
] as const;
export type PeriodId = (typeof PERIODS)[number]["id"];

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function periodStart(id: PeriodId, first: string, end: string): string {
  const e = new Date(`${end}T00:00:00Z`);
  const months = (n: number) => {
    const d = new Date(e);
    d.setUTCMonth(d.getUTCMonth() - n);
    return iso(d);
  };
  const start = (() => {
    switch (id) {
      case "1M": return months(1);
      case "6M": return months(6);
      case "12M": return months(12);
      case "24M": return months(24);
      case "MTD": return iso(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 0)));
      case "YTD": return `${e.getUTCFullYear() - 1}-12-31`;
      default: return first;
    }
  })();
  return start < first ? first : start;
}

/** Último valor com data <= d (busca binária). */
export function valueAt(s: Series, d: string): number | null {
  let lo = 0;
  let hi = s.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid]![0] <= d) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 ? s[ans]![1] : null;
}

export function ret(s: Series, from: string, to: string): number | null {
  const a = valueAt(s, from);
  const b = valueAt(s, to);
  return a && b ? b / a - 1 : null;
}

export const indexSeries = (r: Report): Series => r.daily.map((p) => [p.date, p.index]);

export function gainBetween(daily: DailyPoint[], from: string, to: string) {
  return daily.filter((p) => p.date > from && p.date <= to).reduce((s, p) => s + p.pnl, 0);
}

/** Série rebaseada a 0% no início do período, nos dias da carteira. */
export function rebased(s: Series, days: string[], from: string, deflator?: Series): (number | null)[] {
  const a = valueAt(s, from);
  const ia = deflator ? valueAt(deflator, from) : 1;
  return days.map((d) => {
    const b = valueAt(s, d);
    if (!a || !b) return null;
    let r = b / a;
    if (deflator && ia) r /= (valueAt(deflator, d) ?? ia) / ia;
    return (r - 1) * 100;
  });
}

export const real = (nominal: number, inflation: number | null) => (inflation == null ? nominal : (1 + nominal) / (1 + inflation) - 1);

export interface MonthRow {
  year: number;
  months: ({ ret: number; cdi: number | null } | null)[];
  year_: { ret: number; cdi: number | null } | null;
}

export function monthlyTable(r: Report): MonthRow[] {
  const idx = indexSeries(r);
  const cdi = r.benchmarks.cdi!.points;
  const first = r.daily[0]?.date;
  const last = r.daily.at(-1)?.date;
  if (!first || !last) return [];
  const rows: MonthRow[] = [];
  for (let y = Number(first.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) {
    const months = Array.from({ length: 12 }, (_, m) => {
      const start = iso(new Date(Date.UTC(y, m, 0)));
      const end = iso(new Date(Date.UTC(y, m + 1, 0)));
      if (end < first || start > last) return null;
      const from = start < first ? first : start;
      const to = end > last ? last : end;
      const rr = ret(idx, from, to);
      return rr == null ? null : { ret: rr, cdi: ret(cdi, from, to) };
    });
    const ys = `${y - 1}-12-31`;
    const ye = `${y}-12-31`;
    const from = ys < first ? first : ys;
    const to = ye > last ? last : ye;
    const yr = ret(idx, from, to);
    rows.push({ year: y, months, year_: yr == null ? null : { ret: yr, cdi: ret(cdi, from, to) } });
  }
  return rows.reverse();
}

function firstFullMonth(from: string) {
  const d = new Date(`${from}T00:00:00Z`);
  // Início no último dia do mês (ex.: 31/12 para "no ano") conta a partir do mês seguinte.
  const next = new Date(d.getTime() + 86_400_000);
  if (next.getUTCDate() === 1 || d.getUTCDate() === 1) return iso(d.getUTCDate() === 1 ? d : next).slice(0, 7);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))).slice(0, 7);
}

export function stats(r: Report, from: string, to: string) {
  const pts = r.daily.filter((p) => p.date >= from && p.date <= to);
  const rets: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const x = pts[i]!.index / pts[i - 1]!.index - 1;
    if (x !== 0) rets.push(x);
  }
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(rets.length - 1, 1));
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of pts) {
    peak = Math.max(peak, p.index);
    maxDd = Math.min(maxDd, p.index / peak - 1);
  }
  const months = monthlyTable(r)
    .flatMap((row) => row.months.map((m, i) => (m ? { key: `${row.year}-${String(i + 1).padStart(2, "0")}`, ...m } : null)))
    // Meses cheios a partir do início do período (o mês em curso entra, parcial).
    .filter((m): m is { key: string; ret: number; cdi: number | null } => !!m && m.key >= firstFullMonth(from) && m.key <= to.slice(0, 7));
  const best = months.reduce<(typeof months)[number] | null>((b, m) => (!b || m.ret > b.ret ? m : b), null);
  const worst = months.reduce<(typeof months)[number] | null>((b, m) => (!b || m.ret < b.ret ? m : b), null);
  const total = ret(indexSeries(r), from, to) ?? 0;
  const cdi = ret(r.benchmarks.cdi!.points, from, to) ?? 0;
  const years = Math.max((Date.parse(to) - Date.parse(from)) / (365.25 * 86_400_000), 1 / 12);
  const vol = sd * Math.sqrt(252);
  const annual = (1 + total) ** (1 / years) - 1;
  const annualCdi = (1 + cdi) ** (1 / years) - 1;
  return {
    volatility: vol,
    maxDrawdown: maxDd,
    best,
    worst,
    positiveMonths: months.filter((m) => m.ret > 0).length,
    beatCdi: months.filter((m) => m.cdi != null && m.ret > m.cdi).length,
    months: months.length,
    sharpe: vol > 0 ? (annual - annualCdi) / vol : null,
  };
}
