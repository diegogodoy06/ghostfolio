/**
 * Saúde: peso, dias de academia e treinos guardados no wger (motor self-hosted), mais as atividades
 * da Strava lidas ao vivo.
 *
 * Regras da Strava (API Policy de 1/6/2026): dados da API só em cache por até 7 dias (§6.2), só
 * para o próprio usuário (§2.3) e nunca em aplicações de IA nem em servidor MCP próprio (§5.3 e
 * §5.16). Por isso as atividades ficam só em memória, por minutos, e este módulo não as expõe ao MCP
 * nem ao "Analisar com Claude": no Claude, a Strava entra pelo conector oficial dela.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { seal, unseal } from "./users";

export const WGER_URL = (process.env.WGER_URL ?? "http://host.docker.internal:3336").replace(/\/$/, "");
export const WGER_PUBLIC_URL = (process.env.WGER_PUBLIC_URL ?? "").replace(/\/$/, "");
const STRAVA = (process.env.STRAVA_BASE ?? "https://www.strava.com").replace(/\/$/, "");

export interface SaudeConfig {
  token?: string;
  connectedAt?: string;
  strava?: { clientId: string; clientSecret: string; refresh?: string; athlete?: string };
}
const cfgFile = (dir: string) => path.join(dir, "saude.json");
export function readSaude(dir: string): SaudeConfig {
  try {
    return JSON.parse(fs.readFileSync(cfgFile(dir), "utf8")) as SaudeConfig;
  } catch {
    return {};
  }
}
export function writeSaude(dir: string, cfg: SaudeConfig) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cfgFile(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cfgFile(dir));
}
export const wgerToken = (cfg: SaudeConfig) => (cfg.token ? unseal(cfg.token) : null);
export const sealSaude = (t: string) => seal(t);
export const todaySP = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

// ---------- wger ----------

export class WgerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function wg<T = any>(token: string, p: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${WGER_URL}/api/v2${p}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Token ${token}`, accept: "application/json", "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new WgerError(503, "wger fora do ar ou inacessível");
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* erro em HTML */
  }
  if (!res.ok) throw new WgerError(res.status, json?.detail ?? (json ? JSON.stringify(json).slice(0, 200) : `wger ${res.status}`));
  return json as T;
}
async function wgAll(token: string, p: string): Promise<any[]> {
  const out: any[] = [];
  const sep = p.includes("?") ? "&" : "?";
  for (let offset = 0; offset < 20_000; offset += 500) {
    const r = await wg(token, `${p}${sep}limit=500&offset=${offset}`);
    out.push(...r.results);
    if (!r.next) break;
  }
  return out;
}
const at = (date: string, hour = "12:00") => `${date}T${hour}:00-03:00`;

export interface WeightEntry {
  id: string;
  date: string;
  weight: number;
}
export async function weights(token: string): Promise<WeightEntry[]> {
  const rows = await wgAll(token, "/weightentry/?ordering=date");
  return rows.map((r) => ({ id: String(r.id), date: String(r.date).slice(0, 10), weight: Number(r.weight) }));
}
/** Um peso por dia: lançar de novo no mesmo dia corrige o valor. */
export async function saveWeight(token: string, date: string, kg: number) {
  const same = (await weights(token)).find((w) => w.date === date);
  if (same) await wg(token, `/weightentry/${same.id}/`, { method: "PATCH", body: { weight: kg.toFixed(2) } });
  else await wg(token, "/weightentry/", { method: "POST", body: { date: at(date, "08:00"), weight: kg.toFixed(2) } });
}
export const deleteWeight = (token: string, id: string) => wg(token, `/weightentry/${encodeURIComponent(id)}/`, { method: "DELETE" });

export interface GymSet {
  exercise: number;
  name: string;
  reps: number | null;
  kg: number | null;
}
export interface GymDay {
  id: string;
  date: string;
  notes: string;
  sets: GymSet[];
}
export async function gymDays(token: string): Promise<GymDay[]> {
  const [sessions, logs, names] = await Promise.all([wgAll(token, "/workoutsession/?ordering=datetime_start"), wgAll(token, "/workoutlog/"), exerciseIndex(token)]);
  const bySession = new Map<string, GymSet[]>();
  for (const l of logs) {
    if (!l.session) continue;
    const key = String(l.session);
    bySession.set(key, [...(bySession.get(key) ?? []), { exercise: l.exercise, name: names.byId.get(l.exercise) ?? `Exercício ${l.exercise}`, reps: l.repetitions == null ? null : Number(l.repetitions), kg: l.weight == null ? null : Number(l.weight) }]);
  }
  return sessions
    .filter((s) => s.datetime_start)
    .map((s) => ({ id: String(s.id), date: String(s.datetime_start).slice(0, 10), notes: s.notes ?? "", sets: bySession.get(String(s.id)) ?? [] }));
}

export interface WorkoutInput {
  date: string;
  notes?: string;
  exercises?: { exercise: number; sets: number; reps?: number | null; kg?: number | null }[];
}
/** Marca o dia e, se vierem exercícios, registra as séries. Um dia já marcado recebe o que vier. */
export async function saveWorkout(token: string, w: WorkoutInput) {
  const same = (await wgAll(token, "/workoutsession/?ordering=datetime_start")).find((s) => String(s.datetime_start ?? "").slice(0, 10) === w.date);
  let id: string;
  if (same) {
    id = String(same.id);
    if (w.notes) await wg(token, `/workoutsession/${id}/`, { method: "PATCH", body: { notes: same.notes ? `${same.notes}\n${w.notes}` : w.notes } });
  } else {
    id = String((await wg(token, "/workoutsession/", { method: "POST", body: { datetime_start: at(w.date, "18:00"), notes: w.notes ?? "" } })).id);
  }
  for (const e of w.exercises ?? []) {
    for (let k = 0; k < Math.min(30, Math.max(1, e.sets)); k++) {
      await wg(token, "/workoutlog/", { method: "POST", body: { session: id, exercise: e.exercise, date: at(w.date, "18:10"), repetitions: e.reps == null ? null : String(e.reps), weight: e.kg == null ? null : String(e.kg) } });
    }
  }
  return id;
}
export async function removeGymDay(token: string, date: string) {
  const days = (await wgAll(token, "/workoutsession/?ordering=datetime_start")).filter((s) => String(s.datetime_start ?? "").slice(0, 10) === date);
  for (const s of days) await wg(token, `/workoutsession/${s.id}/`, { method: "DELETE" });
  return days.length;
}

// Nomes dos exercícios (pt e en): não mudam no dia a dia, ficam em memória.
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
const PT = 7;
const EN = 2;
let exCache: { at: number; byId: Map<number, string>; list: { id: number; name: string; lang: number }[] } | null = null;
async function exerciseIndex(token: string) {
  if (exCache && Date.now() - exCache.at < 86_400_000) return exCache;
  const rows = await wgAll(token, "/exercise-translation/");
  const list = rows.filter((r) => r.language === PT || r.language === EN).map((r) => ({ id: Number(r.exercise), name: String(r.name), lang: Number(r.language) }));
  const byId = new Map<number, string>();
  for (const r of list) if (r.lang === EN && !byId.has(r.id)) byId.set(r.id, r.name);
  for (const r of list) if (r.lang === PT) byId.set(r.id, r.name); // português tem prioridade
  exCache = { at: Date.now(), byId, list };
  return exCache;
}
export async function searchExercises(token: string, q: string, limit = 12) {
  const { list, byId } = await exerciseIndex(token);
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const seen = new Set<number>();
  const out: { id: number; name: string }[] = [];
  const score = (n: string) => (n.startsWith(terms[0]!) ? 0 : 1);
  const hits = list.filter((r) => terms.every((t) => norm(r.name).includes(t))).sort((a, b) => a.lang === b.lang ? score(norm(a.name)) - score(norm(b.name)) : a.lang === PT ? -1 : 1);
  for (const r of hits) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, name: byId.get(r.id) ?? r.name });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- metas ligadas à academia ----------

/** Metas de contagem com auto="academia" em plano.json acompanham os dias marcados no ano. */
export function syncGymGoals(dir: string, days: { date: string }[]) {
  const file = path.join(dir, "plano.json");
  let plan: { years?: Record<string, any[]> };
  try {
    plan = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return;
  }
  let changed = false;
  for (const [year, items] of Object.entries(plan.years ?? {})) {
    for (const it of items) {
      if (it.auto !== "academia") continue;
      const inYear = days.filter((d) => d.date.startsWith(year)).sort((a, b) => a.date.localeCompare(b.date));
      const log = inYear.map((d) => ({ date: d.date, n: 1 }));
      if (JSON.stringify(it.log ?? []) !== JSON.stringify(log)) {
        it.log = log;
        changed = true;
      }
    }
  }
  if (!changed) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...plan, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- Strava: só leitura, ao vivo, só para o próprio usuário ----------

export interface StravaActivity {
  id: number;
  name: string;
  sport: string;
  date: string;
  km: number;
  minutes: number;
  elevation: number;
  url: string;
}
const access = new Map<string, { token: string; until: number }>();
const activityCache = new Map<string, { at: number; list: StravaActivity[] }>();
const CACHE_MS = 15 * 60_000;
const states = new Map<string, { dir: string; at: number }>();

export function stravaAuthUrl(dir: string, cfg: SaudeConfig, redirect: string) {
  const state = crypto.randomBytes(16).toString("hex");
  for (const [k, v] of states) if (Date.now() - v.at > 600_000) states.delete(k);
  states.set(state, { dir, at: Date.now() });
  const q = new URLSearchParams({ client_id: cfg.strava!.clientId, redirect_uri: redirect, response_type: "code", approval_prompt: "auto", scope: "read,activity:read_all", state });
  return `${STRAVA}/oauth/authorize?${q}`;
}
async function tokenRequest(cfg: SaudeConfig, body: Record<string, string>) {
  const res = await fetch(`${STRAVA}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.strava!.clientId, client_secret: unseal(cfg.strava!.clientSecret), ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(json?.message ?? `Strava ${res.status}`);
  return json as { access_token: string; refresh_token: string; expires_at: number; athlete?: { firstname?: string; lastname?: string } };
}
/** O retorno da Strava vem de outro site e o cookie de sessão é SameSite=Strict: quem identifica é o state. */
export async function stravaCallback(state: string, code: string) {
  const st = states.get(state);
  states.delete(state);
  if (!st || Date.now() - st.at > 600_000) throw new Error("Pedido de autorização inválido ou expirado. Tente conectar de novo.");
  const dir = st.dir;
  const cfg = readSaude(dir);
  const t = await tokenRequest(cfg, { code, grant_type: "authorization_code" });
  cfg.strava = { ...cfg.strava!, refresh: seal(t.refresh_token), athlete: [t.athlete?.firstname, t.athlete?.lastname].filter(Boolean).join(" ") || undefined };
  writeSaude(dir, cfg);
  access.set(dir, { token: t.access_token, until: t.expires_at * 1000 - 60_000 });
  activityCache.delete(dir);
}
async function stravaToken(dir: string, cfg: SaudeConfig) {
  const a = access.get(dir);
  if (a && a.until > Date.now()) return a.token;
  const refresh = cfg.strava?.refresh ? unseal(cfg.strava.refresh) : null;
  if (!refresh) throw new Error("Strava não conectada.");
  const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refresh });
  if (t.refresh_token !== refresh) writeSaude(dir, { ...cfg, strava: { ...cfg.strava!, refresh: seal(t.refresh_token) } });
  access.set(dir, { token: t.access_token, until: t.expires_at * 1000 - 60_000 });
  return t.access_token;
}
/** Atividades dos últimos 12 meses. Ficam só em memória, por 15 minutos; nada vai para o disco. */
export async function stravaActivities(dir: string, cfg: SaudeConfig, refresh = false): Promise<StravaActivity[]> {
  const hit = activityCache.get(dir);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const token = await stravaToken(dir, cfg);
  const after = Math.floor(Date.now() / 1000) - 366 * 86_400;
  const list: StravaActivity[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${STRAVA}/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(res.status === 429 ? "Limite de consultas da Strava; tente em alguns minutos." : `Strava ${res.status}`);
    const rows = (await res.json()) as any[];
    for (const a of rows)
      list.push({
        id: a.id,
        name: a.name,
        sport: a.sport_type ?? a.type,
        date: String(a.start_date_local).slice(0, 10),
        km: Math.round((a.distance ?? 0) / 10) / 100,
        minutes: Math.round((a.moving_time ?? 0) / 60),
        elevation: Math.round(a.total_elevation_gain ?? 0),
        url: `https://www.strava.com/activities/${a.id}`,
      });
    if (rows.length < 200) break;
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  activityCache.set(dir, { at: Date.now(), list });
  return list;
}
export function stravaForget(dir: string) {
  access.delete(dir);
  activityCache.delete(dir);
}
