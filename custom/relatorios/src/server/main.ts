/**
 * Servidor dos relatórios. Acesso protegido pelo mesmo token de segurança do Ghostfolio:
 * informado uma vez por aparelho, vira um cookie assinado (sobrevive a reinícios).
 *
 * Variáveis: GHOSTFOLIO_URL, GHOSTFOLIO_ACCESS_TOKEN, PORT (3334), EXTRATOS_DIR (/extratos).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildReport, login } from "./report";
import { loadOverrides } from "./categories";
import { quote } from "./quote";

const BASE_URL = (process.env.GHOSTFOLIO_URL ?? "http://ghostfolio:3333").replace(/\/$/, "");
const TOKEN = process.env.GHOSTFOLIO_ACCESS_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 3334);
const PUBLIC_DIR = path.join(__dirname, "public");
const OVERRIDES = path.join(process.env.EXTRATOS_DIR ?? "/extratos", "categorias.json");
const CACHE_MS = 5 * 60_000;

if (!TOKEN) {
  console.error("Defina GHOSTFOLIO_ACCESS_TOKEN (custom/sync/sync.env).");
  process.exit(1);
}

const SESSION = crypto.createHmac("sha256", TOKEN).update("relatorios-session-v1").digest("hex");
const sha = (s: string) => crypto.createHash("sha256").update(s).digest();
// Só para desenvolvimento local (instância temporária presa em 127.0.0.1). Nunca usar no compose.
const DEV_NO_AUTH = process.env.DEV_NO_AUTH === "1";
const authed = (req: http.IncomingMessage) => DEV_NO_AUTH || /(?:^|;\s*)rel_session=([a-f0-9]{64})/.exec(req.headers.cookie ?? "")?.[1] === SESSION;

const cache = new Map<string, { at: number; data: unknown }>();

// ---- Simulação: uma única, salva em /data (volume). Guarda a intenção, não o resultado. ----
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const SIM_FILE = path.join(DATA_DIR, "simulacao.json");
function readSimulation() {
  try {
    return JSON.parse(fs.readFileSync(SIM_FILE, "utf8"));
  } catch {
    return null;
  }
}
function writeSimulation(data: unknown) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SIM_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, SIM_FILE); // gravação atômica
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, { "content-type": json ? "application/json" : "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

async function readBody(req: http.IncomingMessage, limit = 10_000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("corpo grande demais");
  }
  return JSON.parse(raw || "{}");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/api/login" && req.method === "POST") {
      const { token } = await readBody(req);
      // Comparação em tempo constante sobre os hashes.
      if (typeof token !== "string" || !crypto.timingSafeEqual(sha(token.trim()), sha(TOKEN))) return send(res, 401, { error: "Token inválido" });
      return send(res, 200, { ok: true }, { "set-cookie": `rel_session=${SESSION}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` });
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      return send(res, 200, { ok: true }, { "set-cookie": "rel_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict" });
    }
    if (url.pathname === "/api/report") {
      if (!authed(req)) return send(res, 401, { error: "login" });
      const accounts = (url.searchParams.get("accounts") ?? "").split(",").filter(Boolean).sort();
      const key = accounts.join(",");
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS && url.searchParams.get("refresh") !== "1") return send(res, 200, hit.data);
      loadOverrides(OVERRIDES);
      const data = await buildReport(await login(BASE_URL, TOKEN), accounts);
      cache.set(key, { at: Date.now(), data });
      return send(res, 200, data);
    }
    if (url.pathname === "/api/quote") {
      if (!authed(req)) return send(res, 401, { error: "login" });
      const t = (url.searchParams.get("t") ?? "").toUpperCase().replace(/[^A-Z0-9.^-]/g, "");
      if (!t) return send(res, 400, { error: "ticker" });
      return send(res, 200, await quote(t));
    }
    if (url.pathname === "/api/simulation") {
      if (!authed(req)) return send(res, 401, { error: "login" });
      if (req.method === "GET") return send(res, 200, readSimulation());
      if (req.method === "PUT") {
        const body = await readBody(req, 200_000);
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "simulação inválida" });
        writeSimulation({ ...body, updatedAt: new Date().toISOString() });
        return send(res, 200, { ok: true });
      }
    }
    // Arquivos estáticos (SPA).
    // Só arquivos de public/ (e public/fonts/, public/icons/); nada de "..".
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.basename(rel);
    const full = path.join(PUBLIC_DIR, /^(fonts\/[\w.-]+\.woff2|icons\/[\w.-]+\.svg)$/.test(rel) ? rel : file);
    if (fs.existsSync(full)) {
      res.writeHead(200, {
        "content-type": TYPES[path.extname(full)] ?? "application/octet-stream",
        // Sempre revalida: atualizações do app aparecem na hora (fontes podem ficar em cache).
        "cache-control": /^(fonts|icons)\//.test(rel) ? "public, max-age=604800" : "no-cache",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
        "x-content-type-options": "nosniff",
      });
      return fs.createReadStream(full).pipe(res);
    }
    send(res, 404, "não encontrado");
  } catch (err) {
    console.error(new Date().toISOString(), (err as Error).message);
    send(res, 502, { error: (err as Error).message });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`relatórios em http://localhost:${PORT}`));
