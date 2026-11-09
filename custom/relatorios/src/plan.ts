/**
 * Plano do ano ("Meu 2027"): metas de vida de todo tipo (feitas na mão: fazer uma vez, contagem,
 * todo mês) e metas financeiras avaliadas sozinhas, mês a mês, com os lançamentos do Firefly III
 * (gastos e entradas) e o histórico do Ghostfolio (aportes e reserva). Antes de o ano começar,
 * as financeiras são comparadas com os últimos 12 meses; anos passados mostram o que foi cumprido.
 */

export type FinanceKind = "gasto" | "categoria" | "poupanca" | "guardar" | "aporte" | "reserva";
export type LifeKind = "feito" | "contagem" | "mensal";
export type PlanKind = FinanceKind | LifeKind;

export interface PlanLog {
  date: string;
  n: number;
  note?: string;
}

export interface PlanItem {
  id: string;
  kind: PlanKind;
  /**
   * R$ por mês (gasto, categoria), % (poupança), R$ no ano (guardar, aporte), meses de gastos
   * (reserva), quantidade-alvo (contagem), meses-alvo (mensal) ou 1 (feito).
   */
  value: number;
  /** Categoria do Firefly (kind "categoria"). */
  category?: string;
  /** Nome da meta (metas de vida). */
  title?: string;
  /** Área da vida (ver AREAS). As financeiras ficam em "financas". */
  area?: string;
  note?: string;
  /** Feito: data em que foi concluída. */
  done?: string | null;
  /** Contagem: registros (+1, +2…), com data. */
  log?: PlanLog[];
  /** Todo mês: meses cumpridos ("YYYY-MM"). */
  months?: string[];
  /** Contagem automática: "academia" acompanha os dias marcados na aba Saúde. */
  auto?: "academia";
  createdAt: string;
}

export interface PlanFile {
  version: 1;
  years: Record<string, PlanItem[]>;
  /** Retrospectiva livre de cada ano. */
  notes?: Record<string, string>;
}

export const AREAS: { id: string; label: string; color: string }[] = [
  { id: "financas", label: "Finanças", color: "#43d66b" },
  { id: "saude", label: "Saúde e treino", color: "#2fb5a4" },
  { id: "carreira", label: "Carreira e trabalho", color: "#3987e5" },
  { id: "estudos", label: "Estudos", color: "#9085e9" },
  { id: "pessoal", label: "Pessoal", color: "#d55181" },
  { id: "relacoes", label: "Família e amigos", color: "#e66767" },
  { id: "viagens", label: "Viagens e lazer", color: "#c98500" },
  { id: "casa", label: "Casa", color: "#d95926" },
  { id: "outros", label: "Outros", color: "#898781" },
];
export const areaOf = (it: PlanItem) => (it.kind in LIFE_KINDS ? (AREAS.find((a) => a.id === it.area) ?? AREAS.at(-1)!) : AREAS[0]!);
export const LIFE_KINDS: Record<LifeKind, { label: string; hint: string }> = {
  feito: { label: "Fazer uma vez", hint: "Ex.: tirar o passaporte, viajar para o Japão, terminar a pós." },
  contagem: { label: "Contagem", hint: "Ex.: ler 12 livros, correr 500 km, 40 jantares em família." },
  mensal: { label: "Todo mês", hint: "Marque os meses cumpridos. Ex.: treinar 12x no mês, revisar o orçamento." },
};
export const isLife = (k: PlanKind): k is LifeKind => k in LIFE_KINDS;

/** Totais de um mês vindos do Firefly. */
export interface MonthTotals {
  month: string;
  income: number;
  expense: number;
  categories: Record<string, number>;
}

export const KIND_INFO: Record<FinanceKind, { label: string; hint: string; unit: "mes" | "pct" | "ano" | "meses"; finance: boolean }> = {
  gasto: { label: "Limite de gastos por mês", hint: "Quanto pode sair por mês, somando tudo (cartões e contas).", unit: "mes", finance: true },
  categoria: { label: "Limite de uma categoria", hint: "Ex.: delivery até R$ 400 por mês.", unit: "mes", finance: true },
  poupanca: { label: "Taxa de poupança", hint: "Quanto da renda sobra no mês, em %.", unit: "pct", finance: true },
  guardar: { label: "Guardar no ano", hint: "Entradas menos saídas, somadas no ano.", unit: "ano", finance: true },
  aporte: { label: "Aportar nos investimentos", hint: "Dinheiro novo colocado na carteira no ano (pelo Ghostfolio).", unit: "ano", finance: false },
  reserva: { label: "Reserva de emergência", hint: "Quantos meses de gastos guardados na reserva (marcador Fundo de Emergência).", unit: "meses", finance: false },
};

export type PlanStatus = "ok" | "atencao" | "fora" | "futuro" | "sem-dados" | "cumprida" | "nao-cumprida" | "aberta";
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  ok: "No caminho",
  atencao: "Atenção",
  fora: "Fora da meta",
  futuro: "Ainda não começou",
  "sem-dados": "Sem dados",
  cumprida: "Cumprida",
  "nao-cumprida": "Não cumprida",
  aberta: "Em aberto",
};

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
  if (isLife(it.kind)) return it.title || "Meta";
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

/** Avaliação final: num ano encerrado, "no caminho" vira cumprida e o resto vira não cumprida. */
export function evaluate(it: PlanItem, ctx: PlanContext): PlanEval {
  const e = isLife(it.kind) ? evaluateLife(it, ctx) : evaluateFinance(it, ctx);
  if (timing(ctx).phase === "passado" && e.status !== "sem-dados") {
    if (e.status === "ok") return { ...e, status: "cumprida" };
    if (e.status !== "cumprida") return { ...e, status: "nao-cumprida" };
  }
  return e;
}

/** Já conta como cumprida (para o placar do ano). */
export const isAchieved = (e: PlanEval) => e.status === "cumprida";

const dateBR = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

function evaluateLife(it: PlanItem, ctx: PlanContext): PlanEval {
  const t = timing(ctx);
  const base: PlanEval = { status: "aberta", progress: null, current: null, baseline: null, baselineMonths: 0, bars: [], barLimit: null, text: "" };
  const months = yearMonths(ctx.year);
  if (it.kind === "feito") {
    if (it.done) return { ...base, status: "cumprida", progress: 1, current: 1, text: `Feita em ${dateBR(it.done)}.` };
    return { ...base, status: t.phase === "futuro" ? "futuro" : "aberta", progress: 0, current: 0, text: t.phase === "passado" ? "Ficou para trás." : "Marque quando concluir." };
  }
  if (it.kind === "contagem") {
    const log = it.log ?? [];
    const count = log.reduce((s, l) => s + l.n, 0);
    const target = Math.max(1, it.value);
    const bars = months.map((ym, i) => ({ month: ym, value: log.filter((l) => l.date.startsWith(ym)).reduce((s, l) => s + l.n, 0) || (t.phase === "passado" || i < t.elapsed ? 0 : null), partial: t.phase === "atual" && i === t.elapsed - 1 }));
    const last = [...log].sort((a, b) => b.date.localeCompare(a.date))[0];
    const res = { ...base, current: count, progress: Math.min(1, count / target), bars, barLimit: target / 12 };
    const lastTxt = last ? ` Último registro em ${dateBR(last.date)}${last.note ? ` (${last.note})` : ""}.` : "";
    if (count >= target) return { ...res, status: "cumprida", text: `<b>${count} de ${target}</b>: meta cumprida.${lastTxt}` };
    if (t.phase === "futuro") return { ...res, status: "futuro", text: `Meta de ${target}: cerca de ${(target / 12).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} por mês.` };
    const expected = (target * t.elapsed) / 12;
    const left = target - count;
    const monthsLeft = 12 - t.complete;
    return {
      ...res,
      status: t.phase === "passado" ? "nao-cumprida" : count >= expected * 0.9 ? "ok" : count >= expected * 0.6 ? "atencao" : "fora",
      text: `<b>${count} de ${target}</b>${t.phase === "atual" ? `; o esperado até ${MONTHS_PT[t.elapsed - 1]} era ${Math.round(expected)}. Faltam ${left}: ${(left / Math.max(1, monthsLeft)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} por mês.` : "."}${lastTxt}`,
    };
  }
  // mensal
  const checked = new Set((it.months ?? []).filter((m) => m.startsWith(`${ctx.year}-`)));
  const target = Math.min(12, Math.max(1, it.value));
  const count = checked.size;
  const bars = months.map((ym, i) => ({ month: ym, value: checked.has(ym) ? 1 : t.phase === "passado" || i < t.complete ? 0 : null, partial: t.phase === "atual" && i === t.elapsed - 1 }));
  const res = { ...base, current: count, progress: Math.min(1, count / target), bars, barLimit: null };
  if (count >= target) return { ...res, status: "cumprida", text: `<b>${count} de ${target}</b> meses: meta cumprida.` };
  if (t.phase === "futuro") return { ...res, status: "futuro", text: `Meta: ${target} de 12 meses.` };
  const possible = count + (12 - t.complete);
  const expected = (target * t.complete) / 12;
  return {
    ...res,
    status: t.phase === "passado" || possible < target ? "fora" : count >= expected - 0.5 ? "ok" : "atencao",
    text: `<b>${count} de ${target}</b> meses${t.phase === "atual" ? (possible < target ? ". Não dá mais para chegar na meta neste ano." : possible === target ? ". Não dá para falhar mais nenhum mês." : `. Dá para falhar mais ${possible - target} ${possible - target === 1 ? "mês" : "meses"}.`) : "."}`,
  };
}

function evaluateFinance(it: PlanItem, ctx: PlanContext): PlanEval {
  const t = timing(ctx);
  const fmt = ctx.fmt;
  const base: PlanEval = { status: "sem-dados", progress: null, current: null, baseline: null, baselineMonths: 0, bars: [], barLimit: null, text: "" };
  const info = KIND_INFO[it.kind as FinanceKind];
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

// ---------- texto para o Claude (prompt e MCP) ----------

const strip = (s: string) => s.replace(/<[^>]+>/g, "");

/** Plano de um ano em Markdown, por área, com o id de cada meta (o MCP usa para atualizar). */
export function planMarkdown(year: number, items: PlanItem[], evals: PlanEval[], opts: { ids?: boolean; hideValues?: boolean; note?: string } = {}) {
  const lines = [`## Metas de ${year}`];
  if (!items.length) return [...lines, "- Nenhuma meta cadastrada para este ano.", ""];
  const done = evals.filter(isAchieved).length;
  lines.push(`- Placar: ${done} de ${items.length} cumpridas`);
  for (const area of AREAS) {
    const idx = items.map((it, i) => [it, i] as const).filter(([it]) => areaOf(it).id === area.id);
    if (!idx.length) continue;
    lines.push(`### ${area.label}`);
    for (const [it, i] of idx) {
      const e = evals[i]!;
      const title = itemTitle(it, (n) => (opts.hideValues ? "(oculto)" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })));
      const detail = opts.hideValues && !isLife(it.kind) ? "" : ` — ${strip(e.text)}`;
      lines.push(`- [${isAchieved(e) ? "x" : " "}] ${title} (${PLAN_STATUS_LABEL[e.status]})${detail}${it.note ? ` · nota: ${it.note}` : ""}${opts.ids ? ` · id: ${it.id}` : ""}`);
    }
  }
  if (opts.note) lines.push("", `Retrospectiva: ${opts.note}`);
  lines.push("");
  return lines;
}
