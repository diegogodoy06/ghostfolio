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
 * Além do dono (GHOSTFOLIO_ACCESS_TOKEN, extratos na raiz da pasta), sincroniza os outros usuários
 * que enviaram extratos pelos relatórios (users.ts), cada um na própria conta.
 *
 * Variáveis: GHOSTFOLIO_URL, GHOSTFOLIO_ACCESS_TOKEN, EXTRATOS_DIR (/extratos), DATA_DIR (/data),
 * RELATORIOS_DATA_DIR (/relatorios), SYNC_HOUR_UTC (12 = 9h em Brasília), RUN_ONCE=1, DRY_RUN=1,
 * FORCE_RESYNC=1.
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
import { type Api, connect, getActivities, waitForGhostfolio } from "./ghostfolio";
import { extraUsers } from "./users";
import { type State, loadState, saveState } from "./state";
import { DRY_RUN, log } from "./util";

const URL_BASE = process.env.GHOSTFOLIO_URL ?? "http://ghostfolio:3333";
const EXTRATOS_DIR = process.env.EXTRATOS_DIR ?? "/extratos";
const SYNC_HOUR_UTC = Number(process.env.SYNC_HOUR_UTC ?? 12);

function readAjustes(dir: string): Ajuste[] {
  const file = path.join(dir, "ajustes.json");
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Ajuste[];
  } catch (err) {
    throw new Error(`ajustes.json inválido: ${(err as Error).message}`);
  }
}

/** Impressão digital das pastas de extratos (dono e usuários) e dos cadastros de usuários. */
function folderFingerprint() {
  const dirs = [EXTRATOS_DIR, ...extraUsers(EXTRATOS_DIR).map((u) => u.dir)];
  const parts = extraUsers(EXTRATOS_DIR).map((u) => `user:${u.id}`);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /\.(xlsx|json)$/i.test(x)).sort()) {
      const st = fs.statSync(path.join(dir, f));
      parts.push(`${dir}/${f}:${st.size}:${st.mtimeMs}`);
    }
  }
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    log(`erro em ${name}:`, (err as Error).message);
  }
}

/** Sincroniza a conta de um usuário: extratos, câmbio, países, proventos e Tesouro. */
async function syncUser(label: string, api: Api, admin: Api, dir: string, state: State) {
  // Com a "Vista do Apresentador" ligada, o Ghostfolio apaga quantidades, valores e comentários
  // das respostas da API; sincronizar assim duplicaria ou apagaria atividades. Pausa a conta.
  const user = await api<{ settings?: { isRestrictedView?: boolean } }>("GET", "/v1/user");
  if (user.settings?.isRestrictedView) {
    log(`⚠ ${label}: Vista do Apresentador ligada no Ghostfolio; a API esconde os valores. Sincronização pausada até ser desligada (Ajustes da conta).`);
    return null;
  }
  await step(`${label}: configuração inicial`, () => ensureCurrencySetup(api, state));

  let activities = await getActivities(api);
  const files = listStatements(dir);
  if (files.some((f) => /movimenta/i.test(path.basename(f)))) {
    await step(`${label}: extratos`, async () => {
      const { activities: desired, warnings } = await buildDesired(files, readAjustes(dir));
      for (const w of warnings) log(`⚠ ${label}: ${w}`);
      const { created } = await syncB3Accounts(api, desired, activities);
      if (created) activities = await getActivities(api);
    });
  } else {
    log(`${label}: nenhum arquivo de Movimentação em ${dir}; contas da B3 não foram alteradas`);
  }

  const oldest = activities.reduce<string | null>((m, a) => (!m || a.date < m ? a.date : m), null);
  // Coleta de cotações e países são tarefas de administrador: rodam com o token do dono.
  await step(`${label}: câmbio histórico`, () => ensureHistoricalData(admin, state, oldest));
  await step(`${label}: países`, () => syncProfiles(admin, activities));
  await step(`${label}: proventos`, () => syncDividends(api, activities));
  await step(`${label}: tesouro`, async () => {
    await syncTesouro(api, activities, !state.tesouroHistoryLoaded);
    if (!DRY_RUN) state.tesouroHistoryLoaded = true;
  });
  return oldest;
}

let running = false;
async function runOnce(reason: string) {
  if (running) return;
  running = true;
  const state = loadState();
  try {
    log(`— sincronizando (${reason})${DRY_RUN ? " [dry-run]" : ""}`);
    const admin = await connect(URL_BASE);
    const oldest = await syncUser("dono", admin, admin, EXTRATOS_DIR, state);
    for (const u of extraUsers(EXTRATOS_DIR)) {
      const label = u.name ?? `usuário ${u.id.slice(0, 8)}`;
      try {
        const api = await connect(URL_BASE, u.token);
        state.users ??= {};
        await syncUser(label, api, admin, u.dir, (state.users[u.id] ??= {}));
      } catch (err) {
        log(`${label}: falha:`, (err as Error).message);
      }
    }
    await step("benchmarks", () => syncBenchmarks(admin, oldest?.slice(0, 10) ?? null));
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
