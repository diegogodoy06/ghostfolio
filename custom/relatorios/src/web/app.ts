import {
  ArcElement, BarController, BarElement, CategoryScale, Chart, DoughnutController, Filler, Legend,
  LineController, LineElement, LinearScale, PointElement, Tooltip,
} from "chart.js";
import type { CategoryGroup, Position, Report } from "../shared";
import { PERIODS, type PeriodId, gainBetween, indexSeries, monthlyTable, periodStart, real, rebased, ret, stats } from "./calc";
import { ACCENT, CATEGORY_COLOR, MONTHS, PALETTE, countUp, dateBR, drawLine, esc, fadeFill, growBars, money, openModal, pct, qty, skeleton, spinDonut, spct, tone } from "./ui";
import { mountSimSummary, renderCarteiraSim } from "./simulacao";

Chart.register(ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip);
Chart.defaults.color = "rgba(255,255,255,0.7)";
// Animação curta só na entrada; dados mudam sem "crescer do zero".
Chart.defaults.animation = { duration: 450, easing: "easeOutQuart" };
// Degradês (CanvasGradient) não são interpoláveis: anima forma e posição, não as cores.
Chart.defaults.animations.colors = false as any;
Chart.defaults.borderColor = "rgba(255,255,255,0.12)";
Chart.defaults.font.family = '"Inter", Roboto, "Helvetica Neue", sans-serif';

const BENCH = [
  { key: "carteira", label: "Carteira", color: ACCENT },
  { key: "cdi", label: "CDI", color: "#9085e9" },
  { key: "ibov", label: "Ibovespa", color: "#d95926" },
  { key: "ipca", label: "IPCA", color: "#c98500" },
  { key: "ipca6", label: "IPCA + 6%", color: "#d55181" },
  { key: "ifix", label: "IFIX", color: "#3987e5" },
  { key: "usd", label: "Dólar", color: "#e66767" },
] as const;

// ---------- estado ----------
type Tab = "resumo" | "carteira" | "proventos" | "rentabilidade";
const TABS: Tab[] = ["resumo", "carteira", "proventos", "rentabilidade"];
const TITLES: Record<Tab, string> = { resumo: "Resumo", carteira: "Carteira", proventos: "Proventos", rentabilidade: "Rentabilidade" };
/** Hash inicial; "#simulacao" (endereço antigo) abre a Carteira já no modo simulação. */
function tabFromHash(): Tab {
  const h = location.hash.slice(1);
  if (h === "simulacao") {
    save("rel.carteiraMode", "sim");
    return "carteira";
  }
  return (TABS as string[]).includes(h) ? (h as Tab) : "resumo";
}
const saved = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* sem armazenamento local */
  }
};
const state = {
  tab: "resumo" as Tab,
  carteiraMode: "atual" as "atual" | "sim",
  period: saved("rel.period", "12M") as PeriodId,
  realMode: saved("rel.real", "0") === "1",
  bench: new Set(saved("rel.bench", "carteira,cdi,ibov").split(",")),
  account: saved("rel.account", ""),
  incomeRange: saved("rel.incomeRange", "24"),
  report: null as Report | null,
};
state.tab = tabFromHash();
state.carteiraMode = saved("rel.carteiraMode", "atual") === "sim" ? "sim" : "atual";
let charts: Chart[] = [];
const main = document.getElementById("main")!;

async function load(refresh = false) {
  const btn = document.getElementById("refresh")!;
  btn.classList.add("spin");
  main.classList.remove("enter");
  main.innerHTML = skeleton(state.tab);
  try {
    await fetchReport(refresh);
  } finally {
    btn.classList.remove("spin");
  }
}

async function fetchReport(refresh: boolean) {
  const res = await fetch(`/api/report?accounts=${encodeURIComponent(state.account)}${refresh ? "&refresh=1" : ""}`);
  if (res.status === 401) return showLogin();
  if (!res.ok) {
    main.innerHTML = `<div class="card"><p class="error">Erro ao carregar: ${esc((await res.json().catch(() => ({}))).error ?? res.statusText)}</p></div>`;
    return;
  }
  state.report = await res.json();
  fillAccounts();
  render();
}

function showLogin() {
  main.innerHTML = "";
  const form = (document.getElementById("login-tpl") as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = (form.elements.namedItem("token") as HTMLInputElement).value;
    const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (r.ok) return load();
    const err = form.querySelector(".error") as HTMLElement;
    err.hidden = false;
    err.textContent = "Token inválido.";
  });
  main.append(form);
}

function fillAccounts() {
  const sel = document.getElementById("account") as HTMLSelectElement;
  const accs = state.report!.accounts;
  sel.innerHTML = `<option value="">Consolidado</option>` + accs.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  sel.value = state.account;
}

function render() {
  charts.forEach((c) => c.destroy());
  charts = [];
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  const r = state.report;
  if (!r) return;
  if (!r.daily.length) {
    main.innerHTML = `<div class="card"><p class="muted">Ainda não há atividades nesta carteira.</p></div>`;
    return;
  }
  document.getElementById("page-title")!.textContent = TITLES[state.tab] + (state.tab === "carteira" && state.carteiraMode === "sim" ? " · simulação" : "");
  document.title = `${TITLES[state.tab]} · Ghostfolio`;
  main.classList.remove("enter");
  ({ resumo: renderResumo, carteira: renderCarteira, proventos: renderProventos, rentabilidade: renderRentabilidade })[state.tab](r);
  void main.offsetWidth; // reinicia a animação de entrada
  main.classList.add("enter");
  countUp(main);
}

// ---------- componentes ----------
const periodChips = () =>
  `<div class="chips" data-role="period">${PERIODS.map((p) => `<button class="chip" data-period="${p.id}" aria-pressed="${state.period === p.id}">${p.label}</button>`).join("")}</div>`;
const realToggle = () =>
  `<div class="toggle" data-role="real"><button data-real="0" aria-pressed="${!state.realMode}">Nominal</button><button data-real="1" aria-pressed="${state.realMode}">Real (IPCA)</button></div>`;

function wireCommon() {
  main.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) =>
    b.addEventListener("click", () => {
      state.period = b.dataset.period as PeriodId;
      save("rel.period", state.period);
      render();
    }),
  );
  main.querySelectorAll<HTMLButtonElement>("[data-real]").forEach((b) =>
    b.addEventListener("click", () => {
      state.realMode = b.dataset.real === "1";
      save("rel.real", state.realMode ? "1" : "0");
      render();
    }),
  );
}

function donut(canvas: HTMLCanvasElement, labels: string[], values: number[], colors: string[]) {
  charts.push(
    new Chart(canvas, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#191919", borderWidth: 2 }] },
      options: {
        cutout: "68%",
        maintainAspectRatio: false,
        animation: spinDonut(),
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.parsed)} (${pct(c.parsed / values.reduce((s, v) => s + v, 0), 1)})` } } },
      },
    }),
  );
}

const legendList = (items: { label: string; value: number; weight: number; color: string }[]) =>
  `<div class="legend">${items
    .map((i) => `<div class="li"><span class="sw" style="background:${i.color}"></span><span>${esc(i.label)}</span><span class="num">${money(i.value)}</span><span class="num">${pct(i.weight, 1)}</span></div>`)
    .join("")}</div>`;

// ---------- Resumo ----------
function renderResumo(r: Report) {
  const end = r.daily.at(-1)!.date;
  const from = periodStart(state.period, r.firstDate, end);
  const idx = indexSeries(r);
  const ipca = r.benchmarks.ipca!.points;
  const inflation = state.realMode ? ret(ipca, from, end) : null;
  const items = BENCH.filter((b) => b.key !== "ipca" || !state.realMode).map((b) => {
    const s = b.key === "carteira" ? idx : r.benchmarks[b.key]!.points;
    const n = ret(s, from, end);
    return { ...b, value: n == null ? null : real(n, inflation) };
  });
  const nominal = ret(idx, from, end);
  const cdi = ret(r.benchmarks.cdi!.points, from, end);
  const gain = gainBetween(r.daily, from, end);
  const incomesPeriod = r.incomes.filter((i) => i.date > from && i.date <= end).reduce((s, i) => s + i.value, 0);
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.value ?? 0)), 0.0001);
  const s = r.summary;

  main.innerHTML = `
    <section class="kpis">
      <div class="card kpi"><div class="label">Patrimônio</div><div class="value">${money(s.value)}</div><div class="sub">Investido ${money(s.cost)}</div></div>
      <div class="card kpi"><div class="label">Valorização</div><div class="value ${tone(s.gain)}">${money(s.gain)}</div><div class="sub ${tone(s.gainPct)}">${spct(s.gainPct)} sobre o custo</div></div>
      <div class="card kpi"><div class="label">Proventos 12 meses</div><div class="value">${money(s.income12m)}</div><div class="sub">yield ${pct(s.yield12m)}</div></div>
      <div class="card kpi"><div class="label">Rendimento no período</div><div class="value ${tone(gain)}">${money(gain)}</div><div class="sub">sendo ${money(incomesPeriod)} em proventos</div></div>
    </section>
    <section id="sim-summary"></section>
    <section class="card">
      <div class="row-between"><h2>Meu desempenho</h2>${realToggle()}</div>
      ${periodChips()}
      <div class="split-1-2">
        <div>
          <div class="bars">${items
            .map((i) => `<div class="item"><span>${i.label}</span><div class="track"><div class="fill ${i.value != null && i.value < 0 ? "neg" : ""}" style="background:${i.color};left:${i.value != null && i.value < 0 ? 50 - (Math.abs(i.value) / maxAbs) * 50 : 50}%;width:${i.value == null ? 0 : (Math.abs(i.value) / maxAbs) * 50}%"></div></div><span class="v ${tone(i.value)}">${pct(i.value)}</span></div>`)
            .join("")}</div>
          <p class="note">${nominal != null && cdi ? `Sua carteira rendeu <b>${pct(nominal)}</b> contra <b>${pct(cdi)}</b> do CDI: <b>${pct(nominal / cdi, 1)} do CDI</b>.` : ""} Rentabilidade por cota (ponderada no tempo), com proventos — mesmo método de Rico e TradeMap.${state.realMode ? " Valores reais: descontada a inflação (IPCA) do período." : ""}${ghostNote(r, gain)}</p>
        </div>
        <div>
          <div class="chips" data-role="bench">${BENCH.map((b) => `<button class="chip" data-bench="${b.key}" aria-pressed="${state.bench.has(b.key)}"><span class="dot" style="background:${b.color}"></span>${b.label}</button>`).join("")}</div>
          <div class="chart-box"><canvas id="perf"></canvas></div>
        </div>
      </div>
    </section>
    <section class="split">
      <div class="card"><h2>Alocação</h2><div class="chart-box donut"><canvas id="alloc"></canvas></div><h3>Por categoria</h3>${legendList(r.categories.map((c) => ({ label: c.name, value: c.value, weight: c.weight, color: CATEGORY_COLOR[c.name] ?? PALETTE[8]! })))}</div>
      <div class="card"><h2>Evolução do patrimônio</h2><div class="chart-box"><canvas id="equity"></canvas></div><p class="note">Valor de mercado × valor investido.</p></div>
    </section>`;
  wireCommon();
  main.querySelectorAll<HTMLButtonElement>("[data-bench]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.bench!;
      state.bench.has(k) ? state.bench.delete(k) : state.bench.add(k);
      save("rel.bench", [...state.bench].join(","));
      render();
    }),
  );

  mountSimSummary(document.getElementById("sim-summary")!, r, () => openCarteira("sim"));

  // Desempenho: carteira x referências, rebaseadas a 0%.
  const days = r.daily.filter((p) => p.date >= from).map((p) => p.date);
  const defl = state.realMode ? ipca : undefined;
  charts.push(
    new Chart(document.getElementById("perf") as HTMLCanvasElement, {
      type: "line",
      data: {
        labels: days.map(dateBR),
        datasets: BENCH.filter((b) => state.bench.has(b.key)).map((b) => ({
          label: b.label,
          data: rebased(b.key === "carteira" ? idx : r.benchmarks[b.key]!.points, days, from, defl),
          borderColor: b.color,
          backgroundColor: b.key === "carteira" ? fadeFill("54, 207, 204", 0.22) : b.color,
          fill: b.key === "carteira" ? "origin" : false,
          borderWidth: b.key === "carteira" ? 2.5 : 1.75,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.25,
        })),
      },
      options: {
        maintainAspectRatio: false,
        animation: drawLine(days.length),
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${(c.parsed.y ?? 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` } } },
        scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { callback: (v) => `${v}%` } } },
      },
    }),
  );
  donut(document.getElementById("alloc") as HTMLCanvasElement, r.categories.map((c) => c.name), r.categories.map((c) => c.value), r.categories.map((c) => CATEGORY_COLOR[c.name] ?? PALETTE[8]!));

  const eq = r.daily.filter((p) => p.date >= from);
  charts.push(
    new Chart(document.getElementById("equity") as HTMLCanvasElement, {
      type: "line",
      data: {
        labels: eq.map((p) => dateBR(p.date)),
        datasets: [
          { label: "Patrimônio", data: eq.map((p) => p.value), borderColor: "#36cfcc", backgroundColor: fadeFill("54, 207, 204", 0.25), fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25 },
          { label: "Investido", data: eq.map((p) => p.invested), borderColor: "#858a96", borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        animation: drawLine(eq.length),
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y ?? 0)}` } } },
        scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { callback: (v) => `R$ ${(Number(v) / 1000).toLocaleString("pt-BR")} mil` } } },
      },
    }),
  );
}

/** Explica a diferença para o percentual exibido no Ghostfolio no mesmo período. */
function ghostNote(r: Report, gain: number) {
  const g = r.ghostfolio[state.period as keyof Report["ghostfolio"]];
  if (!g) return "";
  return `<br>No Ghostfolio, este período aparece como <b>${pct(g.pct)}</b>: o ganho é o mesmo (${money(g.gain)} lá, ${money(gain)} aqui), mas ele divide pelo <b>capital médio investido</b> no período. Com aportes ao longo do ano, os dois métodos dão percentuais diferentes para o mesmo dinheiro.`;
}

// ---------- Carteira ----------
function positionsTable(ps: Position[]) {
  const rows = ps
    .map(
      (p) => `<tr class="clickable" data-ticker="${esc(p.ticker)}">
      <td><div class="tk">${esc(p.ticker)}</div><div class="nm">${esc(p.subcategory)}</div></td>
      <td>${qty(p.quantity)}</td><td>${money(p.avgPrice)}</td><td>${money(p.price)}</td><td>${money(p.value)}</td>
      <td class="${tone(p.gain)}">${money(p.gain)}<div class="small">${spct(p.gainPct)}</div></td>
      <td>${money(p.income)}</td><td>${pct(p.weightInCategory, 1)}</td><td>${pct(p.weight, 1)}</td></tr>`,
    )
    .join("");
  const cards = ps
    .map(
      (p) => `<div class="pos" data-ticker="${esc(p.ticker)}"><div class="head"><span>${esc(p.ticker)} <span class="muted small">${qty(p.quantity)} cotas</span></span><span>${money(p.value)}</span></div>
      <div class="grid"><div><div class="l">P. médio</div>${money(p.avgPrice)}</div><div><div class="l">Preço</div>${money(p.price)}</div><div><div class="l">Retorno</div><span class="${tone(p.gain)}">${spct(p.gainPct, 1)}</span></div>
      <div><div class="l">Proventos</div>${money(p.income)}</div><div><div class="l">% classe</div>${pct(p.weightInCategory, 1)}</div><div><div class="l">% carteira</div>${pct(p.weight, 1)}</div></div></div>`,
    )
    .join("");
  return `<div class="scroll pos-table"><table><thead><tr><th>Ativo</th><th>Qtde</th><th>P. médio</th><th>Preço</th><th>Valor</th><th>Retorno</th><th>Proventos</th><th>% classe</th><th>% carteira</th></tr></thead><tbody>${rows}</tbody></table></div><div class="pos-cards">${cards}</div>`;
}

function openCarteira(mode: "atual" | "sim") {
  state.carteiraMode = mode;
  save("rel.carteiraMode", mode);
  state.tab = "carteira";
  history.replaceState(null, "", "#carteira");
  render();
  window.scrollTo(0, 0);
}

/** Seletor "Carteira atual | Simulação" (como a conta simulação do TradeMap). */
const modeBar = () => `<section class="mode-bar"><div class="toggle" role="group" aria-label="Modo da carteira">
    <button data-cmode="atual" aria-pressed="${state.carteiraMode === "atual"}">Carteira atual</button>
    <button data-cmode="sim" aria-pressed="${state.carteiraMode === "sim"}">Simulação</button></div>
    <span class="muted small">${state.carteiraMode === "sim" ? "Simule aportes e boletas de compra e venda sem alterar o Ghostfolio." : "Posições reais vindas do Ghostfolio."}</span></section>`;
const wireModeBar = () =>
  main.querySelectorAll<HTMLButtonElement>("[data-cmode]").forEach((b) => b.addEventListener("click", () => b.dataset.cmode !== state.carteiraMode && openCarteira(b.dataset.cmode as "atual" | "sim")));

function renderCarteira(r: Report) {
  if (state.carteiraMode === "sim") return renderCarteiraSim(r, main, modeBar(), wireModeBar);
  const total = r.summary.value;
  main.innerHTML =
    modeBar() +
    `<section class="split"><div class="card"><h2>Minha carteira · ${money(total)}</h2><div class="chart-box donut"><canvas id="alloc"></canvas></div></div>
     <div class="card"><h2>Por categoria</h2>${legendList(r.categories.map((c) => ({ label: c.name, value: c.value, weight: c.weight, color: CATEGORY_COLOR[c.name] ?? PALETTE[8]! })))}
     <p class="note">Ajuste a categoria de um ativo em <code>extratos/categorias.json</code>.</p></div></section>` +
    r.categories
      .map((c: CategoryGroup, i) => {
        const color = CATEGORY_COLOR[c.name] ?? PALETTE[8]!;
        const gain = c.value - c.cost;
        return `<details class="cat" ${i === 0 ? "open" : ""}>
        <summary><span class="ring" style="border:3px solid ${color}">${pct(c.weight, 0)}</span>
          <span><div class="t">${esc(c.name)}</div><div class="muted small">${c.positions.length} ativo(s) · custo ${money(c.cost)}</div></span>
          <span style="text-align:right"><div class="t">${money(c.value)}</div><div class="small ${tone(gain)}">${spct(c.cost ? gain / c.cost : null)}</div></span>
          <span class="chev">›</span></summary>
        <div class="body"><div class="split"><div class="chart-box donut"><canvas id="sub-${i}"></canvas></div><div>${legendList(c.subgroups.map((g, j) => ({ label: g.name, value: g.value, weight: g.weight, color: PALETTE[j % PALETTE.length]! })))}</div></div>
        <h3>Ativos</h3>${positionsTable(c.positions)}</div></details>`;
      })
      .join("");
  wireModeBar();
  donut(document.getElementById("alloc") as HTMLCanvasElement, r.categories.map((c) => c.name), r.categories.map((c) => c.value), r.categories.map((c) => CATEGORY_COLOR[c.name] ?? PALETTE[8]!));
  const drawSub = (i: number) => {
    const c = r.categories[i]!;
    const el = document.getElementById(`sub-${i}`) as HTMLCanvasElement | null;
    if (el && !Chart.getChart(el)) donut(el, c.subgroups.map((g) => g.name), c.subgroups.map((g) => g.value), c.subgroups.map((_, j) => PALETTE[j % PALETTE.length]!));
  };
  main.querySelectorAll<HTMLElement>("[data-ticker]").forEach((el) => el.addEventListener("click", () => assetModal(r, el.dataset.ticker!)));
  main.querySelectorAll("details.cat").forEach((d, i) => {
    if ((d as HTMLDetailsElement).open) drawSub(i);
    d.addEventListener("toggle", () => (d as HTMLDetailsElement).open && drawSub(i));
  });
}

/** Detalhe de um ativo: posição, retorno e histórico de proventos. */
function assetModal(r: Report, ticker: string) {
  const p = r.categories.flatMap((c) => c.positions).find((x) => x.ticker === ticker);
  if (!p) return;
  const incomes = r.incomes.filter((i) => i.ticker === ticker);
  const today = new Date();
  const months: string[] = [];
  for (let k = 23; k >= 0; k--) months.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
  const yoc = p.cost > 0 ? p.income12m / p.cost : null;
  const m = openModal(
    `${p.ticker} · ${p.category}`,
    `<p class="muted" style="margin-top:0">${esc(p.name)} · ${esc(p.subcategory)}</p>
     <div class="stats">
       <div class="stat"><div class="l">Quantidade</div><div class="v">${qty(p.quantity)}</div></div>
       <div class="stat"><div class="l">Preço médio</div><div class="v">${money(p.avgPrice)}</div></div>
       <div class="stat"><div class="l">Preço atual</div><div class="v">${money(p.price)}</div></div>
       <div class="stat"><div class="l">Valor</div><div class="v">${money(p.value)}</div></div>
       <div class="stat"><div class="l">Valorização</div><div class="v ${tone(p.gain)}">${spct(p.gainPct)}</div><div class="small ${tone(p.gain)}">${money(p.gain)}</div></div>
       <div class="stat"><div class="l">Proventos (total)</div><div class="v">${money(p.income)}</div></div>
       <div class="stat"><div class="l">Yield sobre custo (12m)</div><div class="v">${pct(yoc)}</div></div>
       <div class="stat"><div class="l">% da carteira</div><div class="v">${pct(p.weight, 1)}</div><div class="small muted">${pct(p.weightInCategory, 1)} da classe</div></div>
     </div>
     <h3>Proventos por mês (24 meses)</h3><div class="chart-box" style="height:220px"><canvas id="asset-inc"></canvas></div>`,
    { wide: true },
  );
  const chart = new Chart(m.el.querySelector("#asset-inc") as HTMLCanvasElement, {
    type: "bar",
    data: {
      labels: months.map((x) => `${MONTHS[Number(x.slice(5)) - 1]}/${x.slice(2, 4)}`),
      datasets: [
        { label: "Recebido", data: months.map((x) => incomes.filter((i) => !i.estimated && i.date.startsWith(x)).reduce((s, i) => s + i.value, 0)), backgroundColor: ACCENT, borderRadius: 3, stack: "s" },
        { label: "Estimado", data: months.map((x) => incomes.filter((i) => i.estimated && i.date.startsWith(x)).reduce((s, i) => s + i.value, 0)), backgroundColor: "rgba(54,207,204,0.35)", borderRadius: 3, stack: "s" },
      ],
    },
    options: {
      maintainAspectRatio: false,
      animation: growBars(),
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y ?? 0)}` } } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v) => `R$ ${v}` } } },
    },
  });
  // O gráfico do modal é destruído junto com ele.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(m.el)) {
      chart.destroy();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });
}

// ---------- Proventos ----------
function renderProventos(r: Report) {
  const today = new Date().toISOString().slice(0, 10);
  const y = today.slice(0, 4);
  const sum = (f: (i: Report["incomes"][number]) => boolean) => r.incomes.filter(f).reduce((s, i) => s + i.value, 0);
  const since12 = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const last12 = sum((i) => i.date >= since12);
  const estimated = sum((i) => i.estimated);

  // Mensal por categoria.
  const monthsBack = state.incomeRange === "all" ? 999 : Number(state.incomeRange);
  const allMonths = [...new Set(r.incomes.map((i) => i.date.slice(0, 7)))].sort();
  const lastMonth = today.slice(0, 7);
  const months: string[] = [];
  if (allMonths.length) {
    const d = new Date(`${lastMonth}-01T00:00:00Z`);
    for (let k = 0; k < monthsBack; k++) {
      const m = d.toISOString().slice(0, 7);
      if (m < allMonths[0]!) break;
      months.unshift(m);
      d.setUTCMonth(d.getUTCMonth() - 1);
    }
  }
  const cats = [...new Set(r.incomes.map((i) => i.category))];
  const byType = new Map<string, number>();
  const byAsset = new Map<string, number>();
  const byYear = new Map<string, number>();
  for (const i of r.incomes) {
    const t = i.type.replace(" (estimado)", "");
    byType.set(t, (byType.get(t) ?? 0) + i.value);
    if (i.date >= since12) byAsset.set(i.ticker, (byAsset.get(i.ticker) ?? 0) + i.value);
    byYear.set(i.date.slice(0, 4), (byYear.get(i.date.slice(0, 4)) ?? 0) + i.value);
  }
  const top = [...byAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const topMax = top[0]?.[1] ?? 1;
  const typeTotal = [...byType.values()].reduce((s, v) => s + v, 0);

  main.innerHTML = `
    <section class="kpis">
      <div class="card kpi"><div class="label">Últimos 12 meses</div><div class="value">${money(last12)}</div><div class="sub">média ${money(last12 / 12)}/mês</div></div>
      <div class="card kpi"><div class="label">Em ${y}</div><div class="value">${money(sum((i) => i.date.startsWith(y)))}</div><div class="sub">yield 12m ${pct(r.summary.yield12m)}</div></div>
      <div class="card kpi"><div class="label">Total recebido</div><div class="value">${money(r.summary.incomeTotal - estimated)}</div><div class="sub">desde ${dateBR(r.firstDate)}</div></div>
      <div class="card kpi"><div class="label">A receber (estimado)</div><div class="value">${money(estimated)}</div><div class="sub">anunciados, ainda fora do extrato</div></div>
    </section>
    <section class="card">
      <div class="row-between"><h2>Evolução mensal</h2><div class="chips">${[["12", "12 meses"], ["24", "24 meses"], ["all", "Tudo"]].map(([v, l]) => `<button class="chip" data-irange="${v}" aria-pressed="${state.incomeRange === v}">${l}</button>`).join("")}</div></div>
      <div class="chart-box tall"><canvas id="monthly"></canvas></div>
      <p class="note">Barras por categoria; o segmento mais claro no topo são os proventos estimados (data ex), que viram valores reais quando o extrato da B3 chega.</p>
    </section>
    <section class="split">
      <div class="card"><h2>Quem mais pagou (12 meses)</h2><div class="bars">${top
        .map(([t, v]) => `<div class="item"><span>${esc(t)}</span><div class="track"><div class="fill" style="background:#36cfcc;left:0;width:${(v / topMax) * 100}%"></div></div><span class="v">${money(v)}</span></div>`)
        .join("")}</div></div>
      <div class="card"><h2>Por tipo</h2>${legendList([...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, v], j) => ({ label: t, value: v, weight: v / (typeTotal || 1), color: PALETTE[j % PALETTE.length]! })))}
        <h3>Por ano</h3>${legendList([...byYear.entries()].sort().reverse().map(([yy, v]) => ({ label: yy, value: v, weight: v / (typeTotal || 1), color: "#36cfcc" })))}</div>
    </section>
    <section class="card"><h2>Últimos lançamentos</h2><div class="scroll"><table><thead><tr><th>Data</th><th>Ativo</th><th>Tipo</th><th>Valor</th></tr></thead><tbody>${[...r.incomes]
      .reverse()
      .slice(0, 40)
      .map((i) => `<tr><td>${dateBR(i.date)}</td><td>${esc(i.ticker)}</td><td>${esc(i.type)}</td><td>${money(i.value)}</td></tr>`)
      .join("")}</tbody></table></div></section>`;

  main.querySelectorAll<HTMLButtonElement>("[data-irange]").forEach((b) =>
    b.addEventListener("click", () => {
      state.incomeRange = b.dataset.irange!;
      save("rel.incomeRange", state.incomeRange);
      render();
    }),
  );
  const val = (m: string, c: string, est: boolean) => r.incomes.filter((i) => i.date.startsWith(m) && i.category === c && i.estimated === est).reduce((s, i) => s + i.value, 0);
  charts.push(
    new Chart(document.getElementById("monthly") as HTMLCanvasElement, {
      type: "bar",
      data: {
        labels: months.map((m) => `${MONTHS[Number(m.slice(5)) - 1]}/${m.slice(2, 4)}`),
        datasets: [
          ...cats.map((c) => ({ label: c, data: months.map((m) => val(m, c, false)), backgroundColor: CATEGORY_COLOR[c] ?? PALETTE[8]!, borderRadius: 3, stack: "s" })),
          { label: "Estimado", data: months.map((m) => cats.reduce((s, c) => s + val(m, c, true), 0)), backgroundColor: "rgba(54,207,204,0.35)", borderRadius: 3, stack: "s" },
        ],
      },
      options: {
        maintainAspectRatio: false,
        animation: growBars(),
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10 } },
          tooltip: { mode: "index", filter: (i) => (i.parsed.y ?? 0) > 0, callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y ?? 0)}`, footer: (items) => `Total: ${money(items.reduce((s, i) => s + (i.parsed.y ?? 0), 0))}` } },
        },
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v) => `R$ ${v}` } } },
      },
    }),
  );
}

// ---------- Rentabilidade ----------
function renderRentabilidade(r: Report) {
  const end = r.daily.at(-1)!.date;
  const from = periodStart(state.period, r.firstDate, end);
  const st = stats(r, from, end);
  const rows = monthlyTable(r);
  const cell = (m: { ret: number; cdi: number | null } | null) =>
    m ? `<td><span class="${tone(m.ret)}">${pct(m.ret)}</span><span class="c">${m.cdi ? `${pct(m.ret / m.cdi, 0)} CDI` : ""}</span></td>` : `<td class="muted">—</td>`;
  main.innerHTML = `
    <section class="card"><h2>Rentabilidade mensal</h2><div class="scroll"><table class="months"><thead><tr><th>Ano</th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}<th>Ano</th></tr></thead>
      <tbody>${rows.map((row) => `<tr><td><b>${row.year}</b></td>${row.months.map(cell).join("")}${cell(row.year_)}</tr>`).join("")}</tbody></table></div>
      <p class="note">Rentabilidade por cota com proventos. Abaixo de cada mês, quanto ele representou do CDI.</p></section>
    <section class="card"><h2>Estatísticas</h2>${periodChips()}
      <div class="stats">
        <div class="stat"><div class="l">Volatilidade (anual)</div><div class="v">${pct(st.volatility)}</div></div>
        <div class="stat"><div class="l">Maior queda</div><div class="v down">${pct(st.maxDrawdown)}</div></div>
        <div class="stat"><div class="l">Melhor mês</div><div class="v up">${st.best ? `${pct(st.best.ret)}` : "—"}</div><div class="muted small">${st.best ? st.best.key.split("-").reverse().join("/") : ""}</div></div>
        <div class="stat"><div class="l">Pior mês</div><div class="v ${tone(st.worst?.ret)}">${st.worst ? pct(st.worst.ret) : "—"}</div><div class="muted small">${st.worst ? st.worst.key.split("-").reverse().join("/") : ""}</div></div>
        <div class="stat"><div class="l">Meses positivos</div><div class="v">${st.positiveMonths} de ${st.months}</div></div>
        <div class="stat"><div class="l">Meses acima do CDI</div><div class="v">${st.beatCdi} de ${st.months}</div></div>
        <div class="stat"><div class="l">Índice de Sharpe</div><div class="v">${st.sharpe == null ? "—" : st.sharpe.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}</div></div>
        <div class="stat"><div class="l">Rendimento no período</div><div class="v ${tone(gainBetween(r.daily, from, end))}">${money(gainBetween(r.daily, from, end))}</div></div>
      </div>
      <p class="note">Sharpe: retorno anual acima do CDI dividido pela volatilidade. Maior queda: pior perda do topo ao fundo no período.</p></section>`;
  wireCommon();
}

// ---------- eventos globais ----------
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    state.tab = b.dataset.tab as Tab;
    history.replaceState(null, "", `#${state.tab}`);
    render();
    window.scrollTo(0, 0);
  }),
);
window.addEventListener("hashchange", () => {
  const t = tabFromHash();
  if (location.hash === "#simulacao") state.carteiraMode = "sim";
  if (t !== state.tab || location.hash === "#simulacao") {
    state.tab = t;
    history.replaceState(null, "", `#${t}`);
    render();
  }
});

// Links para as páginas do Ghostfolio (mesmo host, porta 3333, em português).
const GHOSTFOLIO = `${location.protocol}//${location.hostname}:3333/pt/`;
document.querySelectorAll<HTMLAnchorElement>("[data-gf]").forEach((a) => (a.href = GHOSTFOLIO + a.dataset.gf));
const menuBtn = document.getElementById("gf-menu")!;
const menuList = document.getElementById("gf-menu-list")!;
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menuList.hidden = !menuList.hidden;
  menuBtn.setAttribute("aria-expanded", String(!menuList.hidden));
});
document.addEventListener("click", () => {
  menuList.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
});
document.getElementById("account")!.addEventListener("change", (e) => {
  state.account = (e.target as HTMLSelectElement).value;
  save("rel.account", state.account);
  load();
});
document.getElementById("refresh")!.addEventListener("click", () => load(true));
load();
