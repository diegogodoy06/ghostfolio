// Formato do relatório entregue pelo servidor ao navegador.

export interface Position {
  symbol: string;
  ticker: string;
  name: string;
  category: string;
  subcategory: string;
  currency: string;
  quantity: number;
  avgPrice: number;
  price: number;
  value: number;
  cost: number;
  gain: number;
  gainPct: number | null;
  income: number;
  income12m: number;
  weightInCategory: number;
  weight: number;
}

export interface CategoryGroup {
  name: string;
  value: number;
  cost: number;
  weight: number;
  subgroups: { name: string; value: number; weight: number }[];
  positions: Position[];
}

export interface DailyPoint {
  date: string;
  /** Índice da carteira (rentabilidade por cota com proventos), base 1. */
  index: number;
  value: number;
  invested: number;
  /** Ganho do dia em R$, já com proventos e descontados aportes/retiradas. */
  pnl: number;
}

export interface IncomeItem {
  date: string;
  ticker: string;
  category: string;
  type: string;
  value: number;
  estimated: boolean;
}

export interface Report {
  generatedAt: string;
  baseCurrency: string;
  accounts: { id: string; name: string }[];
  summary: { value: number; cost: number; gain: number; gainPct: number; income12m: number; incomeTotal: number; yield12m: number };
  categories: CategoryGroup[];
  daily: DailyPoint[];
  /** Séries de referência alinhadas por data (índices). */
  benchmarks: Record<string, { label: string; points: [string, number][] }>;
  incomes: IncomeItem[];
  firstDate: string;
  /** Percentual que o próprio Ghostfolio mostra (retorno sobre o capital médio), por período. */
  ghostfolio: Partial<Record<"MTD" | "YTD" | "12M" | "MAX", { pct: number; gain: number }>>;
  /** "Vista do Apresentador" ligada no Ghostfolio: a API devolve os valores apagados. */
  ghostfolioRestricted: boolean;
  /** Recorte mostrado: tudo, só a carteira ou só a reserva (marcador "Fundo de Emergência"). */
  scope: "tudo" | "carteira" | "reserva";
  /** Reserva de emergência: operações com o marcador "Fundo de Emergência" no Ghostfolio. */
  reserve: { value: number; tagged: boolean };
  /** Quem está vendo é o usuário da sincronização (pode enviar extratos). */
  owner?: boolean;
}
