// Aba Saúde: peso e academia (wger) e atividades da Strava (só leitura, ao vivo).
import { Chart } from "chart.js";
import { api, shift, thisMonth, todayIso } from "./fin-common";
import { MONTHS, esc, fadeFill, hatch, highlightPlugin, isMobile, openModal, parseNum, toast } from "./ui";

interface Weight {
  id: string;
  date: string;
  weight: number;
}
interface GymDay {
  id: string;
  date: string;
  notes: string;
  sets: { exercise: number; name: string; reps: number | null; kg: number | null }[];
}
interface Activity {
  id: number;
  name: string;
  sport: string;
  date: string;
  km: number;
  minutes: number;
  elevation: number;
  url: string;
}
interface Status {
  connected: boolean;
  publicUrl: string;
  strava: { configured: boolean; connected: boolean; athlete: string | null };
}

const SPORTS: Record<string, string> = { Run: "Corrida", TrailRun: "Trilha", Ride: "Pedal", VirtualRide: "Pedal indoor", MountainBikeRide: "Mountain bike", GravelRide: "Gravel", Walk: "Caminhada", Hike: "Trekking", Swim: "Natação", WeightTraining: "Musculação", Workout: "Treino", Yoga: "Yoga" };
const sportName = (s: string) => SPORTS[s] ?? s;
const kg = (n: number) => `${n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg`;
const dayBR = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
const duration = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}` : `${min} min`);
const WEEK = ["D", "S", "T", "Q", "Q", "S", "S"];
const addDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/** Domingo da semana da data. */
const weekStart = (d: string) => addDays(d, -new Date(`${d}T12:00:00Z`).getUTCDay());

let calMonth = thisMonth();
let rerender: () => void = () => {};

export async function renderSaude(main: HTMLElement, charts: Chart[]) {
  rerender = () => {
    charts.splice(0).forEach((c) => {
      try {
        c.destroy();
      } catch {
        /* já destruído */
      }
    });
    void renderSaude(main, charts);
  };
  const st = await api<Status>("/api/saude").catch(() => null);
  if (!main.isConnected) return;
  if (!st) {
    main.innerHTML = `<div class="card"><p class="error">Não foi possível abrir a Saúde.</p></div>`;
    return;
  }
  const err = new URLSearchParams(location.search).get("stravaErro");
  if (err) {
    toast(err);
    history.replaceState(null, "", `${location.pathname}#saude`);
  }
  if (!st.connected) return renderConnect(main, st);

  let weights: Weight[];
  let gym: GymDay[];
  try {
    [weights, gym] = await Promise.all([api<Weight[]>("/api/saude/peso"), api<GymDay[]>("/api/saude/academia")]);
  } catch (e) {
    main.innerHTML = `<div class="card"><p class="error">Não foi possível ler o wger: ${esc((e as Error).message)}</p></div>`;
    return;
  }
  if (!main.isConnected) return;

  const today = todayIso();
  const last = weights.at(-1);
  const ref = [...weights].reverse().find((w) => w.date <= addDays(today, -30));
  const diff = last && ref ? last.weight - ref.weight : null;
  const thisM = gym.filter((d) => d.date.startsWith(today.slice(0, 7))).length;
  const thisY = gym.filter((d) => d.date.startsWith(today.slice(0, 4))).length;
  const weeks = Array.from({ length: 4 }, (_, i) => addDays(weekStart(today), -7 * (i + 1)));
  const perWeek = gym.filter((d) => d.date >= weeks.at(-1)! && d.date < weekStart(today)).length / 4;

  main.innerHTML = `
    <section class="sa-bar"><div></div><div class="fin-actions"><button class="icon" id="sa-settings" title="Conexões" aria-label="Conexões"><span class="ico" style="--icon: url(icons/settings-outline.svg)"></span></button><button class="ghost" id="sa-weight">Lançar peso</button><button class="primary" id="sa-workout">+ Registrar treino</button></div></section>
    <section class="kpis">
      <div class="card kpi"><div class="label">Peso atual</div><div class="value">${last ? kg(last.weight) : "—"}</div>${diff != null ? `<span class="delta ${diff <= 0 ? "up" : "down"}">${diff > 0 ? "+" : ""}${diff.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} kg em 30 dias</span>` : `<span class="sub">${last ? `em ${dayBR(last.date)}` : "lance o primeiro peso"}</span>`}</div>
      <div class="card kpi"><div class="label">Academia no mês</div><div class="value">${thisM}<small> dias</small></div><span class="sub">média de ${perWeek.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} por semana</span></div>
      <div class="card kpi"><div class="label">Academia em ${today.slice(0, 4)}</div><div class="value">${thisY}<small> dias</small></div><span class="sub">registrados aqui</span></div>
      <div class="card kpi" id="sa-kpi-strava"><div class="label">Strava na semana</div><div class="value">—</div><span class="sub">${st.strava.connected ? "carregando" : "não conectada"}</span></div>
    </section>
    <section class="split">
      <div class="card" id="sa-cal"></div>
      <div class="card" id="sa-peso"></div>
    </section>
    <section class="card" id="sa-strava"></section>`;

  main.querySelector("#sa-workout")!.addEventListener("click", () => openWorkout(todayIso()));
  main.querySelector("#sa-weight")!.addEventListener("click", () => openWeight(weights));
  main.querySelector("#sa-settings")!.addEventListener("click", () => openSettings(st));
  drawCalendar(main.querySelector<HTMLElement>("#sa-cal")!, gym);
  drawWeight(main.querySelector<HTMLElement>("#sa-peso")!, weights, charts);
  void drawStrava(main, st, charts);
}

// ---------- academia ----------

function drawCalendar(el: HTMLElement, gym: GymDay[]) {
  const today = todayIso();
  const [y, m] = calMonth.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map(gym.map((d) => [d.date, d]));
  const count = gym.filter((d) => d.date.startsWith(calMonth)).length;
  const cells: string[] = Array.from({ length: first }, () => `<span></span>`);
  for (let d = 1; d <= total; d++) {
    const iso = `${calMonth}-${String(d).padStart(2, "0")}`;
    const it = byDate.get(iso);
    const future = iso > today;
    cells.push(`<button class="cal-day ${it ? "on" : ""} ${iso === today ? "now" : ""} ${it && (it.sets.length || it.notes) ? "has" : ""}" data-d="${iso}" aria-pressed="${!!it}" ${future ? "disabled" : ""} aria-label="${d} de ${MONTHS[m - 1]}">${d}</button>`);
  }
  el.innerHTML = `
    <div class="row-between"><h2 style="margin:0">Academia</h2>
      <div class="month-nav"><button class="icon" data-cm="-1" aria-label="Mês anterior">‹</button><b>${MONTHS[m - 1]}/${y}</b><button class="icon" data-cm="1" aria-label="Próximo mês" ${calMonth >= thisMonth() ? "disabled" : ""}>›</button></div></div>
    <p class="muted small" style="margin:8px 0 12px"><b>${count}</b> ${count === 1 ? "dia" : "dias"} neste mês. Toque num dia para marcar ou desmarcar.</p>
    <div class="cal-grid">${WEEK.map((w) => `<span class="cal-h">${w}</span>`).join("")}${cells.join("")}</div>`;
  el.querySelectorAll<HTMLButtonElement>("[data-cm]").forEach((b) =>
    b.addEventListener("click", () => {
      calMonth = shift(calMonth, Number(b.dataset.cm));
      drawCalendar(el, gym);
    }),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-d]").forEach((b) =>
    b.addEventListener("click", async () => {
      const date = b.dataset.d!;
      const it = byDate.get(date);
      if (it && (it.sets.length || it.notes)) return openDay(it);
      b.disabled = true;
      try {
        if (it) await api(`/api/saude/academia?date=${date}`, { method: "DELETE" });
        else await api("/api/saude/academia", { method: "PUT", body: { date } });
        rerender();
      } catch (e) {
        b.disabled = false;
        toast((e as Error).message);
      }
    }),
  );
}

function openDay(d: GymDay) {
  const groups = new Map<string, GymDay["sets"]>();
  for (const s of d.sets) groups.set(s.name, [...(groups.get(s.name) ?? []), s]);
  const m = openModal(
    `Treino de ${dayBR(d.date)}`,
    `${d.notes ? `<p class="muted" style="margin-top:0">${esc(d.notes)}</p>` : ""}
     ${[...groups].map(([n, sets]) => `<div class="sa-ex"><b>${esc(n)}</b><span class="muted small">${sets.map((s) => `${s.reps ?? "–"}×${s.kg ?? "–"}kg`).join(" · ")}</span></div>`).join("") || `<p class="muted small">Sem exercícios registrados.</p>`}
     <div class="modal-actions"><button class="ghost danger" id="sd-del">Desmarcar o dia</button><button class="primary" id="sd-add">Adicionar exercícios</button></div>`,
  );
  m.el.querySelector("#sd-add")!.addEventListener("click", () => {
    m.close();
    openWorkout(d.date);
  });
  m.el.querySelector("#sd-del")!.addEventListener("click", async () => {
    if (!confirm(`Desmarcar ${dayBR(d.date)}? Os exercícios deste dia também serão apagados.`)) return;
    await api(`/api/saude/academia?date=${d.date}`, { method: "DELETE" });
    m.close();
    rerender();
  });
}

function openWorkout(date: string) {
  const m = openModal(
    "Registrar treino",
    `<div class="fin-form">
       <label class="field">Data<input id="wk-date" type="date" value="${date}" max="${todayIso()}" /></label>
       <label class="field">Observações<input id="wk-notes" maxlength="300" placeholder="Ex.: perna, pouco tempo" /></label>
     </div>
     <div id="wk-rows"></div>
     <button class="ghost" id="wk-more" type="button">+ Exercício</button>
     <p class="muted small">Os exercícios são opcionais: sem nenhum, o dia só fica marcado.</p>
     <p class="error small form-err" hidden></p>
     <div class="modal-actions"><button class="primary" id="wk-save">Salvar</button></div>`,
    { wide: true },
  );
  const box = m.el.querySelector<HTMLElement>("#wk-rows")!;
  const addRow = () => {
    const row = document.createElement("div");
    row.className = "wk-row";
    row.innerHTML = `<label class="field wk-name">Exercício<input placeholder="Buscar: supino, agachamento…" autocomplete="off" /><div class="wk-list" hidden></div></label>
      <label class="field">Séries<input class="wk-s" type="number" min="1" max="30" value="3" /></label>
      <label class="field">Reps<input class="wk-r" type="number" min="0" max="500" placeholder="10" /></label>
      <label class="field">Kg<input class="wk-k" inputmode="decimal" placeholder="20" /></label>
      <button class="icon wk-x" type="button" aria-label="Remover">✕</button>`;
    box.append(row);
    const input = row.querySelector<HTMLInputElement>(".wk-name input")!;
    const list = row.querySelector<HTMLElement>(".wk-list")!;
    let timer = 0;
    input.addEventListener("input", () => {
      delete row.dataset.ex;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return void (list.hidden = true);
      timer = window.setTimeout(async () => {
        const hits = await api<{ id: number; name: string }[]>(`/api/saude/exercicios?q=${encodeURIComponent(q)}`).catch(() => []);
        list.innerHTML = hits.map((h) => `<button type="button" data-id="${h.id}">${esc(h.name)}</button>`).join("") || `<span class="muted small">Nada encontrado. Tente em inglês (ex.: bench press) ou anote nas observações.</span>`;
        list.hidden = false;
        list.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
          b.addEventListener("click", () => {
            row.dataset.ex = b.dataset.id!;
            input.value = b.textContent ?? "";
            list.hidden = true;
          }),
        );
      }, 220);
    });
    row.querySelector(".wk-x")!.addEventListener("click", () => row.remove());
    input.focus();
  };
  m.el.querySelector("#wk-more")!.addEventListener("click", addRow);
  m.el.querySelector("#wk-save")!.addEventListener("click", async () => {
    const err = m.el.querySelector<HTMLElement>(".form-err")!;
    const rows = [...box.querySelectorAll<HTMLElement>(".wk-row")];
    const pending = rows.filter((r) => !r.dataset.ex && r.querySelector<HTMLInputElement>(".wk-name input")!.value.trim());
    if (pending.length) {
      err.hidden = false;
      err.textContent = "Escolha cada exercício na lista de sugestões.";
      return;
    }
    const exercises = rows
      .filter((r) => r.dataset.ex)
      .map((r) => ({
        exercise: Number(r.dataset.ex),
        sets: Number(r.querySelector<HTMLInputElement>(".wk-s")!.value) || 1,
        reps: Number(r.querySelector<HTMLInputElement>(".wk-r")!.value) || null,
        kg: parseNum(r.querySelector<HTMLInputElement>(".wk-k")!.value),
      }));
    const btn = m.el.querySelector<HTMLButtonElement>("#wk-save")!;
    btn.disabled = true;
    try {
      await api("/api/saude/academia", { method: "PUT", body: { date: m.el.querySelector<HTMLInputElement>("#wk-date")!.value, notes: m.el.querySelector<HTMLInputElement>("#wk-notes")!.value.trim(), exercises } });
      toast("Treino salvo");
      m.close();
      rerender();
    } catch (e) {
      btn.disabled = false;
      err.hidden = false;
      err.textContent = (e as Error).message;
    }
  });
}

// ---------- peso ----------

function drawWeight(el: HTMLElement, weights: Weight[], charts: Chart[]) {
  const recent = weights.slice(-120);
  if (!recent.length) {
    el.innerHTML = `<h2>Peso</h2><p class="muted">Sem balança inteligente, é só lançar quando se pesar: aqui, pelo botão <b>Lançar peso</b>, ou pedindo ao Claude ("pesei 78,4").</p>`;
    return;
  }
  const min = Math.min(...recent.map((w) => w.weight));
  const max = Math.max(...recent.map((w) => w.weight));
  el.innerHTML = `<div class="row-between"><h2 style="margin:0">Peso</h2><span class="muted small">mín ${kg(min)} · máx ${kg(max)}</span></div>
    <div class="chart-box"><canvas></canvas></div>
    <details class="sa-more"><summary>Últimos lançamentos</summary><div class="fin-tx">${[...weights]
      .reverse()
      .slice(0, 12)
      .map((w) => `<div class="sa-w"><span class="muted">${w.date.split("-").reverse().join("/")}</span><b>${kg(w.weight)}</b><button class="small-x" data-w="${esc(w.id)}" aria-label="Excluir">✕</button></div>`)
      .join("")}</div></details>`;
  charts.push(
    new Chart(el.querySelector("canvas")!, {
      type: "line",
      data: {
        labels: recent.map((w) => dayBR(w.date)),
        datasets: [{ data: recent.map((w) => w.weight), borderColor: "#43d66b", backgroundColor: fadeFill("67, 214, 107", 0.2), fill: true, borderWidth: 2, pointRadius: recent.length > 40 ? 0 : 3, pointBackgroundColor: "#43d66b", tension: 0.3 }],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${kg(Number(c.raw))}` } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { suggestedMin: Math.floor(min - 1), suggestedMax: Math.ceil(max + 1), ticks: { callback: (v) => `${v} kg` } } },
      },
    }),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-w]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Excluir este peso?")) return;
      await api(`/api/saude/peso?id=${encodeURIComponent(b.dataset.w!)}`, { method: "DELETE" });
      rerender();
    }),
  );
}

function openWeight(weights: Weight[]) {
  const last = weights.at(-1);
  const m = openModal(
    "Lançar peso",
    `<div class="fin-form">
       <label class="field">Peso<div class="money-input"><input id="w-v" inputmode="decimal" placeholder="${last ? String(last.weight).replace(".", ",") : "78,4"}" /><b>kg</b></div></label>
       <label class="field">Data<input id="w-d" type="date" value="${todayIso()}" max="${todayIso()}" /></label>
     </div>
     <p class="error small form-err" hidden></p>
     <div class="modal-actions"><button class="primary" id="w-save">Salvar</button></div>`,
  );
  setTimeout(() => m.el.querySelector<HTMLInputElement>("#w-v")!.focus(), 80);
  m.el.querySelector("#w-save")!.addEventListener("click", async () => {
    const v = parseNum(m.el.querySelector<HTMLInputElement>("#w-v")!.value);
    const err = m.el.querySelector<HTMLElement>(".form-err")!;
    try {
      await api("/api/saude/peso", { method: "PUT", body: { kg: v, date: m.el.querySelector<HTMLInputElement>("#w-d")!.value } });
      toast("Peso salvo");
      m.close();
      rerender();
    } catch (e) {
      err.hidden = false;
      err.textContent = (e as Error).message;
    }
  });
}

// ---------- Strava ----------

async function drawStrava(main: HTMLElement, st: Status, charts: Chart[]) {
  const el = main.querySelector<HTMLElement>("#sa-strava")!;
  if (!st.strava.connected) return renderStravaConnect(el, st);
  el.innerHTML = `<h2>Atividades</h2><div class="skeleton chart"></div>`;
  let list: Activity[];
  try {
    list = await api<Activity[]>("/api/saude/strava/atividades");
  } catch (e) {
    el.innerHTML = `<h2>Atividades</h2><p class="error small">Não foi possível ler a Strava: ${esc((e as Error).message)}</p>`;
    return;
  }
  if (!el.isConnected) return;
  const today = todayIso();
  const cur = weekStart(today);
  const week = list.filter((a) => a.date >= cur);
  const kp = main.querySelector<HTMLElement>("#sa-kpi-strava");
  if (kp) kp.innerHTML = `<div class="label">Strava na semana</div><div class="value">${week.reduce((s, a) => s + a.km, 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}<small> km</small></div><span class="sub">${week.length} ${week.length === 1 ? "atividade" : "atividades"} · ${duration(week.reduce((s, a) => s + a.minutes, 0))}</span>`;
  const starts = Array.from({ length: isMobile() ? 8 : 12 }, (_, i) => addDays(cur, -7 * (isMobile() ? 7 - i : 11 - i)));
  const perWeek = starts.map((s) => {
    const e = addDays(s, 7);
    return Math.round(list.filter((a) => a.date >= s && a.date < e).reduce((t, a) => t + a.km, 0) * 10) / 10;
  });
  const lastI = perWeek.length - 1;
  el.innerHTML = `<div class="row-between"><h2 style="margin:0">Atividades</h2><span class="muted small">km por semana</span></div>
    <div class="chart-box"><canvas></canvas></div>
    <details class="sa-more"><summary>Últimas atividades</summary><div class="fin-tx">${list
      .slice(0, 15)
      .map((a) => `<div class="sa-act"><span class="t"><b>${esc(a.name)}</b><span class="muted small">${dayBR(a.date)} · ${esc(sportName(a.sport))}${a.km ? ` · ${a.km.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km` : ""} · ${duration(a.minutes)}</span></span><a href="${esc(a.url)}" target="_blank" rel="noopener">View on Strava</a></div>`)
      .join("")}</div></details>
    <p class="note strava-mark">Powered by Strava. Lido ao vivo, só para você; nada fica salvo aqui.</p>`;
  charts.push(
    new Chart(el.querySelector("canvas")!, {
      type: "bar",
      data: { labels: starts.map(dayBR), datasets: [{ data: perWeek, backgroundColor: perWeek.map((_, i) => (i === lastI ? "#fc5200" : hatch("rgba(252,82,0,0.7)", "rgba(252,82,0,0.06)"))), borderRadius: 999, borderSkipped: false, barPercentage: 0.6 }] },
      plugins: [highlightPlugin],
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: { raw: unknown }) => ` ${Number(c.raw).toLocaleString("pt-BR")} km` } }, highlight: { index: lastI, text: `${perWeek[lastI]!.toLocaleString("pt-BR")} km` } } as any,
        scales: { x: { grid: { display: false } }, y: { ticks: { callback: (v) => `${v} km` } } },
      },
    }),
  );
}

function renderStravaConnect(el: HTMLElement, st: Status) {
  const callback = location.hostname;
  if (st.strava.configured) {
    el.innerHTML = `<h2>Atividades</h2><p class="muted">Chaves salvas. Falta autorizar a leitura das suas atividades.</p><a class="strava-connect" href="/api/saude/strava/auth">Connect with Strava</a>`;
    return;
  }
  el.innerHTML = `<h2>Atividades</h2>
    <p class="muted" style="margin-top:0">Para ver corridas e pedais aqui, crie o seu app pessoal na Strava:</p>
    <ol class="muted">
      <li>Abra <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a> e crie o app. Em <b>Authorization Callback Domain</b>, coloque <code>${esc(callback)}</code>.</li>
      <li>Cole aqui o <b>Client ID</b> e o <b>Client Secret</b>, que ficam guardados cifrados.</li>
    </ol>
    <form id="sv-form" class="fin-form">
      <label class="field">Client ID<input name="id" inputmode="numeric" autocomplete="off" required /></label>
      <label class="field">Client Secret<input name="secret" type="password" autocomplete="off" required /></label>
    </form>
    <p class="error small form-err" hidden></p>
    <div class="modal-actions"><button class="primary" form="sv-form" type="submit">Salvar e continuar</button></div>`;
  el.querySelector<HTMLFormElement>("#sv-form")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    try {
      await api("/api/saude/strava", { method: "PUT", body: { clientId: (f.elements.namedItem("id") as HTMLInputElement).value, clientSecret: (f.elements.namedItem("secret") as HTMLInputElement).value } });
      rerender();
    } catch (err) {
      const b = el.querySelector<HTMLElement>(".form-err")!;
      b.hidden = false;
      b.textContent = (err as Error).message;
    }
  });
}

// ---------- conexão ----------

function renderConnect(main: HTMLElement, st: Status) {
  const url = st.publicUrl || "o endereço do wger";
  main.innerHTML = `<div class="card fin-connect">
    <h2>Conectar o wger</h2>
    <p class="muted">O peso, os dias de academia e os treinos ficam no wger; esta aba mostra tudo e você não precisa voltar nele depois.</p>
    <ol class="muted">
      <li>Abra ${st.publicUrl ? `<a href="${esc(st.publicUrl)}" target="_blank" rel="noopener">${esc(url)}</a>` : esc(url)} na sua rede de casa e entre com o usuário <code>admin</code> e a senha <code>adminadmin</code>.</li>
      <li><b>Troque essa senha agora</b>, no menu do usuário.</li>
      <li>Ainda no menu do usuário, abra <b>API key</b>, gere a chave e cole aqui. Ela fica guardada cifrada.</li>
    </ol>
    <form id="sa-connect" class="fin-connect-form">
      <input name="token" type="password" autocomplete="off" placeholder="Chave da API do wger" required />
      <button class="primary" type="submit">Conectar</button>
    </form>
    <p class="error small form-err" hidden></p></div>`;
  main.querySelector<HTMLFormElement>("#sa-connect")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = ((e.target as HTMLFormElement).elements.namedItem("token") as HTMLInputElement).value;
    try {
      await api("/api/saude/token", { method: "PUT", body: { token } });
      toast("wger conectado");
      rerender();
    } catch (err) {
      const b = main.querySelector<HTMLElement>(".form-err")!;
      b.hidden = false;
      b.textContent = (err as Error).message;
    }
  });
}

function openSettings(st: Status) {
  const m = openModal(
    "Conexões da Saúde",
    `<p class="muted" style="margin-top:0"><b>wger:</b> conectado${st.publicUrl ? ` (<a href="${esc(st.publicUrl)}" target="_blank" rel="noopener">abrir</a>, só na sua rede)` : ""}.</p>
     <p class="muted"><b>Strava:</b> ${st.strava.connected ? `conectada${st.strava.athlete ? ` como ${esc(st.strava.athlete)}` : ""}` : st.strava.configured ? "chaves salvas, falta autorizar" : "não conectada"}.</p>
     <div class="modal-actions">${st.strava.configured ? `<button class="ghost danger" id="st-strava">Desconectar a Strava</button>` : ""}<button class="ghost danger" id="st-wger">Desconectar o wger</button><button class="primary" id="st-ok">Fechar</button></div>`,
  );
  m.el.querySelector("#st-ok")!.addEventListener("click", m.close);
  m.el.querySelector("#st-strava")?.addEventListener("click", async () => {
    if (!confirm("Desconectar a Strava? Nada é apagado na sua conta.")) return;
    await api("/api/saude/strava", { method: "DELETE" });
    m.close();
    rerender();
  });
  m.el.querySelector("#st-wger")!.addEventListener("click", async () => {
    if (!confirm("Desconectar o wger? Os dados continuam lá; só esta aba deixa de mostrar.")) return;
    await api("/api/saude/token", { method: "DELETE" });
    m.close();
    rerender();
  });
}
