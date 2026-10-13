/**
 * ghostfolio-sync: tudo que precisa acontecer automaticamente ao subir o Ghostfolio.
 *
 * Ao iniciar, uma vez por dia e sempre que a pasta de extratos muda:
 *  1. configuração inicial (moeda BRL, moeda base, câmbio histórico);
 *  2. contas da B3 iguais aos extratos (.xlsx) + ajustes.json da pasta de extratos;
 *  3. proventos automáticos (Yahoo) até o extrato trazer o valor real;
 *  4. preço do Tesouro Direto (Tesouro Transparente);
 *  5. benchmarks: CDI, IPCA, IPCA + 6%, IFIX, Ibovespa e dólar;
 *  6. país dos ativos sem essa informação (mapa de regiões).
 *
 * Variáveis: GHOSTFOLIO_URL, GHOSTFOLIO_ACCESS_TOKEN, EXTRATOS_DIR (/extratos), DATA_DIR (/data),
 * SYNC_HOUR_UTC (12 = 9h em Brasília), RUN_ONCE=1, DRY_RUN=1, FORCE_RESYNC=1.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Ajuste, buildDesired, listStatements } from "./convert";
import { syncB3Accounts } from "./b3sync";
import { syncDividends } from "./dividends";
import { syncTesouro } from "./tesouro";
import { syncBenchmarks } from "./benchmarks";
import { syncProfiles } from "./profiles";
import { ensureCurrencySetup, ensureHistoricalData } from "./bootstrap";
import { connect, getActivities, waitForGhostfolio } from "./ghostfolio";
import { loadState, saveState } from "./state";
import { DRY_RUN, log } from "./util";

const URL_BASE = process.env.GHOSTFOLIO_URL ?? "http://ghostfolio:3333";
const EXTRATOS_DIR = process.env.EXTRATOS_DIR ?? "/extratos";
const SYNC_HOUR_UTC = Number(process.env.SYNC_HOUR_UTC ?? 12);

function readAjustes(): Ajuste[] {
  const file = path.join(EXTRATOS_DIR, "ajustes.json");
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Ajuste[];
  } catch (err) {
    throw new Error(`ajustes.json inválido: ${(err as Error).message}`);
  }
}

/** Impressão digital da pasta de extratos (nomes, tamanhos e datas de modificação). */
function folderFingerprint() {
  if (!fs.existsSync(EXTRATOS_DIR)) return "";
  const parts = fs
    .readdirSync(EXTRATOS_DIR)
    .filter((f) => /\.(xlsx|json)$/i.test(f))
    .sort()
    .map((f) => {
      const s = fs.statSync(path.join(EXTRATOS_DIR, f));
      return `${f}:${s.size}:${s.mtimeMs}`;
    });
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    log(`erro em ${name}:`, (err as Error).message);
  }
}

let running = false;
async function runOnce(reason: string) {
  if (running) return;
  running = true;
  const state = loadState();
  try {
    log(`— sincronizando (${reason})${DRY_RUN ? " [dry-run]" : ""}`);
    const api = await connect(URL_BASE);
    await step("configuração inicial", () => ensureCurrencySetup(api, state));

    let activities = await getActivities(api);
    const files = listStatements(EXTRATOS_DIR);
    if (files.some((f) => /movimenta/i.test(path.basename(f)))) {
      await step("extratos", async () => {
        const { activities: desired, warnings } = await buildDesired(files, readAjustes());
        for (const w of warnings) log(`⚠ ${w}`);
        const { created } = await syncB3Accounts(api, desired, activities);
        if (created) activities = await getActivities(api);
      });
    } else {
      log(`extratos: nenhum arquivo de Movimentação em ${EXTRATOS_DIR}; contas da B3 não foram alteradas`);
    }

    const oldest = activities.reduce<string | null>((m, a) => (!m || a.date < m ? a.date : m), null);
    await step("câmbio histórico", () => ensureHistoricalData(api, state, oldest));
    await step("países", () => syncProfiles(api, activities));
    await step("proventos", () => syncDividends(api, activities));
    await step("tesouro", async () => {
      await syncTesouro(api, activities, !state.tesouroHistoryLoaded);
      if (!DRY_RUN) state.tesouroHistoryLoaded = true;
    });
    await step("benchmarks", () => syncBenchmarks(api, oldest?.slice(0, 10) ?? null));
    log("— concluído");
  } catch (err) {
    log("falha:", (err as Error).message);
  } finally {
    if (!DRY_RUN) {
      try {
        saveState(state);
      } catch (err) {
        log("aviso: não foi possível gravar o estado:", (err as Error).message);
      }
    }
    running = false;
  }
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SYNC_HOUR_UTC));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function main() {
  log(`aguardando o Ghostfolio em ${URL_BASE}…`);
  await waitForGhostfolio(URL_BASE);
  await runOnce("início");
  if (process.env.RUN_ONCE === "1") return;

  // Execução diária.
  const daily = () => setTimeout(async () => {
    await runOnce("rotina diária");
    daily();
  }, msUntilNextRun());
  daily();

  // Pasta de extratos: novo arquivo (ou ajustes.json alterado) dispara uma sincronização.
  let fingerprint = folderFingerprint();
  setInterval(async () => {
    const now = folderFingerprint();
    if (now === fingerprint) return;
    fingerprint = now;
    // Espera o arquivo terminar de ser copiado.
    await new Promise((r) => setTimeout(r, 5_000));
    await runOnce("extratos alterados");
  }, 30_000);
  log(`próxima rotina diária em ${(msUntilNextRun() / 3_600_000).toFixed(1)} h; monitorando ${EXTRATOS_DIR}`);
}

main();
