import crypto from "node:crypto";
import * as XLSX from "xlsx";
import type { DB } from "./db";
import { tx } from "./db";
import { classify, parseProduct, upsertAsset } from "./assets";

export type ImportKind = "b3_movimentacao" | "b3_posicao";

export interface ImportResult {
  kind: ImportKind;
  filename: string;
  rowsTotal: number;
  rowsNew: number;
  dateMin: string | null;
  dateMax: string | null;
}

type Cell = string | number | boolean | null;

function readSheets(buf: Buffer): { name: string; rows: Cell[][] }[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name]!, { header: 1, raw: true, defval: null, blankrows: false }),
  }));
}

export function normalizeInstitution(s: string): string {
  return s.trim().replace(/\.$/, "").replace(/\s+/g, " ").toUpperCase();
}

/** "08/10/2026" ou serial do Excel -> "2026-10-08". */
export function parseDate(v: Cell): string | null {
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  if (typeof v !== "string") return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** A B3 usa "-" para campos vazios. */
export function parseNum(v: Cell): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t === "-") return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const str = (v: Cell) => (v == null ? "" : String(v).trim());

export function detectKind(buf: Buffer): ImportKind | null {
  const sheets = readSheets(buf);
  for (const s of sheets) {
    const header = (s.rows[0] ?? []).map(str);
    if (header.includes("Entrada/Saída") && header.includes("Movimentação")) return "b3_movimentacao";
    if (header.includes("Produto") && header.includes("Valor Atualizado")) return "b3_posicao";
  }
  return null;
}

export function importFile(db: DB, buf: Buffer, filename: string): ImportResult {
  const kind = detectKind(buf);
  if (kind === "b3_movimentacao") return importMovimentacao(db, buf, filename);
  if (kind === "b3_posicao") return importPosicao(db, buf, filename);
  throw new Error("Formato não reconhecido. Use os arquivos de Movimentação ou Posição exportados da Área do Investidor da B3.");
}

export function importMovimentacao(db: DB, buf: Buffer, filename: string): ImportResult {
  const sheet = readSheets(buf).find((s) => str(s.rows[0]?.[0] ?? null) === "Entrada/Saída");
  if (!sheet) throw new Error("Aba de Movimentação não encontrada");
  const header = sheet.rows[0]!.map(str);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Coluna "${name}" não encontrada no extrato`);
    return i;
  };
  const c = {
    dir: col("Entrada/Saída"),
    date: col("Data"),
    mov: col("Movimentação"),
    product: col("Produto"),
    inst: col("Instituição"),
    qty: col("Quantidade"),
    price: col("Preço unitário"),
    value: col("Valor da Operação"),
  };

  return tx(db, () => {
    const imp = db
      .prepare("INSERT INTO imports (kind, filename, imported_at, rows_total, rows_new) VALUES ('b3_movimentacao', ?, ?, 0, 0)")
      .run(filename, new Date().toISOString());
    const importId = Number(imp.lastInsertRowid);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO b3_movements
       (row_hash, occurrence, import_id, direction, date, movement, product, ticker, institution, quantity, unit_price, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seen = new Map<string, number>();
    let total = 0;
    let fresh = 0;
    let dateMin: string | null = null;
    let dateMax: string | null = null;

    for (const row of sheet.rows.slice(1)) {
      const dirRaw = str(row[c.dir] ?? null);
      const date = parseDate(row[c.date] ?? null);
      if (!dirRaw || !date) continue;
      const direction = /^cr/i.test(dirRaw) ? "in" : "out";
      const movement = str(row[c.mov] ?? null);
      const product = str(row[c.product] ?? null);
      const institution = normalizeInstitution(str(row[c.inst] ?? null));
      const quantity = parseNum(row[c.qty] ?? null) ?? 0;
      const unitPrice = parseNum(row[c.price] ?? null);
      const value = parseNum(row[c.value] ?? null);
      const { ticker, name } = parseProduct(product);

      // O nome do produto muda entre exportações (ex.: GGRC11), então o hash usa o ticker.
      const hash = crypto
        .createHash("sha1")
        .update([direction, date, movement, ticker, institution, quantity, unitPrice, value].join("|"))
        .digest("hex");
      const occurrence = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, occurrence);

      const r = insert.run(hash, occurrence, importId, direction, date, movement, product, ticker, institution, quantity, unitPrice, value);
      total++;
      if (r.changes > 0) fresh++;
      upsertAsset(db, ticker, name, classify(ticker, name));
      if (!dateMin || date < dateMin) dateMin = date;
      if (!dateMax || date > dateMax) dateMax = date;
    }

    db.prepare("UPDATE imports SET rows_total = ?, rows_new = ?, date_min = ?, date_max = ? WHERE id = ?").run(total, fresh, dateMin, dateMax, importId);
    return { kind: "b3_movimentacao", filename, rowsTotal: total, rowsNew: fresh, dateMin, dateMax };
  });
}

/** "posicao-2026-10-12-18-26-39.xlsx" -> "2026-10-12"; senão, hoje. */
function snapshotDateFromName(filename: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(filename);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
}

export function importPosicao(db: DB, buf: Buffer, filename: string): ImportResult {
  const sheets = readSheets(buf);
  const snapshotDate = snapshotDateFromName(filename);

  return tx(db, () => {
    const imp = db
      .prepare("INSERT INTO imports (kind, filename, imported_at, rows_total, rows_new, date_min, date_max) VALUES ('b3_posicao', ?, ?, 0, 0, ?, ?)")
      .run(filename, new Date().toISOString(), snapshotDate, snapshotDate);
    const importId = Number(imp.lastInsertRowid);
    // Um retrato por dia: reimportar no mesmo dia substitui o anterior.
    db.prepare("DELETE FROM position_snapshots WHERE snapshot_date = ?").run(snapshotDate);
    const insert = db.prepare(
      `INSERT INTO position_snapshots
       (import_id, snapshot_date, sheet, ticker, product, institution, account, quantity, close_price, value, applied_value, maturity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let total = 0;

    for (const s of sheets) {
      const header = (s.rows[0] ?? []).map(str);
      const idx = (name: string) => header.indexOf(name);
      if (idx("Produto") < 0 || idx("Quantidade") < 0) continue;
      for (const row of s.rows.slice(1)) {
        const product = str(row[idx("Produto")] ?? null);
        const quantity = parseNum(row[idx("Quantidade")] ?? null);
        if (!product || quantity == null) continue;
        const code = idx("Código de Negociação") >= 0 ? str(row[idx("Código de Negociação")] ?? null) : "";
        const parsed = parseProduct(product);
        const ticker = code || parsed.ticker;
        const get = (name: string) => (idx(name) >= 0 ? row[idx(name)] ?? null : null);
        insert.run(
          importId,
          snapshotDate,
          s.name,
          ticker,
          product,
          normalizeInstitution(str(get("Instituição"))),
          str(get("Conta")) || null,
          quantity,
          parseNum(get("Preço de Fechamento")),
          parseNum(get("Valor Atualizado")),
          parseNum(get("Valor Aplicado")),
          parseDate(get("Vencimento")),
        );
        upsertAsset(db, ticker, parsed.name, classify(ticker, parsed.name, s.name), true);
        total++;
      }
    }

    db.prepare("UPDATE imports SET rows_total = ?, rows_new = ? WHERE id = ?").run(total, total, importId);
    return { kind: "b3_posicao", filename, rowsTotal: total, rowsNew: total, dateMin: snapshotDate, dateMax: snapshotDate };
  });
}
