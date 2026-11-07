// Formulários da aba Finanças: lançar, editar lançamento, previsto, orçamento da categoria e cartão.
import { type Account, type Planned, type Tx, api, clearListCaches, getAccounts, getCategories, thisMonth, todayIso } from "./fin-common";
import { esc, money, openModal, parseNum, toast } from "./ui";

const accountOptions = (accs: Account[], selected?: string | null, opts: { any?: string } = {}) =>
  (opts.any != null ? `<option value="">${esc(opts.any)}</option>` : "") +
  accs.map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? "selected" : ""}>${esc(a.name)}${a.card ? " (cartão)" : ""}</option>`).join("");
const catList = (cats: string[]) => `<datalist id="fin-cats">${cats.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>`;
const fail = (el: HTMLElement, msg: string) => {
  const e = el.querySelector<HTMLElement>(".form-err")!;
  e.hidden = false;
  e.textContent = msg;
};
const val = (el: HTMLElement, sel: string) => el.querySelector<HTMLInputElement | HTMLSelectElement>(sel)!.value.trim();

// ---------- lançar ----------

export async function openLancar(done: () => void, preset: { kind?: "expense" | "income" | "transfer"; accountId?: string } = {}) {
  const [accs, cats] = await Promise.all([getAccounts(), getCategories()]);
  let kind = preset.kind ?? "expense";
  const m = openModal(
    "Lançar",
    `<div class="toggle fin-kind" role="group">${[
      ["expense", "Gasto"],
      ["income", "Entrada"],
      ["transfer", "Transferência"],
    ]
      .map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${k === kind}">${l}</button>`)
      .join("")}</div>
     <div class="fin-form">
       <label class="field">Valor<div class="money-input"><b>R$</b><input id="lx-amount" inputmode="decimal" placeholder="0,00" autocomplete="off" /></div></label>
       <label class="field">Data<input id="lx-date" type="date" value="${todayIso()}" /></label>
       <label class="field wide">Descrição<input id="lx-desc" maxlength="200" placeholder="Ex.: Mercado, Uber, presente" /></label>
       <label class="field" data-show="expense income transfer"><span id="lx-acc-l">Conta ou cartão</span><select id="lx-acc">${accountOptions(accs, preset.accountId ?? accs.find((a) => !a.card)?.id)}</select></label>
       <label class="field" data-show="transfer">Para<select id="lx-to">${accountOptions(accs, accs.find((a) => a.card)?.id)}</select></label>
       <label class="field" data-show="expense income">Categoria<input id="lx-cat" list="fin-cats" placeholder="Escolha ou digite" /></label>
       <label class="field" data-show="expense" id="lx-parc-f">Parcelas<input id="lx-parc" type="number" min="1" max="48" value="1" /></label>
       <label class="switch wide" data-show="expense income"><input type="checkbox" id="lx-rep" /><span></span>Repete todo mês (cria também um previsto)</label>
     </div>${catList(cats)}
     <p class="muted small" id="lx-hint"></p>
     <p class="error small form-err" hidden></p>
     <div class="modal-actions"><button class="primary" id="lx-go">Lançar</button></div>`,
  );
  const el = m.el;
  const acc = el.querySelector<HTMLSelectElement>("#lx-acc")!;
  const parc = el.querySelector<HTMLInputElement>("#lx-parc")!;
  const hint = el.querySelector<HTMLElement>("#lx-hint")!;
  const sync = () => {
    el.querySelectorAll<HTMLElement>("[data-show]").forEach((f) => (f.hidden = !f.dataset.show!.split(" ").includes(kind)));
    el.querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === kind)));
    el.querySelector("#lx-acc-l")!.textContent = kind === "transfer" ? "De" : kind === "income" ? "Entrou em" : "Conta ou cartão";
    const card = accs.find((a) => a.id === acc.value)?.card;
    el.querySelector<HTMLElement>("#lx-parc-f")!.hidden = kind !== "expense" || !card;
    const n = Number(parc.value) || 1;
    const amount = parseNum(val(el, "#lx-amount")) ?? 0;
    hint.textContent = card && kind === "expense" && n > 1 && amount ? `${n}× de ${money(amount / n)}, cada parcela na sua fatura.` : "";
  };
  el.querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) =>
    b.addEventListener("click", () => {
      kind = b.dataset.k as typeof kind;
      sync();
    }),
  );
  el.querySelectorAll("input, select").forEach((i) => i.addEventListener("input", sync));
  sync();
  setTimeout(() => el.querySelector<HTMLInputElement>("#lx-amount")!.focus(), 80);

  el.querySelector("#lx-go")!.addEventListener("click", async () => {
    const amount = parseNum(val(el, "#lx-amount"));
    const description = val(el, "#lx-desc");
    if (!amount || amount <= 0) return fail(el, "Informe o valor.");
    if (!description) return fail(el, "Informe a descrição.");
    const card = accs.find((a) => a.id === acc.value)?.card;
    const body = {
      kind,
      date: val(el, "#lx-date"),
      amount,
      description,
      accountId: acc.value,
      toAccountId: kind === "transfer" ? val(el, "#lx-to") : undefined,
      category: kind === "transfer" ? null : val(el, "#lx-cat") || null,
      installments: kind === "expense" && card ? Number(parc.value) || 1 : 1,
    };
    const btn = el.querySelector<HTMLButtonElement>("#lx-go")!;
    btn.disabled = true;
    try {
      await api("/api/fin/tx", { method: "POST", body });
      if (kind !== "transfer" && el.querySelector<HTMLInputElement>("#lx-rep")!.checked)
        await api("/api/fin/planned", {
          method: "PUT",
          body: { kind, description, amount, accountId: acc.value, category: body.category, day: Number(body.date.slice(8)), freq: "monthly", start: body.date.slice(0, 7), match: description },
        });
      clearListCaches();
      toast(body.installments > 1 ? `Lançado em ${body.installments} parcelas` : "Lançado");
      m.close();
      done();
    } catch (e) {
      btn.disabled = false;
      fail(el, (e as Error).message);
    }
  });
}

// ---------- editar lançamento ----------

export async function openTx(t: Tx, done: () => void) {
  const cats = await getCategories();
  const transfer = t.type === "transfer";
  const m = openModal(
    "Lançamento",
    `<p class="muted small" style="margin-top:0">${esc(t.type === "deposit" ? `${t.sourceName} → ${t.destinationName}` : `${t.sourceName} → ${t.destinationName}`)}</p>
     <div class="fin-form">
       <label class="field wide">Descrição<input id="tx-desc" maxlength="1000" value="${esc(t.description)}" /></label>
       <label class="field">Valor<div class="money-input"><b>R$</b><input id="tx-amount" inputmode="decimal" value="${t.amount.toFixed(2).replace(".", ",")}" /></div></label>
       <label class="field">Data<input id="tx-date" type="date" value="${t.date}" /></label>
       ${transfer ? "" : `<label class="field wide">Categoria<input id="tx-cat" list="fin-cats" value="${esc(t.category ?? "")}" placeholder="Sem categoria" /></label>`}
     </div>${catList(cats)}
     <p class="error small form-err" hidden></p>
     <div class="modal-actions"><button class="ghost danger" id="tx-del">Excluir</button><button class="primary" id="tx-save">Salvar</button></div>`,
  );
  const el = m.el;
  el.querySelector("#tx-save")!.addEventListener("click", async () => {
    const amount = parseNum(val(el, "#tx-amount"));
    if (!amount || amount <= 0) return fail(el, "Valor inválido.");
    try {
      await api(`/api/fin/tx/${t.id}`, { method: "PUT", body: { description: val(el, "#tx-desc"), amount, date: val(el, "#tx-date"), ...(transfer ? {} : { category: val(el, "#tx-cat") || null }) } });
      clearListCaches();
      toast("Salvo");
      m.close();
      done();
    } catch (e) {
      fail(el, (e as Error).message);
    }
  });
  el.querySelector("#tx-del")!.addEventListener("click", async () => {
    if (!confirm(`Excluir "${t.description}" (${money(t.amount)})? Isso apaga o lançamento no Firefly.`)) return;
    try {
      await api(`/api/fin/tx/${t.id}`, { method: "DELETE" });
      toast("Excluído");
      m.close();
      done();
    } catch (e) {
      fail(el, (e as Error).message);
    }
  });
}

// ---------- previsto ----------

export async function openPlanned(p: Partial<Planned> | null, done: () => void) {
  const [accs, cats] = await Promise.all([getAccounts(), getCategories()]);
  let kind: Planned["kind"] = p?.kind ?? "expense";
  const editing = !!p?.id;
  const m = openModal(
    editing ? "Previsto" : "Novo previsto",
    `<p class="muted small" style="margin-top:0">Contas fixas, assinaturas e entradas que se repetem. Ficam provisionadas nos meses seguintes e, quando o lançamento de verdade aparece no extrato, viram ✓.</p>
     <div class="toggle fin-kind" role="group"><button type="button" data-k="expense" aria-pressed="${kind === "expense"}">Saída</button><button type="button" data-k="income" aria-pressed="${kind === "income"}">Entrada</button></div>
     <div class="fin-form">
       <label class="field wide">Descrição<input id="pl-desc" maxlength="120" value="${esc(p?.description ?? "")}" placeholder="Ex.: Aluguel, Spotify, Salário" /></label>
       <label class="field">Valor<div class="money-input"><b>R$</b><input id="pl-amount" inputmode="decimal" value="${p?.amount ? p.amount.toFixed(2).replace(".", ",") : ""}" /></div></label>
       <label class="field">Dia do mês<input id="pl-day" type="number" min="1" max="31" value="${p?.day ?? Number(todayIso().slice(8))}" /></label>
       <label class="field">Conta ou cartão<select id="pl-acc">${accountOptions(accs, p?.accountId ?? null, { any: "Qualquer conta" })}</select></label>
       <label class="field">Categoria<input id="pl-cat" list="fin-cats" value="${esc(p?.category ?? "")}" /></label>
       <label class="field">Repete<select id="pl-freq"><option value="monthly" ${p?.freq !== "once" ? "selected" : ""}>Todo mês</option><option value="once" ${p?.freq === "once" ? "selected" : ""}>Só uma vez</option></select></label>
       <label class="field">A partir de<input id="pl-start" type="month" value="${p?.start ?? thisMonth()}" /></label>
       <label class="field" id="pl-end-f">Até (opcional)<input id="pl-end" type="month" value="${p?.end ?? ""}" /></label>
       <label class="field wide">Como aparece no extrato <span class="muted small">(parte do nome; ex.: “energisa”, “gdy consultoria”)</span><input id="pl-match" maxlength="80" value="${esc(p?.match ?? "")}" /></label>
     </div>${catList(cats)}
     <p class="error small form-err" hidden></p>
     <div class="modal-actions">${editing ? `<button class="ghost danger" id="pl-del">Excluir</button>` : ""}<button class="primary" id="pl-save">Salvar</button></div>`,
  );
  const el = m.el;
  const freq = el.querySelector<HTMLSelectElement>("#pl-freq")!;
  const sync = () => {
    el.querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === kind)));
    el.querySelector<HTMLElement>("#pl-end-f")!.hidden = freq.value === "once";
  };
  el.querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) => b.addEventListener("click", () => ((kind = b.dataset.k as Planned["kind"]), sync())));
  freq.addEventListener("change", sync);
  sync();
  el.querySelector("#pl-save")!.addEventListener("click", async () => {
    const amount = parseNum(val(el, "#pl-amount"));
    if (!val(el, "#pl-desc")) return fail(el, "Informe a descrição.");
    if (!amount || amount <= 0) return fail(el, "Informe o valor.");
    try {
      await api("/api/fin/planned", {
        method: "PUT",
        body: {
          id: p?.id,
          kind,
          description: val(el, "#pl-desc"),
          amount,
          day: Number(val(el, "#pl-day")),
          accountId: val(el, "#pl-acc") || null,
          category: val(el, "#pl-cat") || null,
          freq: freq.value,
          start: val(el, "#pl-start"),
          end: freq.value === "once" ? null : val(el, "#pl-end") || null,
          match: val(el, "#pl-match") || null,
        },
      });
      toast("Previsto salvo");
      m.close();
      done();
    } catch (e) {
      fail(el, (e as Error).message);
    }
  });
  el.querySelector("#pl-del")?.addEventListener("click", async () => {
    if (!confirm(`Excluir o previsto "${p!.description}"? Os lançamentos já feitos continuam.`)) return;
    await api(`/api/fin/planned?id=${encodeURIComponent(p!.id!)}`, { method: "DELETE" });
    m.close();
    done();
  });
}

// ---------- orçamento da categoria ----------

export function openBudget(category: string, current: number | undefined, avg: number, done: () => void) {
  const m = openModal(
    category,
    `<p class="muted small" style="margin-top:0">Meta mensal para esta categoria. Média dos últimos meses: <b>${money(avg)}</b>.</p>
     <label class="field">Meta por mês<div class="money-input"><b>R$</b><input id="bg-v" inputmode="decimal" value="${current ? current.toFixed(2).replace(".", ",") : ""}" /></div></label>
     <p class="error small form-err" hidden></p>
     <div class="modal-actions">${current ? `<button class="ghost danger" id="bg-del">Remover meta</button>` : ""}<button class="primary" id="bg-save">Salvar</button></div>`,
  );
  const save = async (amount: number | null) => {
    try {
      await api("/api/fin/budget", { method: "PUT", body: { category, amount } });
      m.close();
      done();
    } catch (e) {
      fail(m.el, (e as Error).message);
    }
  };
  m.el.querySelector("#bg-save")!.addEventListener("click", () => {
    const v = parseNum(val(m.el, "#bg-v"));
    if (!v || v <= 0) return fail(m.el, "Informe um valor.");
    void save(v);
  });
  m.el.querySelector("#bg-del")?.addEventListener("click", () => void save(null));
}

// ---------- cartão: fechamento, vencimento e limite ----------

export function openCardConfig(c: { id: string; name: string; config: { closing: number; due: number; limit?: number } | null; paymentDay?: number | null }, done: () => void) {
  const m = openModal(
    c.name,
    `<p class="muted" style="margin-top:0">Compras feitas depois do fechamento entram na fatura seguinte. Os dias e o limite ficam salvos só aqui (o Firefly não tem fechamento).</p>
     <div class="fin-form">
       <label class="field">Dia do fechamento<input id="cc-close" type="number" inputmode="numeric" min="1" max="31" value="${c.config?.closing ?? ""}" /></label>
       <label class="field">Dia do vencimento<input id="cc-due" type="number" inputmode="numeric" min="1" max="31" value="${c.config?.due ?? c.paymentDay ?? ""}" /></label>
       <label class="field wide">Limite (opcional)<div class="money-input"><b>R$</b><input id="cc-limit" inputmode="decimal" value="${c.config?.limit ? c.config.limit.toFixed(2).replace(".", ",") : ""}" /></div></label>
     </div>
     <p class="error small form-err" hidden></p>
     <div class="modal-actions">${c.config ? `<button class="ghost danger" id="cc-clear">Remover</button>` : ""}<button class="primary" id="cc-save">Salvar</button></div>`,
  );
  const save = async (body: object) => {
    try {
      await api("/api/fin/cards", { method: "PUT", body: { id: c.id, ...body } });
      m.close();
      done();
    } catch (e) {
      fail(m.el, (e as Error).message);
    }
  };
  m.el.querySelector("#cc-save")!.addEventListener("click", () =>
    save({ closing: Number(val(m.el, "#cc-close")), due: Number(val(m.el, "#cc-due")), limit: parseNum(val(m.el, "#cc-limit")) }),
  );
  m.el.querySelector("#cc-clear")?.addEventListener("click", () => save({}));
}
