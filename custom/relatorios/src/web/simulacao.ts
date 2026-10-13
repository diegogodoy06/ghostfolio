/**
 * Aba Simulação: metas por categoria + aporte + vendas -> o que comprar/vender/realocar.
 *
 * Só a intenção é salva (metas, aporte, vendas, planos por ativo); o resultado é recalculado
 * sempre com a carteira atual vinda do Ghostfolio.
 */
import type { Chart } from "chart.js";
import type { Report } from "../shared";
import { type AssetPlan, type SaleParam, type SimPosition, type SimResult, type SimulationParams, defaultParams, simulate } from "../sim-engine";
import { colorOf, esc, money, openModal, parseNum, pct, qty, skeleton, toast } from "./ui";

const ALL_CATEGORIES = ["Ações", "FIIs", "ETFs", "BDRs", "Exterior", "Tesouro Direto", "Renda Fixa", "Cripto"];

let params: SimulationParams | null = null;
let loading = false;
const prices: Record<string, number> = {};
let saveTimer: number | undefined;
let savedAt: string | null = null;

const positionsOf = (r: Report): SimPosition[] =>
  r.categories.flatMap((c) => c.positions.map((p) => ({ ticker: p.ticker, category: p.category, value: p.value, price: p.price, quantity: p.quantity })));

async function loadParams(r: Report) {
  const res = await fetch("/api/simulation");
  const saved = res.ok ? ((await res.json()) as SimulationParams | null) : null;
  params = saved && saved.version === 1 ? { ...defaultParams(positionsOf(r)), ...saved } : defaultParams(positionsOf(r));
  savedAt = saved?.updatedAt ?? null;
  // Cotação dos ativos novos marcados em algum plano.
  const extras = Object.values(params.assetPlans).flatMap((p) => p.extra ?? []);
  await Promise.all(extras.map(fetchPrice));
}

async function fetchPrice(ticker: string) {
  if (prices[ticker]) return prices[ticker];
  const res = await fetch(`/api/quote?t=${encodeURIComponent(ticker)}`);
  const q = res.ok ? ((await res.json()) as { price: number | null }) : null;
  if (q?.price) prices[ticker] = q.price;
  return q?.price ?? null;
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  const el = document.getElementById("sim-saved");
  if (el) el.textContent = "Salvando…";
  saveTimer = window.setTimeout(async () => {
    const res = await fetch("/api/simulation", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
    savedAt = res.ok ? new Date().toISOString() : savedAt;
    const e = document.getElementById("sim-saved");
    if (e) e.textContent = res.ok ? `Salvo às ${new Date(savedAt!).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Erro ao salvar";
  }, 500);
}

const savedLabel = () => (savedAt ? `Salvo em ${new Date(savedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "Ainda não salva");
const qtyLabel = (n: number | null, whole: boolean) => (n == null ? "" : whole ? `${Math.abs(Math.round(n))} cota${Math.abs(Math.round(n)) === 1 ? "" : "s"}` : `${qty(Math.abs(n))} cotas`);

export function renderSimulacao(r: Report, main: HTMLElement, _charts: Chart[]) {
  if (!params) {
    main.innerHTML = skeleton("simulacao");
    if (!loading) {
      loading = true;
      loadParams(r)
        .then(() => renderSimulacao(r, main, _charts))
        .finally(() => (loading = false));
    }
    return;
  }
  const p = params;
  const positions = positionsOf(r);
  const total = positions.reduce((s, x) => s + x.value, 0);
  const currentPct = (c: string) => (total ? positions.filter((x) => x.category === c).reduce((s, x) => s + x.value, 0) / total : 0);
  const shown = ALL_CATEGORIES.filter((c) => currentPct(c) > 0 || c in p.targets);
  const hidden = ALL_CATEGORIES.filter((c) => !shown.includes(c));

  main.innerHTML = `
    <section class="card sim-hero">
      <div class="row-between">
        <div><h2 style="margin:0">Simulação de carteira</h2>
          <p class="muted" style="margin:4px 0 0">Recalculada com a sua carteira de agora (${money(total)}). Nada aqui altera o Ghostfolio.</p></div>
        <span class="muted small" id="sim-saved">${savedLabel()}</span>
      </div>
    </section>
    <section class="sim-layout">
      <div class="sim-config">
        <div class="card">
          <div class="row-between"><h2 style="margin:0">Estratégia</h2><span id="sim-sum" class="small"></span></div>
          <p class="note" style="margin:6px 0 14px">Meta de cada categoria em % do patrimônio.</p>
          <div class="targets">${shown
            .map(
              (c) => `<label class="target-row"><span class="sw" style="background:${colorOf(c)}"></span><span class="t">${esc(c)}</span>
              <span class="muted small">hoje ${pct(currentPct(c), 1)}</span>
              <span class="pct-input"><input inputmode="decimal" data-target="${esc(c)}" value="${(p.targets[c] ?? 0).toLocaleString("pt-BR")}" aria-label="Meta de ${esc(c)}"/><b>%</b></span></label>`,
            )
            .join("")}</div>
          <div class="row-between" style="margin-top:12px">
            ${hidden.length ? `<select id="sim-add-cat"><option value="">+ Categoria…</option>${hidden.map((c) => `<option>${esc(c)}</option>`).join("")}</select>` : "<span></span>"}
            <button class="link" id="sim-use-current">Usar alocação atual</button>
          </div>
        </div>
        <div class="card">
          <h2>Dinheiro</h2>
          <label class="field">Novo aporte<span class="money-input"><b>R$</b><input id="sim-contribution" inputmode="decimal" value="${p.contribution ? p.contribution.toLocaleString("pt-BR") : ""}" placeholder="0,00"/></span></label>
          <label class="switch"><input type="checkbox" id="sim-allow-sells" ${p.allowSells ? "checked" : ""}/><span></span>Vender o que passar da meta (rebalanceamento completo)</label>
          <label class="switch"><input type="checkbox" id="sim-whole" ${p.wholeShares ? "checked" : ""}/><span></span>Cotas inteiras para ativos da B3</label>
        </div>
        <div class="card">
          <div class="row-between"><h2 style="margin:0">Vendas planejadas</h2><button class="ghost" id="sim-add-sale">+ Venda</button></div>
          <div id="sim-sales" style="margin-top:12px"></div>
        </div>
      </div>
      <div class="sim-result" id="sim-result"></div>
    </section>`;

  const update = () => {
    const sum = shown.reduce((s, c) => s + (p.targets[c] ?? 0), 0);
    const sumEl = document.getElementById("sim-sum")!;
    sumEl.innerHTML = Math.abs(sum - 100) < 0.05 ? `<span class="up">Total 100%</span>` : `<span class="warn">Total ${sum.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% · ${sum < 100 ? "faltam" : "sobram"} ${Math.abs(100 - sum).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</span>`;
    renderSales(r);
    renderResult(r, simulate(positions, p, prices));
  };

  // Metas
  main.querySelectorAll<HTMLInputElement>("[data-target]").forEach((inp) =>
    inp.addEventListener("input", () => {
      p.targets[inp.dataset.target!] = Math.max(0, parseNum(inp.value) ?? 0);
      update();
      scheduleSave();
    }),
  );
  document.getElementById("sim-add-cat")?.addEventListener("change", (e) => {
    const c = (e.target as HTMLSelectElement).value;
    if (!c) return;
    p.targets[c] = p.targets[c] ?? 0; // aparece na lista; o usuário define o valor
    scheduleSave();
    renderSimulacao(r, main, _charts);
  });
  document.getElementById("sim-use-current")!.addEventListener("click", () => {
    p.targets = defaultParams(positions).targets;
    scheduleSave();
    renderSimulacao(r, main, _charts);
    toast("Metas iguais à alocação atual");
  });
  // Dinheiro
  document.getElementById("sim-contribution")!.addEventListener("input", (e) => {
    p.contribution = Math.max(0, parseNum((e.target as HTMLInputElement).value) ?? 0);
    update();
    scheduleSave();
  });
  for (const [id, key] of [["sim-allow-sells", "allowSells"], ["sim-whole", "wholeShares"]] as const) {
    document.getElementById(id)!.addEventListener("change", (e) => {
      p[key] = (e.target as HTMLInputElement).checked;
      update();
      scheduleSave();
    });
  }
  document.getElementById("sim-add-sale")!.addEventListener("click", () => saleModal(r, null, update));
  update();
}

// ---------- Vendas ----------

function renderSales(r: Report) {
  const p = params!;
  const el = document.getElementById("sim-sales")!;
  const res = simulate(positionsOf(r), p, prices);
  if (!p.sales.length) {
    el.innerHTML = `<p class="muted small" style="margin:0">Nenhuma. Use para simular vender um ou mais ativos e realocar o dinheiro.</p>`;
    return;
  }
  el.innerHTML = `<div class="sale-list">${p.sales
    .map((s, i) => {
      const out = res.sales[i]!;
      const desc = s.mode === "all" ? "tudo" : s.mode === "qty" ? `${qty(s.amount ?? 0)} cotas` : money(s.amount ?? 0);
      const warn = out.status === "fora-da-carteira" ? `<span class="warn small">não está mais na carteira</span>` : out.status === "limitada" ? `<span class="warn small">limitada ao que você tem</span>` : "";
      return `<div class="sale-item"><button class="sale-edit" data-sale="${i}"><b>${esc(s.ticker)}</b> <span class="muted small">${desc}</span> ${warn}</button>
        <span class="v">${money(out.value)}</span><button class="icon small-x" data-remove-sale="${i}" aria-label="Remover venda">✕</button></div>`;
    })
    .join("")}</div><div class="row-between" style="margin-top:10px"><span class="muted small">Total das vendas</span><b>${money(res.fromSales)}</b></div>`;
  el.querySelectorAll<HTMLButtonElement>("[data-remove-sale]").forEach((b) =>
    b.addEventListener("click", () => {
      p.sales.splice(Number(b.dataset.removeSale), 1);
      scheduleSave();
      document.getElementById("sim-contribution")!.dispatchEvent(new Event("input"));
    }),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-sale]").forEach((b) =>
    b.addEventListener("click", () => saleModal(r, Number(b.dataset.sale), () => document.getElementById("sim-contribution")!.dispatchEvent(new Event("input")))),
  );
}

function saleModal(r: Report, index: number | null, onDone: () => void) {
  const p = params!;
  const editing = index != null ? p.sales[index]! : null;
  const groups = r.categories.map(
    (c) => `<optgroup label="${esc(c.name)}">${c.positions.map((x) => `<option value="${esc(x.ticker)}" ${editing?.ticker === x.ticker ? "selected" : ""}>${esc(x.ticker)} · ${money(x.value)}</option>`).join("")}</optgroup>`,
  );
  const m = openModal(
    editing ? `Editar venda de ${editing.ticker}` : "Simular venda",
    `<label class="field">Ativo<select id="sale-ticker">${groups.join("")}</select></label>
     <div class="toggle" id="sale-mode" style="margin:14px 0">${(["all", "qty", "value"] as const)
       .map((mo) => `<button data-mode="${mo}" aria-pressed="${(editing?.mode ?? "all") === mo}">${{ all: "Vender tudo", qty: "Quantidade", value: "Valor (R$)" }[mo]}</button>`)
       .join("")}</div>
     <label class="field" id="sale-amount-wrap">Quantidade<input id="sale-amount" inputmode="decimal" value="${editing?.amount != null ? editing.amount.toLocaleString("pt-BR") : ""}"/></label>
     <p class="note" id="sale-preview"></p>
     <div class="row-between" style="margin-top:16px"><span></span><button class="primary" id="sale-ok">${editing ? "Salvar" : "Adicionar venda"}</button></div>`,
  );
  let mode: SaleParam["mode"] = editing?.mode ?? "all";
  const sel = m.el.querySelector("#sale-ticker") as HTMLSelectElement;
  const amount = m.el.querySelector("#sale-amount") as HTMLInputElement;
  const wrap = m.el.querySelector("#sale-amount-wrap") as HTMLElement;
  const preview = () => {
    const pos = r.categories.flatMap((c) => c.positions).find((x) => x.ticker === sel.value)!;
    wrap.style.display = mode === "all" ? "none" : "";
    wrap.firstChild!.textContent = mode === "qty" ? "Quantidade" : "Valor em R$";
    const a = parseNum(amount.value) ?? 0;
    const value = mode === "all" ? pos.value : mode === "qty" ? Math.min(a, pos.quantity) * pos.price : Math.min(a, pos.value);
    (m.el.querySelector("#sale-preview") as HTMLElement).innerHTML = `Você tem ${qty(pos.quantity)} cotas (${money(pos.value)}) a ${money(pos.price)}. Esta venda gera <b>${money(value)}</b>.`;
  };
  m.el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode as SaleParam["mode"];
      m.el.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      preview();
    }),
  );
  sel.addEventListener("change", preview);
  amount.addEventListener("input", preview);
  preview();
  m.el.querySelector("#sale-ok")!.addEventListener("click", () => {
    const sale: SaleParam = { ticker: sel.value, mode, amount: mode === "all" ? undefined : (parseNum(amount.value) ?? 0) };
    if (mode !== "all" && !sale.amount) return amount.focus();
    if (index != null) p.sales[index] = sale;
    else p.sales.push(sale);
    scheduleSave();
    m.close();
    onDone();
  });
}

// ---------- Resultado ----------

const STATUS: Record<string, { label: (c: SimResult["categories"][number]) => string; cls: string }> = {
  comprar: { label: (c) => `Comprar ${money(c.buy)}`, cls: "buy" },
  vender: { label: (c) => `Vender ${money(c.sell)}`, cls: "sell" },
  acima: { label: (c) => `Acima da meta · não aportar`, cls: "over" },
  "na-meta": { label: () => "Na meta", cls: "ok" },
  "sem-meta": { label: () => "Sem meta definida", cls: "ok" },
};

function renderResult(r: Report, res: SimResult) {
  const el = document.getElementById("sim-result")!;
  const maxPct = Math.max(...res.categories.flatMap((c) => [c.current / (res.totalBefore || 1), c.final / (res.totalAfter || 1), c.target]), 0.01);
  const bar = (v: number, color: string, cls = "") => `<div class="cmp-bar ${cls}"><div style="width:${(v / maxPct) * 100}%;background:${color}"></div></div>`;
  const nothing = res.available < 0.01 && res.fromRebalanceSells < 0.01;

  el.innerHTML = `
    <div class="kpis sim-kpis">
      <div class="card kpi"><div class="label">Para distribuir</div><div class="value">${money(res.available + res.fromRebalanceSells)}</div><div class="sub">aporte ${money(res.contribution)}${res.fromSales ? ` + vendas ${money(res.fromSales)}` : ""}${res.fromRebalanceSells ? ` + excedente ${money(res.fromRebalanceSells)}` : ""}</div></div>
      <div class="card kpi"><div class="label">Patrimônio depois</div><div class="value">${money(res.totalAfter)}</div><div class="sub">hoje ${money(res.totalBefore)}</div></div>
      <div class="card kpi"><div class="label">Sobra (arredondamento)</div><div class="value">${money(res.leftover)}</div><div class="sub">não alocado</div></div>
      <div class="card kpi"><div class="label">Distância da meta</div><div class="value">${pct(distance(res), 1)}</div><div class="sub">depois · hoje ${pct(distance(res, true), 1)}</div></div>
    </div>
    <div class="card">
      <div class="row-between"><h2 style="margin:0">Antes, depois e meta</h2>
        <div class="cmp-legend small"><span><i class="now"></i>Hoje</span><span><i class="after"></i>Depois</span><span><i class="goal"></i>Meta</span></div></div>
      <div class="cmp">${res.categories
        .map(
          (c) => `<div class="cmp-row"><span class="t"><span class="sw" style="background:${colorOf(c.name)}"></span>${esc(c.name)}</span>
          <div class="cmp-bars">${bar(c.current / (res.totalBefore || 1), "rgba(255,255,255,0.28)")}${bar(c.final / (res.totalAfter || 1), colorOf(c.name))}<div class="cmp-goal" style="left:${(c.target / maxPct) * 100}%"></div></div>
          <span class="v small">${pct(c.current / (res.totalBefore || 1), 1)} → <b>${pct(c.final / (res.totalAfter || 1), 1)}</b><br><span class="muted">meta ${pct(c.target, 1)}</span></span></div>`,
        )
        .join("")}</div>
    </div>
    <h2 class="section-title">O que fazer</h2>
    ${nothing ? `<div class="card"><p class="muted" style="margin:0">Informe um aporte, marque vendas ou ligue o rebalanceamento completo para ver as ações sugeridas.</p></div>` : ""}
    <div class="actions">${res.categories
      .filter((c) => !nothing || c.status === "acima")
      .sort((a, b) => b.buy + b.sell - (a.buy + a.sell))
      .map((c) => {
        const st = STATUS[c.status]!;
        return `<div class="card action ${st.cls}">
          <div class="row-between"><div class="t"><span class="sw" style="background:${colorOf(c.name)}"></span>${esc(c.name)}</div><span class="badge ${st.cls}">${st.label(c)}</span></div>
          <p class="muted small" style="margin:6px 0 0">Meta ${money(c.targetValue)} · hoje ${money(c.current)}${c.status === "acima" ? ` · ${money(c.excess)} acima` : ""}</p>
          ${c.needsAssets ? `<p class="warn small">Nenhum ativo nesta categoria ainda. Escolha onde investir em “Ativos”.</p>` : ""}
          ${c.assets.length ? assetList(c.assets) : ""}
          ${c.target > 0 && c.status !== "acima" ? `<button class="link small plan-btn" data-plan="${esc(c.name)}">Ativos: ${planLabel(params!.assetPlans[c.name])} ›</button>` : ""}
        </div>`;
      })
      .join("")}</div>`;
  el.querySelectorAll<HTMLButtonElement>("[data-plan]").forEach((b) => b.addEventListener("click", () => planModal(r, b.dataset.plan!)));
}

const assetRow = (a: SimResult["categories"][number]["assets"][number]) =>
  `<div class="aa"><span><b>${esc(a.ticker)}</b>${a.isNew ? ` <span class="badge new">novo</span>` : ""}</span>
   <span class="muted small">${a.price ? `${qtyLabel(a.quantity, a.whole)} × ${money(a.price)}` : "sem cotação"}</span>
   <span class="${a.sell > 0 ? "down" : "up"}">${a.sell > 0 ? `− ${money(a.sell)}` : `+ ${money(a.buy)}`}</span></div>`;

/** Mostra os 6 maiores movimentos; o resto fica num "ver mais". */
function assetList(assets: SimResult["categories"][number]["assets"]) {
  const top = assets.slice(0, 6).map(assetRow).join("");
  const rest = assets.slice(6);
  return `<div class="asset-actions">${top}${rest.length ? `<details class="more"><summary>ver mais ${rest.length} ativo${rest.length > 1 ? "s" : ""}</summary>${rest.map(assetRow).join("")}</details>` : ""}</div>`;
}

/** Desvio total em relação às metas (metade da soma das diferenças absolutas). */
function distance(res: SimResult, before = false) {
  const t = before ? res.totalBefore : res.totalAfter;
  return res.categories.reduce((s, c) => s + Math.abs((before ? c.current : c.final) / (t || 1) - c.target), 0) / 2;
}

const planLabel = (p?: AssetPlan) => (!p || p.mode === "proportional" ? "proporcional à posição" : p.mode === "equal" ? "partes iguais" : "pesos personalizados");

// ---------- Plano por ativo ----------

function planModal(r: Report, category: string) {
  const p = params!;
  const plan: AssetPlan = structuredClone(p.assetPlans[category] ?? { mode: "proportional" });
  // Ativos com venda total planejada não recebem aporte.
  const soldAll = new Set(p.sales.filter((s) => s.mode === "all").map((s) => s.ticker));
  const own = (r.categories.find((c) => c.name === category)?.positions ?? []).filter((x) => !soldAll.has(x.ticker));
  const m = openModal(`Ativos de ${category}`, `<div id="plan-body"></div>`, { wide: true });
  const body = m.el.querySelector("#plan-body") as HTMLElement;

  const draw = () => {
    const members = [...own.map((x) => ({ ticker: x.ticker, value: x.value, isNew: false })), ...(plan.extra ?? []).map((t) => ({ ticker: t, value: 0, isNew: true }))];
    const sum = members.reduce((s, x) => s + (plan.weights?.[x.ticker] ?? 0), 0);
    body.innerHTML = `
      <p class="muted" style="margin-top:0">Como dividir o dinheiro desta categoria entre os ativos. O simulador prioriza os ativos mais abaixo do peso desejado.</p>
      <div class="toggle" style="margin-bottom:14px">${(["proportional", "equal", "custom"] as const)
        .map((mo) => `<button data-pmode="${mo}" aria-pressed="${plan.mode === mo}">${{ proportional: "Proporcional à posição", equal: "Partes iguais", custom: "Personalizado" }[mo]}</button>`)
        .join("")}</div>
      <div class="plan-list">${members
        .map(
          (x) => `<div class="plan-row"><span><b>${esc(x.ticker)}</b>${x.isNew ? ` <span class="badge new">novo${prices[x.ticker] ? ` · ${money(prices[x.ticker]!)}` : ""}</span>` : ` <span class="muted small">${money(x.value)}</span>`}</span>
          ${plan.mode === "custom" ? `<span class="pct-input"><input inputmode="decimal" data-w="${esc(x.ticker)}" value="${(plan.weights?.[x.ticker] ?? 0).toLocaleString("pt-BR")}"/><b>%</b></span>` : "<span></span>"}
          ${x.isNew ? `<button class="icon small-x" data-rm="${esc(x.ticker)}" aria-label="Remover">✕</button>` : "<span></span>"}</div>`,
        )
        .join("")}</div>
      ${plan.mode === "custom" ? `<p class="small ${Math.abs(sum - 100) < 0.05 ? "up" : "warn"}">Total ${sum.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% (os pesos são normalizados se não somarem 100%). Ativos com 0% não recebem aporte.</p>` : ""}
      <div class="row-between" style="margin-top:14px;gap:8px">
        <span class="add-ticker"><input id="plan-new" placeholder="Novo ativo (ex.: HGLG11)" autocapitalize="characters"/><button class="ghost" id="plan-add">Adicionar</button></span>
        <button class="primary" id="plan-ok">Aplicar</button></div>
      <p class="error small" id="plan-err" hidden></p>`;
    body.querySelectorAll<HTMLButtonElement>("[data-pmode]").forEach((b) =>
      b.addEventListener("click", () => {
        plan.mode = b.dataset.pmode as AssetPlan["mode"];
        if (plan.mode === "custom" && !plan.weights) {
          const tot = own.reduce((s, x) => s + x.value, 0);
          plan.weights = Object.fromEntries(own.map((x) => [x.ticker, Math.round((tot ? x.value / tot : 0) * 1000) / 10]));
        }
        draw();
      }),
    );
    body.querySelectorAll<HTMLInputElement>("[data-w]").forEach((inp) =>
      inp.addEventListener("change", () => {
        plan.weights = { ...(plan.weights ?? {}), [inp.dataset.w!]: Math.max(0, parseNum(inp.value) ?? 0) };
        draw();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => {
        plan.extra = (plan.extra ?? []).filter((t) => t !== b.dataset.rm);
        draw();
      }),
    );
    body.querySelector("#plan-add")!.addEventListener("click", async () => {
      const inp = body.querySelector("#plan-new") as HTMLInputElement;
      const t = inp.value.trim().toUpperCase();
      const err = body.querySelector("#plan-err") as HTMLElement;
      if (!/^[A-Z0-9.^-]{2,15}$/.test(t)) return inp.focus();
      if (own.some((x) => x.ticker === t) || plan.extra?.includes(t)) return draw();
      const price = await fetchPrice(t);
      if (!price) {
        err.hidden = false;
        err.textContent = `Não encontrei cotação para ${t}. Confira o código.`;
        return;
      }
      plan.extra = [...(plan.extra ?? []), t];
      if (plan.mode !== "custom") {
        plan.mode = "custom";
        const tot = own.reduce((s, x) => s + x.value, 0);
        plan.weights = Object.fromEntries(own.map((x) => [x.ticker, Math.round((tot ? x.value / tot : 0) * 1000) / 10]));
      }
      plan.weights = { ...(plan.weights ?? {}), [t]: plan.weights?.[t] ?? 0 };
      draw();
      (body.querySelector(`[data-w="${t}"]`) as HTMLInputElement | null)?.focus();
    });
    body.querySelector("#plan-ok")!.addEventListener("click", () => {
      p.assetPlans[category] = plan;
      scheduleSave();
      m.close();
      document.getElementById("sim-contribution")!.dispatchEvent(new Event("input"));
    });
  };
  draw();
}
