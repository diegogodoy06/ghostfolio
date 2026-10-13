import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type DB = DatabaseSync;

// Cada entrada é uma migração; a posição no array é a versão do schema.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,              -- 'b3_movimentacao' | 'b3_posicao'
    filename TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    rows_total INTEGER NOT NULL,
    rows_new INTEGER NOT NULL,
    date_min TEXT,
    date_max TEXT
  );

  -- Linhas cruas do extrato de Movimentação da B3. (row_hash, occurrence) deduplica
  -- arquivos com períodos sobrepostos sem perder linhas legitimamente repetidas.
  CREATE TABLE b3_movements (
    id INTEGER PRIMARY KEY,
    row_hash TEXT NOT NULL,
    occurrence INTEGER NOT NULL,
    import_id INTEGER NOT NULL REFERENCES imports(id),
    direction TEXT NOT NULL,         -- 'in' | 'out'
    date TEXT NOT NULL,              -- ISO yyyy-mm-dd
    movement TEXT NOT NULL,
    product TEXT NOT NULL,
    ticker TEXT NOT NULL,
    institution TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL,
    value REAL,
    UNIQUE (row_hash, occurrence)
  );
  CREATE INDEX b3_movements_ticker ON b3_movements(ticker, date);

  -- Retrato da carteira exportado pela B3 (aba Posição). Usado para conferência
  -- e para o valor do Tesouro Direto.
  CREATE TABLE position_snapshots (
    id INTEGER PRIMARY KEY,
    import_id INTEGER NOT NULL REFERENCES imports(id),
    snapshot_date TEXT NOT NULL,
    sheet TEXT NOT NULL,
    ticker TEXT NOT NULL,
    product TEXT NOT NULL,
    institution TEXT NOT NULL,
    account TEXT,
    quantity REAL NOT NULL,
    close_price REAL,
    value REAL,
    applied_value REAL,
    maturity TEXT
  );

  CREATE TABLE assets (
    ticker TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    class TEXT NOT NULL,             -- acao | fii | etf | bdr | tesouro | renda_fixa | cripto | internacional
    currency TEXT NOT NULL DEFAULT 'BRL',
    quote_symbol TEXT,
    class_locked INTEGER NOT NULL DEFAULT 0
  );

  -- Lançamentos feitos pelo usuário: saldo inicial, subscrição, conversões
  -- (troca de ticker / incorporação), e operações de ativos fora da B3.
  CREATE TABLE manual_events (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,              -- ENTRY | BUY | SELL | SUBSCRIPTION | CONVERSION
    ticker TEXT NOT NULL,
    ticker_to TEXT,
    quantity REAL NOT NULL,
    quantity_to REAL,
    price REAL,
    cash REAL,
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE quotes (
    symbol TEXT PRIMARY KEY,
    price REAL NOT NULL,
    currency TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE online_dividends (
    ticker TEXT NOT NULL,
    ex_date TEXT NOT NULL,
    amount REAL NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (ticker, ex_date, amount)
  );

  CREATE TABLE dismissed_issues (key TEXT PRIMARY KEY);
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    });
    version++;
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
