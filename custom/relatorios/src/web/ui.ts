// Peças de interface compartilhadas: formatação, cores, modal animado, skeletons e avisos.

export const PALETTE = ["#5ab8f0", "#f07a4f", "#43d66b", "#f3c623", "#e562a8", "#8b8ff8", "#2fb5a4", "#f04f55", "#8a8f8c"];
export const CATEGORY_COLOR: Record<string, string> = {
  Ações: PALETTE[0]!, FIIs: PALETTE[1]!, Fiagros: PALETTE[2]!, ETFs: "#4bb4b0", BDRs: PALETTE[3]!, Exterior: PALETTE[4]!,
  "Tesouro Direto": PALETTE[5]!, "Renda Fixa": PALETTE[6]!, Cripto: PALETTE[7]!, Outros: PALETTE[8]!,
};
export const ACCENT = "#43d66b";
export const colorOf = (category: string) => CATEGORY_COLOR[category] ?? PALETTE[8]!;

/** "Vista do Apresentador": esconde valores absolutos e quantidades (percentuais continuam). */
export const privacy = { on: false };
export const MASK = "R$ •••••";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const money = (n: number) => (privacy.on ? MASK : brl.format(n));
export const pct = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
export const spct = (n: number | null | undefined, d = 2) => (n == null ? "—" : `${n > 0 ? "+" : ""}${pct(n, d)}`);
export const qty = (n: number) => (privacy.on ? "•••" : n.toLocaleString("pt-BR", { maximumFractionDigits: 4 }));
/** Rótulo de eixo em R$ (oculto na Vista do Apresentador). */
export const axisMoney = (v: number | string, suffix = "") => (privacy.on ? "•••" : `R$ ${Number(v).toLocaleString("pt-BR")}${suffix}`);
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

// ---------- Animações dos gráficos (Chart.js) ----------
// Tipadas como `any` para servir a qualquer tipo de gráfico sem brigar com os genéricos.

/** Barras que sobem da base em cascata. */
export function growBars(): any {
  if (reducedMotion()) return false;
  return {
    duration: 650,
    easing: "easeOutCubic",
    delay: (ctx: any) => (ctx.type === "data" && ctx.mode === "default" ? ctx.dataIndex * 28 + ctx.datasetIndex * 60 : 0),
  };
}

/** Rosca que gira e cresce até o lugar. */
export function spinDonut(): any {
  if (reducedMotion()) return false;
  return { animateRotate: true, animateScale: true, duration: 950, easing: "easeOutQuart" };
}

/** Degradê vertical sob uma linha (cor no topo, transparente na base). */
export function fadeFill(rgb: string, alpha = 0.28) {
  return (ctx: any) => {
    const { chart } = ctx;
    const area = chart.chartArea;
    if (!area) return "transparent";
    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    return g;
  };
}

/** Faz os valores em R$ dos cartões de destaque contarem até o número final. */
export function countUp(root: ParentNode, selector = ".kpi .value") {
  if (reducedMotion()) return;
  root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    const text = el.textContent?.trim() ?? "";
    const m = /^(-?)\s?R\$\s?([\d.]+,\d{2})$/.exec(text);
    if (!m) return;
    const target = Number(m[2]!.replace(/\./g, "").replace(",", ".")) * (m[1] ? -1 : 1);
    const start = performance.now();
    const duration = 750;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = money(target * eased);
      if (t < 1 && el.isConnected) requestAnimationFrame(tick);
      else el.textContent = text;
    };
    requestAnimationFrame(tick);
  });
}

// ---------- Celular ----------
export const MOBILE_QUERY = window.matchMedia("(max-width: 575.98px)");
export const isMobile = () => MOBILE_QUERY.matches;

/**
 * Eixo X dos gráficos de linha: no celular, menos marcas e datas curtas ("out/25" em vez de
 * "24/10/2025"), para não se sobreporem.
 */
export function xTicks(maxDesktop = 6): any {
  const mobile = isMobile();
  return {
    maxTicksLimit: mobile ? 4 : maxDesktop,
    maxRotation: 0,
    autoSkipPadding: mobile ? 14 : 8,
    callback(this: any, v: number) {
      const label = String(this.getLabelForValue(v));
      const m = /^(\d{2})\/(\d{2})\/\d{2}(\d{2})$/.exec(label);
      return mobile && m ? `${MONTHS[Number(m[2]) - 1]!.toLowerCase()}/${m[3]}` : label;
    },
  };
}

// ---------- Gráficos no estilo do painel: barras hachuradas e destaque ----------

/** Preenchimento listrado na diagonal (barras "apagadas"). */
export function hatch(color = "rgba(255,255,255,0.32)", bg = "rgba(255,255,255,0.03)") {
  const c = document.createElement("canvas");
  const s = 8 * (window.devicePixelRatio || 1);
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = color;
  g.lineWidth = s / 8;
  g.beginPath();
  for (const o of [-s, 0, s]) {
    g.moveTo(o, s);
    g.lineTo(o + s, 0);
  }
  g.stroke();
  return g.createPattern(c, "repeat")!;
}

/**
 * Plugin: escreve o valor num selo acima da barra destacada (`options.plugins.highlight.index`).
 */
export const highlightPlugin = {
  id: "highlight",
  afterDatasetsDraw(chart: any, _args: unknown, opts: { index?: number; text?: string }) {
    if (opts?.index == null || !opts.text) return;
    const meta = chart.getDatasetMeta(0);
    const el = meta?.data?.[opts.index];
    if (!el) return;
    const ctx = chart.ctx as CanvasRenderingContext2D;
    ctx.save();
    ctx.font = '600 11px "Manrope", sans-serif';
    const w = ctx.measureText(opts.text).width + 14;
    const x = el.x - w / 2;
    const y = Math.max(chart.chartArea.top - 2, el.y - 30);
    ctx.fillStyle = "rgba(30,33,31,0.96)";
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.beginPath();
    ctx.roundRect(x, y, w, 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f3f5f4";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(opts.text, el.x, y + 10);
    ctx.restore();
  },
};
