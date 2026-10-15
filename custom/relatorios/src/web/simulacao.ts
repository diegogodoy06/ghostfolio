/**
 * Simulação dentro da aba Carteira (como a "Conta Simulação" do TradeMap) e cartão no Resumo.
 *
 * Salva só a intenção (metas, aporte, boletas de compra/venda, planos por ativo); o resultado é
 * sempre recalculado com a carteira atual vinda do Ghostfolio.
 */
import { Chart } from "chart.js";
import type { Report } from "../shared";
import {
  type AssetPlan, type BuyParam, type CategoryAction, type Quote, type SaleParam, type SimPosition, type SimResult,
  type SimulationParams, defaultParams, simulate,
} from "../sim-engine";
import { colorOf, countUp, esc, money, openModal, parseNum, pct, privacy, qty, spinDonut, toast } from "./ui";

const ALL_CATEGORIES = ["Ações", "FIIs", "Fiagros", "ETFs", "BDRs", "Exterior", "Tesouro Direto", "Renda Fixa", "Cripto"];

let params: SimulationParams | null = null;
let loadingParams: Promise<SimulationParams> | null = null;
const quotes: Record<string, Quote> = {};
let saveTimer: number | undefined;
let savedAt: string | null = null;

export const positionsOf = (r: Report): SimPosition[] =>
  r.categories.flatMap((c) => c.positions.map((p) => ({ ticker: p.ticker, category: p.category, value: p.value, price: p.price, quantity: p.quantity })));

/** Carrega a simulação salva (uma vez) e as cotações dos ativos novos. */
export function ensureParams(r: Report): Promise<SimulationParams> {
  if (params) return Promise.resolve(params);
  loadingParams ??= (async () => {
    const res = await fetch("/api/simulation");
    const saved = res.ok ? ((await res.json()) as SimulationParams | null) : null;
    const base = defaultParams(positionsOf(r));
    params = saved && saved.version === 1 ? { ...base, ...saved, buys: saved.buys ?? [], autoAllocate: saved.autoAllocate ?? true } : { ...base, buys: [], autoAllocate: true };
    savedAt = saved?.updatedAt ?? null;
    const own = new Set(positionsOf(r).map((p) => p.ticker));
    const extras = [...Object.values(params.assetPlans).flatMap((p) => p.extra ?? []), ...(params.buys ?? []).map((b) => b.ticker)].filter((t) => !own.has(t));
    await Promise.all([...new Set(extras)].map(fetchQuote));
    return params;
  })();
  return loadingParams;
}

/** Cotações dos ativos novos já buscadas (usadas no contexto para o Claude). */
export const simQuotes = () => quotes;

export async function fetchQuote(ticker: string): Promise<Quote | null> {
  if (quotes[ticker]) return quotes[ticker]!;
  const res = await fetch(`/api/quote?t=${encodeURIComponent(ticker)}`);
  const q = res.ok ? ((await res.json()) as { price: number | null; category: string | null; name: string | null }) : null;
  if (!q?.price) return null;
  quotes[ticker] = { price: q.price, category: q.category ?? "Outros", name: q.name };
  return quotes[ticker]!;
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  setSaved("Salvando…");
  saveTimer = window.setTimeout(async () => {
    const res = await fetch("/api/simulation", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
    if (res.ok) savedAt = new Date().toISOString();
    setSaved(res.ok ? savedLabel() : "Erro ao salvar");
  }, 500);
}
const setSaved = (t: string) => document.querySelectorAll(".sim-saved").forEach((e) => (e.textContent = t));
const savedLabel = () => (savedAt ? `Salvo ${new Date(savedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "Não salva");

const isActive = (p: SimulationParams) => p.contribution > 0 || p.sales.length > 0 || (p.buys?.length ?? 0) > 0 || p.allowSells;
const qtyLabel = (n: number | null, whole: boolean) => {
  if (n == null || Math.abs(n) < 1e-9) return "";
  if (privacy.on) return "••• cotas";
  const v = Math.abs(n);
  return whole ? `${Math.round(v)} cota${Math.round(v) === 1 ? "" : "s"}` : `${qty(v)} cotas`;
};
/** Desvio total em relação às metas (metade da soma das diferenças absolutas). */
const distance = (res: SimResult, before = false) =>
  res.categories.reduce((s, c) => s + Math.abs((before ? c.current : c.final) / ((before ? res.totalBefore : res.totalAfter) || 1) - c.target), 0) / 2;

const STATUS: Record<CategoryAction["status"], { label: (c: CategoryAction) => string; cls: string }> = {
  comprar: { label: (c) => `Comprar ${money(c.buy)}`, cls: "buy" },
  vender: { label: (c) => `Vender ${money(c.sell)}`, cls: "sell" },
  acima: { label: () => "Acima da meta · não aportar", cls: "over" },
  "na-meta": { label: () => "Na meta", cls: "ok" },
  "sem-meta": { label: () => "Sem meta", cls: "ok" },
};

// =====================================================================================
// Aba Carteira em modo simulação
// =====================================================================================

let simChart: Chart | null = null;
let firstDonut = true;

export function renderCarteiraSim(r: Report, main: HTMLElement, header: string, onReady: () => void) {
  if (!params) {
    main.innerHTML = `${header}<div class="card"><div class="skeleton line short"></div><div class="skeleton rows"></div></div>`;
    onReady();
    ensureParams(r).then(() => renderCarteiraSim(r, main, header, onReady));
    return;
  }
  const p = params;
  firstDonut = true; // abrir a aba anima de novo; editar não
  main.innerHTML = `${header}
    <section class="card sim-toolbar">
      <div class="sim-controls">
        <label class="field">Novo aporte<span class="money-input"><b>R$</b><input id="sim-contribution" inputmode="decimal" value="${p.contribution ? p.contribution.toLocaleString("pt-BR") : ""}" placeholder="0,00"/></span></label>
        <div class="sim-switches">
          <label class="switch"><input type="checkbox" id="sim-auto" ${p.autoAllocate !== false ? "checked" : ""}/><span></span>Distribuir o dinheiro automaticamente</label>
          <label class="switch"><input type="checkbox" id="sim-allow-sells" ${p.allowSells ? "checked" : ""}/><span></span>Vender o que passar da meta</label>
          <label class="switch"><input type="checkbox" id="sim-whole" ${p.wholeShares ? "checked" : ""}/><span></span>Cotas inteiras na B3</label>
        </div>
        <div class="sim-buttons">
          <button class="primary" id="sim-boleta">+ Boleta</button>
          <button class="ghost" id="sim-clear">Limpar</button>
          <span class="muted small sim-saved">${savedLabel()}</span>
        </div>
      </div>
      <div id="sim-orders"></div>
    </section>
    <div id="sim-body" class="sim-body"></div>`;

  const refresh = () => renderSimBody(r);
  document.getElementById("sim-contribution")!.addEventListener("input", (e) => {
    p.contribution = Math.max(0, parseNum((e.target as HTMLInputElement).value) ?? 0);
    refresh();
    scheduleSave();
  });
  for (const [id, key] of [["sim-auto", "autoAllocate"], ["sim-allow-sells", "allowSells"], ["sim-whole", "wholeShares"]] as const) {
    document.getElementById(id)!.addEventListener("change", (e) => {
      p[key] = (e.target as HTMLInputElement).checked;
      refresh();
      scheduleSave();
    });
  }
  document.getElementById("sim-boleta")!.addEventListener("click", () => boletaModal(r, { side: "buy" }, refresh));
  document.getElementById("sim-clear")!.addEventListener("click", () => {
    if (!confirm("Limpar aporte e boletas da simulação? As metas e os planos por ativo são mantidos.")) return;
    p.contribution = 0;
    p.sales = [];
    p.buys = [];
    p.allowSells = false;
    scheduleSave();
    renderCarteiraSim(r, main, header, onReady);
    toast("Simulação limpa");
  });
  refresh();
  onReady();
}

function renderOrders(r: Report, res: SimResult, refresh: () => void) {
  const p = params!;
  const el = document.getElementById("sim-orders")!;
  const items = [
    ...(p.buys ?? []).map((b, i) => {
      const o = res.buys[i]!;
      const desc = b.mode === "qty" ? `${qty(b.amount)} cotas` : money(b.amount);
      return `<button class="order buy" data-buy="${i}"><b>C</b> ${esc(b.ticker)} <span class="muted">${desc}</span> <span>${money(o.value)}</span><span class="x" data-rm-buy="${i}" aria-label="Remover">✕</span></button>`;
    }),
    ...p.sales.map((s, i) => {
      const o = res.sales[i]!;
      const desc = s.mode === "all" ? "tudo" : s.mode === "qty" ? `${qty(s.amount ?? 0)} cotas` : money(s.amount ?? 0);
      const warn = o.status === "fora-da-carteira" ? " ⚠ fora da carteira" : o.status === "limitada" ? " ⚠ limitada" : "";
      return `<button class="order sell" data-sale="${i}"><b>V</b> ${esc(s.ticker)} <span class="muted">${desc}${warn}</span> <span>${money(o.value)}</span><span class="x" data-rm-sale="${i}" aria-label="Remover">✕</span></button>`;
    }),
  ];
  el.innerHTML = items.length ? `<div class="orders"><span class="muted small">Boletas</span>${items.join("")}</div>` : "";
  el.querySelectorAll<HTMLElement>("[data-rm-buy]").forEach((x) =>
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      p.buys!.splice(Number(x.dataset.rmBuy), 1);
      scheduleSave();
      refresh();
    }),
  );
  el.querySelectorAll<HTMLElement>("[data-rm-sale]").forEach((x) =>
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      p.sales.splice(Number(x.dataset.rmSale), 1);
      scheduleSave();
      refresh();
    }),
  );
  el.querySelectorAll<HTMLElement>("[data-buy]").forEach((x) => x.addEventListener("click", () => boletaModal(r, { side: "buy", index: Number(x.dataset.buy) }, refresh)));
  el.querySelectorAll<HTMLElement>("[data-sale]").forEach((x) => x.addEventListener("click", () => boletaModal(r, { side: "sell", index: Number(x.dataset.sale) }, refresh)));
}

const openCats = new Set<string>();
let openCatsInit = false;

function renderSimBody(r: Report) {
  const p = params!;
  const body = document.getElementById("sim-body");
  if (!body) return;
  const positions = positionsOf(r);
  const res = simulate(positions, p, quotes);
  const refresh = () => renderSimBody(r);
  renderOrders(r, res, refresh);
  // Na primeira visita, abre as categorias que têm algo a fazer.
  if (!openCatsInit) {
    openCatsInit = true;
    for (const c of res.categories) if (c.buy > 0.5 || c.sell > 0.5) openCats.add(c.name);
  }

  const total = res.totalBefore;
  const currentPct = (c: string) => (total ? positions.filter((x) => x.category === c).reduce((s, x) => s + x.value, 0) / total : 0);
  const shown = ALL_CATEGORIES.filter((c) => currentPct(c) > 0 || c in p.targets || res.categories.some((x) => x.name === c && x.final > 0));
  const hidden = ALL_CATEGORIES.filter((c) => !shown.includes(c));
  const sum = shown.reduce((s, c) => s + (p.targets[c] ?? 0), 0);
  const cat = (c: string) => res.categories.find((x) => x.name === c);
  const toDistribute = res.available + res.fromRebalanceSells;

  body.innerHTML = `
    <section class="kpis">
      <div class="card kpi"><div class="label">Para investir</div><div class="value">${money(toDistribute)}</div><div class="sub">aporte ${money(res.contribution)}${res.fromSales ? ` + vendas ${money(res.fromSales)}` : ""}${res.fromRebalanceSells ? ` + excedente ${money(res.fromRebalanceSells)}` : ""}</div></div>
      <div class="card kpi"><div class="label">Boletas de compra</div><div class="value">${money(res.manualBuys)}</div><div class="sub">${res.deficit > 0.005 ? `<span class="down">faltam ${money(res.deficit)}</span>` : p.autoAllocate === false ? `${money(res.leftover)} fica em caixa` : `resto distribuído automaticamente`}</div></div>
      <div class="card kpi"><div class="label">Patrimônio depois</div><div class="value">${money(res.totalAfter)}</div><div class="sub">hoje ${money(res.totalBefore)}${res.leftover > 0.005 && p.autoAllocate !== false ? ` · sobra ${money(res.leftover)}` : ""}</div></div>
      <div class="card kpi"><div class="label">Distância da meta</div><div class="value">${pct(distance(res, true), 1)} → ${pct(distance(res), 1)}</div><div class="sub">hoje → depois da simulação</div></div>
    </section>
    <section class="split-1-2">
      <div class="card"><div class="row-between"><h2 style="margin:0">Depois da simulação</h2><span class="muted small">${money(res.totalAfter)}</span></div><div class="chart-box donut"><canvas id="sim-donut"></canvas></div></div>
      <div class="card">
        <div class="row-between"><h2 style="margin:0">Estratégia</h2><span class="small ${Math.abs(sum - 100) < 0.05 ? "up" : "warn"}">${Math.abs(sum - 100) < 0.05 ? "Metas somam 100%" : `Metas somam ${sum.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}</span></div>
        <div class="strategy">
          <div class="strategy-head muted small"><span></span><span>Categoria</span><span>Hoje</span><span>Depois</span><span>Meta</span><span></span></div>
          ${shown
            .map((c) => {
              const a = cat(c);
              const st = a ? STATUS[a.status] : null;
              return `<div class="strategy-row"><span class="sw" style="background:${colorOf(c)}"></span><span class="t">${esc(c)}</span>
                <span class="num">${pct(currentPct(c), 1)}</span><span class="num"><b>${a ? pct(a.final / (res.totalAfter || 1), 1) : "—"}</b></span>
                <span class="pct-input"><input inputmode="decimal" data-target="${esc(c)}" value="${(p.targets[c] ?? 0).toLocaleString("pt-BR")}" aria-label="Meta de ${esc(c)}"/><b>%</b></span>
                <span>${st && a ? `<span class="badge ${st.cls}">${st.label(a)}</span>` : ""}</span></div>`;
            })
            .join("")}
        </div>
        <div class="row-between" style="margin-top:12px">
          ${hidden.length ? `<select id="sim-add-cat"><option value="">+ Categoria…</option>${hidden.map((c) => `<option>${esc(c)}</option>`).join("")}</select>` : "<span></span>"}
          <button class="link" id="sim-use-current">Metas = alocação atual</button>
        </div>
      </div>
    </section>
    ${res.categories
      .filter((c) => c.current > 0 || c.final > 0 || c.target > 0)
      .map((c) => categoryBlock(r, c, res))
      .join("")}`;

  // Donut "depois".
  simChart?.destroy();
  const cats = res.categories.filter((c) => c.final > 0.005);
  simChart = new Chart(document.getElementById("sim-donut") as HTMLCanvasElement, {
    type: "doughnut",
    data: { labels: cats.map((c) => c.name), datasets: [{ data: cats.map((c) => c.final), backgroundColor: cats.map((c) => colorOf(c.name)), borderColor: "#1d1d1d", borderWidth: 2 }] },
    options: {
      cutout: "68%",
      maintainAspectRatio: false,
      // Na primeira abertura gira até o lugar; nas edições só transiciona.
      animation: firstDonut ? spinDonut() : { duration: 350, easing: "easeOutQuart" },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => ` ${x.label}: ${money(x.parsed)} (${pct(x.parsed / (res.totalAfter || 1), 1)} · meta ${pct(cats[x.dataIndex]!.target, 1)})` } } },
    },
  });

  if (firstDonut) {
    firstDonut = false;
    countUp(body);
    // Depois da entrada, as edições atualizam sem replay das animações.
    setTimeout(() => body.classList.add("settled"), 1200);
  }

  // Metas (confirma ao sair do campo / Enter para não perder o foco a cada tecla).
  body.querySelectorAll<HTMLInputElement>("[data-target]").forEach((inp) =>
    inp.addEventListener("change", () => {
      p.targets[inp.dataset.target!] = Math.max(0, parseNum(inp.value) ?? 0);
      scheduleSave();
      refresh();
    }),
  );
  body.querySelector("#sim-add-cat")?.addEventListener("change", (e) => {
    const c = (e.target as HTMLSelectElement).value;
    if (!c) return;
    p.targets[c] = p.targets[c] ?? 0;
    scheduleSave();
    refresh();
  });
  body.querySelector("#sim-use-current")!.addEventListener("click", () => {
    p.targets = defaultParams(positions).targets;
    scheduleSave();
    refresh();
    toast("Metas iguais à alocação atual");
  });

  // Blocos por categoria.
  body.querySelectorAll<HTMLDetailsElement>("details.cat").forEach((d) => d.addEventListener("toggle", () => (d.open ? openCats.add(d.dataset.cat!) : openCats.delete(d.dataset.cat!))));
  body.querySelectorAll<HTMLButtonElement>("[data-pmode]").forEach((b) =>
    b.addEventListener("click", () => {
      const c = b.dataset.cat!;
      const plan: AssetPlan = { ...(p.assetPlans[c] ?? { mode: "proportional" }), mode: b.dataset.pmode as AssetPlan["mode"] };
      if (plan.mode === "custom" && !plan.weights) plan.weights = currentWeights(r, c);
      p.assetPlans[c] = plan;
      scheduleSave();
      refresh();
    }),
  );
  body.querySelectorAll<HTMLInputElement>("[data-w]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const c = inp.dataset.cat!;
      const plan = (p.assetPlans[c] ??= { mode: "custom" });
      plan.weights = { ...(plan.weights ?? {}), [inp.dataset.w!]: Math.max(0, parseNum(inp.value) ?? 0) };
      scheduleSave();
      refresh();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-trade]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const side = b.dataset.trade as "buy" | "sell";
      const t = b.dataset.ticker!;
      // Já existe boleta deste ativo? Abre para editar/excluir em vez de criar outra.
      const idx = side === "buy" ? (p.buys ?? []).findIndex((x) => x.ticker === t) : p.sales.findIndex((x) => x.ticker === t);
      boletaModal(r, idx >= 0 ? { side, index: idx } : { side, ticker: t }, refresh);
    }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-edit-buy]").forEach((b) =>
    b.addEventListener("click", () => {
      const idx = (p.buys ?? []).findIndex((x) => x.ticker === b.dataset.editBuy);
      if (idx >= 0) boletaModal(r, { side: "buy", index: idx }, refresh);
    }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-add-asset]").forEach((b) => b.addEventListener("click", () => addAssetModal(r, b.dataset.addAsset!, refresh)));
  body.querySelectorAll<HTMLButtonElement>("[data-rm-extra]").forEach((b) =>
    b.addEventListener("click", () => {
      const plan = p.assetPlans[b.dataset.cat!];
      if (plan) plan.extra = (plan.extra ?? []).filter((t) => t !== b.dataset.rmExtra);
      scheduleSave();
      refresh();
    }),
  );
}

function currentWeights(r: Report, category: string) {
  const own = r.categories.find((c) => c.name === category)?.positions ?? [];
  const tot = own.reduce((s, x) => s + x.value, 0);
  return Object.fromEntries(own.map((x) => [x.ticker, Math.round((tot ? x.value / tot : 0) * 1000) / 10]));
}

function categoryBlock(r: Report, c: CategoryAction, res: SimResult) {
  const p = params!;
  const plan = p.assetPlans[c.name] ?? { mode: "proportional" };
  const st = STATUS[c.status];
  const own = r.categories.find((x) => x.name === c.name)?.positions ?? [];
  const action = new Map(c.assets.map((a) => [a.ticker, a]));
  const soldAll = new Set(p.sales.filter((s) => s.mode === "all").map((s) => s.ticker));
  // Linhas: posições atuais + ativos novos (boletas ou plano).
  const newOnes = [...new Set([...c.assets.filter((a) => a.isNew).map((a) => a.ticker), ...(plan.extra ?? [])])].filter((t) => !own.some((x) => x.ticker === t));
  const catAfterTotal = c.final || 1;
  const rows = [
    ...own.map((x) => ({ ticker: x.ticker, sub: x.subcategory, quantity: x.quantity, price: x.price, value: x.value, isNew: false })),
    ...newOnes.map((t) => ({ ticker: t, sub: "novo", quantity: 0, price: quotes[t]?.price ?? 0, value: 0, isNew: true })),
  ];
  const tr = rows
    .map((x) => {
      const a = action.get(x.ticker);
      const move = a ? a.buy - a.sell : 0;
      const after = x.value + move;
      const sold = soldAll.has(x.ticker);
      const sim = a && Math.abs(move) > 0.005
        ? `<span class="${move > 0 ? "up" : "down"}">${move > 0 ? "+" : "−"} ${money(Math.abs(move))}</span><div class="small muted">${move > 0 ? "+" : "−"}${qtyLabel(a.quantity, a.whole)}${a.manual > 0.005 ? ` · <button class="link small" data-edit-buy="${esc(x.ticker)}">boleta</button>` : ""}</div>`
        : `<span class="muted">—</span>`;
      return `<tr class="${x.isNew ? "is-new" : ""} ${sold ? "is-sold" : ""}">
        <td><div class="tk">${esc(x.ticker)}${x.isNew ? ` <span class="badge new">novo</span>` : ""}${sold ? ` <span class="badge sell">venda total</span>` : ""}</div><div class="nm">${esc(x.sub)}</div></td>
        <td>${qty(x.quantity)}</td><td>${x.price ? money(x.price) : "—"}</td><td>${money(x.value)}</td>
        <td>${sim}</td><td><b>${money(after)}</b></td>
        <td>${pct(c.current ? x.value / c.current : 0, 1)} → <b>${pct(after / catAfterTotal, 1)}</b></td>
        ${plan.mode === "custom" ? `<td><span class="pct-input slim"><input inputmode="decimal" data-cat="${esc(c.name)}" data-w="${esc(x.ticker)}" value="${(plan.weights?.[x.ticker] ?? 0).toLocaleString("pt-BR")}"/><b>%</b></span></td>` : ""}
        <td class="trade"><button class="mini buy" data-trade="buy" data-ticker="${esc(x.ticker)}" title="Comprar">C</button>${x.isNew ? `<button class="mini" data-rm-extra="${esc(x.ticker)}" data-cat="${esc(c.name)}" title="Remover">✕</button>` : `<button class="mini sell" data-trade="sell" data-ticker="${esc(x.ticker)}" title="Vender">V</button>`}</td></tr>`;
    })
    .join("");
  const open = openCats.has(c.name);
  return `<details class="cat sim-cat ${st.cls}" data-cat="${esc(c.name)}" ${open ? "open" : ""}>
    <summary><span class="ring" style="border:3px solid ${colorOf(c.name)}">${pct(c.final / (res.totalAfter || 1), 0)}</span>
      <span><div class="t">${esc(c.name)}</div><div class="muted small">hoje ${money(c.current)} → depois ${money(c.final)} · meta ${money(c.targetValue)} (${pct(c.target, 1)})</div></span>
      <span class="badge ${st.cls}">${st.label(c)}</span><span class="chev">›</span></summary>
    <div class="body">
      ${c.needsAssets ? `<p class="warn small">Esta categoria deveria receber ${money(c.buy)}, mas não tem ativos. Adicione um ativo abaixo.</p>` : ""}
      <div class="row-between plan-bar">
        <div class="toggle">${(["proportional", "equal", "custom"] as const)
          .map((mo) => `<button data-cat="${esc(c.name)}" data-pmode="${mo}" aria-pressed="${plan.mode === mo}">${{ proportional: "Proporcional", equal: "Partes iguais", custom: "Pesos próprios" }[mo]}</button>`)
          .join("")}</div>
        <button class="ghost" data-add-asset="${esc(c.name)}">+ Ativo novo</button>
      </div>
      <div class="scroll"><table class="sim-table"><thead><tr><th>Ativo</th><th>Qtde</th><th>Preço</th><th>Valor hoje</th><th>Simulação</th><th>Depois</th><th>% da classe</th>${plan.mode === "custom" ? "<th>Peso alvo</th>" : ""}<th></th></tr></thead><tbody>${tr}</tbody></table></div>
    </div></details>`;
}

// =====================================================================================
// Boleta (compra/venda simulada) e ativo novo
// =====================================================================================

function boletaModal(r: Report, opts: { side: "buy" | "sell"; index?: number; ticker?: string }, onDone: () => void) {
  const p = params!;
  const own = r.categories.flatMap((c) => c.positions);
  let side = opts.side;
  const editingBuy = side === "buy" && opts.index != null ? p.buys![opts.index]! : null;
  const editingSale = side === "sell" && opts.index != null ? p.sales[opts.index]! : null;
  let mode: string = editingBuy?.mode ?? editingSale?.mode ?? (side === "buy" ? "qty" : "all");
  const initialTicker = editingBuy?.ticker ?? editingSale?.ticker ?? opts.ticker ?? "";
  const initialAmount = editingBuy?.amount ?? editingSale?.amount;
  const m = openModal(
    opts.index != null ? "Editar boleta" : "Boleta simulada",
    `<div class="toggle side-toggle" style="margin-bottom:14px"><button data-side="buy" aria-pressed="${side === "buy"}">Comprar</button><button data-side="sell" aria-pressed="${side === "sell"}">Vender</button></div>
     <label class="field">Ativo<input id="b-ticker" list="b-tickers" value="${esc(initialTicker)}" placeholder="Ex.: ITSA4, HGLG11" autocapitalize="characters"/></label>
     <datalist id="b-tickers">${own.map((x) => `<option value="${esc(x.ticker)}">${esc(x.category)} · ${money(x.value)}</option>`).join("")}</datalist>
     <div class="toggle" id="b-modes" style="margin:14px 0"></div>
     <label class="field" id="b-amount-wrap"><span id="b-amount-label">Quantidade</span><input id="b-amount" inputmode="decimal" value="${initialAmount != null ? initialAmount.toLocaleString("pt-BR") : ""}"/></label>
     <p class="note" id="b-preview"></p>
     <div class="row-between" style="margin-top:16px">${opts.index != null ? `<button class="ghost danger" id="b-del">Excluir boleta</button>` : "<span></span>"}<button class="primary" id="b-ok">${opts.index != null ? "Salvar" : "Adicionar à simulação"}</button></div>`,
  );
  const $ = <T extends HTMLElement>(s: string) => m.el.querySelector(s) as T;
  const tickerEl = $<HTMLInputElement>("#b-ticker");
  const amountEl = $<HTMLInputElement>("#b-amount");

  const drawModes = () => {
    const modes = side === "buy" ? [["qty", "Quantidade"], ["value", "Valor (R$)"]] : [["all", "Vender tudo"], ["qty", "Quantidade"], ["value", "Valor (R$)"]];
    if (!modes.some(([k]) => k === mode)) mode = modes[0]![0]!;
    $("#b-modes").innerHTML = modes.map(([k, l]) => `<button data-mode="${k}" aria-pressed="${mode === k}">${l}</button>`).join("");
    $("#b-modes").querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        mode = b.dataset.mode!;
        drawModes();
        preview();
      }),
    );
  };
  const preview = async () => {
    const t = tickerEl.value.trim().toUpperCase();
    const pos = own.find((x) => x.ticker === t);
    $("#b-amount-wrap").style.display = mode === "all" ? "none" : "";
    $("#b-amount-label").textContent = mode === "qty" ? "Quantidade de cotas" : "Valor em R$";
    const out = $("#b-preview");
    if (!t) return void (out.textContent = "");
    if (side === "sell" && !pos) return void (out.innerHTML = `<span class="warn">Você não tem ${esc(t)} na carteira.</span>`);
    const q = pos ? null : await fetchQuote(t);
    const price = pos?.price ?? q?.price ?? null;
    if (!price) return void (out.innerHTML = `<span class="warn">Não encontrei cotação para ${esc(t)}.</span>`);
    const a = parseNum(amountEl.value) ?? 0;
    const category = pos?.category ?? q?.category ?? "Outros";
    let n = mode === "all" ? pos!.quantity : mode === "qty" ? a : a / price;
    if (side === "sell" && pos) n = Math.min(n, pos.quantity);
    out.innerHTML = `${esc(t)} · ${esc(category)} · ${money(price)}${pos ? ` · você tem ${qty(pos.quantity)} cotas` : ` · <span class="badge new">novo na carteira</span>`}<br>${side === "buy" ? "Compra" : "Venda"} de <b>${qty(n)} cotas ≈ ${money(n * price)}</b>`;
  };
  m.el.querySelectorAll<HTMLButtonElement>("[data-side]").forEach((b) =>
    b.addEventListener("click", () => {
      side = b.dataset.side as "buy" | "sell";
      m.el.querySelectorAll("[data-side]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      drawModes();
      preview();
    }),
  );
  tickerEl.addEventListener("change", preview);
  amountEl.addEventListener("input", preview);
  drawModes();
  preview();

  m.el.querySelector("#b-del")?.addEventListener("click", () => {
    if (editingBuy) p.buys!.splice(opts.index!, 1);
    if (editingSale) p.sales.splice(opts.index!, 1);
    scheduleSave();
    m.close();
    onDone();
    toast("Boleta excluída");
  });
  $("#b-ok").addEventListener("click", async () => {
    const t = tickerEl.value.trim().toUpperCase();
    if (!t) return tickerEl.focus();
    const a = parseNum(amountEl.value);
    if (mode !== "all" && !a) return amountEl.focus();
    if (side === "sell" && !own.some((x) => x.ticker === t)) return void preview();
    if (side === "buy" && !own.some((x) => x.ticker === t) && !(await fetchQuote(t))) return void preview();
    // Na edição, remove a ordem anterior (inclusive se trocou de compra para venda).
    if (editingBuy) p.buys!.splice(opts.index!, 1);
    if (editingSale) p.sales.splice(opts.index!, 1);
    if (side === "buy") (p.buys ??= []).push({ ticker: t, mode: mode as BuyParam["mode"], amount: a! });
    else p.sales.push({ ticker: t, mode: mode as SaleParam["mode"], amount: mode === "all" ? undefined : a! });
    scheduleSave();
    m.close();
    onDone();
  });
}

function addAssetModal(r: Report, category: string, onDone: () => void) {
  const p = params!;
  const m = openModal(
    `Ativo novo em ${category}`,
    `<p class="muted" style="margin-top:0">O ativo passa a receber parte do aporte desta categoria. Ajuste o peso dele em “Pesos próprios”.</p>
     <label class="field">Código<input id="n-ticker" placeholder="Ex.: HGLG11" autocapitalize="characters"/></label>
     <p class="note" id="n-msg"></p>
     <div class="row-between" style="margin-top:16px"><span></span><button class="primary" id="n-ok">Adicionar</button></div>`,
  );
  const inp = m.el.querySelector("#n-ticker") as HTMLInputElement;
  const msg = m.el.querySelector("#n-msg") as HTMLElement;
  m.el.querySelector("#n-ok")!.addEventListener("click", async () => {
    const t = inp.value.trim().toUpperCase();
    if (!/^[A-Z0-9.^-]{2,15}$/.test(t)) return inp.focus();
    if (r.categories.some((c) => c.positions.some((x) => x.ticker === t))) {
      msg.innerHTML = `<span class="warn">${esc(t)} já está na carteira.</span>`;
      return;
    }
    const q = await fetchQuote(t);
    if (!q) {
      msg.innerHTML = `<span class="warn">Não encontrei cotação para ${esc(t)}.</span>`;
      return;
    }
    const plan: AssetPlan = p.assetPlans[category] ?? { mode: "proportional" };
    plan.extra = [...new Set([...(plan.extra ?? []), t])];
    if (plan.mode !== "custom") {
      plan.mode = "custom";
      plan.weights = currentWeights(r, category);
    }
    plan.weights = { ...(plan.weights ?? {}), [t]: plan.weights?.[t] ?? 10 };
    p.assetPlans[category] = plan;
    openCats.add(category);
    scheduleSave();
    m.close();
    onDone();
    if (q.category && q.category !== category) toast(`${t} parece ser ${q.category}, mas foi incluído em ${category}`);
  });
}

// =====================================================================================
// Cartão no Resumo
// =====================================================================================

export async function mountSimSummary(el: HTMLElement, r: Report, openSim: () => void) {
  const p = await ensureParams(r);
  if (!document.body.contains(el)) return;
  if (!isActive(p)) {
    el.innerHTML = `<div class="card sim-cta"><div><h2 style="margin:0">Simulação</h2><p class="muted" style="margin:4px 0 0">Simule um aporte ou vendas e veja o que comprar para chegar nas suas metas.</p></div><button class="ghost" id="sim-open">Simular na Carteira ›</button></div>`;
    el.querySelector("#sim-open")!.addEventListener("click", openSim);
    return;
  }
  const res = simulate(positionsOf(r), p, quotes);
  // Vendas planejadas (boletas) + compras/vendas calculadas, das maiores para as menores.
  const planned = res.sales
    .filter((x) => x.value > 0.5)
    .map((x) => ({ ticker: x.ticker, category: x.category ?? "Outros", buy: 0, sell: x.value, quantity: -x.quantity, whole: true, isNew: false }));
  const moves = [
    ...planned,
    ...res.categories.flatMap((c) => c.assets.map((a) => ({ ticker: a.ticker, category: c.name, buy: a.buy, sell: a.sell, quantity: a.quantity, whole: a.whole, isNew: a.isNew }))),
  ]
    .filter((a) => a.buy > 0.5 || a.sell > 0.5)
    .sort((a, b) => b.buy + b.sell - (a.buy + a.sell));
  const top = moves.slice(0, 8);
  el.innerHTML = `<div class="card sim-summary">
    <div class="row-between"><div><h2 style="margin:0">Simulação salva</h2><p class="muted small" style="margin:4px 0 0">${savedLabel()} · recalculada com a carteira de agora</p></div><button class="ghost" id="sim-open">Abrir na Carteira ›</button></div>
    <div class="sim-summary-grid">
      <div class="stats two">
        <div class="stat"><div class="l">Para investir</div><div class="v">${money(res.available + res.fromRebalanceSells)}</div></div>
        <div class="stat"><div class="l">Compras</div><div class="v up">${money(res.categories.reduce((s, c) => s + c.buy, 0))}</div></div>
        <div class="stat"><div class="l">Vendas</div><div class="v down">${money(res.fromSales + res.fromRebalanceSells)}</div></div>
        <div class="stat"><div class="l">Distância da meta</div><div class="v">${pct(distance(res, true), 1)} → ${pct(distance(res), 1)}</div></div>
      </div>
      <div><h3 style="margin-top:0">O que fazer</h3><div class="asset-actions">${top
        .map(
          (a) => `<div class="aa"><span><span class="sw" style="background:${colorOf(a.category)}"></span> <b>${esc(a.ticker)}</b>${a.isNew ? ` <span class="badge new">novo</span>` : ""}</span>
          <span class="muted small">${qtyLabel(a.quantity, a.whole)}</span><span class="${a.sell > 0 ? "down" : "up"}">${a.sell > 0 ? `− ${money(a.sell)}` : `+ ${money(a.buy)}`}</span></div>`,
        )
        .join("")}${moves.length > top.length ? `<p class="muted small" style="margin:8px 0 0">e mais ${moves.length - top.length} ativo(s) na Carteira.</p>` : ""}${res.deficit > 0.005 ? `<p class="down small">As boletas passam do dinheiro disponível em ${money(res.deficit)}.</p>` : ""}</div></div>
    </div></div>`;
  el.querySelector("#sim-open")!.addEventListener("click", openSim);
}
