/**
 * Saúde: peso, dias de academia e treinos guardados no wger (motor self-hosted), mais as atividades
 * da Strava lidas ao vivo.
 *
 * Regras da Strava (API Policy de 1/6/2026): dados da API só em cache por até 7 dias (§6.2), só
 * para o próprio usuário (§2.3) e nunca em aplicações de IA nem em servidor MCP próprio (§5.3 e
 * §5.16). Por isso as atividades ficam só em memória, por minutos, e este módulo não as expõe ao MCP
 * nem ao "Analisar com Claude": no Claude, a Strava entra pelo conector oficial dela.
 *
 * O histórico permanente vem por outro caminho: a exportação de dados da própria Strava (Bulk Data
 * Export, direito do usuário garantido no §6.6 da mesma Policy). O arquivo activities.csv dessa
 * exportação é importado no wger como sessões marcadas com [strava:ID:Tipo|km|seg|elev]. Nada que
 * venha da API entra no wger.
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
  /** Dia da rotina (Treino A, B…) feito nesta data, se escolhido. */
  day: number | null;
  treino: string | null;
  sets: GymSet[];
}
/** Data (São Paulo) de um datetime do wger, qualquer que seja o fuso em que ele devolve. */
const spDate = (dt: unknown) => new Date(String(dt)).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const MARK = /\[strava:(\d+):([A-Za-z]+)\|([\d.]+)\|(\d+)\|([\d.]+)\]\s*/;
const MARK_ALL = new RegExp(MARK.source, "g");
/** Tipos da Strava que são academia: viram dia de academia (e contam nas metas). */
const GYM_TYPES = new Set(["WeightTraining", "Crossfit"]);
/** Sessão importada da Strava que NÃO é academia (corrida, pedal…): fica fora dos dias de academia. */
const isCardio = (notes: unknown) => {
  const m = MARK.exec(String(notes ?? ""));
  return !!m && !GYM_TYPES.has(m[2]!);
};
const cleanNotes = (notes: unknown) => String(notes ?? "").replace(MARK_ALL, "").trim();
const gymSessions = async (token: string) => (await wgAll(token, "/workoutsession/?ordering=datetime_start")).filter((s) => s.datetime_start && !isCardio(s.notes));

export async function gymDays(token: string): Promise<GymDay[]> {
  const [sessions, logs, names, days, labels] = await Promise.all([wgAll(token, "/workoutsession/?ordering=datetime_start"), wgAll(token, "/workoutlog/"), exerciseIndex(token), wgAll(token, "/day/"), myExerciseNames(token)]);
  const dayName = new Map(days.map((d) => [Number(d.id), String(d.name)]));
  const bySession = new Map<string, GymSet[]>();
  for (const l of logs) {
    if (!l.session) continue;
    const key = String(l.session);
    bySession.set(key, [...(bySession.get(key) ?? []), { exercise: l.exercise, name: labels.get(l.exercise) ?? names.byId.get(l.exercise) ?? `Exercício ${l.exercise}`, reps: l.repetitions == null ? null : Number(l.repetitions), kg: l.weight == null ? null : Number(l.weight) }]);
  }
  return sessions
    .filter((s) => s.datetime_start && !isCardio(s.notes))
    .map((s) => ({ id: String(s.id), date: spDate(s.datetime_start), notes: cleanNotes(s.notes), day: s.day == null ? null : Number(s.day), treino: s.day == null ? null : (dayName.get(Number(s.day)) ?? null), sets: bySession.get(String(s.id)) ?? [] }));
}

/** Nomes que o usuário deu aos exercícios na rotina (ex.: "Rosca scott"), no lugar do nome do catálogo. */
async function myExerciseNames(token: string) {
  const [slots, entries] = await Promise.all([wgAll(token, "/slot/"), wgAll(token, "/slot-entry/")]);
  const slotComment = new Map(slots.map((s) => [Number(s.id), String(s.comment ?? "")]));
  const out = new Map<number, string>();
  for (const e of entries) {
    const label = String(e.comment || slotComment.get(Number(e.slot)) || "").trim();
    if (label && !out.has(Number(e.exercise))) out.set(Number(e.exercise), label);
  }
  return out;
}

// ---------- rotina (Treino A, B, C…) ----------

export interface RoutineDay {
  id: number;
  name: string;
  exercises: { exercise: number; name: string }[];
}
export interface Routine {
  id: number;
  name: string;
  end: string;
  days: RoutineDay[];
}
const plusDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/**
 * Rotina em uso, com os treinos e exercícios na ordem. O wger limita uma rotina a 120 dias: quando
 * faltam menos de 30, ela é renovada sozinha (começa hoje e vai por mais 119 dias), sem perder nada.
 */
export async function currentRoutine(token: string): Promise<Routine | null> {
  const today = todaySP();
  const all = (await wgAll(token, "/routine/")).filter((r) => !r.is_template);
  if (!all.length) return null;
  all.sort((a, b) => String(b.end).localeCompare(String(a.end)));
  const r = all.find((x) => String(x.start) <= today && String(x.end) >= today) ?? all[0];
  let end = String(r.end);
  if (end < plusDays(today, 30)) {
    end = plusDays(today, 119);
    await wg(token, `/routine/${r.id}/`, { method: "PATCH", body: { start: today, end } });
  }
  const [days, slots, entries, names] = await Promise.all([wgAll(token, `/day/?routine=${r.id}`), wgAll(token, "/slot/"), wgAll(token, "/slot-entry/"), exerciseIndex(token)]);
  const ord = (a: any, b: any) => Number(a.order) - Number(b.order) || Number(a.id) - Number(b.id);
  return {
    id: Number(r.id),
    name: String(r.name),
    end,
    days: days
      .filter((d) => !d.is_rest)
      .sort(ord)
      .map((d) => ({
        id: Number(d.id),
        name: String(d.name),
        exercises: slots
          .filter((s) => Number(s.day) === Number(d.id))
          .sort(ord)
          .flatMap((s) =>
            entries
              .filter((e) => Number(e.slot) === Number(s.id))
              .sort(ord)
              .map((e) => ({ exercise: Number(e.exercise), name: String(e.comment || s.comment || names.byId.get(Number(e.exercise)) || `Exercício ${e.exercise}`) })),
          ),
      })),
  };
}
/** Próximo treino da sequência: o seguinte ao último feito (depois do último, volta ao primeiro). */
export function nextDay(r: Routine, gym: GymDay[]): RoutineDay | null {
  if (!r.days.length) return null;
  const last = [...gym].reverse().find((g) => g.day != null && r.days.some((d) => d.id === g.day));
  if (!last) return r.days[0]!;
  const i = r.days.findIndex((d) => d.id === last.day);
  return r.days[(i + 1) % r.days.length]!;
}
/** Acha um treino pelo nome ou pela letra ("C", "treino c"). */
export function findDay(r: Routine, q: string): RoutineDay | null {
  const n = norm(q).replace(/^treino\s+/, "");
  return r.days.find((d) => norm(d.name) === norm(q) || norm(d.name).replace(/^treino\s+/, "") === n) ?? null;
}

export interface WorkoutInput {
  date: string;
  notes?: string;
  /** Dia da rotina (Treino A, B…), opcional. */
  day?: number | null;
  exercises?: { exercise: number; sets: number; reps?: number | null; kg?: number | null }[];
}
/** Marca o dia e, se vierem exercícios, registra as séries. Um dia já marcado recebe o que vier. */
export async function saveWorkout(token: string, w: WorkoutInput) {
  const same = (await gymSessions(token)).find((s) => spDate(s.datetime_start) === w.date);
  let id: string;
  if (same) {
    id = String(same.id);
    const patch: Record<string, unknown> = {};
    if (w.notes) patch.notes = same.notes ? `${same.notes}\n${w.notes}` : w.notes;
    if (w.day && w.day !== same.day) Object.assign(patch, await dayRef(token, w.day));
    if (Object.keys(patch).length) await wg(token, `/workoutsession/${id}/`, { method: "PATCH", body: patch });
  } else {
    id = String((await wg(token, "/workoutsession/", { method: "POST", body: { datetime_start: at(w.date, "18:00"), notes: w.notes ?? "", ...(w.day ? await dayRef(token, w.day) : {}) } })).id);
  }
  for (const e of w.exercises ?? []) {
    for (let k = 0; k < Math.min(30, Math.max(1, e.sets)); k++) {
      await wg(token, "/workoutlog/", { method: "POST", body: { session: id, exercise: e.exercise, date: at(w.date, "18:10"), repetitions: e.reps == null ? null : String(e.reps), weight: e.kg == null ? null : String(e.kg) } });
    }
  }
  return id;
}
async function dayRef(token: string, day: number) {
  const d = await wg(token, `/day/${day}/`);
  return { day: Number(d.id), routine: Number(d.routine) };
}
export async function removeGymDay(token: string, date: string) {
  const days = (await gymSessions(token)).filter((s) => spDate(s.datetime_start) === date);
  for (const s of days) await wg(token, `/workoutsession/${s.id}/`, { method: "DELETE" });
  return days.length;
}

// ---------- histórico da Strava pela exportação de dados (não pela API) ----------

export interface StravaRow {
  id: string;
  start: string; // ISO UTC
  date: string; // dia em São Paulo
  name: string;
  type: string;
  km: number;
  sec: number;
  elev: number;
}
/** CSV com aspas, vírgulas e quebras de linha dentro dos campos. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  if (f || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}
/** "5.21", "5,21", "1,234.5" ou "1.234,5". */
function num(v: string | undefined) {
  let t = String(v ?? "").trim();
  if (!t) return NaN;
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (t.includes(",")) t = t.replace(",", ".");
  return Number(t);
}
const MONTHS: Record<string, number> = { jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12 };
/** Datas da exportação (em UTC): "Nov 9, 2026, 2:55:00 PM", "9 de nov. de 2026 14:55:00" ou ISO. */
function stravaDate(s: string): Date | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t.replace(" ", "T") : `${t.replace(" ", "T")}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const tm = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s?m?\.?/i.exec(t);
  const rest = tm ? t.replace(tm[0], " ") : t;
  const mon = (rest.toLowerCase().match(/[a-zç]{3,}/g) ?? []).map((w) => MONTHS[w.slice(0, 3)]).find(Boolean);
  const ns = (rest.match(/\d+/g) ?? []).map(Number);
  const year = ns.find((n) => n > 1900);
  const day = ns.find((n) => n >= 1 && n <= 31);
  if (!mon || !year || !day) return null;
  let h = tm ? Number(tm[1]) : 12;
  const ap = tm?.[4]?.toLowerCase();
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return new Date(Date.UTC(year, mon - 1, day, h, tm ? Number(tm[2]) : 0, tm?.[3] ? Number(tm[3]) : 0));
}
/** Tipo canônico (o da Strava em inglês), aceitando a exportação em português. */
function stravaType(raw: string) {
  const t = raw.replace(/\s+/g, "");
  const known = ["Run", "TrailRun", "VirtualRun", "Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "EBikeRide", "Walk", "Hike", "Swim", "WeightTraining", "Crossfit", "Workout", "Yoga", "Elliptical", "Rowing"];
  const hit = known.find((k) => k.toLowerCase() === t.toLowerCase());
  if (hit) return hit;
  const n = norm(raw);
  if (/eletric|e-?bike/.test(n)) return "EBikeRide";
  if (/virtual/.test(n) && /ped|ride|bike/.test(n)) return "VirtualRide";
  if (/trilh|trail/.test(n) && /corr|run/.test(n)) return "TrailRun";
  if (/corr|run/.test(n)) return "Run";
  if (/ped|cicl|bike|bicic|ride/.test(n)) return "Ride";
  if (/trilh|hike|trek/.test(n)) return "Hike";
  if (/camin|walk/.test(n)) return "Walk";
  if (/nata|swim/.test(n)) return "Swim";
  if (/muscul|peso|weight/.test(n)) return "WeightTraining";
  if (/crossfit/.test(n)) return "Crossfit";
  if (/eliptic|ellipt/.test(n)) return "Elliptical";
  if (/remo|row/.test(n)) return "Rowing";
  if (/yoga|ioga/.test(n)) return "Yoga";
  return "Workout";
}
/** Lê o activities.csv da exportação de dados da Strava. */
export function parseStravaExport(csv: string): { rows: StravaRow[]; skipped: number } {
  const all = parseCsv(csv.replace(/^\uFEFF/, ""));
  const head = (all.shift() ?? []).map((h) => h.trim());
  // A exportação vem no idioma da conta: aceita os nomes em inglês e em português.
  const col = (names: string | string[], nth = 0) => {
    const want = (Array.isArray(names) ? names : [names]).map(norm);
    return head.reduce<number[]>((a, h, i) => (want.includes(norm(h)) ? [...a, i] : a), [])[nth] ?? -1;
  };
  const iId = col(["Activity ID", "ID da atividade"]);
  const iDate = col(["Activity Date", "Data da atividade"]);
  if (iId < 0 || iDate < 0) throw new Error("Este não parece o activities.csv da exportação da Strava (faltam as colunas de ID e data da atividade).");
  const iName = col(["Activity Name", "Nome da atividade"]);
  const iType = col(["Activity Type", "Tipo de atividade"]);
  const DIST = ["Distance", "Distância"];
  const iKm = col(DIST);
  const iM = col(DIST, 1); // a segunda coluna de distância vem em metros
  const iMov = col(["Moving Time", "Tempo de movimentação"]);
  const iEl = col(["Elapsed Time", "Tempo decorrido"]);
  const iUp = col(["Elevation Gain", "Ganho de elevação"]);
  const rows: StravaRow[] = [];
  let skipped = 0;
  for (const r of all) {
    const id = (r[iId] ?? "").trim();
    const d = stravaDate(r[iDate] ?? "");
    if (!/^\d+$/.test(id) || !d) {
      skipped++;
      continue;
    }
    const m = iM >= 0 ? num(r[iM]) : NaN;
    const km = Number.isFinite(m) ? m / 1000 : num(r[iKm]);
    const mov = iMov >= 0 ? num(r[iMov]) : NaN;
    const sec = Number.isFinite(mov) && mov > 0 ? mov : num(r[iEl]);
    const up = iUp >= 0 ? num(r[iUp]) : NaN;
    rows.push({ id, start: d.toISOString(), date: d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }), name: (r[iName] ?? "").trim().slice(0, 200), type: stravaType(r[iType] ?? ""), km: Number.isFinite(km) && km > 0 ? Math.round(km * 100) / 100 : 0, sec: Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0, elev: Number.isFinite(up) && up > 0 ? Math.round(up) : 0 });
  }
  return { rows, skipped };
}
/** Exercício do wger em que a distância fica registrada (km), por tipo. */
const CARDIO_EXERCISE: Record<string, number> = { Run: 319, TrailRun: 319, VirtualRun: 530, Ride: 177, MountainBikeRide: 177, GravelRide: 177, EBikeRide: 177, VirtualRide: 624, Walk: 1104, Hike: 1104, Swim: 1967, Elliptical: 962, Rowing: 1093 };
const KM_UNIT = 6;
const mark = (a: StravaRow) => `[strava:${a.id}:${a.type}|${a.km}|${a.sec}|${a.elev}]`;

export interface ImportResult {
  total: number;
  existing: number;
  created: number;
  remaining: number;
  gymDays: number;
  byType: Record<string, { n: number; km: number }>;
  from: string | null;
  to: string | null;
}
/**
 * Grava no wger as atividades que ainda não estão lá (até `max` por chamada, para não estourar o
 * tempo da requisição: quem chama repete até remaining = 0). Academia (WeightTraining) vira dia de
 * academia: se o dia já estava marcado, só ganha a marca da Strava.
 */
export async function importStrava(token: string, rows: StravaRow[], opts: { dryRun: boolean; max?: number }): Promise<ImportResult> {
  const sessions = await wgAll(token, "/workoutsession/?ordering=datetime_start");
  const have = new Set<string>();
  for (const s of sessions) for (const m of String(s.notes ?? "").matchAll(MARK_ALL)) have.add(m[1]!);
  const fresh = rows.filter((r, i) => !have.has(r.id) && rows.findIndex((x) => x.id === r.id) === i).sort((a, b) => a.start.localeCompare(b.start));
  const byType: ImportResult["byType"] = {};
  for (const r of rows) {
    const b = (byType[r.type] ??= { n: 0, km: 0 });
    b.n++;
    b.km = Math.round((b.km + r.km) * 10) / 10;
  }
  const dates = rows.map((r) => r.date).sort();
  const base = { total: rows.length, existing: rows.length - fresh.length, byType, from: dates[0] ?? null, to: dates.at(-1) ?? null, gymDays: fresh.filter((r) => GYM_TYPES.has(r.type)).length };
  if (opts.dryRun) return { ...base, created: 0, remaining: fresh.length };
  const batch = fresh.slice(0, opts.max ?? 120);
  const gym = sessions.filter((s) => s.datetime_start && !isCardio(s.notes));
  for (const a of batch) {
    const text = `${mark(a)} ${a.name}`.trim();
    if (GYM_TYPES.has(a.type)) {
      const same = gym.find((s) => spDate(s.datetime_start) === a.date);
      if (same) {
        same.notes = same.notes ? `${same.notes}\n${text}` : text;
        await wg(token, `/workoutsession/${same.id}/`, { method: "PATCH", body: { notes: same.notes } });
        continue;
      }
      gym.push(await wg(token, "/workoutsession/", { method: "POST", body: { datetime_start: a.start, notes: text } }));
      continue;
    }
    const s = await wg(token, "/workoutsession/", { method: "POST", body: { datetime_start: a.start, notes: text } });
    const ex = CARDIO_EXERCISE[a.type];
    if (ex && a.km > 0) await wg(token, "/workoutlog/", { method: "POST", body: { session: s.id, exercise: ex, date: a.start, repetitions: a.km.toFixed(2), repetitions_unit: KM_UNIT, weight: null } });
  }
  return { ...base, created: batch.length, remaining: fresh.length - batch.length };
}
export interface HistoryActivity {
  stravaId: string;
  date: string;
  type: string;
  name: string;
  km: number;
  minutes: number;
  elevation: number;
}
/** Atividades importadas da exportação da Strava, guardadas no wger. */
export async function stravaHistory(token: string): Promise<HistoryActivity[]> {
  const out: HistoryActivity[] = [];
  for (const s of await wgAll(token, "/workoutsession/?ordering=datetime_start")) {
    for (const line of String(s.notes ?? "").split("\n")) {
      const m = MARK.exec(line);
      if (!m) continue;
      out.push({ stravaId: m[1]!, date: spDate(s.datetime_start), type: m[2]!, name: line.replace(MARK, "").trim(), km: Number(m[3]), minutes: Math.round(Number(m[4]) / 60), elevation: Number(m[5]) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
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
