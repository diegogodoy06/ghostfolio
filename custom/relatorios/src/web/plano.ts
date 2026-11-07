// "Meu ano": metas de vida (marcadas na mão) e financeiras (automáticas), por área, com os anos
// anteriores e a evolução. Fica no topo da aba Metas; um resumo aparece no Resumo.
import type { Report } from "../shared";
import {
  AREAS,
  KIND_INFO,
  LIFE_KINDS,
  PLAN_STATUS_LABEL,
  type FinanceKind,
  type LifeKind,
  type MonthTotals,
  type PlanContext,
  type PlanEval,
  type PlanFile,
  type PlanItem,
  type PlanKind,
  type PlanStatus,
  areaOf,
  evaluate,
  isAchieved,
  isLife,
  itemTitle,
  planMarkdown,
} from "../plan";
import { MONTHS, esc, money, openModal, parseNum, toast } from "./ui";

let plan: PlanFile = { version: 1, years: {} };
const thisMonth = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const shift = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
/** A partir de outubro, o plano que interessa é o do ano seguinte. */
export const defaultYear = () => {
  const t = thisMonth();
  return Number(t.slice(0, 4)) + (Number(t.slice(5)) >= 10 ? 1 : 0);
};
let year = (() => {
  try {
    const y = Number(sessionStorage.getItem("rel.planYear"));
    return y >= 2000 && y <= 2100 ? y : defaultYear();
  } catch {
    return defaultYear();
  }
})();
const setYear = (y: number) => {
  year = y;
  try {
    sessionStorage.setItem("rel.planYear", String(y));
  } catch {
    /* sem armazenamento */
  }
};

const STATUS_CLASS: Record<PlanStatus, string> = { ok: "buy", cumprida: "buy", atencao: "over", fora: "sell", "nao-cumprida": "sell", futuro: "", "sem-dados": "", aberta: "" };
const FIN_ICON: Record<FinanceKind, string> = { gasto: "cash-outline", categoria: "pie-chart-outline", poupanca: "wallet-outline", guardar: "wallet-outline", aporte: "trending-up-outline", reserva: "flag-outline" };

/** Sempre relê do servidor ao montar: o MCP (Claude) também pode marcar e criar metas. */
async function loadPlan() {
  plan = await fetch("/api/plan")
    .then((r) => (r.ok ? r.json() : { version: 1, years: {} }))
    .catch(() => plan);
  plan.years ??= {};
  return plan;
}
async function savePlan() {
  const res = await fetch("/api/plan", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(plan) });
  if (!res.ok) toast("Não foi possível salvar as metas");
}

// ---------- dados ----------

const monthsCache = new Map<string, Promise<MonthTotals[] | null>>();
function months(from: string, to: string) {
  const key = `${from}|${to}`;
  if (!monthsCache.has(key)) monthsCache.set(key, fetch(`/api/fin/months?from=${from}&to=${to}`).then((r) => (r.ok ? (r.json() as Promise<MonthTotals[]>) : null)).catch(() => null));
  return monthsCache.get(key)!;
}
let finConnected: Promise<boolean> | null = null;
const connected = () => (finConnected ??= fetch("/api/fin").then((r) => (r.ok ? r.json() : { connected: false })).then((d: { connected: boolean }) => d.connected).catch(() => false));

/** Avalia as metas de um ano (busca no Firefly só se houver meta que precise). */
export async function computeYear(r: Report, y: number, p: PlanFile = plan) {
  const items = p.years[String(y)] ?? [];
  const today = thisMonth();
  const ty = Number(today.slice(0, 4));
  const needFin = items.some((it) => !isLife(it.kind) && (KIND_INFO[it.kind as FinanceKind].finance || it.kind === "reserva"));
  const fin = needFin ? await connected() : false;
  const [yearData, trailing] = fin
    ? await Promise.all([y <= ty ? months(`${y}-01`, y < ty ? `${y}-12` : today) : Promise.resolve([] as MonthTotals[]), months(shift(today, -12), shift(today, -1))])
    : [[], []];
  const ctx: PlanContext = {
    year: y,
    today,
    months: yearData ?? [],
    trailing: trailing ?? [],
    financeConnected: fin && yearData != null,
    invested: r.daily.map((d) => ({ date: d.date, invested: d.invested })),
    reserve: r.reserve,
    fmt: money,
  };
  return { items, evals: items.map((it) => evaluate(it, ctx)) };
}

/** Plano do ano (e os anos anteriores) em Markdown, para o botão "Analisar com Claude". */
export async function planContext(r: Report, hideValues: boolean) {
  const p = await loadPlan();
  const y = defaultYear();
  const cur = await computeYear(r, y, p);
  const lines = planMarkdown(y, cur.items, cur.evals, { hideValues, note: p.notes?.[String(y)] });
  const past = Object.keys(p.years)
    .map(Number)
    .filter((x) => x !== y && (p.years[String(x)]?.length ?? 0) > 0)
    .sort((a, b) => b - a);
  for (const py of past.slice(0, 3)) {
    const c = await computeYear(r, py, p);
    lines.push(...planMarkdown(py, c.items, c.evals, { hideValues, note: p.notes?.[String(py)] }));
  }
  return lines;
}

// ---------- aba Metas ----------

type Phase = "futuro" | "atual" | "passado";

export async function mountPlan(el: HTMLElement, r: Report) {
  const draw = () => void mountPlan(el, r);
  if (!el.innerHTML) el.innerHTML = `<section class="card plan"><div class="skeleton line short"></div><div class="skeleton rows"></div></section>`;
  const p = await loadPlan();
  const { items, evals } = await computeYear(r, year, p);
  if (!el.isConnected) return;
  const ty = Number(thisMonth().slice(0, 4));
  const phase: Phase = year > ty ? "futuro" : year < ty ? "passado" : "atual";
  const done = evals.filter(isAchieved).length;
  const counts: Partial<Record<PlanStatus, number>> = {};
  for (const e of evals) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const prev = p.years[String(year - 1)] ?? [];

  const summary = !items.length
    ? "Metas de todo tipo: saúde, carreira, estudos, viagens e as financeiras, que se atualizam sozinhas."
    : phase === "passado"
      ? `Ano encerrado: <b>${done} de ${items.length}</b> cumpridas.`
      : phase === "futuro"
        ? `${items.length} meta${items.length > 1 ? "s" : ""}. Começa em jan/${year}; as financeiras já se comparam com os últimos 12 meses.`
        : `<b>${done} de ${items.length}</b> cumpridas · ${counts.ok ?? 0} no caminho · ${counts.atencao ?? 0} em atenção · ${counts.fora ?? 0} fora`;

  const groups = AREAS.map((a) => ({ area: a, rows: items.map((it, i) => ({ it, e: evals[i]!, i })).filter((x) => areaOf(x.it).id === a.id) })).filter((g) => g.rows.length);

  el.innerHTML = `<section class="card plan">
    <div class="row-between plan-head">
      <div class="plan-title">
        <div class="month-nav" role="group" aria-label="Ano">
          <button class="icon" data-y="-1" aria-label="Ano anterior">‹</button><h2>Meu ${year}</h2><button class="icon" data-y="1" aria-label="Próximo ano">›</button>
        </div>
        <p class="muted small">${summary}</p>
      </div>
      <button class="primary" id="plan-add">+ Meta</button>
    </div>
    ${
      items.length
        ? `<div class="plan-tiles">
        <div class="plan-tile hero"><span class="ring" style="--p:${Math.round((done / items.length) * 100)}"><b>${Math.round((done / items.length) * 100)}%</b></span><div><span class="muted small">Cumpridas</span><b>${done}<small>/${items.length}</small></b></div></div>
        ${phase === "atual" ? [["ok", "No caminho", "good"], ["atencao", "Em atenção", "warn"], ["fora", "Fora da meta", "bad"]].map(([k, l, t]) => `<div class="plan-tile"><span class="muted small"><i class="dot-${t}"></i>${l}</span><b>${counts[k as PlanStatus] ?? 0}</b></div>`).join("") : ""}
      </div>
      <div class="meter-wrap plan-meter" style="--p:${((done / items.length) * 100).toFixed(1)}" title="${done} de ${items.length} cumpridas"><div class="meter"></div></div>`
        : ""
    }
    ${
      items.length
        ? groups
            .map(
              (g) => `<div class="plan-area"><h3><span class="dot" style="background:${g.area.color}"></span>${esc(g.area.label)}<span class="muted small">${g.rows.filter((x) => isAchieved(x.e)).length}/${g.rows.length}</span></h3>
              <div class="plan-list">${g.rows.map((x) => planRow(x.it, x.e, g.rows.length, phase)).join("")}</div></div>`,
            )
            .join("")
        : `<div class="plan-empty"><p class="muted">Ideias para ${year}: tirar o passaporte, ler 12 livros, treinar todo mês, fazer uma viagem, gastar até R$ 6.000 por mês, aportar R$ 30.000 e ter 6 meses de reserva.</p>
           <div class="sim-buttons">${prev.length ? `<button class="ghost" id="plan-copy">Trazer as metas de ${year - 1}</button>` : ""}<button class="ghost" id="plan-add-2">Montar o plano de ${year}</button></div></div>`
    }
    ${
      items.length && phase !== "futuro"
        ? `<details class="plan-notes" ${p.notes?.[String(year)] ? "open" : ""}><summary>Retrospectiva de ${year}</summary>
           <textarea id="plan-note" rows="3" placeholder="O que deu certo, o que não deu e o que levar para o próximo ano.">${esc(p.notes?.[String(year)] ?? "")}</textarea></details>`
        : ""
    }
  </section>
  <div id="plan-history"></div>`;

  el.querySelectorAll<HTMLButtonElement>("[data-y]").forEach((b) =>
    b.addEventListener("click", () => {
      setYear(year + Number(b.dataset.y));
      draw();
    }),
  );
  el.querySelectorAll("#plan-add, #plan-add-2").forEach((b) => b.addEventListener("click", () => itemModal(null, draw)));
  el.querySelector("#plan-copy")?.addEventListener("click", async () => {
    p.years[String(year)] = prev.map((it) => ({ ...it, id: crypto.randomUUID(), done: null, log: [], months: [], createdAt: new Date().toISOString() }));
    await savePlan();
    toast(`${prev.length} metas trazidas de ${year - 1}`);
    draw();
  });
  const note = el.querySelector<HTMLTextAreaElement>("#plan-note");
  note?.addEventListener("change", async () => {
    p.notes = { ...p.notes, [String(year)]: note.value.trim() };
    await savePlan();
    toast("Retrospectiva salva");
  });

  el.querySelectorAll<HTMLElement>("[data-item]").forEach((row) => {
    const it = items.find((x) => x.id === row.dataset.item)!;
    const update = async (f: (x: PlanItem) => void) => {
      f(it);
      await savePlan();
      draw();
    };
    row.querySelector(".plan-edit")!.addEventListener("click", () => itemModal(it, draw));
    row.querySelector(".plan-del")!.addEventListener("click", async () => {
      if (!confirm(`Excluir a meta "${itemTitle(it, money)}"?`)) return;
      p.years[String(year)] = items.filter((x) => x.id !== it.id);
      await savePlan();
      draw();
    });
    row.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((b) =>
      b.addEventListener("click", async () => {
        // Move dentro da mesma área: troca com a vizinha da mesma área.
        const from = items.indexOf(it);
        const same = items.map((x, i) => [x, i] as const).filter(([x]) => areaOf(x).id === areaOf(it).id).map(([, i]) => i);
        const pos = same.indexOf(from) + Number(b.dataset.move);
        if (pos < 0 || pos >= same.length) return;
        const to = same[pos]!;
        const next = [...items];
        [next[from], next[to]] = [next[to]!, next[from]!];
        p.years[String(year)] = next;
        await savePlan();
        draw();
      }),
    );
    row.querySelector(".plan-check")?.addEventListener("click", () => update((x) => (x.done = x.done ? null : year === ty ? todayIso() : `${year}-12-31`)));
    row.querySelectorAll<HTMLButtonElement>("[data-count]").forEach((b) =>
      b.addEventListener("click", () =>
        update((x) => {
          x.log ??= [];
          if (Number(b.dataset.count) > 0) x.log.push({ date: year === ty ? todayIso() : `${year}-12-31`, n: 1 });
          else {
            const last = x.log.at(-1);
            if (!last) return;
            if (last.n > 1) last.n -= 1;
            else x.log.pop();
          }
        }),
      ),
    );
    row.querySelectorAll<HTMLButtonElement>("[data-month]").forEach((b) =>
      b.addEventListener("click", () =>
        update((x) => {
          const set = new Set(x.months ?? []);
          const m = b.dataset.month!;
          set.has(m) ? set.delete(m) : set.add(m);
          x.months = [...set].sort();
        }),
      ),
    );
  });

  void mountHistory(el.querySelector<HTMLElement>("#plan-history")!, r, p, draw);
}

function planRow(it: PlanItem, e: PlanEval, groupSize: number, phase: Phase) {
  const life = isLife(it.kind);
  const lead =
    it.kind === "feito"
      ? `<button class="plan-check ${it.done ? "on" : ""}" aria-pressed="${!!it.done}" aria-label="${it.done ? "Desmarcar" : "Marcar como feita"}" title="${it.done ? "Desmarcar" : "Marcar como feita"}" ${phase === "futuro" ? "disabled" : ""}>✓</button>`
      : `<span class="ico" style="--icon: url(icons/${life ? (it.kind === "contagem" ? "analytics-outline" : "calendar-outline") : FIN_ICON[it.kind as FinanceKind]}.svg)"></span>`;
  const controls =
    it.kind === "contagem" && phase !== "futuro"
      ? `<div class="plan-counter"><button class="icon" data-count="-1" aria-label="Desfazer o último">−</button><b>${e.current ?? 0}<span class="muted"> / ${it.value}</span></b><button class="primary" data-count="1">+1</button></div>`
      : it.kind === "mensal"
        ? `<div class="plan-months">${monthChips(it, phase)}</div>`
        : "";
  const bars = it.kind !== "mensal" && it.kind !== "feito" && e.bars.some((b) => b.value != null) ? miniBars(it, e) : "";
  return `<div class="plan-item ${isAchieved(e) ? "achieved" : ""}" data-item="${esc(it.id)}">
    <div class="plan-item-head">
      ${lead}
      <b>${esc(itemTitle(it, money))}</b>
      <span class="badge ${STATUS_CLASS[e.status]}">${PLAN_STATUS_LABEL[e.status]}</span>
      <span class="plan-tools">
        ${groupSize > 1 ? `<button class="icon" data-move="-1" aria-label="Subir">↑</button><button class="icon" data-move="1" aria-label="Descer">↓</button>` : ""}
        <button class="icon plan-edit" aria-label="Editar" title="Editar">✎</button><button class="icon plan-del" aria-label="Excluir" title="Excluir">✕</button>
      </span>
    </div>
    ${e.progress != null && it.kind !== "feito" ? `<div class="track plan-track"><div class="fill ${STATUS_CLASS[e.status]}" style="width:${(e.progress * 100).toFixed(1)}%"></div></div>` : ""}
    ${e.text || it.note ? `<p class="plan-text">${e.text}${it.note ? `${e.text ? " " : ""}<span class="muted">${esc(it.note)}</span>` : ""}</p>` : ""}
    ${controls}
    ${bars}
  </div>`;
}

function monthChips(it: PlanItem, phase: Phase) {
  const cur = thisMonth();
  const set = new Set(it.months ?? []);
  return Array.from({ length: 12 }, (_, k) => {
    const ym = `${year}-${String(k + 1).padStart(2, "0")}`;
    const future = phase === "futuro" || (phase === "atual" && ym > cur);
    return `<button class="pm ${set.has(ym) ? "on" : ""} ${ym === cur ? "now" : ""}" data-month="${ym}" aria-pressed="${set.has(ym)}" ${future ? "disabled" : ""} title="${MONTHS[k]}/${year}">${MONTHS[k]}</button>`;
  }).join("");
}

function valueLabel(it: PlanItem, v: number) {
  if (it.kind === "poupanca") return `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;
  if (it.kind === "contagem") return v.toLocaleString("pt-BR");
  return money(v);
}

/** 12 barrinhas do ano com a linha do limite (ou do ritmo mensal). */
function miniBars(it: PlanItem, e: PlanEval) {
  if (it.kind === "reserva") return "";
  const vals = e.bars.map((b) => b.value ?? 0);
  const max = Math.max(...vals.map(Math.abs), Math.abs(e.barLimit ?? 0), 1e-9);
  // "Abaixo do limite é bom" para gastos; "acima é bom" para poupança, guardar, aportes e contagens.
  const lowerIsGood = it.kind === "gasto" || it.kind === "categoria";
  const cols = e.bars
    .map((b) => {
      const v = b.value;
      const good = v == null || e.barLimit == null ? null : lowerIsGood ? v <= e.barLimit : v >= e.barLimit;
      const h = v == null ? 0 : (Math.max(0, v) / max) * 100;
      return `<div class="pb ${b.partial ? "partial" : ""} ${v == null || (v === 0 && it.kind === "contagem") ? "empty" : ""}" title="${MONTHS[Number(b.month.slice(5)) - 1]}/${b.month.slice(2, 4)}: ${v == null ? "—" : esc(valueLabel(it, v))}"><div class="pb-fill ${good == null ? "" : good ? "good" : "bad"}" style="height:${h}%"></div></div>`;
    })
    .join("");
  const limit = e.barLimit != null && e.barLimit > 0 ? `<div class="pb-limit" style="bottom:${(e.barLimit / max) * 100}%"></div>` : "";
  return `<div class="plan-bars" aria-hidden="true"><div class="pb-area">${cols}${limit}</div><div class="pb-labels">${e.bars.map((b) => `<span>${MONTHS[Number(b.month.slice(5)) - 1]!.slice(0, 1)}</span>`).join("")}</div>${e.barsTrailing ? `<span class="pb-caption">últimos 12 meses · linha = meta</span>` : ""}</div>`;
}

// ---------- evolução (anos anteriores) ----------

async function mountHistory(el: HTMLElement, r: Report, p: PlanFile, draw: () => void) {
  const years = Object.keys(p.years)
    .map(Number)
    .filter((y) => (p.years[String(y)]?.length ?? 0) > 0)
    .sort((a, b) => a - b);
  if (!years.length || (years.length === 1 && years[0] === year)) return void (el.innerHTML = "");
  const rows = await Promise.all(years.map(async (y) => ({ y, ...(await computeYear(r, y, p)) })));
  if (!el.isConnected) return;
  const ty = Number(thisMonth().slice(0, 4));
  el.innerHTML = `<section class="card plan-evo"><h2>Evolução</h2>
    <div class="evo-list">${rows
      .map(({ y, items, evals }) => {
        const done = evals.filter(isAchieved).length;
        const share = items.length ? done / items.length : 0;
        const byArea = AREAS.map((a) => {
          const idx = items.map((_, i) => i).filter((i) => areaOf(items[i]!).id === a.id);
          const ok = idx.filter((i) => isAchieved(evals[i]!)).length;
          return idx.length ? `<span class="evo-area" title="${esc(a.label)}: ${ok} de ${idx.length}"><span class="dot" style="background:${a.color}"></span>${ok}/${idx.length}</span>` : "";
        }).join("");
        return `<button class="evo-row ${y === year ? "current" : ""}" data-year="${y}">
          <b class="evo-y">${y}</b>
          <div class="evo-bar"><div class="track"><div class="fill" style="width:${(share * 100).toFixed(1)}%"></div></div><div class="evo-areas">${byArea}</div></div>
          <span class="evo-num"><b>${done}/${items.length}</b><span class="muted small">${y < ty ? "cumpridas" : y === ty ? "até agora" : "planejadas"}</span></span></button>`;
      })
      .join("")}</div>
    <p class="note">Toque num ano para ver as metas dele. Nos anos encerrados, as metas financeiras usam o que aconteceu naquele ano; a de reserva usa o valor de hoje.</p></section>`;
  el.querySelectorAll<HTMLButtonElement>("[data-year]").forEach((b) =>
    b.addEventListener("click", () => {
      setYear(Number(b.dataset.year));
      draw();
      document.querySelector(".plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }),
  );
}

// ---------- resumo (aba Resumo) ----------

export async function mountPlanSummary(el: HTMLElement, r: Report, open: () => void) {
  const p = await loadPlan();
  // O ano corrente enquanto ele tiver metas; senão, o próximo plano.
  const ty = Number(thisMonth().slice(0, 4));
  const y = p.years[String(ty)]?.length ? ty : defaultYear();
  const { items, evals } = await computeYear(r, y, p);
  if (!el.isConnected) return;
  if (!items.length) {
    el.innerHTML = `<div class="card hub-card hub-empty"><h2>Meu ${y}</h2><p class="muted">Metas de todo tipo para o ano: saúde, carreira, estudos, viagens e as financeiras, que se atualizam sozinhas.</p><button class="ghost" id="plan-open">Montar meu ${y} ›</button></div>`;
    el.querySelector("#plan-open")!.addEventListener("click", () => {
      setYear(y);
      open();
    });
    return;
  }
  const done = evals.filter(isAchieved).length;
  const ty2 = Number(thisMonth().slice(0, 4));
  const curMonth = thisMonth();
  // Metas de vida em aberto, com ação rápida; financeiras que pedem atenção, como etiquetas.
  const life = items
    .map((it, i) => ({ it, e: evals[i]! }))
    .filter((x) => isLife(x.it.kind) && !isAchieved(x.e) && x.e.status !== "futuro")
    .slice(0, 5);
  const fin = items
    .map((it, i) => ({ it, e: evals[i]! }))
    .filter((x) => !isLife(x.it.kind) && (x.e.status === "atencao" || x.e.status === "fora"))
    .slice(0, 3);
  const action = (it: PlanItem, e: PlanEval) =>
    it.kind === "feito"
      ? `<button class="plan-check" data-quick="${esc(it.id)}" aria-label="Marcar como feita" title="Marcar como feita">✓</button>`
      : it.kind === "contagem"
        ? `<span class="hub-count">${e.current ?? 0}/${it.value}</span><button class="primary hub-plus" data-quick="${esc(it.id)}" aria-label="Somar 1">+1</button>`
        : (it.months ?? []).includes(curMonth)
          ? `<span class="badge buy">${MONTHS[Number(curMonth.slice(5)) - 1]} ✓</span>`
          : `<button class="ghost hub-month" data-quick="${esc(it.id)}">Cumpri ${MONTHS[Number(curMonth.slice(5)) - 1]?.toLowerCase()}</button>`;
  el.innerHTML = `<div class="card hub-card plan-sum">
    <div class="row-between"><h2 style="margin:0">Meu ${y}</h2><button class="link" id="plan-open">Ver metas</button></div>
    <div class="track plan-score"><div class="fill" style="width:${((done / items.length) * 100).toFixed(1)}%"></div></div>
    <p class="muted small" style="margin:0"><b>${done} de ${items.length}</b> cumpridas</p>
    ${
      life.length && y === ty2
        ? `<div class="hub-goals">${life
            .map(
              ({ it, e }) => `<div class="hub-goal"><span class="dot" style="background:${areaOf(it).color}"></span><span class="t">${esc(itemTitle(it, money))}</span>${action(it, e)}</div>`,
            )
            .join("")}</div>`
        : ""
    }
    ${fin.length ? `<div class="plan-sum-list">${fin.map((x) => `<span class="chip-static"><span class="dot" style="background:${x.e.status === "fora" ? "var(--down)" : "var(--warn)"}"></span>${esc(itemTitle(x.it, money))}</span>`).join("")}</div>` : ""}
  </div>`;
  el.querySelector("#plan-open")!.addEventListener("click", () => {
    setYear(y);
    open();
  });
  el.querySelectorAll<HTMLButtonElement>("[data-quick]").forEach((b) =>
    b.addEventListener("click", async () => {
      const it = items.find((x) => x.id === b.dataset.quick)!;
      if (it.kind === "feito") it.done = todayIso();
      else if (it.kind === "contagem") (it.log ??= []).push({ date: todayIso(), n: 1 });
      else it.months = [...new Set([...(it.months ?? []), curMonth])].sort();
      b.disabled = true;
      await savePlan();
      toast(it.kind === "contagem" ? `${itemTitle(it, money)}: +1` : `${itemTitle(it, money)}: marcado`);
      void mountPlanSummary(el, r, open);
    }),
  );
}

// ---------- criar / editar ----------

async function itemModal(it: PlanItem | null, done: () => void) {
  const fin = await connected();
  const cats: string[] = fin ? await fetch("/api/fin/categories").then((r) => (r.ok ? r.json() : [])).catch(() => []) : [];
  const life = Object.entries(LIFE_KINDS) as [LifeKind, (typeof LIFE_KINDS)[LifeKind]][];
  const finance = Object.entries(KIND_INFO) as [FinanceKind, (typeof KIND_INFO)[FinanceKind]][];
  const current: PlanKind = it?.kind ?? "feito";
  const kindBox = (k: PlanKind, label: string, hint: string) =>
    `<label class="plan-kind"><input type="radio" name="kind" value="${k}" ${k === current ? "checked" : ""} ${it ? "disabled" : ""}/><span><b>${label}</b><span class="muted small">${hint}</span></span></label>`;
  const m = openModal(
    it ? "Editar meta" : `Nova meta de ${year}`,
    `<h3 class="plan-group">Metas de vida <span class="muted small">você marca</span></h3>
     <div class="plan-kinds">${life.map(([k, x]) => kindBox(k, x.label, x.hint)).join("")}</div>
     <h3 class="plan-group">Financeiras <span class="muted small">atualizam sozinhas</span></h3>
     <div class="plan-kinds">${finance.map(([k, x]) => kindBox(k, x.label, `${x.hint}${x.finance && !fin ? " Precisa do Firefly conectado." : ""}`)).join("")}</div>
     <div class="plan-fields">
       <label class="field pf-life pf-wide">Meta<input id="pf-title" maxlength="120" value="${esc(it?.title ?? "")}" /></label>
       <label class="field pf-life">Área<select id="pf-area">${AREAS.map((a) => `<option value="${a.id}" ${a.id === (it?.area ?? "pessoal") ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select></label>
       <label class="field" id="pf-cat" hidden>Categoria${cats.length ? `<select id="pf-cat-v">${cats.map((c) => `<option ${c === it?.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>` : `<input id="pf-cat-v" placeholder="Nome da categoria no Firefly" value="${esc(it?.category ?? "")}" />`}</label>
       <label class="field" id="pf-vbox"><span id="pf-label">Valor</span><input id="pf-v" inputmode="decimal" value="${it && it.kind !== "feito" ? String(it.value).replace(".", ",") : ""}" /></label>
       <label class="field pf-wide">Nota (opcional)<input id="pf-note" maxlength="300" placeholder="Por que importa, como medir…" value="${esc(it?.note ?? "")}" /></label>
     </div>
     <p class="error small" id="pf-err" hidden></p>
     <div class="modal-actions"><button class="primary" id="pf-save">${it ? "Salvar" : "Adicionar"}</button></div>`,
    { wide: true },
  );
  const $ = <T extends HTMLElement>(s: string) => m.el.querySelector(s) as T;
  const kindOf = () => $<HTMLInputElement>("input[name=kind]:checked").value as PlanKind;
  const sync = () => {
    const k = kindOf();
    const lifeK = isLife(k);
    m.el.querySelectorAll<HTMLElement>(".pf-life").forEach((x) => (x.hidden = !lifeK));
    $("#pf-cat").hidden = k !== "categoria";
    $("#pf-vbox").hidden = k === "feito";
    $("#pf-label").textContent = isLife(k)
      ? k === "contagem"
        ? "Quantas vezes no ano"
        : "Meses no ano (até 12)"
      : { mes: "Limite por mês (R$)", pct: "Percentual da renda (%)", ano: "Valor no ano (R$)", meses: "Meses de gastos" }[KIND_INFO[k].unit];
    const ph: Record<PlanKind, string> = { feito: "", contagem: "12", mensal: "12", gasto: "6.000", categoria: "400", poupanca: "30", guardar: "36.000", aporte: "30.000", reserva: "6" };
    $<HTMLInputElement>("#pf-v").placeholder = ph[k];
    $<HTMLInputElement>("#pf-title").placeholder = ({ feito: "Ex.: Tirar o passaporte", contagem: "Ex.: Ler livros", mensal: "Ex.: Treinar pelo menos 12 vezes" } as Record<string, string>)[k] ?? "";
  };
  m.el.querySelectorAll("input[name=kind]").forEach((x) => x.addEventListener("change", sync));
  sync();
  if (!it) setTimeout(() => $<HTMLInputElement>("#pf-title").focus(), 50);
  $("#pf-save").addEventListener("click", async () => {
    const k = kindOf();
    const lifeK = isLife(k);
    const title = $<HTMLInputElement>("#pf-title").value.trim();
    const note = $<HTMLInputElement>("#pf-note").value.trim();
    const v = k === "feito" ? 1 : parseNum($<HTMLInputElement>("#pf-v").value);
    const cat = ($<HTMLInputElement | HTMLSelectElement>("#pf-cat-v")?.value ?? "").trim();
    const err = $("#pf-err");
    const bad = (msg: string) => {
      err.hidden = false;
      err.textContent = msg;
    };
    if (lifeK && !title) return bad("Dê um nome para a meta.");
    if (v == null || v <= 0) return bad("Informe um valor maior que zero.");
    if (k === "poupanca" && v >= 100) return bad("Use um percentual abaixo de 100%.");
    if (k === "mensal" && v > 12) return bad("No máximo 12 meses.");
    if (k === "categoria" && !cat) return bad("Escolha a categoria.");
    const item: PlanItem = {
      ...(it ?? {}),
      id: it?.id ?? crypto.randomUUID(),
      kind: k,
      value: k === "contagem" || k === "mensal" ? Math.round(v) : v,
      category: k === "categoria" ? cat : undefined,
      title: lifeK ? title : undefined,
      area: lifeK ? $<HTMLSelectElement>("#pf-area").value : "financas",
      note: note || undefined,
      createdAt: it?.createdAt ?? new Date().toISOString(),
    };
    const list = plan.years[String(year)] ?? [];
    plan.years[String(year)] = it ? list.map((x) => (x.id === it.id ? item : x)) : [...list, item];
    await savePlan();
    m.close();
    done();
  });
}
