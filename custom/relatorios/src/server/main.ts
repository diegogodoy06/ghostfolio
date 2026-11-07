/**
 * Servidor dos relatórios. Cada pessoa entra com o próprio token de segurança do Ghostfolio
 * (informado uma vez por aparelho, guardado cifrado num cookie) e vê só a própria carteira.
 *
 * Variáveis: GHOSTFOLIO_URL, GHOSTFOLIO_ACCESS_TOKEN, PORT (3334), EXTRATOS_DIR (/extratos).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { SCOPES, type Scope, buildReport, login } from "./report";
import { loadOverrides } from "./categories";
import { quote } from "./quote";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp";
import { sameToken, seal, sealForSync, unseal, userDir, userIdOf } from "./users";
import { FIREFLY_PUBLIC_URL, FireflyError, type ImportRow, accounts as finAccounts, existing, ff, importRows, overview, parseStatement, readConfig, sealToken, tokenOf, writeConfig } from "./financas";

const BASE_URL = (process.env.GHOSTFOLIO_URL ?? "http://ghostfolio:3333").replace(/\/$/, "");
const TOKEN = process.env.GHOSTFOLIO_ACCESS_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 3334);
const PUBLIC_DIR = path.join(__dirname, "public");
const EXTRATOS_DIR = process.env.EXTRATOS_DIR ?? "/extratos";
// Arquivos aceitos na pasta de extratos: planilhas da B3 e os dois arquivos de ajuste.
const EXTRATO_NAME = /^(?:[\w][\w .()-]{0,120}\.xlsx|ajustes\.json|categorias\.json)$/i;
const CACHE_MS = 5 * 60_000;
// Endereço público do Ghostfolio (ex.: https://carteira.exemplo.com), usado nos links do topo.
const PUBLIC_GHOSTFOLIO_URL = (process.env.PUBLIC_GHOSTFOLIO_URL ?? "").replace(/["<>]/g, "");

if (!TOKEN) {
  console.error("Defina GHOSTFOLIO_ACCESS_TOKEN (custom/sync/sync.env).");
  process.exit(1);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();
// Token do MCP por HTTPS: derivado do token do Ghostfolio, mas não serve para entrar nele.
// Mostrado com: docker exec ghostfolio-relatorios node server.js --mcp-token
const MCP_TOKEN = crypto.createHmac("sha256", TOKEN).update("relatorios-mcp-v1").digest("hex");
if (process.argv.includes("--mcp-token")) {
  console.log(MCP_TOKEN);
  process.exit(0);
}
const mcpAuthed = (req: http.IncomingMessage) => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return !!m && crypto.timingSafeEqual(sha(m[1]!), sha(MCP_TOKEN));
};
// Só para desenvolvimento local (instância temporária presa em 127.0.0.1). Nunca usar no compose.
const DEV_NO_AUTH = process.env.DEV_NO_AUTH === "1";
// Cookie da versão de um usuário só (HMAC fixo): continua valendo, como o dono.
const LEGACY_SESSION = crypto.createHmac("sha256", TOKEN).update("relatorios-session-v1").digest("hex");

interface Session {
  token: string;
  id: string;
  /** Usuário do GHOSTFOLIO_ACCESS_TOKEN (dono da instalação). */
  owner: boolean;
  dir: string;
}
/** Pasta de extratos do usuário: a raiz para o dono, usuarios/<id>/ para os demais. */
const extratosDir = (s: Session) => (s.owner ? EXTRATOS_DIR : path.join(EXTRATOS_DIR, "usuarios", s.id));
async function session(req: http.IncomingMessage): Promise<Session | null> {
  const cookie = /(?:^|;\s*)rel_session=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
  const token = DEV_NO_AUTH || cookie === LEGACY_SESSION ? TOKEN : cookie ? unseal(cookie) : null;
  if (!token) return null;
  try {
    const id = await userIdOf(token);
    const owner = sameToken(token, TOKEN);
    return { token, id, owner, dir: userDir(id, owner) };
  } catch {
    return null;
  }
}

const cache = new Map<string, { at: number; data: unknown }>();

function readJson(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // gravação atômica
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, { "content-type": json ? "application/json" : "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

async function readRaw(req: http.IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error("arquivo grande demais");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
    // MCP por HTTPS (sem sessão; uma requisição JSON-RPC por chamada).
    if (url.pathname === "/mcp") {
      if (!mcpAuthed(req)) return send(res, 401, { error: "token do MCP inválido" }, { "www-authenticate": "Bearer" });
      if (req.method !== "POST") return send(res, 405, { error: "use POST" }, { allow: "POST" });
      const body = await readBody(req, 1_000_000);
      const mcp = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      return await transport.handleRequest(req, res, body);
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      const { token } = await readBody(req);
      const t = typeof token === "string" ? token.trim() : "";
      try {
        if (!t || t.length > 512) throw new Error("vazio");
        await userIdOf(t); // o próprio Ghostfolio valida o token
      } catch {
        await new Promise((r) => setTimeout(r, 800)); // freia tentativas em série
        return send(res, 401, { error: "Token inválido" });
      }
      // Atrás de um proxy HTTPS o cookie só trafega cifrado.
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      return send(res, 200, { ok: true }, { "set-cookie": `rel_session=${seal(t)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}` });
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      return send(res, 200, { ok: true }, { "set-cookie": "rel_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict" });
    }
    const s = url.pathname.startsWith("/api/") ? await session(req) : null;
    if (url.pathname.startsWith("/api/") && !s) return send(res, 401, { error: "login" });
    if (url.pathname === "/api/report" && s) {
      const accounts = (url.searchParams.get("accounts") ?? "").split(",").filter(Boolean).sort();
      const scope: Scope = SCOPES.find((x) => x === url.searchParams.get("scope")) ?? "tudo";
      const key = `${s.id}|${scope}|${accounts.join(",")}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS && url.searchParams.get("refresh") !== "1") return send(res, 200, hit.data);
      loadOverrides(path.join(extratosDir(s), "categorias.json"));
      const data = { ...(await buildReport(await login(BASE_URL, s.token), accounts, scope)), owner: s.owner };
      cache.set(key, { at: Date.now(), data });
      return send(res, 200, data);
    }
    if (url.pathname === "/api/quote") {
      const t = (url.searchParams.get("t") ?? "").toUpperCase().replace(/[^A-Z0-9.^-]/g, "");
      if (!t) return send(res, 400, { error: "ticker" });
      return send(res, 200, await quote(t));
    }
    if (url.pathname === "/api/simulation" && s) {
      const file = path.join(s.dir, "simulacao.json");
      if (req.method === "GET") return send(res, 200, readJson(file));
      if (req.method === "PUT") {
        const body = await readBody(req, 200_000);
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "simulação inválida" });
        writeJson(file, { ...body, updatedAt: new Date().toISOString() });
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === "/api/goals" && s) {
      const file = path.join(s.dir, "metas.json");
      if (req.method === "GET") return send(res, 200, readJson(file) ?? { version: 1, goals: [] });
      if (req.method === "PUT") {
        const body = await readBody(req, 100_000);
        if (!body || !Array.isArray(body.goals)) return send(res, 400, { error: "metas inválidas" });
        writeJson(file, { version: 1, goals: body.goals, updatedAt: new Date().toISOString() });
        return send(res, 200, { ok: true });
      }
    }
    // Extratos da B3: listar, enviar e remover arquivos da pasta do usuário, lida pela sincronização.
    if (url.pathname.startsWith("/api/extratos") && s) {
      const dir = extratosDir(s);
      const syncFile = path.join(s.dir, "sync.json");
      // Parar a sincronização automática de um usuário (o dono é sempre sincronizado).
      if (url.pathname === "/api/extratos/sync" && req.method === "DELETE") {
        if (fs.existsSync(syncFile)) fs.unlinkSync(syncFile);
        return send(res, 200, { ok: true });
      }
      if (url.pathname !== "/api/extratos") return send(res, 404, { error: "não encontrado" });
      if (req.method === "GET") {
        const files = fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((f) => EXTRATO_NAME.test(f))
              .map((f) => {
                const st = fs.statSync(path.join(dir, f));
                return { name: f, size: st.size, modified: st.mtime.toISOString() };
              })
              .sort((a, b) => b.modified.localeCompare(a.modified))
          : [];
        let writable = true;
        try {
          fs.accessSync(EXTRATOS_DIR, fs.constants.W_OK);
        } catch {
          writable = false;
        }
        return send(res, 200, { files, writable, owner: s.owner, autoSync: s.owner || fs.existsSync(syncFile) });
      }
      const name = path.basename(url.searchParams.get("name") ?? "");
      if (!EXTRATO_NAME.test(name)) return send(res, 400, { error: "Só arquivos .xlsx da B3, ajustes.json ou categorias.json." });
      const file = path.join(dir, name);
      if (req.method === "PUT") {
        const body = await readRaw(req, 15_000_000);
        if (name.endsWith(".json")) {
          try {
            JSON.parse(body.toString("utf8"));
          } catch {
            return send(res, 400, { error: `${name} não é um JSON válido.` });
          }
        } else if (body.subarray(0, 2).toString("latin1") !== "PK") {
          return send(res, 400, { error: `${name} não parece uma planilha .xlsx.` });
        }
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `.${name}.tmp`);
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, file); // a sincronização só enxerga o arquivo completo
        // Outros usuários: guarda o token (cifrado) para a sincronização rodar na conta deles.
        if (!s.owner) {
          const prev = readJson(syncFile) as { name?: string } | null;
          writeJson(syncFile, { token: sealForSync(s.token), name: prev?.name, updatedAt: new Date().toISOString() });
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return send(res, 200, { ok: true });
      }
    }
    // Finanças (Firefly III): conexão, visão geral, cartões e importação de extratos.
    if (url.pathname.startsWith("/api/fin") && s) {
      const cfg = readConfig(s.dir);
      const fin = tokenOf(cfg);
      if (url.pathname === "/api/fin" && req.method === "GET") {
        return send(res, 200, { connected: !!fin, publicUrl: FIREFLY_PUBLIC_URL, cards: cfg.cards ?? {} });
      }
      if (url.pathname === "/api/fin/token") {
        if (req.method === "DELETE") {
          delete cfg.token;
          delete cfg.connectedAt;
          writeConfig(s.dir, cfg);
          return send(res, 200, { ok: true });
        }
        if (req.method === "PUT") {
          const { token } = (await readBody(req, 20_000)) as { token?: string };
          if (!token || typeof token !== "string" || token.length < 20) return send(res, 400, { error: "Token inválido." });
          try {
            await ff(token.trim(), "/about/user");
          } catch (e) {
            const st = e instanceof FireflyError ? e.status : 502;
            return send(res, 400, { error: st === 401 ? "O Firefly recusou este token." : (e as Error).message });
          }
          writeConfig(s.dir, { ...cfg, token: sealToken(token.trim()), connectedAt: new Date().toISOString() });
          return send(res, 200, { ok: true });
        }
      }
      if (!fin) return send(res, 409, { error: "Firefly III não conectado" });
      if (url.pathname === "/api/fin/overview") {
        const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") ?? "") ? url.searchParams.get("month")! : new Date().toISOString().slice(0, 7);
        return send(res, 200, await overview(fin, cfg, month));
      }
      if (url.pathname === "/api/fin/accounts") return send(res, 200, await finAccounts(fin));
      if (url.pathname === "/api/fin/cards" && req.method === "PUT") {
        const { id, closing, due } = (await readBody(req)) as { id?: string; closing?: number; due?: number };
        const day = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 31;
        if (!id || !/^\d+$/.test(id)) return send(res, 400, { error: "cartão inválido" });
        cfg.cards ??= {};
        if (closing == null && due == null) delete cfg.cards[id];
        else if (!day(closing) || !day(due)) return send(res, 400, { error: "Dias de fechamento e vencimento entre 1 e 31." });
        else cfg.cards[id] = { closing: closing!, due: due! };
        writeConfig(s.dir, cfg);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/fin/parse" && req.method === "POST") {
        const name = path.basename(url.searchParams.get("name") ?? "extrato");
        try {
          const parsed = parseStatement(await readRaw(req, 5_000_000), name);
          const suggested = parsed.accountKey ? (cfg.accounts?.[parsed.accountKey] ?? null) : null;
          return send(res, 200, { ...parsed, suggested });
        } catch (e) {
          return send(res, 400, { error: (e as Error).message });
        }
      }
      const rowsOf = (v: unknown): ImportRow[] | null => {
        if (!Array.isArray(v) || v.length > 3000) return null;
        const ok = v.every(
          (r) =>
            r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.amount) && typeof r.description === "string" && typeof r.uid === "string" && (r.transferTo == null || /^\d+$/.test(r.transferTo)),
        );
        return ok ? (v as ImportRow[]) : null;
      };
      if (url.pathname === "/api/fin/check" && req.method === "POST") {
        const body = (await readBody(req, 2_000_000)) as { accountId?: string; rows?: unknown };
        const rows = rowsOf(body.rows);
        if (!rows || !/^\d+$/.test(body.accountId ?? "")) return send(res, 400, { error: "dados inválidos" });
        return send(res, 200, await existing(fin, body.accountId!, rows));
      }
      if (url.pathname === "/api/fin/import" && req.method === "POST") {
        const body = (await readBody(req, 2_000_000)) as { accountId?: string; accountKey?: string | null; rows?: unknown };
        const rows = rowsOf(body.rows);
        if (!rows || !/^\d+$/.test(body.accountId ?? "")) return send(res, 400, { error: "dados inválidos" });
        const key = typeof body.accountKey === "string" ? body.accountKey.slice(0, 200) : null;
        const result = await importRows(fin, body.accountId!, key, rows);
        if (key) writeConfig(s.dir, { ...readConfig(s.dir), accounts: { ...cfg.accounts, [key]: body.accountId! } });
        return send(res, 200, result);
      }
      return send(res, 404, { error: "não encontrado" });
    }
    // Arquivos estáticos (SPA).
    // Só arquivos de public/ (e public/fonts/, public/icons/); nada de "..".
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.basename(rel);
    const full = path.join(PUBLIC_DIR, /^(fonts\/[\w.-]+\.woff2|icons\/[\w.-]+\.(?:svg|png))$/.test(rel) ? rel : file);
    if (fs.existsSync(full)) {
      res.writeHead(200, {
        "content-type": TYPES[path.extname(full)] ?? "application/octet-stream",
        // Sempre revalida: atualizações do app aparecem na hora (fontes podem ficar em cache).
        "cache-control": /^(fonts|icons)\//.test(rel) ? "public, max-age=604800" : "no-cache",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
        "x-content-type-options": "nosniff",
      });
      if (full.endsWith("index.html") && PUBLIC_GHOSTFOLIO_URL) {
        return res.end(fs.readFileSync(full, "utf8").replace('name="ghostfolio-url" content=""', `name="ghostfolio-url" content="${PUBLIC_GHOSTFOLIO_URL}"`));
      }
      return fs.createReadStream(full).pipe(res);
    }
    send(res, 404, "não encontrado");
  } catch (err) {
    console.error(new Date().toISOString(), (err as Error).message);
    const st = err instanceof FireflyError ? (err.status === 401 ? 409 : err.status >= 500 ? 502 : 400) : 502;
    send(res, st, { error: err instanceof FireflyError && err.status === 401 ? "O Firefly recusou o token salvo. Conecte de novo." : (err as Error).message });
  }
});

server.listen(PORT, process.env.HOST ?? "0.0.0.0", () => console.log(`relatórios em http://localhost:${PORT}`));
