// Envio dos extratos da B3 pelo navegador (Mac ou celular). A sincronização percebe a mudança
// na pasta em até um minuto e atualiza o Ghostfolio sozinha.
import { esc, openModal, toast } from "./ui";

interface ExtratoFile {
  name: string;
  size: number;
  modified: string;
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`);
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function openExtratosModal() {
  const m = openModal(
    "Extratos da B3",
    `<p class="muted" style="margin-top:0">Baixe na <b>Área do Investidor da B3</b> os extratos de <b>Movimentação</b> e de <b>Posição</b> (Excel) e envie aqui. A sincronização atualiza o Ghostfolio sozinha em até um minuto. Também aceita <code>ajustes.json</code> e <code>categorias.json</code>.</p>
     <label class="dropzone" tabindex="0"><input type="file" multiple accept=".xlsx,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json" hidden/>
       <span class="ico" style="--icon: url(icons/cloud-upload-outline.svg)"></span><b>Escolher arquivos</b><span class="muted small">ou arraste para cá</span></label>
     <p class="error small" id="x-error" hidden></p>
     <h3>Na pasta</h3><div id="x-list" class="x-list"><p class="muted small">Carregando…</p></div>`,
    { wide: true },
  );
  const list = m.el.querySelector<HTMLElement>("#x-list")!;
  const err = m.el.querySelector<HTMLElement>("#x-error")!;
  const input = m.el.querySelector<HTMLInputElement>("input[type=file]")!;
  const zone = m.el.querySelector<HTMLElement>(".dropzone")!;

  const refresh = async () => {
    const res = await fetch("/api/extratos");
    if (!res.ok) {
      list.innerHTML = `<p class="error small">Não foi possível ler a pasta de extratos.</p>`;
      return;
    }
    const { files, writable } = (await res.json()) as { files: ExtratoFile[]; writable: boolean };
    if (!writable) {
      zone.classList.add("disabled");
      err.hidden = false;
      err.textContent = "A pasta de extratos está somente leitura neste servidor. Atualize o compose.yml (volume ./extratos sem :ro no serviço de relatórios).";
    }
    list.innerHTML = files.length
      ? files
          .map(
            (f) => `<div class="x-row"><span class="x-name">${esc(f.name)}</span><span class="muted small">${kb(f.size)} · ${when(f.modified)}</span>
              <button class="icon x-del" data-name="${esc(f.name)}" aria-label="Remover ${esc(f.name)}" title="Remover">✕</button></div>`,
          )
          .join("")
      : `<p class="muted small">Nenhum arquivo ainda.</p>`;
    list.querySelectorAll<HTMLButtonElement>(".x-del").forEach((b) =>
      b.addEventListener("click", async () => {
        const name = b.dataset.name!;
        if (!confirm(`Remover ${name}? As operações que só existem nele podem sair do Ghostfolio na próxima sincronização.`)) return;
        const r = await fetch(`/api/extratos?name=${encodeURIComponent(name)}`, { method: "DELETE" });
        toast(r.ok ? `${name} removido` : "Não foi possível remover");
        void refresh();
      }),
    );
  };

  const upload = async (files: FileList | File[]) => {
    err.hidden = true;
    const arr = [...files];
    if (!arr.length) return;
    zone.classList.add("busy");
    const failed: string[] = [];
    for (const f of arr) {
      const r = await fetch(`/api/extratos?name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f });
      if (!r.ok) failed.push(`${f.name}: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText}`);
    }
    zone.classList.remove("busy");
    input.value = "";
    if (failed.length) {
      err.hidden = false;
      err.textContent = failed.join(" · ");
    }
    const ok = arr.length - failed.length;
    if (ok) toast(`${ok} arquivo(s) enviado(s). O Ghostfolio será atualizado em até um minuto.`);
    void refresh();
  };

  input.addEventListener("change", () => input.files && void upload(input.files));
  zone.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click()));
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    if (e.dataTransfer?.files) void upload(e.dataTransfer.files);
  });
  void refresh();
}
