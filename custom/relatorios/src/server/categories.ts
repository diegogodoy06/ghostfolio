/**
 * Categorização no estilo das corretoras brasileiras: Ações (por setor), FIIs (por tipo),
 * ETFs, BDRs, Exterior, Tesouro Direto, Renda Fixa e Cripto.
 *
 * O Yahoo classifica FIIs e ETFs da B3 como "ação", então a categoria sai do ticker e do
 * nome. Ajustes por ativo podem ser feitos em extratos/categorias.json:
 *   { "MXRF11": { "categoria": "FIIs", "subcategoria": "Papel" } }
 */
import fs from "node:fs";

export interface Profile {
  dataSource: string;
  symbol: string;
  name: string | null;
  currency: string;
  assetClass?: string | null;
  assetSubClass?: string | null;
  sectors?: { name: string; weight: number }[];
}

export const CATEGORY_ORDER = ["Ações", "FIIs", "ETFs", "BDRs", "Exterior", "Tesouro Direto", "Renda Fixa", "Cripto", "Outros"];

// Tipo dos FIIs mais comuns; os demais saem do nome.
const FII_TYPES: Record<string, string> = {
  MXRF11: "Papel", KNCR11: "Papel", KNIP11: "Papel", KNSC11: "Papel", RECR11: "Papel", PCIP11: "Papel", CVBI11: "Papel",
  VSLH11: "Papel", RBRY11: "Papel", HCTR11: "Papel", IRDM11: "Papel", CPTS11: "Papel", VGIP11: "Papel", MCCI11: "Papel",
  KNHY11: "Papel", VGHF11: "Papel", SNCI11: "Papel", RBRR11: "Papel", BTCI11: "Papel", HGCR11: "Papel", VRTA11: "Papel",
  HGLG11: "Logística", BTLG11: "Logística", XPLG11: "Logística", TRBL11: "Logística", VILG11: "Logística", LVBI11: "Logística",
  GGRC11: "Logística", BRCO11: "Logística", XPIN11: "Industrial",
  XPML11: "Shoppings", VISC11: "Shoppings", HSML11: "Shoppings", HGBS11: "Shoppings", MALL11: "Shoppings",
  HGRE11: "Lajes corporativas", JSRE11: "Lajes corporativas", PVBI11: "Lajes corporativas", RCRB11: "Lajes corporativas",
  TRXF11: "Renda urbana", HGRU11: "Renda urbana", RBVA11: "Renda urbana",
  HFOF11: "Fundo de fundos", SNFF11: "Fundo de fundos", BCFF11: "Fundo de fundos", KFOF11: "Fundo de fundos", RBRF11: "Fundo de fundos",
  BTHF11: "Híbrido", KNRI11: "Híbrido", ALZR11: "Híbrido",
  RZAG11: "Agro (Fiagro)", SNAG11: "Agro (Fiagro)", KNCA11: "Agro (Fiagro)", VGIA11: "Agro (Fiagro)", RZTR11: "Agro (Fiagro)",
};

const SECTOR_PT: Record<string, string> = {
  "Financial Services": "Financeiro",
  Utilities: "Energia e saneamento",
  "Basic Materials": "Materiais básicos",
  Industrials: "Bens industriais",
  "Consumer Cyclical": "Consumo cíclico",
  "Consumer Defensive": "Consumo não cíclico",
  Energy: "Petróleo e gás",
  Healthcare: "Saúde",
  Technology: "Tecnologia",
  "Communication Services": "Comunicações",
  "Real Estate": "Imobiliário",
};

let overrides: Record<string, { categoria?: string; subcategoria?: string }> = {};
export function loadOverrides(file: string) {
  try {
    overrides = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    overrides = {};
  }
}

export function tickerOf(p: Profile) {
  if (p.dataSource === "MANUAL") return p.name?.split(" – ")[0] ?? p.symbol;
  return p.symbol.replace(/\.SA$/, "");
}

function fiiType(ticker: string, name: string) {
  if (FII_TYPES[ticker]) return FII_TYPES[ticker]!;
  if (/fiagro|agro/i.test(name)) return "Agro (Fiagro)";
  if (/fundo de fundos|\bfof\b|fofii/i.test(name)) return "Fundo de fundos";
  if (/receb|cri\b|cr[eé]dito|papel|renda imobili/i.test(name)) return "Papel";
  if (/log[ií]st/i.test(name)) return "Logística";
  if (/shopping|malls?\b/i.test(name)) return "Shoppings";
  if (/lajes|corporativ|escrit/i.test(name)) return "Lajes corporativas";
  return "Outros FIIs";
}

export function categorize(p: Profile): { category: string; subcategory: string } {
  const ticker = tickerOf(p);
  const name = p.name ?? "";
  const o = overrides[ticker];
  const result = ((): { category: string; subcategory: string } => {
    if (p.assetSubClass === "CRYPTOCURRENCY") return { category: "Cripto", subcategory: ticker };
    if (p.dataSource === "MANUAL") {
      const td = /^Tesouro (.+?) \d{4}$/.exec(name);
      if (td) return { category: "Tesouro Direto", subcategory: `Tesouro ${td[1]}` };
      if (p.assetClass === "FIXED_INCOME") return { category: "Renda Fixa", subcategory: /^(CDB|LCI|LCA|CRI|CRA|LC|DEB)/i.exec(name)?.[1]?.toUpperCase() ?? "Outros" };
    }
    const b3 = /^([A-Z]{4})(\d{1,2})$/.exec(ticker);
    if (b3 && (p.symbol.endsWith(".SA") || p.dataSource === "MANUAL")) {
      const n = Number(b3[2]);
      if (n >= 32 && n <= 39) return { category: "BDRs", subcategory: "BDRs" };
      if (/\betf\b|[íi]ndice|ishares|\btrend\b/i.test(name)) return { category: "ETFs", subcategory: /s&p|msci us|nasdaq|world/i.test(name) ? "Exterior" : "Brasil" };
      const isFii = /imobili|\bfii\b|fiagro|real estate|fdo inv|fundo de investimento/i.test(name) || (FII_TYPES[ticker] !== undefined);
      if (n >= 11 && isFii) return { category: "FIIs", subcategory: fiiType(ticker, name) };
      const sector = p.sectors?.[0]?.name;
      return { category: "Ações", subcategory: (sector && SECTOR_PT[sector]) || sector || "Outros" };
    }
    if (p.currency !== "BRL") return { category: "Exterior", subcategory: p.assetSubClass === "ETF" ? "ETFs" : "Ações" };
    return { category: "Outros", subcategory: "Outros" };
  })();
  return { category: o?.categoria ?? result.category, subcategory: o?.subcategoria ?? result.subcategory };
}
