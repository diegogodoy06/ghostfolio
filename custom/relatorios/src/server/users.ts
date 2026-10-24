/**
 * Vários usuários do Ghostfolio: cada um entra nos relatórios com o próprio token de segurança e
 * tem simulação e metas próprias em /data/users/<id do usuário>/.
 *
 * O "dono" é o usuário do GHOSTFOLIO_ACCESS_TOKEN (o mesmo da sincronização dos extratos). Os
 * arquivos antigos (/data/simulacao.json e /data/metas.json) passam a ser dele.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = (process.env.GHOSTFOLIO_URL ?? "http://ghostfolio:3333").replace(/\/$/, "");
export const OWNER_TOKEN = process.env.GHOSTFOLIO_ACCESS_TOKEN ?? "";
export const DATA_DIR = process.env.DATA_DIR ?? "/data";
const LEGACY_FILES = ["simulacao.json", "metas.json"];

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();
export const sameToken = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));

/** Id do usuário dono de um token (cache de 1 h). Lança erro se o Ghostfolio recusar o token. */
const ids = new Map<string, { id: string; at: number }>();
export async function userIdOf(token: string): Promise<string> {
  const key = sha(token).toString("hex");
  const hit = ids.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.id;
  const auth = await fetch(`${BASE_URL}/api/v1/auth/anonymous`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken: token }),
  });
  if (!auth.ok) throw new Error("token recusado pelo Ghostfolio");
  const { authToken } = (await auth.json()) as { authToken: string };
  const me = await fetch(`${BASE_URL}/api/v1/user`, { headers: { Authorization: `Bearer ${authToken}` } });
  if (!me.ok) throw new Error(`Ghostfolio /user: ${me.status}`);
  const { id } = (await me.json()) as { id: string };
  if (!/^[\w-]{8,64}$/.test(id)) throw new Error("id de usuário inesperado");
  ids.set(key, { id, at: Date.now() });
  return id;
}

/** Pasta de dados do usuário; na primeira vez do dono, adota os arquivos de antes. */
export function userDir(id: string, owner: boolean) {
  const dir = path.join(DATA_DIR, "users", id);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (owner) for (const f of LEGACY_FILES) if (fs.existsSync(path.join(DATA_DIR, f))) fs.renameSync(path.join(DATA_DIR, f), path.join(dir, f));
  }
  return dir;
}

export async function ownerDir() {
  return userDir(await userIdOf(OWNER_TOKEN), true);
}

// ---- Cookie de sessão: o token do usuário cifrado (AES-256-GCM) com chave derivada do token do dono. ----
const KEY = crypto.createHmac("sha256", OWNER_TOKEN).update("relatorios-cookie-v2").digest();
export function seal(token: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}
export function unseal(value: string): string | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---- Sincronização de outros usuários: token cifrado com chave que o ghostfolio-sync também deriva. ----
const SYNC_KEY = crypto.createHmac("sha256", OWNER_TOKEN).update("relatorios-sync-v1").digest();
export function sealForSync(token: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", SYNC_KEY, iv);
  const ct = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}
