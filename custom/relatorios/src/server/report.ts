/**
 * Monta o relatório a partir da API do Ghostfolio.
 *
 * Rentabilidade por cota (TWR), como Rico e TradeMap: em cada dia,
 *   r = (V_d − V_{d−1} − F + D) / (V_{d−1} + F)
 * onde V é o valor de mercado, F as compras menos vendas do dia (pelo valor da operação) e D
 * os proventos recebidos. Assim aportes e retiradas não distorcem o resultado e os proventos
 * entram como retorno (diferente do gráfico de Análise do Ghostfolio, que os exclui).
 */
import type { CategoryGroup, DailyPoint, IncomeItem, Position, Report } from "../shared";
import { CATEGORY_ORDER, type Profile, categorize, tickerOf } from "./categories";

type Api = <T>(path: string) => Promise<T>;

interface Activity {
  type: string;
  date: string;
  comment: string | null;
  quantity: number;
  unitPrice: number;
  valueInBaseCurrency: number;
  accountId: string | null;
  assetProfile: Profile;
}

interface Holding {
  assetProfile: Profile;
  quantity: number;
  marketPrice: number;
  valueInBaseCurrency: number;
  investment: number;
}

interface ChartItem {
  date: string;
  value?: number;
  valueWithCurrencyEffect?: number;
  totalInvestment?: number;
}

const day = (d: string) => d.slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

export async function login(baseUrl: string, accessToken: string): Promise<Api> {
  const res = await fetch(`${baseUrl}/api/v1/auth/anonymous`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken }),
  });
  if (!res.ok) throw new Error(`Ghostfolio recusou o token (${res.status})`);
  const { authToken } = (await res.json()) as { authToken: string };
  return async <T>(path: string) => {
    const r = await fetch(`${baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return (await r.json()) as T;
  };
}

function incomeType(comment: string | null) {
  if (!comment) return "Provento";
  if (comment.startsWith("Auto (Yahoo)")) return /JCP/.test(comment) ? "JCP (estimado)" : "Provento (estimado)";
  if (/JCP/i.test(comment)) return "JCP";
  if (/rendimento/i.test(comment)) return "Rendimento";
  if (/dividendo/i.test(comment)) return "Dividendo";
  if (/amortiza/i.test(comment)) return "Amortização";
  if (/aluguel/i.test(comment)) return "Aluguel";
  return "Provento";
}

/** Gráfico diário: o Ghostfolio limita os pontos por consulta, então busca ano a ano. */
async function dailyChart(api: Api, firstYear: number, filter: string) {
  const thisYear = new Date().getUTCFullYear();
  const byDate = new Map<string, ChartItem>();
  for (let y = firstYear; y <= thisYear; y++) {
    const range = y === thisYear ? "ytd" : String(y);
    const { chart } = await api<{ chart: ChartItem[] }>(`/v2/portfolio/performance?range=${range}${filter}`);
    for (const c of chart ?? []) byDate.set(day(c.date), c);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

async function series(api: Api, dataSource: string, symbol: string, days: number): Promise<[string, number][]> {
  try {
    const { historicalData } = await api<{ historicalData: { date: string; value: number }[] }>(
      `/v1/symbol/${dataSource}/${encodeURIComponent(symbol)}?includeHistoricalData=${days}`,
    );
    return historicalData.map((p) => [day(p.date), p.value] as [string, number]).sort((a, b) => a[0].localeCompare(b[0]));
  } catch {
    return [];
  }
}

/** O Ghostfolio devolve a carteira vazia enquanto recalcula o cache: tenta de novo. */
export async function buildReport(api: Api, accountIds: string[]): Promise<Report> {
  for (let attempt = 1; ; attempt++) {
    const report = await buildOnce(api, accountIds);
    if (report.summary.value > 0 || report.incomes.length === 0 || attempt >= 4) return report;
    await new Promise((r) => setTimeout(r, 4_000));
  }
}

async function buildOnce(api: Api, accountIds: string[]): Promise<Report> {
  const filter = accountIds.length ? `&accounts=${accountIds.map(encodeURIComponent).join(",")}` : "";
  const [{ accounts }, { activities }, details, user] = await Promise.all([
    api<{ accounts: { id: string; name: string }[] }>("/v1/account"),
    api<{ activities: Activity[] }>(`/v1/activities?${filter.slice(1)}`),
    api<{ holdings: Holding[] | Record<string, Holding> }>(`/v1/portfolio/details?range=max${filter}`),
    api<{ settings: { baseCurrency?: string } }>("/v1/user"),
  ]);

  // ---- Proventos ----
  const today = new Date().toISOString().slice(0, 10);
  const since12m = addDays(today, -365);
  const incomes: IncomeItem[] = activities
    .filter((a) => a.type === "DIVIDEND")
    .map((a) => ({
      date: day(a.date),
      ticker: tickerOf(a.assetProfile),
      category: categorize(a.assetProfile).category,
      type: incomeType(a.comment),
      value: a.valueInBaseCurrency ?? a.quantity * a.unitPrice,
      estimated: !!a.comment?.startsWith("Auto (Yahoo)"),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const incomeBy = (ticker: string, from = "") => incomes.filter((i) => i.ticker === ticker && i.date >= from).reduce((s, i) => s + i.value, 0);

  // ---- Posições e categorias ----
  const holdings = (Array.isArray(details.holdings) ? details.holdings : Object.values(details.holdings)).filter((h) => h.quantity > 1e-9);
  const total = holdings.reduce((s, h) => s + h.valueInBaseCurrency, 0);
  const positions: Position[] = holdings.map((h) => {
    const { category, subcategory } = categorize(h.assetProfile);
    const ticker = tickerOf(h.assetProfile);
    const gain = h.valueInBaseCurrency - h.investment;
    return {
      symbol: h.assetProfile.symbol,
      ticker,
      name: h.assetProfile.name ?? ticker,
      category,
      subcategory,
      currency: h.assetProfile.currency,
      quantity: h.quantity,
      avgPrice: h.quantity ? h.investment / h.quantity : 0,
      price: h.marketPrice,
      value: h.valueInBaseCurrency,
      cost: h.investment,
      gain,
      gainPct: h.investment > 0 ? gain / h.investment : null,
      income: incomeBy(ticker),
      income12m: incomeBy(ticker, since12m),
      weightInCategory: 0,
      weight: total ? h.valueInBaseCurrency / total : 0,
    };
  });
  const groups = new Map<string, Position[]>();
  for (const p of positions) groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
  const categories: CategoryGroup[] = [...groups.entries()]
    .map(([name, ps]) => {
      const value = ps.reduce((s, p) => s + p.value, 0);
      for (const p of ps) p.weightInCategory = value ? p.value / value : 0;
      const subs = new Map<string, number>();
      for (const p of ps) subs.set(p.subcategory, (subs.get(p.subcategory) ?? 0) + p.value);
      return {
        name,
        value,
        cost: ps.reduce((s, p) => s + p.cost, 0),
        weight: total ? value / total : 0,
        subgroups: [...subs.entries()].map(([n, v]) => ({ name: n, value: v, weight: value ? v / value : 0 })).sort((a, b) => b.value - a.value),
        positions: ps.sort((a, b) => b.value - a.value),
      };
    })
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.name) - CATEGORY_ORDER.indexOf(b.name));

  // ---- Rentabilidade diária (TWR com proventos) ----
  const trades = activities.filter((a) => a.type === "BUY" || a.type === "SELL");
  const firstDate = trades.reduce((m, a) => (day(a.date) < m ? day(a.date) : m), today);
  const chart = await dailyChart(api, Number(firstDate.slice(0, 4)), filter);
  const flows = new Map<string, number>();
  for (const a of trades) flows.set(day(a.date), (flows.get(day(a.date)) ?? 0) + (a.type === "BUY" ? 1 : -1) * (a.valueInBaseCurrency ?? a.quantity * a.unitPrice));
  const divs = new Map<string, number>();
  for (const i of incomes) divs.set(i.date, (divs.get(i.date) ?? 0) + i.value);
  const sumBetween = (m: Map<string, number>, from: string, to: string) => {
    let s = 0;
    for (const [d, v] of m) if (d > from && d <= to) s += v;
    return s;
  };

  const daily: DailyPoint[] = [];
  let index = 1;
  let prev: [string, ChartItem] | null = null;
  for (const [d, c] of chart) {
    if (d < firstDate) continue;
    const v = c.valueWithCurrencyEffect ?? c.value ?? 0;
    let pnl = 0;
    if (prev) {
      const v0 = prev[1].valueWithCurrencyEffect ?? prev[1].value ?? 0;
      const f = sumBetween(flows, prev[0], d);
      const dv = sumBetween(divs, prev[0], d);
      const base = v0 + Math.max(f, 0);
      const r = base > 1e-6 ? (v - v0 - f + dv) / base : 0;
      // Proteção contra dias com dados incompletos (cotação ausente etc.).
      if (Number.isFinite(r) && Math.abs(r) < 0.5) {
        index *= 1 + r;
        pnl = v - v0 - f + dv;
      }
    }
    daily.push({ date: d, index, value: v, invested: c.totalInvestment ?? 0, pnl });
    prev = [d, c];
  }

  // ---- Referências ----
  const days = Math.ceil((Date.now() - Date.parse(firstDate)) / 86_400_000) + 10;
  const [cdi, ipca, ipca6, ibov, ifix, usd] = await Promise.all([
    series(api, "MANUAL", "GF_CDI", days),
    series(api, "MANUAL", "GF_IPCA", days),
    series(api, "MANUAL", "GF_IPCA6", days),
    series(api, "YAHOO", "^BVSP", days),
    series(api, "YAHOO", "XFIX11.SA", days),
    series(api, "YAHOO", "USDBRL", days),
  ]);

  const cost = positions.reduce((s, p) => s + p.cost, 0);
  const income12m = incomes.filter((i) => i.date >= since12m).reduce((s, i) => s + i.value, 0);
  return {
    generatedAt: new Date().toISOString(),
    baseCurrency: user.settings.baseCurrency ?? "BRL",
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    summary: {
      value: total,
      cost,
      gain: total - cost,
      gainPct: cost ? (total - cost) / cost : 0,
      income12m,
      incomeTotal: incomes.reduce((s, i) => s + i.value, 0),
      yield12m: total ? income12m / total : 0,
    },
    categories,
    daily,
    benchmarks: {
      cdi: { label: "CDI", points: cdi },
      ibov: { label: "Ibovespa", points: ibov },
      ipca: { label: "IPCA", points: ipca },
      ipca6: { label: "IPCA + 6%", points: ipca6 },
      ifix: { label: "IFIX", points: ifix },
      usd: { label: "Dólar", points: usd },
    },
    incomes,
    firstDate,
  };
}
