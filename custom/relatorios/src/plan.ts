/**
 * Plano do ano ("Metas 2027"): metas de gasto, poupança, aportes e reserva para um ano, avaliadas
 * mês a mês com os lançamentos do Firefly III (gastos e entradas) e o histórico do Ghostfolio
 * (aportes e reserva). Antes de o ano começar, compara a meta com os últimos 12 meses.
 */

export type PlanKind = "gasto" | "categoria" | "poupanca" | "guardar" | "aporte" | "reserva";

export interface PlanItem {
  id: string;
  kind: PlanKind;
  /** R$ por mês (gasto, categoria), % (poupança), R$ no ano (guardar, aporte) ou meses (reserva). */
  value: number;
  /** Categoria do Firefly (kind "categoria"). */
  category?: string;
  createdAt: string;
}

export interface PlanFile {
  version: 1;
  years: Record<string, PlanItem[]>;
}

/** Totais de um mês vindos do Firefly. */
export interface MonthTotals {
  month: string;
  income: number;
  expense: number;
  categories: Record<string, number>;
}

export const KIND_INFO: Record<PlanKind, { label: string; hint: string; unit: "mes" | "pct" | "ano" | "meses"; finance: boolean }> = {
  gasto: { label: "Limite de gastos por mês", hint: "Quanto pode sair por mês, somando tudo (cartões e contas).", unit: "mes", finance: true },
  categoria: { label: "Limite de uma categoria", hint: "Ex.: delivery até R$ 400 por mês.", unit: "mes", finance: true },
  poupanca: { label: "Taxa de poupança", hint: "Quanto da renda sobra no mês, em %.", unit: "pct", finance: true },
  guardar: { label: "Guardar no ano", hint: "Entradas menos saídas, somadas no ano.", unit: "ano", finance: true },
  aporte: { label: "Aportar nos investimentos", hint: "Dinheiro novo colocado na carteira no ano (pelo Ghostfolio).", unit: "ano", finance: false },
  reserva: { label: "Reserva de emergência", hint: "Quantos meses de gastos guardados na reserva (marcador Fundo de Emergência).", unit: "meses", finance: false },
};

export type PlanStatus = "ok" | "atencao" | "fora" | "futuro" | "sem-dados";
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = { ok: "No caminho", atencao: "Atenção", fora: "Fora da meta", futuro: "Ainda não começou", "sem-dados": "Sem dados" };

export interface PlanBar {
  month: string;
  value: number | null;
  /** Mês em andamento (parcial). */
  partial: boolean;
}

export interface PlanEval {
  status: PlanStatus;
  /** 0..1 */
  progress: number | null;
  /** Número principal (R$, % ou meses, conforme a meta). */
  current: number | null;
  /** Referência de comparação: média dos últimos 12 meses antes do ano. */
  baseline: number | null;
  baselineMonths: number;
  bars: PlanBar[];
  /** Limite desenhado nas barras (mesma unidade de `bars`). */
  barLimit: number | null;
  /** As barras mostram os 12 meses antes do ano (o ano ainda não começou). */
  barsTrailing?: boolean;
  /** Mensagem principal em português (pode ter <b>). */
  text: string;
}

export interface PlanContext {
  year: number;
  /** Mês atual, "YYYY-MM". */
  today: string;
  /** Meses do ano do plano (até 12, os que já existem) — vazio se o Firefly não estiver conectado. */
  months: MonthTotals[];
  /** 12 meses completos antes do mês atual (referência). */
  trailing: MonthTotals[];
  financeConnected: boolean;
  /** Histórico do Ghostfolio (data, valor investido acumulado). */
  invested: { date: string; invested: number }[];
  reserve: { value: number; tagged: boolean };
  fmt: (n: number) => string;
}

const MONTHS_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export const yearMonths = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
const hasData = (m: MonthTotals) => m.income > 0 || m.expense > 0;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pctTxt = (n: number) => `${(n * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

export function itemTitle(it: PlanItem, fmt: (n: number) => string) {
  switch (it.kind) {
    case "gasto":
      return `Gastar até ${fmt(it.value)} por mês`;
    case "categoria":
      return `${it.category ?? "Categoria"}: até ${fmt(it.value)} por mês`;
    case "poupanca":
      return `Poupar ${it.value.toLocaleString("pt-BR")}% da renda`;
    case "guardar":
      return `Guardar ${fmt(it.value)} no ano`;
    case "aporte":
      return `Aportar ${fmt(it.value)} nos investimentos`;
    case "reserva":
      return `Reserva de ${it.value.toLocaleString("pt-BR")} meses de gastos`;
  }
}

/** Situação do ano do plano em relação a hoje. */
function timing(ctx: PlanContext) {
  const ty = Number(ctx.today.slice(0, 4));
  const tm = Number(ctx.today.slice(5));
  if (ctx.year > ty) return { phase: "futuro" as const, elapsed: 0, complete: 0 };
  if (ctx.year < ty) return { phase: "passado" as const, elapsed: 12, complete: 12 };
  return { phase: "atual" as const, elapsed: tm, complete: tm - 1 };
}

/** Valor investido acumulado no último dia até `date` (inclusive). */
function investedAt(ctx: PlanContext, date: string) {
  let v: number | null = null;
  for (const p of ctx.invested) {
    if (p.date > date) break;
    v = p.invested;
  }
  return v;
}

export function evaluate(it: PlanItem, ctx: PlanContext): PlanEval {
  const t = timing(ctx);
  const fmt = ctx.fmt;
  const base: PlanEval = { status: "sem-dados", progress: null, current: null, baseline: null, baselineMonths: 0, bars: [], barLimit: null, text: "" };
  const info = KIND_INFO[it.kind];
  if (info.finance && !ctx.financeConnected) return { ...base, text: "Conecte o Firefly III na aba <b>Finanças</b> para acompanhar esta meta." };

  const byMonth = new Map(ctx.months.map((m) => [m.month, m]));
  const trailing = ctx.trailing.filter(hasData);
  const months = yearMonths(ctx.year);
  const bar = (f: (m: MonthTotals) => number | null): PlanBar[] =>
    months.map((ym, i) => {
      const m = byMonth.get(ym);
      const inRange = t.phase === "passado" || (t.phase === "atual" && i < t.elapsed);
      return { month: ym, value: inRange && m && hasData(m) ? f(m) : null, partial: t.phase === "atual" && i === t.elapsed - 1 };
    });
  const before = (f: (m: MonthTotals) => number | null): PlanBar[] => ctx.trailing.map((m) => ({ month: m.month, value: hasData(m) ? f(m) : null, partial: false }));
  const done = (bars: PlanBar[]) => bars.filter((b) => b.value != null && !b.partial).map((b) => b.value!);

  // ---- limites mensais (total ou categoria) ----
  if (it.kind === "gasto" || it.kind === "categoria") {
    const of = (m: MonthTotals) => (it.kind === "gasto" ? m.expense : (m.categories[it.category ?? ""] ?? 0));
    const bars = bar(of);
    const baseline = avg(trailing.map(of));
    const res = { ...base, bars, barLimit: it.value, baseline, baselineMonths: trailing.length };
    const what = it.kind === "gasto" ? "gasta" : `gasta com ${it.category}`;
    if (t.phase === "futuro") {
      if (baseline == null) return { ...res, bars: [], status: "futuro", text: `Começa em jan/${ctx.year}. Importe alguns meses de extratos para comparar com o que você gasta hoje.` };
      const diff = baseline - it.value;
      return {
        ...res,
        bars: before(of),
        barsTrailing: true,
        status: "futuro",
        current: baseline,
        text:
          diff > 0
            ? `Hoje você ${what} em média <b>${fmt(baseline)}</b> por mês (${trailing.length} ${trailing.length === 1 ? "mês" : "meses"}). Para cumprir, precisa cortar <b>${fmt(diff)}</b> por mês.`
            : `Hoje você ${what} em média <b>${fmt(baseline)}</b> por mês: já cabe na meta, com folga de ${fmt(-diff)}.`,
      };
    }
    const full = done(bars);
    const cur = bars.find((b) => b.partial)?.value ?? null;
    const within = full.filter((v) => v <= it.value).length;
    const mean = avg(full);
    if (!full.length && cur == null) return { ...res, text: `Nenhum lançamento em ${ctx.year} ainda.` };
    const status: PlanStatus = mean == null ? (cur! <= it.value ? "ok" : "fora") : mean <= it.value ? (full.at(-1)! <= it.value ? "ok" : "atencao") : mean <= it.value * 1.1 ? "atencao" : "fora";
    const parts = [];
    if (cur != null) parts.push(`Este mês: <b>${fmt(cur)}</b> de ${fmt(it.value)} (${cur <= it.value ? `sobram ${fmt(it.value - cur)}` : `passou ${fmt(cur - it.value)}`}).`);
    if (full.length) parts.push(`Dentro do limite em <b>${within} de ${full.length}</b> ${full.length === 1 ? "mês" : "meses"}; média de ${fmt(mean!)}.`);
    return { ...res, status, current: cur ?? mean, progress: cur != null ? Math.min(1, cur / it.value) : null, text: parts.join(" ") };
  }

  // ---- taxa de poupança ----
  if (it.kind === "poupanca") {
    const target = it.value / 100;
    const rate = (m: MonthTotals) => (m.income > 0 ? (m.income - m.expense) / m.income : null);
    const bars = bar((m) => rate(m));
    const sum = (ms: MonthTotals[]) => {
      const inc = ms.reduce((s, m) => s + m.income, 0);
      return inc > 0 ? (inc - ms.reduce((s, m) => s + m.expense, 0)) / inc : null;
    };
    const baseline = sum(trailing);
    const res = { ...base, bars, barLimit: target, baseline, baselineMonths: trailing.length };
    if (t.phase === "futuro")
      return {
        ...res,
        bars: baseline == null ? [] : before(rate),
        barsTrailing: true,
        status: "futuro",
        current: baseline,
        text:
          baseline == null
            ? `Começa em jan/${ctx.year}. Importe alguns meses de extratos para ver sua taxa de hoje.`
            : `Nos últimos meses você poupou <b>${pctTxt(baseline)}</b> da renda${baseline >= target ? ": já está na meta." : `. Faltam ${pctTxt(target - baseline)} para chegar em ${pctTxt(target)}.`}`,
      };
    const ms = months
      .slice(0, t.complete)
      .map((ym) => byMonth.get(ym))
      .filter((m): m is MonthTotals => !!m && hasData(m));
    const ytd = sum(ms);
    if (ytd == null) return { ...res, text: `Sem entradas registradas em ${ctx.year} ainda.` };
    return {
      ...res,
      status: ytd >= target ? "ok" : ytd >= target - 0.05 ? "atencao" : "fora",
      current: ytd,
      progress: Math.max(0, Math.min(1, ytd / target)),
      text: `No ano (meses fechados), você poupou <b>${pctTxt(ytd)}</b> da renda; a meta é ${pctTxt(target)}.`,
    };
  }

  // ---- guardar no ano / aportar no ano ----
  if (it.kind === "guardar" || it.kind === "aporte") {
    let total: number | null;
    let bars: PlanBar[];
    let baseline: number | null;
    let baselineMonths: number;
    if (it.kind === "guardar") {
      bars = bar((m) => m.income - m.expense);
      total = bars.some((b) => b.value != null) ? bars.reduce((s, b) => s + (b.value ?? 0), 0) : null;
      baseline = trailing.length ? (trailing.reduce((s, m) => s + m.income - m.expense, 0) / trailing.length) * 12 : null;
      baselineMonths = trailing.length;
    } else {
      // Aportes: variação do valor investido acumulado no Ghostfolio, mês a mês.
      const startY = investedAt(ctx, `${ctx.year - 1}-12-31`) ?? ctx.invested.find((p) => p.date >= `${ctx.year}-01-01`)?.invested ?? null;
      let prev = startY;
      bars = months.map((ym, i) => {
        const inRange = t.phase === "passado" || (t.phase === "atual" && i < t.elapsed);
        const end = investedAt(ctx, `${ym}-31`);
        const v = inRange && end != null && prev != null ? end - prev : null;
        if (end != null && inRange) prev = end;
        return { month: ym, value: v, partial: t.phase === "atual" && i === t.elapsed - 1 };
      });
      total = bars.some((b) => b.value != null) ? bars.reduce((s, b) => s + (b.value ?? 0), 0) : null;
      const now = ctx.invested.at(-1);
      const yearAgo = now ? investedAt(ctx, `${Number(now.date.slice(0, 4)) - 1}${now.date.slice(4)}`) : null;
      baseline = now && yearAgo != null ? now.invested - yearAgo : null;
      baselineMonths = baseline != null ? 12 : 0;
    }
    const perMonth = it.value / 12;
    const res = { ...base, bars, barLimit: perMonth, baseline, baselineMonths };
    const verb = it.kind === "guardar" ? "guardou" : "aportou";
    if (t.phase === "futuro")
      return {
        ...res,
        bars: it.kind === "guardar" && baseline != null ? before((m) => m.income - m.expense) : [],
        barsTrailing: true,
        status: "futuro",
        current: baseline,
        text:
          baseline == null
            ? `Começa em jan/${ctx.year}: são <b>${fmt(perMonth)}</b> por mês.`
            : `São <b>${fmt(perMonth)}</b> por mês. Nos últimos 12 meses você ${verb} ${it.kind === "guardar" && baselineMonths < 12 ? "o equivalente a " : ""}<b>${fmt(baseline)}</b>${baseline >= it.value ? ": no ritmo atual, a meta sai." : `: faltariam ${fmt(it.value - baseline)}.`}`,
      };
    if (total == null) return { ...res, text: `Nada registrado em ${ctx.year} ainda. São ${fmt(perMonth)} por mês.` };
    const expected = (it.value * t.elapsed) / 12;
    const left = Math.max(0, it.value - total);
    const monthsLeft = 12 - t.complete;
    return {
      ...res,
      status: total >= it.value ? "ok" : total >= expected * 0.95 ? "ok" : total >= expected * 0.75 ? "atencao" : "fora",
      current: total,
      progress: Math.max(0, Math.min(1, total / it.value)),
      text:
        total >= it.value
          ? `Meta cumprida: você ${verb} <b>${fmt(total)}</b> em ${ctx.year}.`
          : `Você ${verb} <b>${fmt(total)}</b> de ${fmt(it.value)}${t.phase === "atual" ? ` (o esperado até ${MONTHS_PT[t.elapsed - 1]} era ${fmt(expected)}). Faltam ${fmt(left)}: <b>${fmt(left / Math.max(1, monthsLeft))}</b> por mês até dezembro.` : "."}`,
    };
  }

  // ---- reserva de emergência ----
  const expenseAvg = avg((t.phase === "futuro" ? trailing : [...trailing, ...ctx.months.filter(hasData)].slice(-12)).map((m) => m.expense));
  if (!ctx.reserve.tagged)
    return { ...base, text: "Marque a reserva no Ghostfolio com o marcador <b>Fundo de Emergência</b> para acompanhar." };
  if (expenseAvg == null || expenseAvg <= 0)
    return { ...base, current: ctx.reserve.value, text: `Reserva hoje: <b>${fmt(ctx.reserve.value)}</b>. ${ctx.financeConnected ? "Importe alguns meses de extratos" : "Conecte o Firefly III na aba Finanças"} para saber quantos meses de gastos ela cobre.` };
  const target = it.value * expenseAvg;
  const covered = ctx.reserve.value / expenseAvg;
  return {
    ...base,
    status: covered >= it.value ? "ok" : covered >= it.value * 0.8 ? "atencao" : t.phase === "futuro" ? "futuro" : "fora",
    current: covered,
    progress: Math.min(1, ctx.reserve.value / target),
    text:
      covered >= it.value
        ? `Reserva de <b>${fmt(ctx.reserve.value)}</b> cobre <b>${covered.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} meses</b> de gastos (média de ${fmt(expenseAvg)}/mês). Meta cumprida.`
        : `Reserva de <b>${fmt(ctx.reserve.value)}</b> cobre ${covered.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} meses. Para ${it.value} meses (média de ${fmt(expenseAvg)}/mês), faltam <b>${fmt(target - ctx.reserve.value)}</b>.`,
  };
}
