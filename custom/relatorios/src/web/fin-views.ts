// Telas da aba Finanças além do mês: lançamentos, cartões, categorias e previstos.
import { Chart } from "chart.js";
import {
  type Account,
  type CardBook,
  type ForecastMonth,
  type Invoice,
  type MonthTotals,
  type Planned,
  type Tx,
  STATUS_LABEL,
  api,
  day,
  empty,
  errorBox,
  getAccounts,
  groupOf,
  monthName,
  shift,
  shortMonth,
  sum,
  thisMonth,
  todayIso,
} from "./fin-common";
import { openBudget, openCardConfig, openPlanned, openTx } from "./fin-forms";
import { ACCENT, MONTHS, PALETTE, axisMoney, esc, hatch, money } from "./ui";

export interface ViewCtx {
  month: string;
  charts: Chart[];
  refresh: () => void;
}
const moneyTip = { callbacks: { label: (c: { dataset: { label?: string }; raw: unknown }) => `${c.dataset.label ? `${c.dataset.label}: ` : ""}${money(Number(c.raw))}` } };
const RED = "#f04f55";
const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
/** Sólido até `solidUpTo` (inclusive), hachurado depois: o que é futuro/projetado fica listrado. */
const solidThenHatch = (hex: string, n: number, solidUpTo: number) => Array.from({ length: n }, (_, i) => (i <= solidUpTo ? hex : hatch(rgba(hex, 0.75), rgba(hex, 0.08))));
const GREEN = "#43d66b";

// ---------- lista de lançamentos (com edição) ----------

export function txRows(list: Tx[], ownIds: Set<string>) {
  if (!list.length) return empty("Nada por aqui.");
  let last = "";
  return `<div class="fin-tx">${list
    .map((t, i) => {
      const sign = t.type === "deposit" ? 1 : t.type === "withdrawal" ? -1 : 0;
      const card = t.type === "deposit" ? t.destinationName : t.type === "transfer" ? `${t.sourceName} → ${t.destinationName}` : t.sourceName;
      const tag = t.type === "transfer" ? "Transferência" : (t.category ?? "Sem categoria");
      const head = t.date !== last ? `<div class="fin-day">${day(t.date)}${t.date > todayIso() ? " · agendado" : ""}</div>` : "";
      last = t.date;
      return `${head}<button class="fin-tx-row ${ownIds.has(t.sourceId) || ownIds.has(t.destinationId) ? "" : "muted"}" data-tx="${i}">
        <span class="t"><b>${esc(t.description)}</b><span class="muted small">${esc(card)} · <span class="${t.category || t.type === "transfer" ? "" : "warn"}">${esc(tag)}</span></span></span>
        <span class="v ${sign > 0 ? "up" : ""}">${sign > 0 ? "+" : sign < 0 ? "−" : ""}${money(t.amount)}</span></button>`;
    })
    .join("")}</div>`;
}
export function bindTxRows(root: HTMLElement, list: Tx[], refresh: () => void) {
  root.querySelectorAll<HTMLElement>("[data-tx]").forEach((b) => b.addEventListener("click", () => void openTx(list[Number(b.dataset.tx)]!, refresh)));
}

export async function viewLancamentos(body: HTMLElement, ctx: ViewCtx) {
  let txs: Tx[];
  let accs: Account[];
  try {
    [txs, accs] = await Promise.all([api<Tx[]>(`/api/fin/tx?month=${ctx.month}`), getAccounts()]);
  } catch (e) {
    body.innerHTML = errorBox(e);
    return;
  }
  const own = new Set(accs.map((a) => a.id));
  const cats = [...new Set(txs.map((t) => t.category ?? "Sem categoria"))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const f = { q: "", acc: "", cat: "", type: "all" };
  body.innerHTML = `<section class="card">
    <div class="fin-filters">
      <input id="lf-q" type="search" placeholder="Buscar descrição" />
      <select id="lf-acc"><option value="">Todas as contas</option>${accs.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select>
      <select id="lf-cat"><option value="">Todas as categorias</option>${cats.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
      <div class="chips">${[["all", "Tudo"], ["withdrawal", "Saídas"], ["deposit", "Entradas"], ["transfer", "Transferências"]].map(([k, l]) => `<button class="chip" data-type="${k}" aria-pressed="${k === "all"}">${l}</button>`).join("")}</div>
    </div>
    <div class="im-sum" id="lf-sum"></div>
    <div id="lf-list"></div></section>`;
  const draw = () => {
    const q = f.q.toLowerCase();
    const list = txs.filter(
      (t) =>
        (f.type === "all" || t.type === f.type) &&
        (!f.acc || t.sourceId === f.acc || t.destinationId === f.acc) &&
        (!f.cat || (t.category ?? "Sem categoria") === f.cat) &&
        (!q || `${t.description} ${t.sourceName} ${t.destinationName}`.toLowerCase().includes(q)),
    );
    const out = sum(list.filter((t) => t.type === "withdrawal").map((t) => t.amount));
    const inn = sum(list.filter((t) => t.type === "deposit").map((t) => t.amount));
    body.querySelector("#lf-sum")!.innerHTML = `<span><b>${list.length}</b> lançamentos</span><span>saídas <b>${money(out)}</b></span><span>entradas <b>${money(inn)}</b></span>`;
    const box = body.querySelector<HTMLElement>("#lf-list")!;
    box.innerHTML = txRows(list, own);
    bindTxRows(box, list, ctx.refresh);
  };
  body.querySelector<HTMLInputElement>("#lf-q")!.addEventListener("input", (e) => ((f.q = (e.target as HTMLInputElement).value), draw()));
  body.querySelector<HTMLSelectElement>("#lf-acc")!.addEventListener("change", (e) => ((f.acc = (e.target as HTMLSelectElement).value), draw()));
  body.querySelector<HTMLSelectElement>("#lf-cat")!.addEventListener("change", (e) => ((f.cat = (e.target as HTMLSelectElement).value), draw()));
  body.querySelectorAll<HTMLButtonElement>("[data-type]").forEach((b) =>
    b.addEventListener("click", () => {
      f.type = b.dataset.type!;
      body.querySelectorAll("[data-type]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      draw();
    }),
  );
  draw();
}

// ---------- cartões ----------

const CARD_COLORS = ["#d55181", "#c98500", "#9085e9", "#3987e5", "#e66767", "#898781"];
const cardColor = (i: number) => CARD_COLORS[i % CARD_COLORS.length]!;
let pickedInvoice: Record<string, string> = {};

/** Fatura que interessa agora: a fechada ainda não vencida, senão a aberta. */
const currentInvoice = (b: CardBook) => b.invoices.find((i) => i.status === "fechada" && i.total > 0) ?? b.invoices.find((i) => i.status === "aberta") ?? b.invoices.at(-1);

export async function viewCartoes(body: HTMLElement, ctx: ViewCtx) {
  let books: CardBook[];
  try {
    books = await api<CardBook[]>("/api/fin/books?back=12&ahead=12");
  } catch (e) {
    body.innerHTML = errorBox(e);
    return;
  }
  if (!books.length) {
    body.innerHTML = `<div class="card">${empty("Nenhum cartão. No Firefly, crie uma conta de ativo com a função <b>Cartão de crédito</b>.")}</div>`;
    return;
  }
  const cur = thisMonth();
  const ahead = Array.from({ length: 12 }, (_, i) => shift(cur, i));
  const committed = (b: CardBook, m: string) => {
    const i = b.invoices.find((x) => x.month === m);
    return i && i.status !== "paga" ? Math.max(0, i.total - i.paid) : 0;
  };
  const totalAhead = sum(books.flatMap((b) => ahead.map((m) => committed(b, m))));
  body.innerHTML = `
    <section class="card">
      <div class="row-between"><h2>Comprometido nos próximos meses</h2><span class="muted small">faturas por vencimento · ${money(totalAhead)} em 12 meses</span></div>
      <div class="chart-box tall"><canvas id="cc-ahead"></canvas></div>
      <p class="note">Inclui o que já foi lançado, as parcelas que ainda vão cair e as assinaturas previstas em cada cartão.</p>
    </section>
    ${books.map((b, i) => bookShell(b, i)).join("")}`;
  ctx.charts.push(
    new Chart(body.querySelector<HTMLCanvasElement>("#cc-ahead")!, {
      type: "bar",
      data: { labels: ahead.map(shortMonth), datasets: books.map((b, i) => ({ label: b.name, data: ahead.map((m) => committed(b, m)), backgroundColor: solidThenHatch(cardColor(i), ahead.length, 1), borderRadius: 4, stack: "c" })) },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { ...moneyTip.callbacks, footer: (items) => `Total: ${money(items.reduce((s, x) => s + Number(x.raw), 0))}` } } },
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v) => axisMoney(v) } } },
      },
    }),
  );
  books.forEach((b, i) => {
    const d = body.querySelector<HTMLDetailsElement>(`details[data-book="${b.id}"]`)!;
    const inner = d.querySelector<HTMLElement>(".book-body")!;
    const draw = () => {
      if (d.open && !inner.childElementCount) drawBook(inner, b, i, ctx);
      const set = openBooks();
      d.open ? set.add(b.id) : set.delete(b.id);
      try {
        sessionStorage.setItem("rel.openCards", [...set].join(","));
      } catch {
        /* sem armazenamento */
      }
    };
    d.addEventListener("toggle", draw);
    if (d.open) drawBook(inner, b, i, ctx);
  });
}

const openBooks = () => {
  try {
    return new Set((sessionStorage.getItem("rel.openCards") ?? "").split(",").filter(Boolean));
  } catch {
    return new Set<string>();
  }
};
/** Cartão recolhível: fechado mostra só a fatura do momento e o uso do limite. */
function bookShell(b: CardBook, i: number) {
  const cur = b.config ? currentInvoice(b) : null;
  const debt = Math.max(0, -b.balance);
  const limit = b.config?.limit;
  const label = cur ? (cur.status === "fechada" ? "fechada" : cur.status === "aberta" ? "aberta" : STATUS_LABEL[cur.status]) : "";
  return `<details class="card fin-cardbook" data-book="${esc(b.id)}" style="--cc:${cardColor(i)}" ${openBooks().has(b.id) ? "open" : ""}>
    <summary class="book-sum">
      <span class="book-ico"><span class="ico" style="--icon: url(icons/card-outline.svg)"></span></span>
      <span class="book-name"><b>${esc(b.name)}</b><small>${b.config ? `fecha dia ${b.config.closing} · vence dia ${b.config.due}` : "sem fechamento informado"}</small></span>
      <span class="book-inv">${cur ? `<small>fatura ${label} · vence ${day(cur.due)}</small><b>${money(cur.total)}</b>` : `<small>devendo</small><b>${money(debt)}</b>`}</span>
      <span class="book-limit">${limit ? `<small>limite ${Math.round((debt / limit) * 100)}% usado</small><span class="meter-wrap" style="--p:${Math.min(100, (debt / limit) * 100)}"><span class="meter rev"></span></span>` : ""}</span>
      <span class="ico book-chev" style="--icon: url(icons/chevron-down.svg)"></span>
    </summary>
    <div class="book-body"></div>
  </details>`;
}

function drawBook(el: HTMLElement, b: CardBook, idx: number, ctx: ViewCtx) {
  const cfgBtn = `<button class="link small" data-cfg>${b.config ? "Fechamento, vencimento e limite" : "Informar fechamento e vencimento"}</button>`;
  if (!b.config) {
    el.innerHTML = `<div class="fin-card-head"><span class="ico" style="--icon: url(icons/card-outline.svg)"></span><b>${esc(b.name)}</b><span class="num">${money(-b.balance)}</span></div>
      <p class="muted small">Informe os dias de fechamento e de vencimento para ver as faturas mês a mês e o que já está comprometido.</p>${cfgBtn}`;
  } else {
    const debt = Math.max(0, -b.balance);
    const limit = b.config.limit;
    const visible = b.invoices.filter((i) => i.total !== 0 || i.status !== "futura" || i.month <= shift(thisMonth(), 2)).filter((i) => i.status !== "paga" || i.total !== 0);
    const pick = b.invoices.find((i) => i.month === pickedInvoice[b.id]) ?? currentInvoice(b)!;
    el.innerHTML = `
      ${
        limit
          ? `<div class="fin-limit"><div class="row-between small"><span>Usado <b>${money(debt)}</b> de ${money(limit)}</span><span class="muted">disponível ${money(Math.max(0, limit - debt))}</span></div>
             <div class="meter-wrap" style="--p:${Math.min(100, (debt / limit) * 100)}"><div class="meter rev"></div></div></div>`
          : `<p class="muted small" style="margin:0">Devendo hoje <b>${money(debt)}</b> (todas as faturas em aberto).</p>`
      }
      <div class="split fin-book-grid">
        <div>
          <div class="chips fin-inv-chips">${visible.map((i) => `<button class="chip" data-inv="${i.month}" aria-pressed="${i.month === pick.month}">${shortMonth(i.month)}<span class="muted small"> ${money(i.total)}</span></button>`).join("")}</div>
          ${invoiceDetail(pick)}
        </div>
        ${b.invoices.some((i) => i.total) ? `<div class="chart-box tall"><canvas></canvas></div>` : `<p class="muted small">Nenhum lançamento neste cartão ainda. Importe a fatura (CSV ou OFX) ou lance as compras pelo botão <b>+ Lançar</b>.</p>`}
      </div>${cfgBtn}`;
    const months = visible.map((i) => i.month);
    const inv = (m: string) => b.invoices.find((i) => i.month === m)!;
    const canvas = el.querySelector("canvas");
    if (canvas) ctx.charts.push(
      new Chart(canvas, {
        type: "bar",
        data: {
          labels: months.map(shortMonth),
          datasets: [
            { label: "Lançado", data: months.map((m) => inv(m).posted), backgroundColor: cardColor(idx), borderRadius: 3, stack: "f" },
            { label: "Parcelas futuras", data: months.map((m) => inv(m).installments), backgroundColor: hatch(rgba(cardColor(idx), 0.8), rgba(cardColor(idx), 0.08)), borderRadius: 3, stack: "f" },
            { label: "Previstos", data: months.map((m) => inv(m).planned), backgroundColor: hatch(), borderRadius: 3, stack: "f" },
          ],
        },
        options: {
          maintainAspectRatio: false,
          onClick: (_e, els) => {
            const m = months[els[0]?.index ?? -1];
            if (m) ((pickedInvoice = { ...pickedInvoice, [b.id]: m }), drawBook(el, b, idx, ctx));
          },
          plugins: { legend: { position: "bottom" }, tooltip: moneyTip },
          scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v) => axisMoney(v) } } },
        },
      }),
    );
    el.querySelectorAll<HTMLButtonElement>("[data-inv]").forEach((c) =>
      c.addEventListener("click", () => {
        pickedInvoice = { ...pickedInvoice, [b.id]: c.dataset.inv! };
        drawBook(el, b, idx, ctx);
      }),
    );
    const strip = el.querySelector<HTMLElement>(".fin-inv-chips");
    const on = strip?.querySelector<HTMLElement>("[aria-pressed=true]");
    if (strip && on) strip.scrollLeft = on.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + on.clientWidth / 2;
    el.querySelectorAll<HTMLElement>("[data-item]").forEach((r) =>
      r.addEventListener("click", async () => {
        const txs = await api<Tx[]>(`/api/fin/tx?month=${r.dataset.month}`);
        const t = txs.find((x) => x.id === r.dataset.item);
        if (t) void openTx(t, ctx.refresh);
      }),
    );
  }
  el.querySelector("[data-cfg]")!.addEventListener("click", () => openCardConfig(b, ctx.refresh));
}

function invoiceDetail(i: Invoice) {
  const label = i.status === "paga" ? (i.paid >= i.total - 0.01 ? "paga" : "vencida") : STATUS_LABEL[i.status];
  const groups: [string, Invoice["items"]][] = [
    ["Lançado", i.items.filter((x) => x.source === "posted")],
    ["Parcelas que vão cair", i.items.filter((x) => x.source === "installment")],
    ["Assinaturas e contas previstas", i.items.filter((x) => x.source === "planned")],
  ];
  return `<div class="fin-invoice">
    <div class="fin-inv-head"><div><span class="muted small">Fatura de ${monthName(i.month).toLowerCase()} · ${label}</span><b>${money(i.total)}</b></div>
      <div class="muted small right">compras de ${day(i.start)} a ${day(i.end)}<br/>vence ${day(i.due)}${i.paid ? ` · pago ${money(i.paid)}` : ""}</div></div>
    ${
      i.items.length
        ? groups
            .filter(([, xs]) => xs.length)
            .map(
              ([g, xs]) => `<div class="fin-day">${g} · ${money(sum(xs.map((x) => x.amount)))}</div>${xs
                .map(
                  (x) => `<div class="fin-inv-item ${x.source}" ${x.id ? `data-item="${esc(x.id)}" data-month="${x.date.slice(0, 7)}" role="button" tabindex="0"` : ""}>
                    <span class="d">${day(x.date)}</span><span class="t">${esc(x.description)}<span class="muted small">${esc(x.category ?? "Sem categoria")}</span></span><span class="v ${x.amount < 0 ? "up" : ""}">${x.amount < 0 ? "+" : ""}${money(Math.abs(x.amount))}</span></div>`,
                )
                .join("")}`,
            )
            .join("")
        : empty("Nada nesta fatura.")
    }</div>`;
}

// ---------- categorias ----------

let catMode: "mes" | "ano" = "mes";

export async function viewCategorias(body: HTMLElement, ctx: ViewCtx) {
  let rows: MonthTotals[];
  let budget: Record<string, number>;
  try {
    const [m, st] = await Promise.all([api<MonthTotals[]>(`/api/fin/months?from=${shift(ctx.month, -11)}&to=${ctx.month}`), api<{ budget: Record<string, number> }>("/api/fin")]);
    rows = m;
    budget = st.budget ?? {};
  } catch (e) {
    body.innerHTML = errorBox(e);
    return;
  }
  const cur = rows.at(-1)!;
  const prev = rows.slice(0, -1).filter((r) => r.expense > 0 || r.income > 0);
  const avgOf = (cat: string, key: "categories" | "incomes" = "categories") => (prev.length ? sum(prev.map((r) => r[key][cat] ?? 0)) / prev.length : 0);
  const allCats = [...new Set(rows.flatMap((r) => Object.keys(r.categories)))];

  body.innerHTML = `<section class="mode-bar"><div class="toggle" role="group">
      <button data-cm="mes" aria-pressed="${catMode === "mes"}">${monthName(ctx.month)}</button><button data-cm="ano" aria-pressed="${catMode === "ano"}">Últimos 12 meses</button></div></section>
    <div id="cat-body"></div>`;
  body.querySelectorAll<HTMLButtonElement>("[data-cm]").forEach((b) => b.addEventListener("click", () => ((catMode = b.dataset.cm as typeof catMode), ctx.refresh())));
  const box = body.querySelector<HTMLElement>("#cat-body")!;

  if (catMode === "mes") {
    const cats = Object.entries(cur.categories).filter(([, v]) => v > 0);
    const groups = new Map<string, number>();
    for (const [c, v] of cats) groups.set(groupOf(c), (groups.get(groupOf(c)) ?? 0) + v);
    const gl = [...groups].sort((a, b) => b[1] - a[1]);
    const budgeted = Object.keys(budget).filter((c) => !(c in cur.incomes) && !Object.values(rows).some((r) => c in r.incomes && !(c in r.categories)));
    const metaRows = [...new Set([...budgeted, ...cats.map(([c]) => c)])]
      .map((c) => ({ c, v: cur.categories[c] ?? 0, meta: budget[c], avg: avgOf(c) }))
      .sort((a, b) => b.v - a.v || (b.meta ?? 0) - (a.meta ?? 0));
    const totalMeta = sum(budgeted.map((c) => budget[c]!));
    const spentBudgeted = sum(budgeted.map((c) => Math.max(0, cur.categories[c] ?? 0)));
    const incomes = Object.entries(cur.incomes).sort((a, b) => b[1] - a[1]);
    box.innerHTML = `
      <section class="split">
        <div class="card"><div class="row-between"><h2>Gastos por grupo</h2><span class="muted small">${money(cur.expense)}</span></div><div class="chart-box donut"><canvas id="cg-donut"></canvas></div></div>
        <div class="card"><h2>Top 10 gastos por categoria</h2><div class="chart-box tall"><canvas id="cg-top"></canvas></div></div>
      </section>
      <section class="card">
        <div class="row-between"><h2>Meta × realizado</h2>${totalMeta ? `<span class="muted small">gastou <b class="${spentBudgeted > totalMeta ? "down" : ""}">${money(spentBudgeted)}</b> de ${money(totalMeta)} planejados</span>` : ""}</div>
        <p class="muted small" style="margin-top:0">Toque numa categoria para definir a meta mensal. A linha cinza é a média dos 11 meses anteriores.</p>
        <div class="fin-meta">${metaRows
          .map(({ c, v, meta, avg }) => {
            const ref = Math.max(v, meta ?? 0, avg, 1);
            const over = meta != null && v > meta;
            return `<button class="fin-meta-row" data-cat="${esc(c)}" data-avg="${avg}">
              <div class="row-between"><span>${esc(c)}</span><span class="num"><b class="${over ? "down" : ""}">${money(v)}</b>${meta ? ` <span class="muted">/ ${money(meta)}</span>` : ` <span class="muted small">sem meta</span>`}</span></div>
              <div class="track"><div class="fill ${over ? "over" : ""}" style="width:${(v / ref) * 100}%"></div>${meta ? `<i class="goal" style="left:${(meta / ref) * 100}%"></i>` : ""}${avg > 0 ? `<i class="avg" style="left:${Math.min(100, (avg / ref) * 100)}%"></i>` : ""}</div></button>`;
          })
          .join("")}</div>
      </section>
      <section class="card"><div class="row-between"><h2>Entradas por categoria</h2><span class="muted small">${money(cur.income)}</span></div>
        ${
          incomes.length
            ? `<div class="fin-meta">${incomes
                .map(([c, v]) => {
                  const meta = budget[c];
                  const ref = Math.max(v, meta ?? 0, 1);
                  return `<button class="fin-meta-row" data-cat="${esc(c)}" data-avg="${avgOf(c, "incomes")}"><div class="row-between"><span>${esc(c)}</span><span class="num"><b class="up">${money(v)}</b>${meta ? ` <span class="muted">/ ${money(meta)}</span>` : ""}</span></div>
                  <div class="track"><div class="fill inc" style="width:${(v / ref) * 100}%"></div>${meta ? `<i class="goal" style="left:${(meta / ref) * 100}%"></i>` : ""}</div></button>`;
                })
                .join("")}</div>`
            : empty("Nenhuma entrada neste mês.")
        }</section>`;
    ctx.charts.push(
      new Chart(box.querySelector<HTMLCanvasElement>("#cg-donut")!, {
        type: "doughnut",
        data: { labels: gl.map(([g]) => g), datasets: [{ data: gl.map(([, v]) => v), backgroundColor: gl.map((_, i) => PALETTE[i % PALETTE.length]!), borderWidth: 0 }] },
        options: { maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (c) => `${c.label}: ${money(Number(c.raw))} (${Math.round((Number(c.raw) / cur.expense) * 100)}%)` } } } },
      }),
    );
    const top = [...cats].sort((a, b) => b[1] - a[1]).slice(0, 10);
    ctx.charts.push(
      new Chart(box.querySelector<HTMLCanvasElement>("#cg-top")!, {
        type: "bar",
        data: {
          labels: top.map(([c]) => c),
          datasets: [
            { label: "Este mês", data: top.map(([, v]) => v), backgroundColor: ACCENT, borderRadius: 3 },
            { label: "Média", data: top.map(([c]) => Math.max(0, avgOf(c))), backgroundColor: hatch(), borderRadius: 3 },
          ],
        },
        options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: moneyTip }, scales: { x: { min: 0, ticks: { callback: (v) => axisMoney(v) } }, y: { grid: { display: false } } } },
      }),
    );
  } else {
    const groups = [...new Set(allCats.map(groupOf))];
    const totals = groups.map((g) => ({ g, v: sum(rows.map((r) => sum(Object.entries(r.categories).filter(([c]) => groupOf(c) === g).map(([, v]) => v)))) })).sort((a, b) => b.v - a.v);
    const catRows = allCats
      .map((c) => ({ c, vals: rows.map((r) => r.categories[c] ?? 0) }))
      .map((x) => ({ ...x, total: sum(x.vals) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total);
    const active = rows.filter((r) => r.expense > 0).length || 1;
    box.innerHTML = `
      <section class="card"><h2>Gastos por grupo, mês a mês</h2><div class="chart-box tall"><canvas id="cy-stack"></canvas></div></section>
      <section class="card"><h2>Receitas × despesas</h2><div class="chart-box"><canvas id="cy-flow"></canvas></div></section>
      <section class="card"><h2>Categoria por mês</h2>
        <div class="scroll"><table class="fin-table"><thead><tr><th>Categoria</th>${rows.map((r) => `<th>${MONTHS[Number(r.month.slice(5)) - 1]}</th>`).join("")}<th>Média</th><th>Meta</th></tr></thead>
        <tbody>${catRows
          .map(
            (x) => `<tr><td>${esc(x.c)}</td>${x.vals.map((v) => `<td class="num ${budget[x.c] && v > budget[x.c]! ? "down" : ""}">${v ? money(v).replace("R$", "").trim() : "—"}</td>`).join("")}<td class="num"><b>${money(x.total / active).replace("R$", "").trim()}</b></td><td class="num muted">${budget[x.c] ? money(budget[x.c]!).replace("R$", "").trim() : ""}</td></tr>`,
          )
          .join("")}
          <tr class="total"><td>Total gastos</td>${rows.map((r) => `<td class="num">${money(r.expense).replace("R$", "").trim()}</td>`).join("")}<td class="num"><b>${money(sum(rows.map((r) => r.expense)) / active).replace("R$", "").trim()}</b></td><td></td></tr>
          <tr class="total"><td>Total entradas</td>${rows.map((r) => `<td class="num up">${money(r.income).replace("R$", "").trim()}</td>`).join("")}<td class="num up"><b>${money(sum(rows.map((r) => r.income)) / active).replace("R$", "").trim()}</b></td><td></td></tr>
        </tbody></table></div></section>`;
    ctx.charts.push(
      new Chart(box.querySelector<HTMLCanvasElement>("#cy-stack")!, {
        type: "bar",
        data: {
          labels: rows.map((r) => shortMonth(r.month)),
          datasets: [
            ...totals.slice(0, 8).map(({ g }, i) => ({
              label: g,
              data: rows.map((r) => sum(Object.entries(r.categories).filter(([c]) => groupOf(c) === g).map(([, v]) => v))),
              backgroundColor: PALETTE[i % PALETTE.length],
              stack: "g",
            })),
            ...(totals.length > 8
              ? [{ label: "Demais", data: rows.map((r) => sum(Object.entries(r.categories).filter(([c]) => !totals.slice(0, 8).some((t) => t.g === groupOf(c))).map(([, v]) => v))), backgroundColor: PALETTE[8], stack: "g" }]
              : []),
          ],
        },
        options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: moneyTip }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v) => axisMoney(v) } } } },
      }),
    );
    ctx.charts.push(flowChart(box.querySelector<HTMLCanvasElement>("#cy-flow")!, rows));
  }
  box.querySelectorAll<HTMLElement>("[data-cat]").forEach((b) => b.addEventListener("click", () => openBudget(b.dataset.cat!, budget[b.dataset.cat!], Number(b.dataset.avg), ctx.refresh)));
}

/** Entradas e saídas por mês, com a sobra acumulada em linha. */
export function flowChart(canvas: HTMLCanvasElement, rows: { month: string; income: number; expense: number }[]) {
  return new Chart(canvas, {
    data: {
      labels: rows.map((r) => shortMonth(r.month)),
      datasets: [
        { type: "bar", label: "Entradas", data: rows.map((r) => r.income), backgroundColor: rows.map((_, i) => (i === rows.length - 1 ? ACCENT : hatch(rgba(ACCENT, 0.7), rgba(ACCENT, 0.06)))), borderRadius: 999, borderSkipped: false, barPercentage: 0.7, order: 2 },
        { type: "bar", label: "Saídas", data: rows.map((r) => r.expense), backgroundColor: rows.map((_, i) => (i === rows.length - 1 ? RED : hatch(rgba(RED, 0.7), rgba(RED, 0.06)))), borderRadius: 999, borderSkipped: false, barPercentage: 0.7, order: 2 },
        { type: "line", label: "Sobra", data: rows.map((r) => Math.round((r.income - r.expense) * 100) / 100), borderColor: "rgba(243,245,244,0.85)", borderWidth: 1.5, backgroundColor: "#0b0c0c", pointBorderColor: "rgba(243,245,244,0.9)", pointBorderWidth: 1.5, pointRadius: 3.5, tension: 0.35, order: 1 },
      ],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: moneyTip }, scales: { y: { ticks: { callback: (v) => axisMoney(v) } }, x: { grid: { display: false } } } },
  });
}

// ---------- previstos e projeção ----------

interface Suggestion extends Omit<Planned, "id" | "start" | "freq"> {
  months: number;
}

export async function viewPrevistos(body: HTMLElement, ctx: ViewCtx) {
  let data: { items: Planned[]; suggestions: Suggestion[] };
  let fc: { cash: number; daily: number; months: ForecastMonth[] };
  let accs: Account[];
  try {
    [data, fc, accs] = await Promise.all([api<{ items: Planned[]; suggestions: Suggestion[] }>("/api/fin/planned"), api<{ cash: number; daily: number; months: ForecastMonth[] }>("/api/fin/forecast?ahead=12"), getAccounts()]);
  } catch (e) {
    body.innerHTML = errorBox(e);
    return;
  }
  const accName = (id: string | null) => (id ? (accs.find((a) => a.id === id)?.name ?? "conta removida") : "qualquer conta");
  const byKind = (k: Planned["kind"]) => data.items.filter((p) => p.kind === k).sort((a, b) => a.day - b.day);
  const monthly = (k: Planned["kind"]) => sum(data.items.filter((p) => p.kind === k && p.freq === "monthly" && (!p.end || p.end >= thisMonth())).map((p) => p.amount));
  const row = (p: Planned) => `<button class="fin-plan-row" data-pl="${esc(p.id)}">
      <span class="d">dia ${p.day}</span>
      <span class="t"><b>${esc(p.description)}</b><span class="muted small">${esc(accName(p.accountId))}${p.category ? ` · ${esc(p.category)}` : ""}${p.freq === "once" ? ` · só em ${shortMonth(p.start)}` : p.end ? ` · até ${shortMonth(p.end)}` : ""}</span></span>
      <span class="v ${p.kind === "income" ? "up" : ""}">${p.kind === "income" ? "+" : "−"}${money(p.amount)}</span></button>`;

  body.innerHTML = `
    <section class="kpis">
      <div class="card kpi"><div class="label">Entradas fixas</div><div class="value">${money(monthly("income"))}</div><span class="delta up">por mês</span></div>
      <div class="card kpi"><div class="label">Saídas fixas</div><div class="value">${money(monthly("expense"))}</div><span class="delta down">contas e assinaturas por mês</span></div>
      <div class="card kpi"><div class="label">Em contas hoje</div><div class="value">${money(fc.cash)}</div><div class="sub">ponto de partida da projeção</div></div>
      <div class="card kpi"><div class="label">Saldo projetado</div><div class="value">${money(fc.months.at(-1)!.balance)}</div><span class="delta ${fc.months.at(-1)!.balance >= fc.cash ? "up" : "down"}">em ${monthName(fc.months.at(-1)!.month).toLowerCase()}</span></div>
    </section>
    <section class="card"><div class="row-between"><h2>Fluxo de caixa projetado</h2><span class="muted small">previstos + faturas dos cartões</span></div>
      <div class="chart-box tall"><canvas id="fc-chart"></canvas></div>
      <div class="scroll"><table class="fin-table"><thead><tr><th>Mês</th><th>Entradas previstas</th><th>Agendados</th><th>Contas fixas</th><th>Faturas</th><th>Dia a dia</th><th>Sobra</th><th>Saldo</th></tr></thead>
      <tbody>${fc.months
        .map(
          (m) => `<tr><td>${monthName(m.month)}${m.month === thisMonth() ? ` <span class="muted small">(o que falta)</span>` : ""}</td><td class="num up">${money(m.income)}</td><td class="num ${m.scheduled > 0 ? "up" : ""}">${m.scheduled ? money(m.scheduled) : "—"}</td><td class="num">${money(m.expense)}</td>
          <td class="num" title="${esc(m.cards.map((c) => `${c.name}: ${money(c.value)}`).join("\n"))}">${money(m.cardsTotal)}</td><td class="num">${money(m.variable)}</td><td class="num ${m.net >= 0 ? "up" : "down"}">${money(m.net)}</td><td class="num"><b class="${m.balance < 0 ? "down" : ""}">${money(m.balance)}</b></td></tr>`,
        )
        .join("")}</tbody></table></div>
      <p class="note">“Dia a dia” é a média dos gastos fora dos previstos nos últimos 3 meses (${money(fc.daily)} por mês: mercado, iFood, compras novas no cartão…). “Agendados” são lançamentos já feitos com data futura.</p>
    </section>
    <section class="split">
      <div class="card"><div class="row-between"><h2>Entradas previstas</h2><button class="link" data-new="income">+ Nova</button></div><div class="fin-tx">${byKind("income").map(row).join("") || empty("Nenhuma. Ex.: salário, ajuda da família.")}</div></div>
      <div class="card"><div class="row-between"><h2>Contas e assinaturas</h2><button class="link" data-new="expense">+ Nova</button></div><div class="fin-tx">${byKind("expense").map(row).join("") || empty("Nenhuma. Ex.: aluguel, luz, internet, Spotify.")}</div></div>
    </section>
    ${
      data.suggestions.length
        ? `<section class="card"><h2>Sugestões do seu histórico</h2><p class="muted small" style="margin-top:0">Lançamentos que se repetiram nos últimos meses e ainda não estão nos previstos.</p>
      <div class="fin-tx">${data.suggestions
        .map(
          (s, i) => `<div class="fin-plan-row sug"><span class="d">dia ${s.day}</span><span class="t"><b>${esc(s.description)}</b><span class="muted small">${esc(accName(s.accountId))}${s.category ? ` · ${esc(s.category)}` : ""} · ${s.months} meses</span></span>
          <span class="v ${s.kind === "income" ? "up" : ""}">${s.kind === "income" ? "+" : "−"}${money(s.amount)}</span><button class="ghost small-btn" data-sug="${i}">Adicionar</button></div>`,
        )
        .join("")}</div></section>`
        : ""
    }`;

  const labels = fc.months.map((m) => shortMonth(m.month));
  const cardNames = [...new Set(fc.months.flatMap((m) => m.cards.map((c) => c.name)))];
  ctx.charts.push(
    new Chart(body.querySelector<HTMLCanvasElement>("#fc-chart")!, {
      data: {
        labels,
        datasets: [
          { type: "bar", label: "Entradas", data: fc.months.map((m) => m.income + Math.max(0, m.scheduled)), backgroundColor: solidThenHatch(GREEN, fc.months.length, 0), borderRadius: 3, stack: "in", order: 2 },
          { type: "bar", label: "Dia a dia", data: fc.months.map((m) => m.variable), backgroundColor: hatch(), borderRadius: 3, stack: "out", order: 2 },
          { type: "bar", label: "Contas e assinaturas", data: fc.months.map((m) => m.expense), backgroundColor: solidThenHatch(RED, fc.months.length, 0), borderRadius: 3, stack: "out", order: 2 },
          ...cardNames.map((n, i) => ({ type: "bar" as const, label: n, data: fc.months.map((m) => m.cards.find((c) => c.name === n)?.value ?? 0), backgroundColor: solidThenHatch(cardColor(i), fc.months.length, 0), borderRadius: 3, stack: "out", order: 2 })),
          { type: "line", label: "Saldo projetado", data: fc.months.map((m) => m.balance), borderColor: "rgba(243,245,244,0.9)", borderWidth: 1.5, backgroundColor: "#0b0c0c", pointBorderColor: "rgba(243,245,244,0.9)", pointBorderWidth: 1.5, pointRadius: 3.5, tension: 0.3, order: 1 },
        ],
      },
      options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: moneyTip }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v) => axisMoney(v) } } } },
    }),
  );
  body.querySelectorAll<HTMLElement>("[data-pl]").forEach((b) => b.addEventListener("click", () => void openPlanned(data.items.find((p) => p.id === b.dataset.pl)!, ctx.refresh)));
  body.querySelectorAll<HTMLElement>("[data-new]").forEach((b) => b.addEventListener("click", () => void openPlanned({ kind: b.dataset.new as Planned["kind"] }, ctx.refresh)));
  body.querySelectorAll<HTMLElement>("[data-sug]").forEach((b) =>
    b.addEventListener("click", () => {
      const s = data.suggestions[Number(b.dataset.sug)]!;
      void openPlanned({ ...s, freq: "monthly", start: thisMonth(), description: s.description }, ctx.refresh);
    }),
  );
}
