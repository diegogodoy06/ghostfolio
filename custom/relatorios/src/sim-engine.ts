/**
 * Motor da simulação de carteira (sem efeitos colaterais; roda no navegador).
 *
 * Entrada: carteira atual (do Ghostfolio) + parâmetros salvos (metas, aporte, vendas).
 * Saída: quanto comprar/vender por categoria e por ativo.
 *
 * Rebalanceamento só com dinheiro novo ("encher o que está abaixo da meta"):
 * com T = patrimônio final e t_c a meta da categoria c, procura-se k tal que
 *   Σ_c max(0, k·t_c·T − V_c) = dinheiro disponível
 * e cada categoria recebe max(0, k·t_c·T − V_c). Assim o dinheiro vai primeiro para quem está
 * mais longe da meta e ninguém acima da meta recebe aporte. Com "vender o excedente" ligado,
 * cada categoria vai exatamente para a meta (vende o que sobra, compra o que falta).
 */

export interface SimPosition {
  ticker: string;
  category: string;
  value: number;
  price: number;
  quantity: number;
}

export interface SaleParam {
  ticker: string;
  mode: "all" | "qty" | "value";
  amount?: number;
}

export interface AssetPlan {
  mode: "proportional" | "equal" | "custom";
  /** Pesos em % dentro da categoria (modo custom). */
  weights?: Record<string, number>;
  /** Ativos novos (ainda fora da carteira) que podem receber aporte. */
  extra?: string[];
}

/** Compra manual (boleta): por quantidade de cotas ou por valor em R$. */
export interface BuyParam {
  ticker: string;
  mode: "qty" | "value";
  amount: number;
}

export interface Quote {
  price: number;
  category?: string;
  name?: string | null;
}

export interface SimulationParams {
  version: 1;
  /** Meta por categoria, em % do patrimônio. */
  targets: Record<string, number>;
  contribution: number;
  sales: SaleParam[];
  /** Compras manuais (boletas); o restante do dinheiro é distribuído automaticamente. */
  buys?: BuyParam[];
  /** Distribuir automaticamente o dinheiro que sobrar das boletas. */
  autoAllocate?: boolean;
  allowSells: boolean;
  wholeShares: boolean;
  assetPlans: Record<string, AssetPlan>;
  updatedAt?: string;
}

export interface AssetAction {
  ticker: string;
  isNew: boolean;
  price: number | null;
  current: number;
  buy: number;
  sell: number;
  /** Quantidade sugerida (cotas inteiras quando aplicável). */
  quantity: number | null;
  /** Negociado só em cotas inteiras. */
  whole: boolean;
  /** Parte da compra que veio de boleta manual. */
  manual: number;
  /** Valor-alvo do ativo depois da operação (uso interno do reinvestimento da sobra). */
  goal: number;
}

export interface CategoryAction {
  name: string;
  target: number;
  current: number;
  afterSales: number;
  targetValue: number;
  buy: number;
  sell: number;
  final: number;
  status: "comprar" | "vender" | "acima" | "na-meta" | "sem-meta";
  excess: number;
  assets: AssetAction[];
  /** Categoria deveria receber aporte, mas não tem ativos elegíveis (ex.: meta nova). */
  needsAssets: boolean;
}

export interface SaleResult {
  ticker: string;
  category: string | null;
  quantity: number;
  value: number;
  status: "ok" | "limitada" | "fora-da-carteira";
}

export interface SimResult {
  /** Compras manuais (boletas) somadas. */
  manualBuys: number;
  /** Dinheiro que falta quando as boletas passam do disponível. */
  deficit: number;
  /** Compras manuais resolvidas (quantidade e valor). */
  buys: { ticker: string; category: string; quantity: number; value: number; price: number | null; isNew: boolean }[];
  totalBefore: number;
  totalAfter: number;
  contribution: number;
  fromSales: number;
  fromRebalanceSells: number;
  available: number;
  leftover: number;
  targetSum: number;
  sales: SaleResult[];
  categories: CategoryAction[];
}

const EPS = 1e-6;

/** Distribui `money` entre itens com valor atual `v` e peso-meta `w` (Σw = 1). */
export function waterFill(money: number, items: { v: number; w: number }[], total: number): number[] {
  if (money <= EPS) return items.map(() => 0);
  const need = (k: number) => items.reduce((s, it) => s + Math.max(0, k * it.w * total - it.v), 0);
  let lo = 0;
  let hi = 1;
  while (need(hi) < money && hi < 1e6) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (need(mid) < money) lo = mid;
    else hi = mid;
  }
  const alloc = items.map((it) => Math.max(0, hi * it.w * total - it.v));
  const sum = alloc.reduce((s, x) => s + x, 0);
  // Ajuste fino para fechar exatamente o valor.
  return sum > EPS ? alloc.map((x) => (x * money) / sum) : items.map((it) => (money * it.w) / (items.reduce((s, i) => s + i.w, 0) || 1));
}

/** Ativos negociados em lote inteiro (B3); Tesouro, renda fixa e exterior aceitam fração. */
const wholeLot = (ticker: string, category: string) => /^[A-Z]{4}\d{1,2}$/.test(ticker) && !["Tesouro Direto", "Renda Fixa", "Exterior", "Cripto"].includes(category);

export function defaultParams(positions: SimPosition[]): SimulationParams {
  const total = positions.reduce((s, p) => s + p.value, 0);
  const targets: Record<string, number> = {};
  for (const p of positions) targets[p.category] = (targets[p.category] ?? 0) + (total ? (p.value / total) * 100 : 0);
  for (const k of Object.keys(targets)) targets[k] = Math.round(targets[k]!);
  return { version: 1, targets, contribution: 0, sales: [], allowSells: false, wholeShares: true, assetPlans: {} };
}

/** `prices`: cotação dos ativos novos (fora da carteira), buscada pelo servidor. */
export function simulate(basePositions: SimPosition[], params: SimulationParams, quotes: Record<string, Quote> = {}): SimResult {
  // Ativos de boletas que ainda não estão na carteira entram como posições vazias.
  const newTickers = new Set<string>();
  const positions = [...basePositions];
  for (const b of params.buys ?? []) {
    if (positions.some((p) => p.ticker === b.ticker)) continue;
    const q = quotes[b.ticker];
    positions.push({ ticker: b.ticker, category: q?.category ?? "Outros", value: 0, price: q?.price ?? 0, quantity: 0 });
    newTickers.add(b.ticker);
  }
  const prices = Object.fromEntries(Object.entries(quotes).map(([k, v]) => [k, v.price]));
  const byTicker = new Map(positions.map((p) => [p.ticker, p]));

  // 1) Vendas planejadas.
  const sold = new Map<string, number>(); // ticker -> valor vendido
  const sales: SaleResult[] = params.sales.map((s) => {
    const p = byTicker.get(s.ticker);
    if (!p) return { ticker: s.ticker, category: null, quantity: 0, value: 0, status: "fora-da-carteira" };
    let q = s.mode === "all" ? p.quantity : s.mode === "qty" ? (s.amount ?? 0) : p.price > 0 ? (s.amount ?? 0) / p.price : 0;
    let status: SaleResult["status"] = "ok";
    if (q > p.quantity + EPS) {
      q = p.quantity;
      status = "limitada";
    }
    const value = Math.max(0, q) * p.price;
    sold.set(p.ticker, (sold.get(p.ticker) ?? 0) + value);
    return { ticker: p.ticker, category: p.category, quantity: q, value, status };
  });
  const fromSales = sales.reduce((s, x) => s + x.value, 0);
  const contribution = Math.max(0, params.contribution || 0);
  const available = contribution + fromSales;

  // 1b) Compras manuais (boletas).
  const manual = new Map<string, number>();
  const buys = (params.buys ?? []).map((b) => {
    const p = byTicker.get(b.ticker)!;
    const price = p.price > 0 ? p.price : null;
    const whole = !!params.wholeShares && wholeLot(b.ticker, p.category);
    const quantity = !price ? 0 : b.mode === "qty" ? b.amount : whole ? Math.floor(b.amount / price + EPS) : b.amount / price;
    const value = price ? quantity * price : b.mode === "value" ? b.amount : 0;
    manual.set(b.ticker, (manual.get(b.ticker) ?? 0) + value);
    return { ticker: b.ticker, category: p.category, quantity, value, price, isNew: newTickers.has(b.ticker) };
  });
  const manualBuys = buys.reduce((s, b) => s + b.value, 0);
  const autoCash = params.autoAllocate === false ? 0 : Math.max(0, available - manualBuys);
  const deficit = Math.max(0, manualBuys - available);

  // 2) Valores por categoria depois das vendas e das boletas.
  const valueAfter = (p: SimPosition) => Math.max(0, p.value - (sold.get(p.ticker) ?? 0)) + (manual.get(p.ticker) ?? 0);
  const totalBefore = positions.reduce((s, p) => s + p.value, 0);
  const totalAfter = totalBefore + contribution;
  const categories = [...new Set([...positions.map((p) => p.category), ...Object.keys(params.targets).filter((c) => (params.targets[c] ?? 0) > 0)])];
  const targetSum = categories.reduce((s, c) => s + (params.targets[c] ?? 0), 0);
  const w = (c: string) => (targetSum > 0 ? (params.targets[c] ?? 0) / targetSum : 0);
  const current = (c: string) => positions.filter((p) => p.category === c).reduce((s, p) => s + p.value, 0);
  const afterSales = (c: string) => positions.filter((p) => p.category === c).reduce((s, p) => s + valueAfter(p), 0);

  // 3) Quanto cada categoria compra/vende (automático).
  const catBuys = new Map<string, number>();
  const sells = new Map<string, number>();
  if (params.allowSells) {
    for (const c of categories) {
      const diff = w(c) * totalAfter - afterSales(c);
      if (diff > 0) catBuys.set(c, diff);
      else sells.set(c, -diff);
    }
  } else {
    const alloc = waterFill(autoCash, categories.map((c) => ({ v: afterSales(c), w: w(c) })), totalAfter);
    categories.forEach((c, i) => catBuys.set(c, alloc[i]!));
  }

  // 4) Dentro de cada categoria, por ativo.
  const result: CategoryAction[] = categories.map((c) => {
    const plan = params.assetPlans[c] ?? { mode: "proportional" };
    const fullySold = new Set(params.sales.filter((s) => s.mode === "all").map((s) => s.ticker));
    const own = positions.filter((p) => p.category === c && !fullySold.has(p.ticker));
    const extras = (plan.extra ?? []).filter((t) => !byTicker.has(t));
    const members = [...own.map((p) => ({ ticker: p.ticker, v: valueAfter(p), price: p.price > 0 ? p.price : null, isNew: newTickers.has(p.ticker) })), ...extras.map((t) => ({ ticker: t, v: 0, price: (prices[t] ?? null) as number | null, isNew: true }))];
    const catAfter = afterSales(c);
    const buy = catBuys.get(c) ?? 0;
    const sell = sells.get(c) ?? 0;

    const rawW = members.map((m) =>
      plan.mode === "equal" ? 1 : plan.mode === "custom" ? Math.max(0, plan.weights?.[m.ticker] ?? 0) : m.v,
    );
    const sumW = rawW.reduce((s, x) => s + x, 0);
    const weights = sumW > 0 ? rawW.map((x) => x / sumW) : members.map(() => 1 / (members.length || 1));
    const assetBuys = buy > EPS && members.length ? waterFill(buy, members.map((m, i) => ({ v: m.v, w: weights[i]! })), catAfter + buy) : members.map(() => 0);

    // Venda do excedente: tira de quem mais passou da própria meta dentro da categoria.
    let assetSells = members.map(() => 0);
    if (sell > EPS) {
      const goal = catAfter - sell;
      const excess = members.map((m, i) => Math.max(0, m.v - weights[i]! * goal));
      const ex = excess.reduce((s, x) => s + x, 0);
      assetSells = ex > EPS ? excess.map((x) => (x / ex) * sell) : members.map((m) => (catAfter ? (m.v / catAfter) * sell : 0));
    }

    const assets: AssetAction[] = members.map((m, i) => {
      const whole = !!params.wholeShares && wholeLot(m.ticker, c);
      const goal = weights[i]! * (catAfter + buy - sell);
      let b = assetBuys[i]!;
      let sl = assetSells[i]!;
      let q: number | null = null;
      if (m.price && m.price > 0) {
        if (b > EPS) {
          q = whole ? Math.floor(b / m.price + EPS) : b / m.price;
          b = q * m.price;
        } else if (sl > EPS) {
          // Venda em cotas inteiras arredonda para cima para garantir o valor.
          const sq = whole ? Math.ceil(sl / m.price - EPS) : sl / m.price;
          sl = Math.min(sq * m.price, m.v);
          q = -sl / m.price;
        }
      }
      // Soma a compra manual (boleta) à automática.
      const man = manual.get(m.ticker) ?? 0;
      const manQ = m.price ? man / m.price : 0;
      const current = m.v - man;
      return { ticker: m.ticker, isNew: m.isNew, price: m.price, current, buy: b + man, sell: sl, quantity: q != null || man ? (q ?? 0) + manQ : null, whole, goal, manual: man };
    });

    const needsAssets = buy > 0.5 && members.length === 0;
    const boughtSum = needsAssets ? buy : assets.reduce((s, a) => s + a.buy, 0);
    const soldSum = assets.reduce((s, a) => s + a.sell, 0);
    const targetValue = w(c) * totalAfter;
    const final = catAfter + boughtSum - soldSum;
    const excess = Math.max(0, catAfter - targetValue);
    const status: CategoryAction["status"] =
      w(c) === 0 ? "sem-meta" : soldSum > EPS ? "vender" : boughtSum > 0.5 ? "comprar" : excess > Math.max(1, targetValue * 0.005) ? "acima" : "na-meta";
    return {
      name: c,
      target: w(c),
      current: current(c),
      afterSales: catAfter,
      targetValue,
      buy: boughtSum,
      sell: soldSum,
      final,
      status,
      excess,
      needsAssets,
      assets,
    };
  });

  // 5) Reinveste a sobra do arredondamento: uma cota por vez no ativo mais abaixo da meta,
  //    priorizando as categorias mais longe da meta.
  const spent = () => result.reduce((t, c) => t + (c.needsAssets ? c.buy : c.assets.reduce((u, a) => u + a.buy, 0)), 0);
  const raised = () => result.reduce((t, c) => t + c.assets.reduce((u, a) => u + a.sell, 0), 0);
  let pool = available + raised() - spent();
  for (let guard = 0; guard < 5000 && pool > EPS && params.autoAllocate !== false; guard++) {
    let best: { c: CategoryAction; a: AssetAction; score: number } | null = null;
    for (const c of result) {
      if (c.target <= 0 || c.status === "vender") continue;
      const cFinal = c.afterSales + c.assets.reduce((u, a) => u + a.buy - a.sell, 0);
      const cGap = (c.targetValue - cFinal) / (c.targetValue || 1);
      // Só categorias ainda abaixo da meta (a sobra não deve engordar quem já passou dela).
      if (cGap <= 0) continue;
      for (const a of c.assets) {
        if (!a.price || a.price > pool + EPS || a.sell > EPS) continue;
        if (a.price > c.targetValue - cFinal + a.price * 0.5) continue; // não estoura a meta da categoria
        const aGap = (a.goal - (a.current + a.buy)) / (a.goal || 1);
        const score = cGap * 10 + aGap;
        if (!best || score > best.score) best = { c, a, score };
      }
    }
    if (!best) break;
    const a = best.a;
    const step = a.whole ? a.price! : Math.min(pool, a.price!);
    a.buy += step;
    a.quantity = (a.quantity ?? 0) + step / a.price!;
    pool -= step;
  }
  const leftover = Math.max(0, pool);
  for (const c of result) {
    if (!c.needsAssets) c.buy = c.assets.reduce((u, a) => u + a.buy, 0);
    c.final = c.afterSales + c.buy - c.sell;
    if (c.status !== "vender" && c.status !== "sem-meta") {
      c.status = c.buy > 0.5 ? "comprar" : c.excess > Math.max(1, c.targetValue * 0.005) ? "acima" : "na-meta";
    }
  }

  for (const c of result) c.assets = c.assets.filter((a) => a.buy > EPS || a.sell > EPS || a.isNew || a.manual > EPS).sort((a, b) => b.buy + b.sell - (a.buy + a.sell));

  // Se as boletas passam do dinheiro disponível, o patrimônio "depois" inclui o que falta aportar.
  return {
    manualBuys,
    deficit,
    buys,
    totalBefore,
    totalAfter: totalAfter + deficit,
    contribution,
    fromSales,
    fromRebalanceSells: result.reduce((s, c) => s + c.sell, 0),
    available,
    leftover,
    targetSum,
    sales,
    categories: result,
  };
}
