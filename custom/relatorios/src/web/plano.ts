// Plano do ano (Metas 2027): limites de gasto, poupança, aportes e reserva, no topo da aba Metas.
import type { Report } from "../shared";
import { KIND_INFO, PLAN_STATUS_LABEL, type MonthTotals, type PlanEval, type PlanFile, type PlanItem, type PlanKind, type PlanStatus, evaluate, itemTitle } from "../plan";
import { MONTHS, esc, money, openModal, parseNum, toast } from "./ui";

let plan: PlanFile | null = null;
const thisMonth = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
const shift = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
/** A partir de outubro, o plano que interessa é o do ano seguinte. */
const defaultYear = () => {
  const t = thisMonth();
  return Number(t.slice(0, 4)) + (Number(t.slice(5)) >= 10 ? 1 : 0);
};
let year = (() => {
  try {
    const y = Number(sessionStorage.getItem("rel.planYear"));
    return y >= 2020 && y <= 2100 ? y : defaultYear();
  } catch {
    return defaultYear();
  }
})();

const STATUS_CLASS: Record<PlanStatus, string> = { ok: "buy", atencao: "over", fora: "sell", futuro: "", "sem-dados": "" };
const ICON: Record<PlanKind, string> = { gasto: "cash-outline", categoria: "pie-chart-outline", poupanca: "wallet-outline", guardar: "wallet-outline", aporte: "trending-up-outline", reserva: "flag-outline" };

async function loadPlan() {
  plan ??= await fetch("/api/plan").then((r) => (r.ok ? r.json() : { version: 1, years: {} }));
  return plan!;
}
async function savePlan() {
  const res = await fetch("/api/plan", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(plan) });
  if (!res.ok) toast("Não foi possível salvar o plano");
}

// Dados do Firefly em cache por sessão da aba (o plano pede vários anos ao navegar).
const monthsCache = new Map<string, Promise<MonthTotals[] | null>>();
function months(from: string, to: string) {
  const key = `${from}|${to}`;
  if (!monthsCache.has(key))
    monthsCache.set(
      key,
      fetch(`/api/fin/months?from=${from}&to=${to}`).then((r) => (r.ok ? (r.json() as Promise<MonthTotals[]>) : null)),
    );
  return monthsCache.get(key)!;
}
let finConnected: Promise<boolean> | null = null;
const connected = () => (finConnected ??= fetch("/api/fin").then((r) => (r.ok ? r.json() : { connected: false })).then((d: { connected: boolean }) => d.connected));

export async function mountPlan(el: HTMLElement, r: Report) {
  const draw = () => void mountPlan(el, r);
  el.innerHTML = `<section class="card plan"><div class="skeleton line short"></div><div class="skeleton rows"></div></section>`;
  const [p, fin] = await Promise.all([loadPlan(), connected()]);
  const today = thisMonth();
  const cur = shift(today, -1);
  const [yearData, trailing] = fin
    ? await Promise.all([year <= Number(today.slice(0, 4)) ? months(`${year}-01`, year < Number(today.slice(0, 4)) ? `${year}-12` : today) : Promise.resolve([]), months(shift(today, -12), cur)])
    : [[], []];
  if (!el.isConnected) return;
  const items = p.years[String(year)] ?? [];
  const ctx = {
    year,
    today,
    months: yearData ?? [],
    trailing: trailing ?? [],
    financeConnected: fin && yearData != null,
    invested: r.daily.map((d) => ({ date: d.date, invested: d.invested })),
    reserve: r.reserve,
    fmt: money,
  };
  const evals = items.map((it) => [it, evaluate(it, ctx)] as const);
  const counts = { ok: 0, atencao: 0, fora: 0 } as Record<string, number>;
  for (const [, e] of evals) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const started = year <= Number(today.slice(0, 4));

  el.innerHTML = `<section class="card plan">
    <div class="row-between plan-head">
      <div class="plan-title">
        <div class="month-nav" role="group" aria-label="Ano do plano">
          <button class="icon" data-y="-1" aria-label="Ano anterior">‹</button><h2>Metas de ${year}</h2><button class="icon" data-y="1" aria-label="Próximo ano">›</button>
        </div>
        <p class="muted small">${
          items.length
            ? started
              ? `${counts.ok ?? 0} no caminho · ${counts.atencao ?? 0} em atenção · ${counts.fora ?? 0} fora`
              : `Começa em jan/${year}. Por enquanto, a comparação é com os últimos 12 meses.`
            : `Gastos, poupança, aportes e reserva para o ano. As de patrimônio ficam logo abaixo.`
        }</p>
      </div>
      <button class="primary" id="plan-add">+ Meta do ano</button>
    </div>
    ${
      items.length
        ? `<div class="plan-list">${evals.map(([it, e], i) => planRow(it, e, i, items.length)).join("")}</div>`
        : `<div class="plan-empty"><p class="muted">Exemplos para ${year}: gastar até R$ 6.000 por mês, delivery até R$ 400, poupar 30% da renda, aportar R$ 30.000 e ter 6 meses de reserva.</p><button class="ghost" id="plan-add-2">Montar o plano de ${year}</button></div>`
    }
  </section>`;

  el.querySelectorAll<HTMLButtonElement>("[data-y]").forEach((b) =>
    b.addEventListener("click", () => {
      year += Number(b.dataset.y);
      try {
        sessionStorage.setItem("rel.planYear", String(year));
      } catch {
        /* sem armazenamento */
      }
      draw();
    }),
  );
  el.querySelectorAll("#plan-add, #plan-add-2").forEach((b) => b.addEventListener("click", () => itemModal(null, items, draw)));
  el.querySelectorAll<HTMLElement>("[data-item]").forEach((row) => {
    const it = items.find((x) => x.id === row.dataset.item)!;
    row.querySelector(".plan-edit")!.addEventListener("click", () => itemModal(it, items, draw));
    row.querySelector(".plan-del")!.addEventListener("click", async () => {
      if (!confirm(`Excluir a meta "${itemTitle(it, money)}"?`)) return;
      p.years[String(year)] = items.filter((x) => x.id !== it.id);
      await savePlan();
      draw();
    });
    row.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((b) =>
      b.addEventListener("click", async () => {
        const from = items.indexOf(it);
        const to = from + Number(b.dataset.move);
        if (to < 0 || to >= items.length) return;
        const next = [...items];
        [next[from], next[to]] = [next[to]!, next[from]!];
        p.years[String(year)] = next;
        await savePlan();
        draw();
      }),
    );
  });
}

function valueLabel(it: PlanItem, v: number) {
  if (it.kind === "poupanca") return `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;
  if (it.kind === "reserva") return `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} meses`;
  return money(v);
}

function planRow(it: PlanItem, e: PlanEval, i: number, n: number) {
  const bars = e.bars.some((b) => b.value != null) ? miniBars(it, e) : "";
  return `<div class="plan-item" data-item="${esc(it.id)}">
    <div class="plan-item-head">
      <span class="ico" style="--icon: url(icons/${ICON[it.kind]}.svg)"></span>
      <b>${esc(itemTitle(it, money))}</b>
      <span class="badge ${STATUS_CLASS[e.status]}">${PLAN_STATUS_LABEL[e.status]}</span>
      <span class="plan-tools">
        ${n > 1 ? `<button class="icon" data-move="-1" aria-label="Subir" ${i === 0 ? "disabled" : ""}>↑</button><button class="icon" data-move="1" aria-label="Descer" ${i === n - 1 ? "disabled" : ""}>↓</button>` : ""}
        <button class="icon plan-edit" aria-label="Editar" title="Editar">✎</button><button class="icon plan-del" aria-label="Excluir" title="Excluir">✕</button>
      </span>
    </div>
    ${e.progress != null ? `<div class="track plan-track"><div class="fill ${STATUS_CLASS[e.status]}" style="width:${(e.progress * 100).toFixed(1)}%"></div></div>` : ""}
    <p class="plan-text">${e.text}</p>
    ${bars}
  </div>`;
}

/** 12 barrinhas do ano com a linha do limite (ou do ritmo mensal). */
function miniBars(it: PlanItem, e: PlanEval) {
  const vals = e.bars.map((b) => b.value ?? 0);
  const max = Math.max(...vals.map(Math.abs), Math.abs(e.barLimit ?? 0), 1e-9);
  // "Abaixo do limite é bom" para gastos; "acima é bom" para poupança, guardar e aportes.
  const lowerIsGood = it.kind === "gasto" || it.kind === "categoria";
  if (it.kind === "reserva") return "";
  const cols = e.bars
    .map((b, k) => {
      const v = b.value;
      const good = v == null || e.barLimit == null ? null : lowerIsGood ? v <= e.barLimit : v >= e.barLimit;
      const h = v == null ? 0 : (Math.max(0, v) / max) * 100;
      return `<div class="pb ${b.partial ? "partial" : ""} ${v == null ? "empty" : ""}" title="${MONTHS[Number(b.month.slice(5)) - 1]}/${b.month.slice(2, 4)}: ${v == null ? "—" : esc(valueLabel(it, v))}"><div class="pb-fill ${good == null ? "" : good ? "good" : "bad"}" style="height:${h}%"></div></div>`;
    })
    .join("");
  const limit = e.barLimit != null && e.barLimit > 0 ? `<div class="pb-limit" style="bottom:${(e.barLimit / max) * 100}%"></div>` : "";
  return `<div class="plan-bars" aria-hidden="true"><div class="pb-area">${cols}${limit}</div><div class="pb-labels">${e.bars.map((b) => `<span>${MONTHS[Number(b.month.slice(5)) - 1]!.slice(0, 1)}</span>`).join("")}</div>${e.barsTrailing ? `<span class="pb-caption">últimos 12 meses · linha = meta</span>` : ""}</div>`;
}

async function itemModal(it: PlanItem | null, items: PlanItem[], done: () => void) {
  const fin = await connected();
  const cats: string[] = fin ? await fetch("/api/fin/categories").then((r) => (r.ok ? r.json() : [])) : [];
  const kinds = Object.entries(KIND_INFO) as [PlanKind, (typeof KIND_INFO)[PlanKind]][];
  const m = openModal(
    it ? "Editar meta do ano" : `Nova meta de ${year}`,
    `<div class="plan-kinds" role="radiogroup">${kinds
      .map(
        ([k, info]) => `<label class="plan-kind"><input type="radio" name="kind" value="${k}" ${k === (it?.kind ?? "gasto") ? "checked" : ""} ${it ? "disabled" : ""}/>
          <span><b>${info.label}</b><span class="muted small">${info.hint}${info.finance && !fin ? " Precisa do Firefly conectado." : ""}</span></span></label>`,
      )
      .join("")}</div>
     <div class="plan-fields">
       <label class="field" id="pf-cat" hidden>Categoria${cats.length ? `<select id="pf-cat-v">${cats.map((c) => `<option ${c === it?.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>` : `<input id="pf-cat-v" placeholder="Nome da categoria no Firefly" value="${esc(it?.category ?? "")}" />`}</label>
       <label class="field"><span id="pf-label">Valor</span><input id="pf-v" inputmode="decimal" value="${it ? String(it.value).replace(".", ",") : ""}" /></label>
     </div>
     <p class="error small" id="pf-err" hidden></p>
     <div class="modal-actions"><button class="primary" id="pf-save">${it ? "Salvar" : "Adicionar"}</button></div>`,
    { wide: true },
  );
  const kindOf = () => m.el.querySelector<HTMLInputElement>("input[name=kind]:checked")!.value as PlanKind;
  const sync = () => {
    const k = kindOf();
    m.el.querySelector<HTMLElement>("#pf-cat")!.hidden = k !== "categoria";
    m.el.querySelector("#pf-label")!.textContent = { mes: "Limite por mês (R$)", pct: "Percentual da renda (%)", ano: "Valor no ano (R$)", meses: "Meses de gastos" }[KIND_INFO[k].unit];
    m.el.querySelector<HTMLInputElement>("#pf-v")!.placeholder = { gasto: "6.000", categoria: "400", poupanca: "30", guardar: "36.000", aporte: "30.000", reserva: "6" }[k];
  };
  m.el.querySelectorAll("input[name=kind]").forEach((x) => x.addEventListener("change", sync));
  sync();
  m.el.querySelector("#pf-save")!.addEventListener("click", async () => {
    const k = kindOf();
    const v = parseNum(m.el.querySelector<HTMLInputElement>("#pf-v")!.value);
    const cat = (m.el.querySelector<HTMLInputElement | HTMLSelectElement>("#pf-cat-v")?.value ?? "").trim();
    const err = m.el.querySelector<HTMLElement>("#pf-err")!;
    const bad = (msg: string) => {
      err.hidden = false;
      err.textContent = msg;
    };
    if (v == null || v <= 0) return bad("Informe um valor maior que zero.");
    if (k === "poupanca" && v >= 100) return bad("Use um percentual abaixo de 100%.");
    if (k === "categoria" && !cat) return bad("Escolha a categoria.");
    const item: PlanItem = { id: it?.id ?? crypto.randomUUID(), kind: k, value: v, category: k === "categoria" ? cat : undefined, createdAt: it?.createdAt ?? new Date().toISOString() };
    plan!.years[String(year)] = it ? items.map((x) => (x.id === it.id ? item : x)) : [...items, item];
    await savePlan();
    m.close();
    done();
  });
}
