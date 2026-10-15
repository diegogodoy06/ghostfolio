// "Analisar com Claude": monta um prompt com os dados da carteira para colar no Claude.
import type { Report } from "../shared";
import { TASKS, buildContext, buildPrompt } from "../context";
import { ensureParams, simQuotes } from "./simulacao";
import { esc, openModal, privacy, toast } from "./ui";

/** Copia texto; usa o método antigo quando a página não é HTTPS/localhost (ex.: celular pela rede). */
async function copyText(text: string, fallbackEl: HTMLTextAreaElement) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // cai no método antigo
  }
  fallbackEl.focus();
  fallbackEl.select();
  return document.execCommand("copy");
}

export async function openClaudeModal(r: Report) {
  const params = await ensureParams(r).catch(() => null);
  const hasSim = !!params && (params.contribution > 0 || params.sales.length > 0 || (params.buys?.length ?? 0) > 0 || params.allowSells);
  let task = TASKS[0]!;
  let hide = privacy.on;
  let withSim = !!params;
  let edited = false;

  const m = openModal(
    "Analisar com Claude",
    `<p class="muted" style="margin-top:0">Monta um prompt com os dados atuais da carteira. Cole no Claude (claude.ai, app ou Desktop) para gerar a análise. No Claude Desktop/Code você também pode usar o conector MCP “carteira”, que consulta os dados direto.</p>
     <div class="chips" id="c-tasks">${TASKS.filter((t) => !t.needsSim || hasSim)
       .map((t) => `<button class="chip" data-task="${t.id}" aria-pressed="${t.id === task.id}">${esc(t.label)}</button>`)
       .join("")}</div>
     <div class="claude-opts">
       <label class="switch"><input type="checkbox" id="c-hide" ${hide ? "checked" : ""}/><span></span>Só percentuais (sem valores em R$ nem quantidades)</label>
       ${params ? `<label class="switch"><input type="checkbox" id="c-sim" ${withSim ? "checked" : ""}/><span></span>Incluir metas${hasSim ? " e a simulação salva" : ""}</label>` : ""}
     </div>
     <textarea id="c-text" class="prompt-box" spellcheck="false"></textarea>
     <div class="row-between" style="margin-top:12px">
       <span class="muted small" id="c-size"></span>
       <div class="sim-buttons">
         <button class="ghost" id="c-download">Baixar .md</button>
         <button class="ghost" id="c-copy">Copiar</button>
         <button class="primary" id="c-open">Copiar e abrir o Claude</button>
       </div>
     </div>`,
    { wide: true },
  );
  const $ = <T extends HTMLElement>(s: string) => m.el.querySelector(s) as T;
  const text = $<HTMLTextAreaElement>("#c-text");

  const regen = () => {
    const ctx = buildContext(r, { hideValues: hide, simulation: withSim && params ? { params, quotes: simQuotes() } : null });
    text.value = buildPrompt(ctx, task.prompt);
    edited = false;
    sizeLabel();
    if (task.id === "livre") {
      text.focus();
      const pos = text.value.indexOf("(escreva sua pergunta aqui)");
      if (pos >= 0) text.setSelectionRange(pos, pos + "(escreva sua pergunta aqui)".length);
    }
  };
  const sizeLabel = () => ($("#c-size").textContent = `${text.value.length.toLocaleString("pt-BR")} caracteres${edited ? " · editado" : ""}`);
  const confirmRegen = () => !edited || confirm("Descartar as edições no texto?");

  m.el.querySelectorAll<HTMLButtonElement>("[data-task]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!confirmRegen()) return;
      task = TASKS.find((t) => t.id === b.dataset.task)!;
      m.el.querySelectorAll("[data-task]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      regen();
    }),
  );
  $<HTMLInputElement>("#c-hide").addEventListener("change", (e) => {
    if (!confirmRegen()) return void ((e.target as HTMLInputElement).checked = hide);
    hide = (e.target as HTMLInputElement).checked;
    regen();
  });
  m.el.querySelector("#c-sim")?.addEventListener("change", (e) => {
    if (!confirmRegen()) return void ((e.target as HTMLInputElement).checked = withSim);
    withSim = (e.target as HTMLInputElement).checked;
    regen();
  });
  text.addEventListener("input", () => {
    edited = true;
    sizeLabel();
  });

  $("#c-copy").addEventListener("click", async () => toast((await copyText(text.value, text)) ? "Prompt copiado" : "Não consegui copiar; selecione e copie manualmente"));
  $("#c-open").addEventListener("click", async () => {
    const ok = await copyText(text.value, text);
    toast(ok ? "Copiado. Cole no Claude (Cmd/Ctrl + V)" : "Não consegui copiar; selecione e copie manualmente");
    if (ok) window.open("https://claude.ai/new", "_blank", "noopener");
  });
  $("#c-download").addEventListener("click", () => {
    const blob = new Blob([text.value], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `carteira-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  regen();
}
