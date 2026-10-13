// Tipos compartilhados entre servidor e frontend.

export type AssetClass = "acao" | "fii" | "etf" | "bdr" | "tesouro" | "renda_fixa" | "cripto" | "internacional";

export const CLASS_LABEL: Record<AssetClass, string> = {
  acao: "Ações",
  fii: "FIIs",
  etf: "ETFs",
  bdr: "BDRs",
  tesouro: "Tesouro Direto",
  renda_fixa: "Renda fixa",
  cripto: "Cripto",
  internacional: "Internacional",
};

export type ManualEventKind = "ENTRY" | "BUY" | "SELL" | "SUBSCRIPTION" | "CONVERSION";

export interface ManualEvent {
  id?: number;
  date: string;
  kind: ManualEventKind;
  ticker: string;
  ticker_to?: string | null;
  quantity: number;
  quantity_to?: number | null;
  price?: number | null;
  cash?: number | null;
  note?: string | null;
}

export interface HoldingView {
  ticker: string;
  name: string;
  class: AssetClass;
  currency: string;
  quantity: number;
  avgPrice: number;
  cost: number;
  price: number | null;
  priceSource: string;
  priceUpdatedAt: string | null;
  value: number;
  gain: number;
  gainPct: number | null;
  income: number;
  weight: number;
}

export interface PortfolioSummary {
  total: number;
  cost: number;
  unrealized: number;
  realized: number;
  income12m: number;
  incomeTotal: number;
  byClass: { class: AssetClass; value: number; cost: number; weight: number }[];
  holdings: HoldingView[];
  quotesUpdatedAt: string | null;
}

export interface IncomeEntry {
  date: string;
  ticker: string;
  type: string;
  quantity: number;
  unitValue: number | null;
  value: number;
  status: "recebido" | "estimado";
}

export interface ReconIssue {
  key: string;
  ticker: string;
  ledgerQty: number;
  positionQty: number;
  message: string;
  suggestion: ManualEvent | null;
  suggestionText: string | null;
  needsInput: ("price" | "quantity_to" | "cash")[];
}
