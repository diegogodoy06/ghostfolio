/**
 * Outros usuários do Ghostfolio que enviaram extratos pelos relatórios.
 *
 * Os relatórios guardam, para cada um, o token cifrado em /relatorios/users/<id>/sync.json e os
 * extratos em /extratos/usuarios/<id>/. A chave é derivada do token do dono (o mesmo nos dois
 * serviços), então o arquivo sozinho não revela o token.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REGISTRY_DIR = path.join(process.env.RELATORIOS_DATA_DIR ?? "/relatorios", "users");
const KEY = crypto.createHmac("sha256", process.env.GHOSTFOLIO_ACCESS_TOKEN ?? "").update("relatorios-sync-v1").digest();

export interface ExtraUser {
  id: string;
  /** Nome para os registros (opcional, informado nos relatórios). */
  name: string | null;
  token: string;
  dir: string;
}

function unseal(value: string): string | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function extraUsers(extratosDir: string): ExtraUser[] {
  if (!fs.existsSync(REGISTRY_DIR)) return [];
  const out: ExtraUser[] = [];
  for (const id of fs.readdirSync(REGISTRY_DIR)) {
    if (!/^[\w-]{8,64}$/.test(id)) continue;
    const file = path.join(REGISTRY_DIR, id, "sync.json");
    if (!fs.existsSync(file)) continue;
    try {
      const reg = JSON.parse(fs.readFileSync(file, "utf8")) as { token: string; name?: string };
      const token = unseal(reg.token);
      if (token) out.push({ id, name: reg.name?.slice(0, 40) || null, token, dir: path.join(extratosDir, "usuarios", id) });
    } catch {
      // registro inválido: ignora
    }
  }
  return out;
}
