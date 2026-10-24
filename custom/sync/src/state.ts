// Estado persistente mínimo (volume /data).
import fs from "node:fs";
import path from "node:path";

export interface State {
  baseCurrencySet?: boolean;
  gatheredSince?: string;
  tesouroHistoryLoaded?: boolean;
  /** Estado de cada usuário extra (cadastrado pelos relatórios), por id do Ghostfolio. */
  users?: Record<string, State>;
}

const DATA_DIR = process.env.DATA_DIR ?? "/data";
const FILE = path.join(DATA_DIR, "state.json");

export function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

export function saveState(state: State) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}
