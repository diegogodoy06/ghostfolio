// Aba Finanças: contas, cartões (fatura no padrão brasileiro), gastos do mês e importação de
// extratos, tudo guardado no Firefly III e somado aos investimentos do Ghostfolio.
import { Chart } from "chart.js";
import type { Report } from "../shared";
import { ACCENT, MONTHS, PALETTE, axisMoney, dateBR, esc, money, openModal, toast } from "./ui";

interface Account {
  id: string;
  name: string;
  card: boolean;
  balance: number;
  currency: string;
  paymentDay: number | null;
}
interface Cycle {
  start: string;
  end: string;
  due: string;
  total: number;
}
interface Card extends Account {
  config: { closing: number; due: number } | null;
  open: Cycle | null;
  closed: Cycle | null;
  future: { month: string; value: number }[];
}
interface Tx {
  id: string;
  type: string;
  date: string;
  amount: number;
  description: string;
  category: string | null;
  sourceId: string;
  sourceName: string;
  destinationId: string;
  destinationName: string;
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
  recent: Tx[];
}

const KEY = "rel.finMonth";
const thisMonth = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
let month = thisMonth();
const shift = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]}/${ym.slice(0, 4)}`;
const shortMonth = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]}/${ym.slice(2, 4)}`;
const day = (iso: string) => dateBR(iso).slice(0, 5);
const PAYMENT = /pagamento|pagto|pgto|pag\.? ?fatura|fatura paga|cr[eé]dito de pagamento/i;
const CARD_PAYMENT = /fatura|cart[aã]o|cartao/i;

let rerender: () => void = () => {};

export async function renderFinancas(r: Report, main: HTMLElement, charts: Chart[]) {
  rerender = () => {
    clearFinCache();
    void renderFinancas(r, main, charts);
  };
  const st = await fetch("/api/fin").then((x) => (x.ok ? x.json() : null)) as { connected: boolean; publicUrl: string } | null;
  if (!main.isConnected) return;
  if (!st?.connected) return renderConnect(main, st?.publicUrl ?? "");

  const res = await fetch(`/api/fin/overview?month=${month}`);
  if (!main.isConnected) return;
  if (res.status === 409) return renderConnect(main, st.publicUrl, ((await res.json()) as { error?: string }).error);
  if (!res.ok) {
    main.innerHTML = `<div class="card"><p class="error">Não foi possível ler o Firefly III: ${esc(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)}</p></div>`;
    return;
  }
  const o = (await res.json()) as Overview;
  const cash = o.accounts.reduce((s, a) => s + a.balance, 0);
  const cardDebt = o.cards.reduce((s, c) => s + Math.min(0, c.balance), 0);
  const openInvoices = o.cards.reduce((s, c) => s + (c.open?.total ?? 0), 0);
  const invest = r.summary.value;
  const net = invest + cash + cardDebt;
  const result = o.income - o.expense;
  const ff = o.publicUrl;

  main.innerHTML = `
    <section class="mode-bar fin-bar">
      <div class="month-nav" role="group" aria-label="Mês">
        <button class="icon" data-m="-1" aria-label="Mês anterior">‹</button>
        <b>${monthName(month)}</b>
        <button class="icon" data-m="1" aria-label="Próximo mês" ${month >= thisMonth() ? "disabled" : ""}>›</button>
      </div>
      <div class="fin-actions">
        ${ff ? `<a class="ghost-link" href="${esc(ff)}" target="_blank" rel="noopener"><span class="ico" style="--icon: url(icons/open-outline.svg)"></span><span>Firefly</span></a>` : ""}
        <button class="icon" id="fin-settings" title="Conexão com o Firefly" aria-label="Configurações"><span class="ico" style="--icon: url(icons/settings-outline.svg)"></span></button>
        <button class="primary" id="fin-import"><span class="ico" style="--icon: url(icons/cloud-upload-outline.svg)"></span> Importar extrato</button>
      </div>
    </section>
    <section class="kpis">
      <div class="card kpi"><div class="label">Patrimônio total</div><div class="value">${money(net)}</div><div class="sub">investimentos + contas − cartões</div></div>
      <div class="card kpi"><div class="label">Em contas</div><div class="value">${money(cash)}</div><div class="sub">investido ${money(invest)}</div></div>
      <div class="card kpi"><div class="label">Faturas abertas</div><div class="value ${openInvoices > 0 ? "down" : ""}">${money(openInvoices)}</div><div class="sub">${o.cards.length} cartão${o.cards.length === 1 ? "" : "es"}</div></div>
      <div class="card kpi"><div class="label">Sobra do mês</div><div class="value ${result >= 0 ? "up" : "down"}">${money(result)}</div><div class="sub">entrou ${money(o.income)} · saiu ${money(o.expense)}</div></div>
    </section>
    <section class="split">
      <div class="card"><h2>Cartões</h2>${o.cards.length ? o.cards.map(cardBlock).join("") : `<p class="muted small" style="margin:0">Nenhum cartão. No Firefly, crie uma conta de ativo com a função <b>Cartão de crédito</b>.</p>`}</div>
      <div class="card"><h2>Contas</h2>
        <div class="legend">${o.accounts.map((a) => `<div class="li fin-acc"><span class="ico" style="--icon: url(icons/wallet-outline.svg)"></span><span>${esc(a.name)}</span><span></span><span class="num ${a.balance < 0 ? "down" : ""}">${money(a.balance)}</span></div>`).join("") || `<p class="muted small" style="margin:0">Nenhuma conta ainda.</p>`}</div>
        <div class="fin-total"><span>Total em contas</span><b>${money(cash)}</b></div>
        <p class="note">Investimentos (${money(invest)}) vêm do Ghostfolio, no recorte escolhido no topo. Se a conta da corretora também estiver aqui com saldo em dinheiro, ele pode aparecer nos dois.</p>
      </div>
    </section>
    <section class="split-1-2">
      <div class="card"><h2>Gastos por categoria</h2>${categoryBars(o)}</div>
      <div class="card"><h2>Entradas × saídas</h2><div class="chart-box"><canvas id="fin-hist"></canvas></div></div>
    </section>
    <section class="card"><div class="row-between"><h2>Lançamentos de ${monthName(month).toLowerCase()}</h2><span class="muted small">${o.recent.length} mais recentes</span></div>${txList(o)}</section>`;

  main.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((b) =>
    b.addEventListener("click", () => {
      month = shift(month, Number(b.dataset.m));
      try {
        sessionStorage.setItem(KEY, month);
      } catch {
        /* sem armazenamento */
      }
      rerender();
    }),
  );
  main.querySelector("#fin-import")!.addEventListener("click", () => openImport([...o.accounts, ...o.cards]));
  main.querySelector("#fin-settings")!.addEventListener("click", () => openSettings(ff));
  main.querySelectorAll<HTMLButtonElement>("[data-card]").forEach((b) => b.addEventListener("click", () => openCardConfig(o.cards.find((c) => c.id === b.dataset.card)!)));

  const ctx = main.querySelector<HTMLCanvasElement>("#fin-hist");
  if (ctx)
    charts.push(
      new Chart(ctx, {
        type: "bar",
        data: {
          labels: o.history.map((h) => shortMonth(h.month)),
          datasets: [
            { label: "Entradas", data: o.history.map((h) => h.income), backgroundColor: ACCENT, borderRadius: 4 },
            { label: "Saídas", data: o.history.map((h) => h.expense), backgroundColor: PALETTE[1], borderRadius: 4 },
          ],
        },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(Number(c.raw))}` } } },
          scales: { y: { ticks: { callback: (v) => axisMoney(v) } }, x: { grid: { display: false } } },
        },
      }),
    );
}

function cardBlock(c: Card) {
  const cfgBtn = `<button class="link small" data-card="${esc(c.id)}">${c.config ? "Fechamento e vencimento" : "Informar fechamento e vencimento"}</button>`;
  if (!c.config || !c.open || !c.closed)
    return `<div class="fin-card"><div class="fin-card-head"><span class="ico" style="--icon: url(icons/card-outline.svg)"></span><b>${esc(c.name)}</b><span class="num">${money(-c.balance)}</span></div>
      <p class="muted small">Saldo devedor no Firefly. Informe os dias de fechamento e de vencimento para ver a fatura aberta e as parcelas futuras.</p>${cfgBtn}</div>`;
  const future = c.future.slice(0, 6);
  const futureTotal = c.future.reduce((s, f) => s + f.value, 0);
  return `<div class="fin-card">
    <div class="fin-card-head"><span class="ico" style="--icon: url(icons/card-outline.svg)"></span><b>${esc(c.name)}</b><span class="badge">fecha ${day(c.open.end)}</span></div>
    <div class="fin-inv">
      <div><span class="muted small">Fatura aberta</span><b>${money(c.open.total)}</b><span class="muted small">vence ${day(c.open.due)}</span></div>
      <div><span class="muted small">Última fechada</span><b>${money(c.closed.total)}</b><span class="muted small">${c.closed.due < todayIso() ? "venceu" : "vence"} ${day(c.closed.due)}</span></div>
    </div>
    ${
      future.length
        ? `<div class="fin-future"><span class="muted small">Parcelas já compradas, por fatura · ${money(futureTotal)}</span><div>${future.map((f) => `<span class="chip-static">${shortMonth(f.month)} <b>${money(f.value)}</b></span>`).join("")}</div></div>`
        : ""
    }
    ${cfgBtn}</div>`;
}
const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

function categoryBars(o: Overview) {
  if (!o.categories.length) return `<p class="muted small" style="margin:0">Nenhum gasto em ${monthName(o.month).toLowerCase()}.</p>`;
  const max = o.categories[0]!.value;
  const top = o.categories.slice(0, 9);
  const rest = o.categories.slice(9).reduce((s, c) => s + c.value, 0);
  const rows = rest ? [...top, { name: "Outras", value: rest }] : top;
  return `<div class="fin-cats">${rows
    .map(
      (c, i) => `<div class="fin-cat"><div class="row-between"><span>${esc(c.name)}</span><span class="num">${money(c.value)} <span class="muted">${Math.round((c.value / o.expense) * 100)}%</span></span></div>
        <div class="track"><div class="fill" style="width:${(c.value / max) * 100}%;background:${PALETTE[i % PALETTE.length]}"></div></div></div>`,
    )
    .join("")}</div>${o.categories.some((c) => c.name === "Sem categoria") ? `<p class="note">Regras do Firefly (Automação → Regras) categorizam sozinhas os próximos lançamentos importados.</p>` : ""}`;
}

function txList(o: Overview) {
  if (!o.recent.length) return `<p class="muted small" style="margin:0">Nada lançado neste mês. Use <b>Importar extrato</b>.</p>`;
  const own = new Set([...o.accounts, ...o.cards].map((a) => a.id));
  return `<div class="fin-tx">${o.recent
    .map((t) => {
      const sign = t.type === "deposit" ? 1 : t.type === "withdrawal" ? -1 : 0;
      const account = t.type === "deposit" ? t.destinationName : t.type === "transfer" ? `${t.sourceName} → ${t.destinationName}` : t.sourceName;
      const tag = t.type === "transfer" ? "Transferência" : (t.category ?? "");
      return `<div class="fin-tx-row ${own.has(t.sourceId) || own.has(t.destinationId) ? "" : "muted"}">
        <span class="d">${day(t.date)}</span>
        <span class="t"><b>${esc(t.description)}</b><span class="muted small">${esc(account)}${tag ? ` · ${esc(tag)}` : ""}</span></span>
        <span class="v ${sign > 0 ? "up" : ""}">${sign > 0 ? "+" : sign < 0 ? "−" : ""}${money(t.amount)}</span></div>`;
    })
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

function openCardConfig(c: Card) {
  const closing = c.config?.closing ?? "";
  const due = c.config?.due ?? c.paymentDay ?? "";
  const m = openModal(
    c.name,
    `<p class="muted" style="margin-top:0">Compras feitas depois do fechamento entram na fatura seguinte. Os dias ficam salvos só aqui (o Firefly não tem fechamento).</p>
     <div class="fin-days">
       <label class="field">Dia do fechamento<input id="cc-close" type="number" inputmode="numeric" min="1" max="31" value="${closing}" /></label>
       <label class="field">Dia do vencimento<input id="cc-due" type="number" inputmode="numeric" min="1" max="31" value="${due}" /></label>
     </div>
     <p class="error small" id="cc-err" hidden></p>
     <div class="modal-actions">${c.config ? `<button class="ghost danger" id="cc-clear">Remover</button>` : ""}<button class="primary" id="cc-save">Salvar</button></div>`,
  );
  const save = async (body: object) => {
    const res = await fetch("/api/fin/cards", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: c.id, ...body }) });
    if (!res.ok) {
      const e = m.el.querySelector<HTMLElement>("#cc-err")!;
      e.hidden = false;
      e.textContent = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Não foi possível salvar.";
      return;
    }
    m.close();
    rerender();
  };
  m.el.querySelector("#cc-save")!.addEventListener("click", () =>
    save({ closing: Number(m.el.querySelector<HTMLInputElement>("#cc-close")!.value), due: Number(m.el.querySelector<HTMLInputElement>("#cc-due")!.value) }),
  );
  m.el.querySelector("#cc-clear")?.addEventListener("click", () => save({}));
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
