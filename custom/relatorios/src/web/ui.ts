// Peças de interface compartilhadas: formatação, cores, modal animado, skeletons e avisos.

export const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9", "#008300", "#e66767", "#898781"];
export const CATEGORY_COLOR: Record<string, string> = {
  Ações: PALETTE[0]!, FIIs: PALETTE[1]!, ETFs: PALETTE[2]!, BDRs: PALETTE[3]!, Exterior: PALETTE[4]!,
  "Tesouro Direto": PALETTE[5]!, "Renda Fixa": PALETTE[6]!, Cripto: PALETTE[7]!, Outros: PALETTE[8]!,
};
export const ACCENT = "#36cfcc";
export const colorOf = (category: string) => CATEGORY_COLOR[category] ?? PALETTE[8]!;

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const money = (n: number) => brl.format(n);
export const pct = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
export const spct = (n: number | null | undefined, d = 2) => (n == null ? "—" : `${n > 0 ? "+" : ""}${pct(n, d)}`);
export const qty = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 4 });
export const tone = (n: number | null | undefined) => (n == null ? "" : n > 0.00005 ? "up" : n < -0.00005 ? "down" : "");
export const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
export const dateBR = (d: string) => d.split("-").reverse().join("/");
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Número no formato brasileiro: "10.000" e "10.000,50" (ponto = milhar), "1234,56"; aceita
 * "1234.56" quando o ponto só pode ser decimal. Ignora "R$" e "%". Vazio/inválido -> null.
 */
export function parseNum(v: string): number | null {
  const t = v.trim().replace(/[R$\s%]/g, "");
  if (!t) return null;
  let norm: string;
  if (t.includes(",")) norm = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) norm = t.replace(/\./g, ""); // 10.000 / 1.250.000
  else norm = t;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Modal ----------

export interface ModalHandle {
  el: HTMLElement;
  close: () => void;
}

/** Abre um modal com animação de entrada e saída; fecha com Esc, clique fora ou botão. */
export function openModal(title: string, bodyHtml: string, opts: { wide?: boolean; onClose?: () => void } = {}): ModalHandle {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal ${opts.wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header class="modal-head"><h2>${esc(title)}</h2><button class="icon modal-x" aria-label="Fechar">✕</button></header>
    <div class="modal-body">${bodyHtml}</div></div>`;
  document.body.append(backdrop);
  document.body.classList.add("modal-open");
  const previous = document.activeElement as HTMLElement | null;
  requestAnimationFrame(() => backdrop.classList.add("open"));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove("open");
    backdrop.classList.add("closing");
    const done = () => {
      backdrop.remove();
      if (!document.querySelector(".modal-backdrop")) document.body.classList.remove("modal-open");
      previous?.focus?.();
      opts.onClose?.();
    };
    if (reducedMotion()) done();
    else setTimeout(done, 200);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (e) => e.target === backdrop && close());
  backdrop.querySelector(".modal-x")!.addEventListener("click", close);
  const el = backdrop.querySelector(".modal") as HTMLElement;
  setTimeout(() => (el.querySelector("input, select, button:not(.modal-x)") as HTMLElement | null)?.focus(), 60);
  return { el, close };
}

// ---------- Skeletons ----------

const sk = (cls: string) => `<div class="skeleton ${cls}"></div>`;
export function skeleton(tab: string) {
  const kpis = `<section class="kpis">${Array.from({ length: 4 }, () => `<div class="card">${sk("line short")}${sk("line big")}${sk("line")}</div>`).join("")}</section>`;
  const chart = (h = "chart") => `<section class="card">${sk("line short")}${sk(h)}</section>`;
  switch (tab) {
    case "carteira":
      return `<section class="split">${chart("donut")}${chart("donut")}</section>${chart("rows")}${chart("rows")}`;
    case "rentabilidade":
      return `${chart("rows tall")}${chart("rows")}`;
    case "simulacao":
      return `<section class="sim-layout"><div class="sim-config">${chart("rows")}${chart("rows")}</div><div>${chart("chart")}${chart("rows")}</div></section>`;
    default:
      return `${kpis}<section class="split-1-2">${chart("rows")}${chart("chart")}</section>`;
  }
}

// ---------- Aviso rápido ----------

export function toast(msg: string) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 1800);
}
