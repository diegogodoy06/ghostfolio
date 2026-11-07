// Aba Finanças: contas, cartões (fatura no padrão brasileiro), gastos, previstos e importação de
// extratos, tudo guardado no Firefly III e somado aos investimentos do Ghostfolio.
import { Chart } from "chart.js";
import type { Report } from "../shared";
import { type Account, type MonthTotals, type Occurrence, type Tx, api, clearListCaches, day, empty, monthName, shift, sum, thisMonth, todayIso } from "./fin-common";
import { openCardConfig, openLancar } from "./fin-forms";
import { type ViewCtx, bindTxRows, flowChart, txRows, viewCartoes, viewCategorias, viewLancamentos, viewPrevistos } from "./fin-views";
import { MONTHS, PALETTE, dateBR, esc, money, openModal, toast } from "./ui";

interface Cycle {
  start: string;
  end: string;
  due: string;
  total: number;
}
interface Card extends Account {
  config: { closing: number; due: number; limit?: number } | null;
  open: Cycle | null;
  closed: Cycle | null;
  future: { month: string; value: number }[];
}
interface Overview {
  month: string;
  publicUrl: string;
  accounts: Account[];
  cards: Card[];
  income: number;
  expense: number;
  categories: { name: string; value: number }[];
  history: { month: string; income: number; expense: number }[];
  planned: Occurrence[];
  budget: Record<string, number>;
  recent: Tx[];
}

type View = "mes" | "lancamentos" | "cartoes" | "categorias" | "previstos";
const VIEWS: [View, string][] = [
  ["mes", "Mês"],
  ["lancamentos", "Lançamentos"],
  ["cartoes", "Cartões"],
  ["categorias", "Categorias"],
  ["previstos", "Previstos"],
];
const KEY = "rel.finMonth";
const VKEY = "rel.finView";
let month = thisMonth();
let view: View = "mes";
const PAYMENT = /pagamento|pagto|pgto|pag\.? ?fatura|fatura paga|cr[eé]dito de pagamento/i;
const CARD_PAYMENT = /fatura|cart[aã]o|cartao|cobranca|cobrança/i;

let rerender: () => void = () => {};
const store = (k: string, v: string) => {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* sem armazenamento */
  }
};

export async function renderFinancas(r: Report, main: HTMLElement, charts: Chart[]) {
  rerender = () => {
    clearFinCache();
    charts.splice(0).forEach((c) => c.destroy());
    void renderFinancas(r, main, charts);
  };
  const st = (await fetch("/api/fin").then((x) => (x.ok ? x.json() : null))) as { connected: boolean; publicUrl: string } | null;
  if (!main.isConnected) return;
  if (!st?.connected) return renderConnect(main, st?.publicUrl ?? "");
  const ff = st.publicUrl;
  const monthly = view === "mes" || view === "lancamentos" || view === "categorias";

  main.innerHTML = `
    <section class="mode-bar fin-bar">
      <div class="chips fin-views" role="tablist">${VIEWS.map(([v, l]) => `<button class="chip" role="tab" data-view="${v}" aria-pressed="${v === view}">${l}</button>`).join("")}</div>
      <div class="fin-actions">
        ${ff ? `<a class="ghost-link" href="${esc(ff)}" target="_blank" rel="noopener" title="Abrir o Firefly"><span class="ico" style="--icon: url(icons/open-outline.svg)"></span><span>Firefly</span></a>` : ""}
        <button class="icon" id="fin-settings" title="Conexão com o Firefly" aria-label="Configurações"><span class="ico" style="--icon: url(icons/settings-outline.svg)"></span></button>
        <button class="ghost" id="fin-import"><span class="ico" style="--icon: url(icons/cloud-upload-outline.svg)"></span> Importar</button>
        <button class="primary" id="fin-add">+ Lançar</button>
      </div>
    </section>
    ${
      monthly
        ? `<div class="month-nav fin-month" role="group" aria-label="Mês">
        <button class="icon" data-m="-1" aria-label="Mês anterior">‹</button><b>${monthName(month)}</b>
        <button class="icon" data-m="1" aria-label="Próximo mês" ${month >= shift(thisMonth(), 1) ? "disabled" : ""}>›</button>
        ${month !== thisMonth() ? `<button class="link small" data-m="0">voltar para hoje</button>` : ""}</div>`
        : ""
    }
    <div id="fin-body"><section class="card"><div class="skeleton line short"></div><div class="skeleton chart"></div></section></div>`;

  main.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      view = b.dataset.view as View;
      store(VKEY, view);
      rerender();
    }),
  );
  main.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((b) =>
    b.addEventListener("click", () => {
      month = b.dataset.m === "0" ? thisMonth() : shift(month, Number(b.dataset.m));
      store(KEY, month);
      rerender();
    }),
  );
  main.querySelector("#fin-add")!.addEventListener("click", () => void openLancar(rerender));
  main.querySelector("#fin-settings")!.addEventListener("click", () => openSettings(ff));
  main.querySelector("#fin-import")!.addEventListener("click", async () => openImport(await api<Account[]>("/api/fin/accounts")));

  const body = main.querySelector<HTMLElement>("#fin-body")!;
  const ctx: ViewCtx = { month, charts, refresh: rerender };
  if (view === "lancamentos") return viewLancamentos(body, ctx);
  if (view === "cartoes") return viewCartoes(body, ctx);
  if (view === "categorias") return viewCategorias(body, ctx);
  if (view === "previstos") return viewPrevistos(body, ctx);
  return viewMes(r, body, ctx, main);
}

// ---------- mês ----------

async function viewMes(r: Report, body: HTMLElement, ctx: ViewCtx, main: HTMLElement) {
  const res = await fetch(`/api/fin/overview?month=${month}`);
  if (!body.isConnected) return;
  if (res.status === 409) return renderConnect(main, "", ((await res.json()) as { error?: string }).error);
  if (!res.ok) {
    body.innerHTML = `<div class="card"><p class="error">Não foi possível ler o Firefly III: ${esc(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)}</p></div>`;
    return;
  }
  const o = (await res.json()) as Overview;
  const hist = await api<MonthTotals[]>(`/api/fin/months?from=${shift(month, -11)}&to=${month}`).catch(() => null);
  if (!body.isConnected) return;
  const cash = o.accounts.filter((a) => a.netWorth !== false).reduce((s, a) => s + a.balance, 0);
  const cardDebt = o.cards.reduce((s, c) => s + Math.min(0, c.balance), 0);
  const invest = r.summary.value;
  const net = invest + cash + cardDebt;
  const result = o.income - o.expense;
  const bills = upcomingBills(o);
  const isCur = month === thisMonth();
  const pend = o.planned.filter((p) => !p.matched);
  const pendIn = sum(pend.filter((p) => p.kind === "income").map((p) => p.amount));
  const pendOut = sum(pend.filter((p) => p.kind === "expense" && !o.cards.some((c) => c.id === p.accountId)).map((p) => p.amount));
  const own = new Set([...o.accounts, ...o.cards].map((a) => a.id));

  body.innerHTML = `
    <section class="kpis">
      <div class="card kpi"><div class="label">Patrimônio total</div><div class="value">${money(net)}</div><div class="sub">investimentos ${money(invest)} + contas − cartões</div></div>
      <div class="card kpi"><div class="label">Em contas</div><div class="value">${money(cash)}</div><div class="sub">${o.accounts.filter((a) => a.netWorth !== false).length} contas</div></div>
      <div class="card kpi"><div class="label">Faturas a pagar</div><div class="value ${bills.length ? "down" : ""}">${money(bills.reduce((s, b) => s + b.total, 0))}</div><div class="sub">${bills[0] ? `${esc(bills[0].name)} vence ${day(bills[0].due)}` : "nada em aberto"}</div></div>
      <div class="card kpi"><div class="label">Sobra do mês</div><div class="value ${result >= 0 ? "up" : "down"}">${money(result)}</div><div class="sub">${isCur && (pendIn || pendOut) ? `prevista ${money(result + pendIn - pendOut)} no fim do mês` : `entrou ${money(o.income)} · saiu ${money(o.expense)}`}</div></div>
    </section>
    <section class="split">
      <div class="card">${plannedBlock(o)}</div>
      <div class="card">${budgetBlock(o)}</div>
    </section>
    <section class="split">
      <div class="card"><div class="row-between"><h2>Cartões</h2><button class="link" data-goto="cartoes">Ver faturas</button></div>${o.cards.length ? o.cards.map(cardBlock).join("") : empty("Nenhum cartão. No Firefly, crie uma conta de ativo com a função <b>Cartão de crédito</b>.")}</div>
      <div class="card"><h2>Contas</h2>
        <div class="legend">${o.accounts.map((a) => `<div class="li fin-acc ${a.netWorth === false ? "muted" : ""}"><span class="ico" style="--icon: url(icons/wallet-outline.svg)"></span><span>${esc(a.name)}${a.netWorth === false ? ` <span class="small">(fora do patrimônio)</span>` : ""}</span><span></span><span class="num ${a.balance < 0 ? "down" : ""}">${money(a.balance)}</span></div>`).join("") || empty("Nenhuma conta ainda.")}</div>
        <div class="fin-total"><span>Total em contas</span><b>${money(cash)}</b></div>
      </div>
    </section>
    <section class="split">
      <div class="card"><div class="row-between"><h2>Gastos por categoria</h2><button class="link" data-goto="categorias">Detalhar</button></div>${categoryBars(o)}</div>
      <div class="card"><h2>Entradas × saídas</h2><div class="chart-box tall"><canvas id="fin-hist"></canvas></div></div>
    </section>
    <section class="card"><div class="row-between"><h2>Lançamentos de ${monthName(month).toLowerCase()}</h2><button class="link" data-goto="lancamentos">Ver todos e filtrar</button></div><div id="fin-recent">${txRows(o.recent.slice(0, 15), own)}</div></section>`;

  bindTxRows(body.querySelector<HTMLElement>("#fin-recent")!, o.recent.slice(0, 15), rerender);
  body.querySelectorAll<HTMLButtonElement>("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => {
      view = b.dataset.goto as View;
      store(VKEY, view);
      rerender();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-card]").forEach((b) => b.addEventListener("click", () => openCardConfig(o.cards.find((c) => c.id === b.dataset.card)!, rerender)));
  body.querySelectorAll<HTMLButtonElement>("[data-pay]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = o.planned[Number(b.dataset.pay)]!;
      void openLancar(rerender, { kind: p.kind, accountId: p.accountId ?? undefined });
    }),
  );
  const ctxEl = body.querySelector<HTMLCanvasElement>("#fin-hist");
  if (ctxEl) ctx.charts.push(flowChart(ctxEl, hist ?? o.history));
}

function plannedBlock(o: Overview) {
  const list = o.planned;
  const head = `<div class="row-between"><h2>Previstos do mês</h2><button class="link" data-goto="previstos">Gerenciar</button></div>`;
  if (!list.length) return `${head}${empty("Cadastre contas fixas, assinaturas e entradas (salário, aluguel, Spotify…) em <b>Previstos</b> para acompanhar aqui o que já caiu e o que falta.")}`;
  const today = todayIso();
  const done = list.filter((p) => p.matched).length;
  const left = (k: Occurrence["kind"]) => sum(list.filter((p) => p.kind === k && !p.matched).map((p) => p.amount));
  return `${head}
    <p class="muted small" style="margin:0 0 8px"><b>${done}</b> de ${list.length} já caíram · faltam entrar <b class="up">${money(left("income"))}</b> e sair <b>${money(left("expense"))}</b></p>
    <div class="fin-planned">${list
      .map((p, i) => {
        const late = !p.matched && p.date < today && o.month <= thisMonth();
        return `<div class="fin-pl ${p.matched ? "ok" : late ? "late" : ""}">
          <span class="mark">${p.matched ? "✓" : late ? "!" : ""}</span>
          <span class="t"><b>${esc(p.description)}</b><span class="muted small">${p.matched ? `caiu ${day(p.matched.date)}${p.matched.count > 1 ? ` (${p.matched.count} lançamentos)` : ""}` : `${late ? "atrasado · " : ""}dia ${day(p.date)}`}</span></span>
          <span class="v ${p.kind === "income" ? "up" : ""}">${p.kind === "income" ? "+" : "−"}${money(p.matched?.amount ?? p.amount)}</span>
          ${p.matched ? "" : `<button class="icon small" data-pay="${i}" title="Lançar agora" aria-label="Lançar ${esc(p.description)}">+</button>`}
        </div>`;
      })
      .join("")}</div>`;
}

function budgetBlock(o: Overview) {
  const head = `<div class="row-between"><h2>Planejado × gasto</h2><button class="link" data-goto="categorias">Metas</button></div>`;
  const cats = new Map(o.categories.map((c) => [c.name, c.value]));
  const items = Object.entries(o.budget)
    .filter(([c]) => cats.has(c) || !/sal[aá]rio|fam[ií]lia|aux[ií]lio|pix recebidos|rendimentos/i.test(c))
    .map(([c, meta]) => ({ c, meta, v: cats.get(c) ?? 0 }))
    .sort((a, b) => b.v / b.meta - a.v / a.meta);
  if (!items.length) return `${head}${empty("Defina metas mensais por categoria em <b>Categorias</b> para comparar o planejado com o gasto, como na sua planilha.")}`;
  const meta = sum(items.map((x) => x.meta));
  const spent = sum(items.map((x) => Math.max(0, x.v)));
  const pct = Math.min(100, (spent / meta) * 100);
  return `${head}
    <div class="fin-gauge"><div class="ring" style="--p:${pct}"><b>${Math.round((spent / meta) * 100)}%</b></div>
      <div><span class="muted small">Gastou</span><b class="${spent > meta ? "down" : ""}">${money(spent)}</b><span class="muted small">de ${money(meta)} planejados nas categorias com meta</span></div></div>
    <div class="fin-cats">${items
      .slice(0, 6)
      .map(
        ({ c, meta: m, v }) => `<div class="fin-cat"><div class="row-between"><span>${esc(c)}</span><span class="num ${v > m ? "down" : ""}">${money(v)} <span class="muted">/ ${money(m)}</span></span></div>
        <div class="track"><div class="fill ${v > m ? "over" : ""}" style="width:${Math.min(100, (v / m) * 100)}%"></div></div></div>`,
      )
      .join("")}</div>`;
}

function cardBlock(c: Card) {
  const cfgBtn = `<button class="link small" data-card="${esc(c.id)}">${c.config ? "Fechamento, vencimento e limite" : "Informar fechamento e vencimento"}</button>`;
  if (!c.config || !c.open || !c.closed)
    return `<div class="fin-card"><div class="fin-card-head"><span class="ico" style="--icon: url(icons/card-outline.svg)"></span><b>${esc(c.name)}</b><span class="num">${money(-c.balance)}</span></div>
      <p class="muted small">Saldo devedor no Firefly. Informe os dias de fechamento e de vencimento para ver a fatura aberta e as parcelas futuras.</p>${cfgBtn}</div>`;
  const future = c.future.slice(0, 6);
  const futureTotal = c.future.reduce((s, f) => s + f.value, 0);
  const limit = c.config.limit;
  const debt = Math.max(0, -c.balance);
  return `<div class="fin-card">
    <div class="fin-card-head"><span class="ico" style="--icon: url(icons/card-outline.svg)"></span><b>${esc(c.name)}</b><span class="badge">fecha ${day(c.open.end)}</span></div>
    <div class="fin-inv">
      <div><span class="muted small">Fatura aberta</span><b>${money(c.open.total)}</b><span class="muted small">vence ${day(c.open.due)}</span></div>
      <div><span class="muted small">Última fechada</span><b>${money(c.closed.total)}</b><span class="muted small">${c.closed.due < todayIso() ? "venceu" : "vence"} ${day(c.closed.due)}</span></div>
    </div>
    ${limit ? `<div class="fin-limit"><div class="row-between small"><span class="muted">limite usado</span><span>${money(debt)} / ${money(limit)}</span></div><div class="track"><div class="fill" style="width:${Math.min(100, (debt / limit) * 100)}%"></div></div></div>` : ""}
    ${
      future.length
        ? `<div class="fin-future"><span class="muted small">Parcelas já compradas, por fatura · ${money(futureTotal)}</span><div>${future.map((f) => `<span class="chip-static">${MONTHS[Number(f.month.slice(5)) - 1]}/${f.month.slice(2, 4)} <b>${money(f.value)}</b></span>`).join("")}</div></div>`
        : ""
    }
    ${cfgBtn}</div>`;
}

function categoryBars(o: Overview) {
  if (!o.categories.length) return empty(`Nenhum gasto em ${monthName(o.month).toLowerCase()}.`);
  const max = o.categories[0]!.value;
  const top = o.categories.slice(0, 9);
  const rest = o.categories.slice(9).reduce((s, c) => s + c.value, 0);
  const rows = rest ? [...top, { name: "Outras", value: rest }] : top;
  return `<div class="fin-cats">${rows
    .map(
      (c, i) => `<div class="fin-cat"><div class="row-between"><span>${esc(c.name)}</span><span class="num">${money(c.value)} <span class="muted">${Math.round((c.value / o.expense) * 100)}%</span></span></div>
        <div class="track"><div class="fill" style="width:${(c.value / max) * 100}%;background:${PALETTE[i % PALETTE.length]}"></div></div></div>`,
    )
    .join("")}</div>`;
}

// ---------- conexão ----------

function renderConnect(main: HTMLElement, publicUrl: string, error?: string) {
  const profile = publicUrl ? `<a href="${esc(publicUrl)}/profile" target="_blank" rel="noopener">Firefly → Opções → Perfil</a>` : "Firefly → Opções → Perfil";
  main.innerHTML = `<div class="card fin-connect">
    <h2>Conectar o Firefly III</h2>
    <p class="muted">As contas, os cartões e os gastos ficam no Firefly III; esta aba mostra tudo junto dos investimentos e importa os extratos dos bancos.</p>
    <ol class="muted">
      <li>Abra ${profile} e vá na guia <b>OAuth</b>.</li>
      <li>Em <b>Personal Access Tokens</b>, clique em <b>Create new token</b>, dê um nome (ex.: “relatórios”) e copie o token.</li>
      <li>Cole aqui. Ele fica guardado cifrado no servidor e só serve para a sua conta.</li>
    </ol>
    <form id="fin-connect" class="fin-connect-form">
      <input name="token" type="password" autocomplete="off" placeholder="Token de acesso pessoal do Firefly" required />
      <button class="primary" type="submit">Conectar</button>
    </form>
    <p class="error small" ${error ? "" : "hidden"}>${esc(error ?? "")}</p></div>`;
  const form = main.querySelector<HTMLFormElement>("#fin-connect")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button")!;
    btn.disabled = true;
    const token = (form.elements.namedItem("token") as HTMLInputElement).value.trim();
    const res = await fetch("/api/fin/token", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    btn.disabled = false;
    if (res.ok) {
      toast("Firefly III conectado");
      return rerender();
    }
    const err = main.querySelector<HTMLElement>(".error")!;
    err.hidden = false;
    err.textContent = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Não foi possível conectar.";
  });
}

function openSettings(publicUrl: string) {
  const m = openModal(
    "Firefly III",
    `<p class="muted" style="margin-top:0">Conectado com um token de acesso pessoal. Para trocar, desconecte e cole um novo.${publicUrl ? ` Endereço: <a href="${esc(publicUrl)}" target="_blank" rel="noopener">${esc(publicUrl.replace(/^https?:\/\//, ""))}</a>.` : ""}</p>
     <div class="modal-actions"><button class="ghost danger" id="fin-off">Desconectar</button><button class="primary" id="fin-ok">Fechar</button></div>`,
  );
  m.el.querySelector("#fin-ok")!.addEventListener("click", m.close);
  m.el.querySelector("#fin-off")!.addEventListener("click", async () => {
    if (!confirm("Desconectar o Firefly III? Os dados continuam lá; só esta aba deixa de mostrar.")) return;
    await fetch("/api/fin/token", { method: "DELETE" });
    m.close();
    rerender();
  });
}


// ---------- importação ----------

interface Parsed {
  format: "ofx" | "csv";
  kind: "bank" | "card" | "unknown";
  accountKey: string | null;
  bank: string | null;
  rows: { date: string; amount: number; description: string; uid: string }[];
  suggestInvert: boolean;
  suggested: string | null;
}
const BANKS: Record<string, string> = { "0237": "Bradesco", "237": "Bradesco", "102": "XP", "0102": "XP", "348": "XP", "0348": "XP", "323": "Mercado Pago", "0323": "Mercado Pago" };

function openImport(accounts: Account[]) {
  const m = openModal(
    "Importar extrato ou fatura",
    `<p class="muted" style="margin-top:0">Arquivo <b>OFX</b> (o “Money” ou “Quicken” do app do banco) ou <b>CSV</b>. Lançamentos repetidos são ignorados, então pode importar o mesmo período de novo sem medo.</p>
     <label class="dropzone" tabindex="0"><input type="file" accept=".ofx,.csv,.txt,.qfx,application/x-ofx,text/csv" hidden/>
       <span class="ico" style="--icon: url(icons/cloud-upload-outline.svg)"></span><b>Escolher arquivo</b><span class="muted small">ou arraste para cá</span></label>
     <p class="error small" id="im-err" hidden></p>
     <div id="im-preview"></div>`,
    { wide: true },
  );
  const input = m.el.querySelector<HTMLInputElement>("input[type=file]")!;
  const zone = m.el.querySelector<HTMLElement>(".dropzone")!;
  const err = m.el.querySelector<HTMLElement>("#im-err")!;
  const box = m.el.querySelector<HTMLElement>("#im-preview")!;
  const fail = (msg: string) => {
    err.hidden = false;
    err.textContent = msg;
  };

  const load = async (file: File) => {
    err.hidden = true;
    box.innerHTML = "";
    zone.classList.add("busy");
    const res = await fetch(`/api/fin/parse?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    zone.classList.remove("busy");
    input.value = "";
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail((data as { error?: string }).error ?? "Não foi possível ler o arquivo.");
    zone.hidden = true;
    preview(file.name, data as Parsed);
  };

  const preview = (name: string, p: Parsed) => {
    const cards = accounts.filter((a) => a.card);
    const bankName = p.bank ? BANKS[p.bank] : null;
    const guess =
      p.suggested ??
      (bankName ? accounts.find((a) => a.card === (p.kind === "card") && a.name.toLowerCase().includes(bankName.toLowerCase()))?.id : null) ??
      (p.kind === "card" ? cards[0]?.id : accounts.find((a) => !a.card)?.id) ??
      "";
    const state = { account: guess, invert: p.suggestInvert, exists: [] as boolean[], include: [] as boolean[], transfer: [] as string[] };
    const dates = p.rows.map((r) => r.date).sort();

    box.innerHTML = `
      <div class="im-head">
        <div><b>${esc(name)}</b><span class="muted small">${p.rows.length} lançamentos · ${dateBR(dates[0]!)} a ${dateBR(dates.at(-1)!)} · ${p.format.toUpperCase()}${bankName ? ` · ${bankName}` : ""}</span></div>
        <button class="link small" id="im-other">Outro arquivo</button>
      </div>
      <div class="im-opts">
        <label class="field">Importar na conta<select id="im-acc">${accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === guess ? "selected" : ""}>${esc(a.name)}${a.card ? " (cartão)" : ""}</option>`).join("")}</select></label>
        <label class="switch"><input type="checkbox" id="im-inv" ${state.invert ? "checked" : ""}/><span></span>Compras vêm com valor positivo (inverter sinais)</label>
      </div>
      <div class="im-sum" id="im-sum"></div>
      <div class="im-rows" id="im-rows"></div>
      <div class="modal-actions"><button class="primary" id="im-go">Importar</button></div>`;

    const accSel = box.querySelector<HTMLSelectElement>("#im-acc")!;
    const inv = box.querySelector<HTMLInputElement>("#im-inv")!;
    const rowsBox = box.querySelector<HTMLElement>("#im-rows")!;
    const sum = box.querySelector<HTMLElement>("#im-sum")!;
    const go = box.querySelector<HTMLButtonElement>("#im-go")!;
    box.querySelector("#im-other")!.addEventListener("click", () => {
      box.innerHTML = "";
      zone.hidden = false;
    });

    const signed = () => p.rows.map((r) => ({ ...r, amount: state.invert ? -r.amount : r.amount }));
    const isCard = () => accounts.find((a) => a.id === state.account)?.card ?? false;

    const draw = () => {
      const rows = signed();
      const card = isCard();
      let n = 0;
      let out = 0;
      let inn = 0;
      rowsBox.innerHTML = rows
        .map((r, i) => {
          const payment = card && r.amount > 0 && PAYMENT.test(r.description);
          const label = state.exists[i] ? `<span class="badge">já existe</span>` : payment ? `<span class="badge over">pagamento da fatura</span>` : "";
          if (state.include[i]) {
            n++;
            r.amount < 0 ? (out += -r.amount) : (inn += r.amount);
          }
          const transfer =
            !card && r.amount < 0 && CARD_PAYMENT.test(r.description) && cards.length
              ? `<select class="im-tr" data-i="${i}" aria-label="Pagamento de cartão"><option value="">despesa</option>${cards.map((c) => `<option value="${esc(c.id)}" ${state.transfer[i] === c.id ? "selected" : ""}>pagou a fatura do ${esc(c.name)}</option>`).join("")}</select>`
              : "";
          return `<label class="im-row ${state.include[i] ? "" : "off"}"><input type="checkbox" data-i="${i}" ${state.include[i] ? "checked" : ""}/>
            <span class="d">${day(r.date)}</span><span class="t">${esc(r.description)} ${label}${transfer}</span>
            <span class="v ${r.amount > 0 ? "up" : ""}">${r.amount > 0 ? "+" : "−"}${money(Math.abs(r.amount))}</span></label>`;
        })
        .join("");
      sum.innerHTML = `<span><b>${n}</b> para importar</span><span>saídas <b>${money(out)}</b></span><span>entradas <b>${money(inn)}</b></span>`;
      go.disabled = !n || !state.account;
      go.textContent = n ? `Importar ${n} lançamento${n > 1 ? "s" : ""}` : "Nada para importar";
      rowsBox.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((c) =>
        c.addEventListener("change", () => {
          state.include[Number(c.dataset.i)] = c.checked;
          draw();
        }),
      );
      rowsBox.querySelectorAll<HTMLSelectElement>(".im-tr").forEach((s) => {
        s.addEventListener("click", (e) => e.preventDefault());
        s.addEventListener("change", () => (state.transfer[Number(s.dataset.i)] = s.value));
      });
    };

    // Ao trocar conta ou sinal: marca o que já existe e desmarca pagamentos de fatura no cartão.
    const check = async () => {
      rowsBox.innerHTML = `<p class="muted small">Conferindo o que já está no Firefly…</p>`;
      const rows = signed();
      const res = await fetch("/api/fin/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: state.account, rows }) });
      state.exists = res.ok ? ((await res.json()) as boolean[]) : rows.map(() => false);
      const card = isCard();
      state.include = rows.map((r, i) => !state.exists[i] && !(card && r.amount > 0 && PAYMENT.test(r.description)));
      state.transfer = rows.map(() => "");
      draw();
    };
    accSel.addEventListener("change", () => {
      state.account = accSel.value;
      void check();
    });
    inv.addEventListener("change", () => {
      state.invert = inv.checked;
      void check();
    });
    go.addEventListener("click", async () => {
      const rows = signed()
        .map((r, i) => ({ ...r, transferTo: state.transfer[i] || undefined }))
        .filter((_, i) => state.include[i]);
      go.disabled = true;
      go.textContent = "Importando…";
      const res = await fetch("/api/fin/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: state.account, accountKey: p.accountKey, rows }) });
      const out = (await res.json().catch(() => ({}))) as { created?: number; duplicates?: number; errors?: string[]; error?: string };
      if (!res.ok) {
        go.disabled = false;
        go.textContent = "Tentar de novo";
        return fail(out.error ?? "Falha ao importar.");
      }
      const msg = `${out.created} importado${out.created === 1 ? "" : "s"}${out.duplicates ? `, ${out.duplicates} já existia${out.duplicates === 1 ? "" : "m"}` : ""}`;
      if (out.errors?.length) fail(`${msg}. Erros: ${out.errors.join(" · ")}`);
      else {
        toast(msg);
        m.close();
      }
      rerender();
    });
    void check();
  };

  input.addEventListener("change", () => input.files?.[0] && void load(input.files[0]));
  zone.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click()));
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) void load(f);
  });
}

try {
  const m = sessionStorage.getItem(KEY);
  if (m && /^\d{4}-\d{2}$/.test(m)) month = m;
  const v = sessionStorage.getItem(VKEY);
  if (v && VIEWS.some(([x]) => x === v)) view = v as View;
} catch {
  /* sem armazenamento */
}

// ---------- Resumo (hub): visão do mês, com cache para as trocas de filtro não piscarem ----------

let ovCache: { month: string; at: number; data: Overview | null; pending?: Promise<Overview | null> } | null = null;
/** Último resultado conhecido (síncrono): `undefined` = ainda não buscou; `null` = Firefly não conectado. */
export const cachedOverview = (): Overview | null | undefined => (ovCache && ovCache.month === thisMonth() && !ovCache.pending ? ovCache.data : undefined);
export function clearFinCache() {
  ovCache = null;
}
export function getOverview(): Promise<Overview | null> {
  const m = thisMonth();
  if (ovCache && ovCache.month === m && Date.now() - ovCache.at < 5 * 60_000) return ovCache.pending ?? Promise.resolve(ovCache.data);
  const pending = fetch(`/api/fin/overview?month=${m}`)
    .then((r) => (r.ok ? (r.json() as Promise<Overview>) : null))
    .catch(() => null)
    .then((data) => {
      ovCache = { month: m, at: Date.now(), data };
      return data;
    });
  ovCache = { month: m, at: Date.now(), data: null, pending };
  return pending;
}

/** Faturas a pagar: a fechada ainda não vencida, ou a aberta. */
export function upcomingBills(o: Overview) {
  const today = todayIso();
  return o.cards
    .filter((c) => c.open && c.closed)
    .map((c) => (c.closed!.due >= today && c.closed!.total > 0 ? { name: c.name, due: c.closed!.due, total: c.closed!.total, closed: true } : { name: c.name, due: c.open!.due, total: c.open!.total, closed: false }))
    .filter((b) => b.total > 0)
    .sort((a, b) => a.due.localeCompare(b.due));
}

export function hubNumbers(o: Overview, invest: number) {
  const cash = o.accounts.reduce((s, a) => s + a.balance, 0);
  const cardDebt = o.cards.reduce((s, c) => s + Math.min(0, c.balance), 0);
  const bills = upcomingBills(o);
  return { cash, net: invest + cash + cardDebt, result: o.income - o.expense, bills, billsTotal: bills.reduce((s, b) => s + b.total, 0) };
}

/** Card "Este mês" do Resumo: sobra, maiores gastos e próximos vencimentos. */
export async function mountFinSummary(el: HTMLElement, open: () => void) {
  const o = cachedOverview() ?? (await getOverview());
  if (!el.isConnected) return;
  if (!o) {
    el.innerHTML = `<div class="card hub-card hub-empty"><h2>Este mês</h2><p class="muted">Conecte o Firefly III para ver aqui o que entrou, o que saiu, os gastos por categoria e as faturas dos cartões.</p><button class="ghost" id="fin-open">Conectar finanças ›</button></div>`;
  } else {
    const result = o.income - o.expense;
    const bills = upcomingBills(o).slice(0, 3);
    const top = o.categories.slice(0, 4);
    const max = top[0]?.value ?? 1;
    el.innerHTML = `<div class="card hub-card">
      <div class="row-between"><h2 style="margin:0">${MONTHS[Number(o.month.slice(5)) - 1]} em resumo</h2><button class="link" id="fin-open">Ver finanças</button></div>
      <p class="muted small" style="margin:0">Saiu <b>${money(o.expense)}</b> · sobrou <b class="${result >= 0 ? "up" : "down"}">${money(result)}</b>${top.length ? " · maiores gastos:" : ""}</p>
      ${
        top.length
          ? `<div class="fin-cats hub-cats">${top
              .map((c, i) => `<div class="fin-cat"><div class="row-between"><span>${esc(c.name)}</span><span class="num">${money(c.value)}</span></div><div class="track"><div class="fill" style="width:${(c.value / max) * 100}%;background:${PALETTE[i % PALETTE.length]}"></div></div></div>`)
              .join("")}</div>`
          : `<p class="muted small" style="margin:0">Nenhum gasto lançado neste mês.</p>`
      }
      ${bills.length ? `<div class="hub-bills"><span class="muted small">Próximos vencimentos</span>${bills.map((b) => `<div class="row-between"><span><span class="ico" style="--icon: url(icons/card-outline.svg)"></span>${esc(b.name)} <span class="muted small">${b.closed ? "fechada" : "aberta"} · vence ${day(b.due)}</span></span><b>${money(b.total)}</b></div>`).join("")}</div>` : ""}
    </div>`;
  }
  el.querySelector("#fin-open")!.addEventListener("click", open);
}
