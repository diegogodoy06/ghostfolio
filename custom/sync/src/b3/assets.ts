import type { AssetClass } from "./types";
import type { DB } from "./db";

const FIXED_INCOME_PREFIXES = ["CDB", "LCI", "LCA", "LC", "CRI", "CRA", "DEB", "LIG", "RDB"];

/** Extrai o ticker do campo "Produto" da B3 ("ALUP3 - ALUPAR ...", "CDB - CDBC233ZJQJ - BANCO XP"). */
export function parseProduct(product: string): { ticker: string; name: string } {
  const text = product.trim().replace(/\s+/g, " ");
  if (/^tesouro /i.test(text)) return { ticker: text, name: text };
  const parts = text.split(" - ").map((p) => p.trim());
  if (parts.length >= 3 && FIXED_INCOME_PREFIXES.includes(parts[0]!.toUpperCase())) {
    return { ticker: parts[1]!, name: text };
  }
  if (parts.length >= 2) return { ticker: parts[0]!.toUpperCase(), name: parts.slice(1).join(" - ") };
  return { ticker: text.toUpperCase(), name: text };
}

/** Classe por heurística sobre ticker e nome; a aba da Posição, quando conhecida, tem precedência. */
export function classify(ticker: string, name: string, sheet?: string): AssetClass {
  if (sheet === "Tesouro Direto" || /^tesouro /i.test(ticker)) return "tesouro";
  if (sheet === "ETF") return "etf";
  if (sheet === "BDR") return "bdr";
  const upper = `${ticker} ${name}`.toUpperCase();
  const m = /^[A-Z]{4}(\d{1,2})$/.exec(ticker);
  if (m) {
    const n = Number(m[1]);
    if (n >= 32 && n <= 39) return "bdr";
    if (n >= 11 && n <= 15) {
      if (/FUNDO DE [IÍ]NDICE|\bETF\b|ISHARE|\bINDEX\b/.test(upper)) return "etf";
      if (/IMOB|\bFII\b|FDO INV|FUNDO DE INVESTIMENTO|RECEB|LOG[IÍ]ST/.test(upper) || sheet === "Fundo de Investimento") return "fii";
      if (n === 11) return "acao"; // units (TAEE11, KLBN11...)
      return "fii";
    }
    return "acao";
  }
  return "renda_fixa";
}

/**
 * Garante uma linha em `assets`. Só uma fonte `authoritative` (a aba da Posição) reclassifica
 * um ativo existente, e nunca quando o usuário travou a classe manualmente.
 */
export function upsertAsset(db: DB, ticker: string, name: string, cls: AssetClass, authoritative = false) {
  db.prepare(
    `INSERT INTO assets (ticker, name, class) VALUES (?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET
       name = excluded.name,
       class = CASE WHEN assets.class_locked = 0 AND ? = 1 THEN excluded.class ELSE assets.class END`,
  ).run(ticker, name, cls, authoritative ? 1 : 0);
}

export function getAssets(db: DB): Map<string, { ticker: string; name: string; class: AssetClass; currency: string; quote_symbol: string | null }> {
  const rows = db.prepare("SELECT ticker, name, class, currency, quote_symbol FROM assets").all() as any[];
  return new Map(rows.map((r) => [r.ticker, r]));
}
