// Painel do Resumo: índice de saúde financeira, sinais do que pede atenção, fôlego da reserva e
// o gráfico principal (barras hachuradas com o mês atual em destaque).
import { Chart } from "chart.js";
import type { Report } from "../shared";
import { gainBetween, indexSeries, periodStart, ret } from "./calc";
import { type MonthTotals, api, shift, thisMonth, todayIso } from "./fin-common";
import { type Overview, getOverview, upcomingBills } from "./financas";
import { MONTHS, axisMoney, esc, hatch, highlightPlugin, money, openModal, pct } from "./ui";

export interface HubData {
  o: Overview | null;
  months: MonthTotals[] | null;
}
let monthsCache: { at: number; data: MonthTotals[] | null } | null = null;
export async function loadHub(): Promise<HubData> {
  const o = await getOverview();
  if (!o) return { o: null, months: null };
  if (!monthsCache || Date.now() - monthsCache.at > 5 * 60_000) {
    const cur = thisMonth();
    const data = await api<MonthTotals[]>(`/api/fin/months?from=${shift(cur, -12)}&to=${cur}`).catch(() => null);
    monthsCache = { at: Date.now(), data };
  }
  return { o, months: monthsCache.data };
}
export const clearHubCache = () => (monthsCache = null);

const clamp = (n: number, a = 0, b = 100) => Math.max(a, Math.min(b, n));
const lerp = (x: number, x0: number, y0: number, x1: number, y1: number) => clamp(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0), Math.min(y0, y1), Math.max(y0, y1));
const median = (xs: number[]) => {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const h = Math.floor(v.length / 2);
  return v.length % 2 ? v[h]! : (v[h - 1]! + v[h]!) / 2;
};

/** Números de base usados no índice, nos sinais e no fôlego. */
export function hubFacts(r: Report, d: HubData) {
  const end = r.daily.at(-1)!.date;
  const from12 = periodStart("12M", r.firstDate, end);
  const from30 = periodStart("1M", r.firstDate, end);
  const carteira12 = ret(indexSeries(r), from12, end);
  const cdi12 = ret(r.benchmarks.cdi!.points, from12, end);
  const gain30 = gainBetween(r.daily, from30, end);
  const pct30 = ret(indexSeries(r), from30, end);
  const cur = thisMonth();
  const full = (d.months ?? []).filter((m) => m.month < cur && (m.income > 0 || m.expense > 0));
  const last3 = full.slice(-3);
  const spend = median(last3.map((m) => m.expense));
  const income = median(last3.map((m) => m.income));
  const saved = last3.reduce((s, m) => s + m.income - m.expense, 0);
  const earned = last3.reduce((s, m) => s + m.income, 0);
  const savingRate = earned > 0 ? saved / earned : null;
  const reserve = r.reserve.value;
  const runway = spend > 0 && r.reserve.tagged ? reserve / spend : null;
  const o = d.o;
  const bills = o ? upcomingBills(o) : [];
  // Faturas já contratadas: as abertas/fechadas + parcelas dos próximos 2 meses.
  const committed = o ? o.cards.reduce((s, c) => s + (c.closed && c.closed.due >= todayIso() ? c.closed.total : 0) + (c.open?.total ?? 0) + c.future.slice(0, 2).reduce((a, f) => a + f.value, 0), 0) : 0;
  const cash = o ? o.accounts.filter((a) => a.netWorth !== false).reduce((s, a) => s + a.balance, 0) : 0;
  const cardDebt = o ? o.cards.reduce((s, c) => s + Math.min(0, c.balance), 0) : 0;
  return { tagged: r.reserve.tagged, end, carteira12, cdi12, gain30, pct30, spend, income, savingRate, reserve, runway, bills, committed, cash, cardDebt, net: r.summary.value + cash + cardDebt, last3 };
}
export type Facts = ReturnType<typeof hubFacts>;

// ---------- índice de saúde ----------

export interface ScorePart {
  label: string;
  value: string;
  points: number;
  weight: number;
  rule: string;
}
export function healthScore(f: Facts, d: HubData) {
  const parts: ScorePart[] = [];
  if (f.savingRate != null)
    parts.push({ label: "Taxa de poupança", value: pct(f.savingRate, 0), points: f.savingRate < 0 ? lerp(f.savingRate, -0.3, 0, 0, 25) : lerp(f.savingRate, 0, 25, 0.25, 100), weight: 25, rule: "o que sobra das entradas nos últimos 3 meses; 25% ou mais vale nota máxima" });
  if (f.runway != null)
    parts.push({ label: "Reserva de emergência", value: `${f.runway.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} meses`, points: lerp(f.runway, 0, 0, 6, 100), weight: 25, rule: "quantos meses de gasto a reserva cobre; 6 meses ou mais vale nota máxima" });
  if (d.o && f.income > 0)
    parts.push({ label: "Cartões comprometidos", value: pct(f.committed / f.income, 0), points: lerp(f.committed / f.income, 0.3, 100, 0.9, 10), weight: 20, rule: "faturas em aberto e parcelas dos próximos 2 meses sobre a renda mensal; até 30% vale nota máxima" });
  if (d.o && Object.keys(d.o.budget).length) {
    const cats = new Map(d.o.categories.map((c) => [c.name, c.value]));
    const rows = Object.entries(d.o.budget).filter(([c]) => cats.has(c));
    const meta = rows.reduce((s, [, v]) => s + v, 0);
    const spent = rows.reduce((s, [c]) => s + Math.max(0, cats.get(c) ?? 0), 0);
    if (meta > 0) parts.push({ label: "Metas por categoria", value: `${pct(spent / meta, 0)} usado`, points: lerp(spent / meta, 1, 100, 1.5, 20), weight: 15, rule: "gasto nas categorias com meta, neste mês; dentro da meta vale nota máxima" });
  }
  if (f.carteira12 != null && f.cdi12)
    parts.push({ label: "Investimentos × CDI (12 meses)", value: `${pct(f.carteira12 / f.cdi12, 0)} do CDI`, points: f.carteira12 < 0 ? 15 : lerp(f.carteira12 / f.cdi12, 0.5, 40, 1, 100), weight: 15, rule: "rentabilidade da carteira em 12 meses comparada ao CDI; 100% do CDI ou mais vale nota máxima" });
  const w = parts.reduce((s, p) => s + p.weight, 0) || 1;
  const score = Math.round(parts.reduce((s, p) => s + p.points * p.weight, 0) / w);
  const label = score >= 75 ? "Boa" : score >= 50 ? "Atenção" : "Crítica";
  return { score, label, tone: score >= 75 ? "good" : score >= 50 ? "warn" : "bad", parts };
}
export type Health = ReturnType<typeof healthScore>;

export function openScoreModal(h: Health) {
  openModal(
    "Como o índice é calculado",
    `<p class="muted" style="margin-top:0">Uma nota de 0 a 100 que junta o que mais pesa na saúde do seu dinheiro. Cada parte vale de 0 a 100 e entra com o seu peso.</p>
     <div class="score-parts">${h.parts
       .map(
         (p) => `<div class="score-part"><div class="row-between"><b>${esc(p.label)}</b><span class="num">${esc(p.value)} · <b>${Math.round(p.points)}</b>/100 · peso ${p.weight}</span></div>
         <div class="meter-wrap" style="--p:${Math.round(p.points)}"><div class="meter"></div></div><p class="muted small">${esc(p.rule)}</p></div>`,
       )
       .join("")}</div>
     <p class="note">Sem o Firefly conectado, o índice usa só a carteira e a reserva. Valores de referência: poupar 25% da renda, reserva de 6 meses de gasto, cartões até 30% da renda.</p>`,
  );
}

// ---------- sinais ----------

export interface Signal {
  title: string;
  sub: string;
  when: string;
  impact: "alto" | "medio" | "baixo" | "bom";
  area: "Finanças" | "Cartões" | "Investimentos" | "Metas" | "Reserva";
  level: number;
  go: [string, string?];
}
const ORDER = { alto: 0, medio: 1, baixo: 2, bom: 3 };
export function hubSignals(r: Report, f: Facts, d: HubData): Signal[] {
  const out: Signal[] = [];
  const today = todayIso();
  const dayBR = (iso: string) => iso.split("-").reverse().slice(0, 2).join("/");
  const o = d.o;
  if (o) {
    for (const p of o.planned.filter((x) => !x.matched && x.date < today)) {
      out.push({
        title: p.kind === "expense" ? `${p.description} ainda não foi paga` : `${p.description} ainda não caiu`,
        sub: `previsto para dia ${dayBR(p.date)} · ${money(p.amount)}`,
        when: dayBR(p.date),
        impact: p.kind === "expense" ? "alto" : "medio",
        area: "Finanças",
        level: 85,
        go: ["financas", "mes"],
      });
    }
    for (const b of f.bills) {
      const days = Math.round((new Date(`${b.due}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
      if (days > 10) continue;
      out.push({
        title: `Fatura ${b.name} vence ${days <= 0 ? "hoje" : days === 1 ? "amanhã" : `em ${days} dias`}`,
        sub: `${b.closed ? "fechada" : "aberta"} · ${money(b.total)}`,
        when: dayBR(b.due),
        impact: days <= 3 ? "alto" : "medio",
        area: "Cartões",
        level: lerp(days, 10, 50, 0, 95),
        go: ["financas", "cartoes"],
      });
    }
    const cats = new Map(o.categories.map((c) => [c.name, c.value]));
    for (const [c, meta] of Object.entries(o.budget)) {
      const v = cats.get(c) ?? 0;
      if (v <= meta * 0.85) continue;
      out.push({
        title: v > meta ? `${c} acima da meta` : `${c} perto da meta`,
        sub: `${money(v)} de ${money(meta)} (${pct(v / meta, 0)})`,
        when: MONTHS[Number(o.month.slice(5)) - 1]!,
        impact: v > meta * 1.3 ? "alto" : v > meta ? "medio" : "baixo",
        area: "Metas",
        level: lerp(v / meta, 0.85, 50, 1.6, 98),
        go: ["financas", "categorias"],
      });
    }
    const result = o.income - o.expense;
    if (result < 0) out.push({ title: "O mês está gastando mais do que entra", sub: `saiu ${money(o.expense)} · entrou ${money(o.income)}`, when: MONTHS[Number(o.month.slice(5)) - 1]!, impact: "alto", area: "Finanças", level: 90, go: ["financas", "mes"] });
    if (f.spend > 0 && o.expense > f.spend * 1.2)
      out.push({ title: "Gastos do mês acima do normal", sub: `${money(o.expense)} contra a mediana de ${money(f.spend)}`, when: MONTHS[Number(o.month.slice(5)) - 1]!, impact: "medio", area: "Finanças", level: lerp(o.expense / f.spend, 1.2, 55, 2, 95), go: ["financas", "categorias"] });
    const unc = cats.get("Sem categoria") ?? 0;
    if (unc > 0) out.push({ title: "Lançamentos sem categoria", sub: `${money(unc)} neste mês · categorize para as metas ficarem certas`, when: MONTHS[Number(o.month.slice(5)) - 1]!, impact: "baixo", area: "Finanças", level: 35, go: ["financas", "lancamentos"] });
    if (f.income > 0 && f.committed / f.income > 0.5)
      out.push({ title: "Cartões comprometem boa parte da renda", sub: `${money(f.committed)} entre faturas e parcelas dos próximos meses`, when: "3 meses", impact: f.committed / f.income > 0.8 ? "alto" : "medio", area: "Cartões", level: lerp(f.committed / f.income, 0.5, 55, 1, 95), go: ["financas", "cartoes"] });
  }
  if (f.runway != null && f.runway < 6)
    out.push({ title: f.runway < 3 ? "Reserva de emergência curta" : "Reserva abaixo de 6 meses", sub: `cobre ${f.runway.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} meses do seu gasto (${money(f.spend)}/mês)`, when: "hoje", impact: f.runway < 3 ? "alto" : "medio", area: "Reserva", level: lerp(f.runway, 6, 50, 0, 95), go: ["metas"] });
  if (f.carteira12 != null && f.cdi12) {
    const rel = f.carteira12 / f.cdi12;
    out.push(
      rel >= 1
        ? { title: "Carteira acima do CDI", sub: `${pct(f.carteira12)} em 12 meses · ${pct(rel, 0)} do CDI`, when: "12 meses", impact: "bom", area: "Investimentos", level: lerp(rel, 1, 70, 1.5, 100), go: ["rentabilidade"] }
        : { title: "Carteira abaixo do CDI", sub: `${pct(f.carteira12)} em 12 meses · ${pct(rel, 0)} do CDI`, when: "12 meses", impact: rel < 0.7 ? "alto" : "medio", area: "Investimentos", level: lerp(rel, 1, 50, 0, 95), go: ["rentabilidade"] },
    );
  }
  if (f.savingRate != null && f.savingRate >= 0.2) out.push({ title: "Boa taxa de poupança", sub: `guardou ${pct(f.savingRate, 0)} das entradas nos últimos 3 meses`, when: "3 meses", impact: "bom", area: "Finanças", level: lerp(f.savingRate, 0.2, 70, 0.4, 100), go: ["financas", "categorias"] });
  return out.sort((a, b) => ORDER[a.impact] - ORDER[b.impact] || b.level - a.level);
}

const AREA_ICON: Record<Signal["area"], string> = { Finanças: "wallet-outline", Cartões: "card-outline", Investimentos: "trending-up-outline", Metas: "target-outline", Reserva: "cash-outline" };
const IMPACT: Record<Signal["impact"], [string, string]> = { alto: ["Alto", "bad"], medio: ["Médio", "warn"], baixo: ["Baixo", ""], bom: ["Bom", "good"] };

export function signalsHtml(list: Signal[]) {
  if (!list.length) return `<p class="muted small" style="margin:0">Nada pedindo atenção agora.</p>`;
  return `<div class="sig-table" role="table">
    <div class="sig-row sig-head" role="row"><span>Sinal</span><span>Quando</span><span>Impacto</span><span>Área</span><span>Intensidade</span><span></span></div>
    ${list
      .map(
        (s, i) => `<div class="sig-row" role="row">
        <span class="sig-t"><b>${esc(s.title)}</b><small>${esc(s.sub)}</small></span>
        <span class="sig-when"><span class="ico" style="--icon: url(icons/calendar-outline.svg)"></span>${esc(s.when)}</span>
        <span><span class="tag ${IMPACT[s.impact][1]}">${IMPACT[s.impact][0]}</span></span>
        <span class="sig-area"><span class="ico" style="--icon: url(icons/${AREA_ICON[s.area]}.svg)"></span>${s.area}</span>
        <span class="sig-meter"><span class="meter-wrap ${s.impact === "bom" ? "good" : ""}" style="--p:${Math.round(s.level)}"><span class="meter"></span></span><b>${Math.round(s.level)}%</b></span>
        <span><button class="icon sig-go" data-sig="${i}" aria-label="Abrir ${esc(s.title)}">+</button></span>
      </div>`,
      )
      .join("")}</div>`;
}

// ---------- KPIs e fôlego ----------

const delta = (v: number | null, text: string) => (v == null ? `<span class="sub">${text}</span>` : `<span class="delta ${v >= 0 ? "up" : "down"}">${text}</span>`);

export function kpisHtml(r: Report, f: Facts, h: Health | null, d: HubData) {
  const s = r.summary;
  const o = d.o;
  const result = o ? o.income - o.expense : null;
  const next = f.bills[0];
  const score = h
    ? `<button class="card kpi kpi-score" id="score-open" title="Como é calculado">
        <div class="label">Saúde financeira <span class="ico info" style="--icon: url(icons/info-outline.svg)"></span></div>
        <div class="value">${h.score}<small>/100</small></div>
        <div class="score-line"><span class="meter-wrap" style="--p:${h.score}"><span class="meter"></span></span><span class="tag ${h.tone}">${h.label}</span></div>
      </button>`
    : "";
  return `${score}
    <div class="card kpi"><div class="label">Patrimônio total</div><div class="value">${money(o ? f.net : s.value)}</div>${delta(f.gain30, `${f.gain30 >= 0 ? "+" : ""}${money(f.gain30)} em 30 dias`)}</div>
    <div class="card kpi"><div class="label">Investimentos</div><div class="value">${money(s.value)}</div>${delta(f.carteira12, `${f.carteira12 != null ? pct(f.carteira12) : "—"} em 12 meses${f.cdi12 ? ` · CDI ${pct(f.cdi12)}` : ""}`)}</div>
    ${
      o
        ? `<div class="card kpi"><div class="label">Sobra do mês</div><div class="value">${money(result!)}</div>${delta(result, o.income > 0 ? `${pct(result! / o.income, 0)} das entradas` : `saiu ${money(o.expense)}`)}</div>
    <div class="card kpi"><div class="label">Faturas a pagar</div><div class="value">${money(f.bills.reduce((a, b) => a + b.total, 0))}</div><span class="sub">${next ? `${esc(next.name)} vence ${next.due.split("-").reverse().slice(0, 2).join("/")}` : "nenhuma em aberto"}</span></div>`
        : `<div class="card kpi"><div class="label">Proventos 12 meses</div><div class="value">${money(s.income12m)}</div><span class="sub">yield ${pct(s.yield12m)}</span></div>`
    }`;
}

export function runwayHtml(f: Facts, d: HubData, ghostfolio = "") {
  if (!f.tagged)
    return `<div class="row-between"><h2 style="margin:0">Fôlego · reserva de emergência</h2></div>
      <div class="runway-big">?<small>meses</small> <span class="tag warn">Sem reserva marcada</span></div>
      <div class="runway-split"><div><span class="muted small">Gasto por mês</span><b>${d.o ? money(f.spend) : "—"}</b></div><div><span class="muted small">Reserva ideal (6 meses)</span><b>${d.o ? money(f.spend * 6) : "—"}</b></div></div>
      <p class="muted small" style="margin:0">Para medir quantos meses a sua reserva cobre, marque no Ghostfolio as aplicações da reserva (Tesouro Selic, CDB de liquidez…) com o marcador <b>Fundo de Emergência</b>${ghostfolio ? ` em <a href="${esc(ghostfolio)}portfolio/activities" target="_blank" rel="noopener">Atividades</a>` : ""}.</p>`;
  const months = f.runway;
  const tag = months == null ? "" : months < 3 ? `<span class="tag bad">Crítico</span>` : months < 6 ? `<span class="tag warn">Normal</span>` : `<span class="tag good">Saudável</span>`;
  return `<div class="row-between"><h2 style="margin:0">Fôlego · reserva de emergência</h2><span class="ico info muted" style="--icon: url(icons/info-outline.svg)" title="Reserva (marcador Fundo de Emergência no Ghostfolio) dividida pela mediana do gasto mensal dos últimos 3 meses."></span></div>
    <div class="runway-big">${months == null ? "—" : `${months.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}<small>meses</small>`} ${tag}</div>
    <div class="runway-split">
      <div><span class="muted small">Gasto por mês</span><b>${d.o ? money(f.spend) : "—"}</b></div>
      <div><span class="muted small">Reserva</span><b>${money(f.reserve)}</b></div>
    </div>
    <div class="runway-legend">
      <span><i class="bad"></i>&lt; 3 meses · crítico</span>
      <span><i class="warn"></i>3 a 6 meses · normal</span>
      <span><i class="good"></i>&gt; 6 meses · saudável</span>
    </div>
    ${d.o ? "" : `<p class="note">Conecte o Firefly na aba Finanças para medir o gasto mensal.</p>`}`;
}

// ---------- gráfico principal ----------

export type MainMode = "invest" | "sobra";
export function mainChartHead(r: Report, f: Facts, d: HubData, mode: MainMode) {
  const tabs = d.months ? `<div class="toggle" role="group"><button data-main="invest" aria-pressed="${mode === "invest"}">Investimentos</button><button data-main="sobra" aria-pressed="${mode === "sobra"}">Sobra mensal</button></div>` : "";
  if (mode === "sobra" && d.months) {
    const full = d.months.filter((m) => m.income > 0 || m.expense > 0);
    const avg = full.length ? full.reduce((s, m) => s + m.income - m.expense, 0) / full.length : 0;
    return `<div class="row-between"><span class="muted small">Sobra mensal · entradas − saídas</span>${tabs}</div>
      <div class="big-line"><span class="big">${money(avg)}</span><span class="delta ${avg >= 0 ? "up" : "down"}">média por mês em 12 meses</span></div>`;
  }
  return `<div class="row-between"><span class="muted small">Investimentos · valor no fim de cada mês</span>${tabs}</div>
    <div class="big-line"><span class="big">${money(r.summary.value)}</span><span class="delta ${f.gain30 >= 0 ? "up" : "down"}">${f.gain30 >= 0 ? "+" : ""}${money(f.gain30)} em 30 dias${f.pct30 != null ? ` · ${pct(f.pct30)}` : ""}</span></div>`;
}

export function mainChart(canvas: HTMLCanvasElement, r: Report, d: HubData, mode: MainMode) {
  let labels: string[] = [];
  let values: number[] = [];
  if (mode === "sobra" && d.months) {
    const rows = d.months.slice(-12);
    labels = rows.map((m) => MONTHS[Number(m.month.slice(5)) - 1]!);
    values = rows.map((m) => Math.round((m.income - m.expense) * 100) / 100);
  } else {
    const byMonth = new Map<string, number>();
    for (const p of r.daily) byMonth.set(p.date.slice(0, 7), p.value);
    const keys = [...byMonth.keys()].slice(-12);
    labels = keys.map((k) => MONTHS[Number(k.slice(5)) - 1]!);
    values = keys.map((k) => byMonth.get(k)!);
  }
  const last = values.length - 1;
  const neg = values.map((v) => v < 0);
  const fills = values.map((_, i) => (i === last ? "#43d66b" : neg[i] ? hatch("rgba(240,79,85,0.55)", "rgba(240,79,85,0.05)") : hatch()));
  const short = (v: number) => (Math.abs(v) >= 1000 ? `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : money(v));
  return new Chart(canvas, {
    data: {
      labels,
      datasets: [
        { type: "bar", data: values, backgroundColor: fills, borderRadius: 999, borderSkipped: false, barPercentage: 0.62, categoryPercentage: 0.9, order: 2 },
        { type: "line", data: values, showLine: false, pointRadius: values.map((_, i) => (i === last ? 0 : 4)), pointHoverRadius: 5, pointBackgroundColor: "#0b0c0c", pointBorderColor: "rgba(243,245,244,0.8)", pointBorderWidth: 1.5, order: 1 },
      ],
    },
    plugins: [highlightPlugin],
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { filter: (c: { datasetIndex: number }) => c.datasetIndex === 0, callbacks: { label: (c: { raw: unknown }) => ` ${money(Number(c.raw))}` } }, highlight: { index: last, text: short(values[last] ?? 0) } } as any,
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: { grid: { color: "rgba(255,255,255,0.05)" }, border: { display: false }, ticks: { maxTicksLimit: 5, callback: (v) => axisMoney(Number(v) / 1000, " mil") } },
      },
    },
  });
}
