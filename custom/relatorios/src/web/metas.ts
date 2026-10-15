// Metas de patrimônio: "quero chegar a R$ X até tal mês". Independente da simulação de aportes.
import { Chart } from "chart.js";
import type { Report } from "../shared";
import { type Goal, type GoalPlan, INFLATION, STATUS_LABEL, addMonths, futureValue, goalBaseValue as baseValue, monthKey, monthsBetween, planGoal } from "../goals";
import { indexSeries, periodStart, ret } from "./calc";
import { ACCENT, MONTHS, axisMoney, esc, fadeFill, money, openModal, parseNum, pct, toast } from "./ui";

let goals: Goal[] | null = null;
let loading: Promise<Goal[]> | null = null;

export function loadGoals(): Promise<Goal[]> {
  if (goals) return Promise.resolve(goals);
  loading ??= fetch("/api/goals")
    .then((r) => (r.ok ? r.json() : { goals: [] }))
    .then((d: { goals?: Goal[] }) => (goals = d.goals ?? []));
  return loading;
}

async function saveGoals(quiet = false) {
  const res = await fetch("/api/goals", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ goals }) });
  if (!res.ok || !quiet) toast(res.ok ? "Metas salvas" : "Não foi possível salvar as metas");
}

/** O histórico diário só serve se o recorte carregado for o mesmo da meta (ou se não houver reserva marcada). */
const historyMatches = (r: Report, base: Goal["base"]) => !r.reserve.tagged || r.scope === base;

const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]}/${ym.slice(2, 4)}`;
const monthLong = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]?.toLowerCase()}/${ym.slice(0, 4)}`;
const duration = (n: number) => {
  if (n <= 0) return "prazo encerrado";
  const y = Math.floor(n / 12);
  const m = n % 12;
  return [y ? `${y} ano${y > 1 ? "s" : ""}` : "", m ? `${m} ${m > 1 ? "meses" : "mês"}` : ""].filter(Boolean).join(" e ");
};
const statusClass = (s: GoalPlan["status"]) => (s === "atingida" || s === "no-ritmo" ? "buy" : s === "abaixo" ? "over" : "sell");

function verdict(g: Goal, p: GoalPlan) {
  if (p.status === "atingida") return "Meta atingida. Dá para definir a próxima.";
  if (p.status === "vencida") return `O prazo passou e faltam ${money(p.missing)}. Ajuste a data para continuar acompanhando.`;
  const reach = p.reach ? `Com ${money(g.monthly)} por mês você chega lá em <b>${monthLong(p.reach)}</b>` : `Com ${money(g.monthly)} por mês a meta não é atingida em 50 anos`;
  if (p.status === "no-ritmo") return `${reach}${p.reach && p.reach < g.date ? `, ${duration(monthsBetween(p.reach, g.date))} antes do prazo` : ""}.`;
  return `${reach}. Para chegar em ${monthLong(g.date)}, o aporte precisa ser de <b>${money(p.required)}</b> por mês (${money(p.required - g.monthly)} a mais).`;
}

// ---------- Aba Metas ----------
export async function renderMetas(r: Report, main: HTMLElement, charts: Chart[]) {
  const list = await loadGoals();
  if (!main.isConnected) return;
  const head = `<section class="mode-bar"><p class="muted small" style="margin:0">Quanto você quer ter e até quando. Não depende da simulação: usa o patrimônio de hoje, uma rentabilidade esperada e o seu aporte mensal.</p>
    <button class="primary" id="goal-new">+ Nova meta</button></section>`;
  if (r.scope === "reserva") {
    main.innerHTML = head + `<div class="card"><p class="muted" style="margin:0">As metas usam a carteira ou o patrimônio todo. Escolha <b>Carteira</b> ou <b>Tudo</b> no seletor do topo.</p></div>`;
  } else if (!list.length) {
    main.innerHTML =
      head +
      `<div class="card goal-empty"><h2 style="margin:0 0 6px">Nenhuma meta ainda</h2><p class="muted" style="margin:0 0 16px">Exemplo: R$ 100 mil até dezembro de 2030, aportando R$ 500 por mês. A tela mostra se você está no ritmo e quanto precisa aportar.</p><button class="ghost" id="goal-new-2">Criar minha primeira meta</button></div>`;
  } else {
    main.innerHTML = head + list.map((g, i) => goalCard(r, g, i, list.length)).join("");
  }
  main.querySelectorAll("#goal-new, #goal-new-2").forEach((b) => b.addEventListener("click", () => goalModal(r, null, () => renderMetas(r, main, charts))));
  for (const g of list) {
    const card = main.querySelector<HTMLElement>(`[data-goal="${g.id}"]`);
    if (!card) continue;
    card.querySelector(".goal-edit")!.addEventListener("click", () => goalModal(r, g, () => renderMetas(r, main, charts)));
    card.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((b) =>
      b.addEventListener("click", async () => {
        const from = list.findIndex((x) => x.id === g.id);
        const to = from + Number(b.dataset.move);
        if (to < 0 || to >= list.length) return;
        const next = [...list];
        [next[from], next[to]] = [next[to]!, next[from]!];
        goals = next;
        charts.splice(0).forEach((c) => c.destroy());
        await renderMetas(r, main, charts);
        // Mantém a meta movida à vista e com o foco no mesmo botão.
        const moved = main.querySelector<HTMLElement>(`[data-goal="${g.id}"]`);
        moved?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        (moved?.querySelector<HTMLElement>(`[data-move="${b.dataset.move}"]:not(:disabled)`) ?? moved?.querySelector<HTMLElement>("[data-move]:not(:disabled)"))?.focus();
        await saveGoals(true);
      }),
    );
    card.querySelector(".goal-del")!.addEventListener("click", async () => {
      if (!confirm(`Excluir a meta "${g.name}"?`)) return;
      goals = list.filter((x) => x.id !== g.id);
      await saveGoals();
      renderMetas(r, main, charts);
    });
    const canvas = card.querySelector("canvas");
    if (canvas) charts.push(goalChart(canvas, r, g));
  }
}

function goalCard(r: Report, g: Goal, index: number, count: number) {
  const value = baseValue(r, g.base) ?? 0;
  const p = planGoal(g, value);
  return `<section class="card goal" data-goal="${esc(g.id)}">
    <div class="row-between goal-top">
      <div><h2 style="margin:0">${esc(g.name)}</h2>
        <p class="muted small" style="margin:4px 0 0">${money(g.target)}${g.real ? " em valores de hoje" : ""} até ${monthLong(g.date)} · ${g.base === "tudo" ? "carteira + reserva" : "só a carteira"} · ${pct(g.annualReturn / 100, 1)} a.a. esperados</p></div>
      <div class="goal-actions"><span class="badge ${statusClass(p.status)}">${STATUS_LABEL[p.status]}</span>
        ${count > 1 ? `<span class="goal-move"><button class="icon" data-move="-1" aria-label="Subir meta" title="Subir" ${index === 0 ? "disabled" : ""}>↑</button><button class="icon" data-move="1" aria-label="Descer meta" title="Descer" ${index === count - 1 ? "disabled" : ""}>↓</button></span>` : ""}
        <button class="ghost small-btn goal-edit">Editar</button><button class="icon goal-del" aria-label="Excluir meta" title="Excluir">✕</button></div>
    </div>
    <div class="goal-progress"><div class="track"><div class="fill" style="width:${(p.progress * 100).toFixed(1)}%"></div></div>
      <div class="row-between small"><span><b>${money(value)}</b> de ${money(g.target)}</span><span class="muted">${pct(p.progress, 1)}</span></div></div>
    <div class="stats goal-stats">
      <div class="stat"><div class="l">Falta</div><div class="v">${money(p.missing)}</div></div>
      <div class="stat"><div class="l">Prazo</div><div class="v">${duration(p.months)}</div></div>
      <div class="stat"><div class="l">Aporte necessário</div><div class="v">${money(p.required)}<span class="muted small"> /mês</span></div><div class="small muted">você planeja ${money(g.monthly)}</div></div>
      <div class="stat"><div class="l">Na data, com seu aporte</div><div class="v ${p.projected >= g.target ? "up" : ""}">${money(p.projected)}</div></div>
    </div>
    <p class="note" style="margin-top:4px">${verdict(g, p)}</p>
    <div class="chart-box wipe goal-chart"><canvas></canvas></div>
    <p class="note">${historyMatches(r, g.base) ? "" : `O histórico aparece quando o seletor do topo está em <b>${g.base === "tudo" ? "Tudo" : "Carteira"}</b>. `}Projeção com juros compostos mensais${g.real ? `, em valores de hoje (descontando inflação de ${INFLATION.toLocaleString("pt-BR")}% a.a.)` : ""}. É uma estimativa: a rentabilidade real varia mês a mês.</p>
  </section>`;
}

function goalChart(canvas: HTMLCanvasElement, r: Report, g: Goal) {
  const today = monthKey(new Date());
  const value = baseValue(r, g.base) ?? 0;
  const p = planGoal(g, value, today);
  // Histórico: último valor de cada mês, até 24 meses para trás.
  const hist = new Map<string, number>();
  if (historyMatches(r, g.base)) {
    const from = addMonths(today, -24);
    for (const d of r.daily) if (d.date.slice(0, 7) >= from) hist.set(d.date.slice(0, 7), d.value);
  }
  hist.set(today, value);
  const start = [...hist.keys()].sort()[0]!;
  let end = g.date > today ? g.date : addMonths(today, 12);
  if (p.reach && p.reach > end && monthsBetween(end, p.reach) <= 120) end = p.reach;
  const months: string[] = [];
  for (let m = start; m <= end; m = addMonths(m, 1)) months.push(m);
  const ahead = (pmt: number) => months.map((m) => (m < today ? null : futureValue(value, pmt, p.monthlyRate, monthsBetween(today, m))));
  const datasets: any[] = [
    { label: "Patrimônio", data: months.map((m) => hist.get(m) ?? null), borderColor: ACCENT, backgroundColor: fadeFill("54, 207, 204", 0.22), fill: true, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, spanGaps: true },
    { label: `Com ${money(g.monthly)}/mês`, data: ahead(g.monthly), borderColor: ACCENT, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
  ];
  if (p.status === "abaixo") datasets.push({ label: `Necessário: ${money(p.required)}/mês`, data: ahead(p.required).map((v, i) => (months[i]! > g.date ? null : v)), borderColor: "#c98500", borderDash: [2, 4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 });
  datasets.push({ label: "Meta", data: months.map(() => g.target), borderColor: "rgba(255,255,255,0.45)", borderDash: [3, 3], borderWidth: 1, pointRadius: 0, pointHoverRadius: 0 });
  return new Chart(canvas, {
    type: "line",
    data: { labels: months.map(monthLabel), datasets },
    options: {
      maintainAspectRatio: false,
      animation: false, // revelação por CSS (.chart-box.wipe)
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => (c.parsed.y == null ? "" : ` ${c.dataset.label}: ${money(c.parsed.y)}`) } } },
      scales: { x: { ticks: { maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => axisMoney(Number(v) / 1000, " mil") } } },
    },
  });
}

// ---------- Criar / editar ----------
function goalModal(r: Report, g: Goal | null, done: () => void) {
  const end = r.daily.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const r12 = ret(indexSeries(r), periodStart("12M", r.firstDate, end), end);
  const rMax = ret(indexSeries(r), r.firstDate, end);
  const years = Math.max(1, (Date.parse(end) - Date.parse(r.firstDate)) / (365.25 * 86_400_000));
  const rMaxYear = rMax == null ? null : Math.pow(1 + rMax, 1 / years) - 1;
  const v = g ?? { name: "", target: 0, date: addMonths(monthKey(new Date()), 60), base: "carteira" as const, annualReturn: 10, monthly: 500, real: false };
  const num = (n: number) => (n ? n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "");
  const m = openModal(
    g ? "Editar meta" : "Nova meta",
    `<form class="goal-form">
      <label class="field">Nome<input name="name" maxlength="60" placeholder="Ex.: Independência financeira, Entrada do apartamento" value="${esc(v.name)}" required/></label>
      <div class="goal-form-row">
        <label class="field">Quero ter<span class="money-input"><b>R$</b><input name="target" inputmode="decimal" placeholder="100.000" value="${num(v.target)}" required/></span></label>
        <label class="field">Até<input name="date" type="month" min="${monthKey(new Date())}" value="${v.date}" required/></label>
      </div>
      <div class="field">Contar
        <div class="toggle" role="group"><button type="button" data-base="carteira" aria-pressed="${v.base === "carteira"}">Só a carteira</button><button type="button" data-base="tudo" aria-pressed="${v.base === "tudo"}">Carteira + reserva</button></div>
      </div>
      <div class="goal-form-row">
        <label class="field">Aporte mensal<span class="money-input"><b>R$</b><input name="monthly" inputmode="decimal" placeholder="500" value="${num(v.monthly)}"/></span></label>
        <label class="field">Rentabilidade esperada<span class="money-input suffix"><input name="annualReturn" inputmode="decimal" value="${num(v.annualReturn)}"/><b>% a.a.</b></span></label>
      </div>
      <p class="muted small" style="margin:-4px 0 0">Referências: sua carteira rendeu ${pct(r12, 1)} nos últimos 12 meses e ${pct(rMaxYear, 1)} ao ano desde o início. Para prazos longos, algo entre 8% e 12% a.a. é uma premissa comum.</p>
      <label class="switch"><input type="checkbox" name="real" ${v.real ? "checked" : ""}/><span></span>Meta em valores de hoje (desconta inflação de ${INFLATION.toLocaleString("pt-BR")}% a.a.)</label>
      <p class="error small" hidden></p>
      <div class="row-between" style="margin-top:8px"><span></span><button class="primary" type="submit">${g ? "Salvar" : "Criar meta"}</button></div>
    </form>`,
  );
  const form = m.el.querySelector("form")!;
  let base: Goal["base"] = v.base;
  form.querySelectorAll<HTMLButtonElement>("[data-base]").forEach((b) =>
    b.addEventListener("click", () => {
      base = b.dataset.base as Goal["base"];
      form.querySelectorAll<HTMLButtonElement>("[data-base]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value;
    const err = form.querySelector(".error") as HTMLElement;
    const target = parseNum(f("target")) ?? 0;
    const date = f("date");
    if (target <= 0 || !/^\d{4}-\d{2}$/.test(date)) {
      err.hidden = false;
      err.textContent = "Informe o valor e o mês da meta.";
      return;
    }
    const next: Goal = {
      id: g?.id ?? crypto.randomUUID(),
      createdAt: g?.createdAt ?? new Date().toISOString(),
      name: f("name").trim() || `R$ ${target.toLocaleString("pt-BR")} até ${monthLong(date)}`,
      target,
      date,
      base,
      monthly: Math.max(0, parseNum(f("monthly")) ?? 0),
      annualReturn: Math.min(100, Math.max(-50, parseNum(f("annualReturn")) ?? 0)),
      real: (form.elements.namedItem("real") as HTMLInputElement).checked,
    };
    const list = await loadGoals();
    goals = g ? list.map((x) => (x.id === g.id ? next : x)) : [...list, next];
    await saveGoals();
    m.close();
    done();
  });
}

// ---------- Cartão no Resumo ----------
export async function mountGoalsSummary(el: HTMLElement, r: Report, open: () => void) {
  const list = await loadGoals();
  if (!el.isConnected) return;
  if (!list.length || r.scope === "reserva") {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<div class="card goals-summary"><div class="row-between"><h2 style="margin:0">Metas</h2><button class="ghost" id="goals-open">Ver metas ›</button></div>
    ${list
      .map((g) => {
        const value = baseValue(r, g.base) ?? 0;
        const p = planGoal(g, value);
        return `<div class="goal-mini"><div class="row-between"><span><b>${esc(g.name)}</b> <span class="muted small">${money(g.target)} até ${monthLong(g.date)}</span></span><span class="badge ${statusClass(p.status)}">${STATUS_LABEL[p.status]}</span></div>
          <div class="track"><div class="fill" style="width:${(p.progress * 100).toFixed(1)}%"></div></div>
          <div class="row-between small muted"><span>${pct(p.progress, 1)} · faltam ${money(p.missing)}</span><span>${p.status === "abaixo" ? `precisa de ${money(p.required)}/mês` : p.reach && p.status !== "atingida" ? `previsão ${monthLong(p.reach)}` : ""}</span></div></div>`;
      })
      .join("")}</div>`;
  el.querySelector("#goals-open")!.addEventListener("click", open);
}
