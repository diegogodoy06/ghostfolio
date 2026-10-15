/**
 * Contexto da carteira em Markdown para o Claude (botão "Analisar com Claude" e servidor MCP).
 * Puro: recebe o relatório e, se houver, a simulação salva; não acessa rede nem DOM.
 */
import type { Report } from "./shared";
import { type PeriodId, gainBetween, indexSeries, monthlyTable, periodStart, ret, stats } from "./web/calc";
import { type Quote, type SimulationParams, simulate } from "./sim-engine";

export interface ContextOptions {
  /** Só percentuais: sem valores em R$ nem quantidades. */
  hideValues?: boolean;
  simulation?: { params: SimulationParams; quotes?: Record<string, Quote> } | null;
  /** Incluir a tabela completa de posições (padrão: sim). */
  positions?: boolean;
}

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const p = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })}%`);
const today = () => new Date().toISOString().slice(0, 10);

export function buildContext(r: Report, opts: ContextOptions = {}): string {
  const hide = !!opts.hideValues;
  const m = (n: number) => (hide ? "(oculto)" : brl.format(n));
  const end = r.daily.at(-1)?.date ?? today();
  const idx = indexSeries(r);
  const lines: string[] = [];
  const s = r.summary;

  lines.push(`# Minha carteira de investimentos (dados de ${end.split("-").reverse().join("/")})`);
  lines.push("");
  lines.push("Investidor pessoa física no Brasil. Rentabilidade calculada por cota (ponderada no tempo, inclui proventos), como Rico/TradeMap.");
  if (hide) lines.push("Valores absolutos em R$ foram omitidos de propósito; use os percentuais.");
  lines.push("");

  // Resumo
  lines.push("## Resumo");
  lines.push(`- Patrimônio: ${m(s.value)} · investido: ${m(s.cost)} · valorização sobre o custo: ${p(s.gainPct)}`);
  lines.push(`- Proventos últimos 12 meses: ${m(s.income12m)} (yield ${p(s.yield12m, 2)})`);
  lines.push(`- Início do histórico: ${r.firstDate.split("-").reverse().join("/")}`);
  lines.push("");

  // Desempenho
  lines.push("## Desempenho (carteira × referências)");
  lines.push("| Período | Carteira | CDI | % do CDI | Ibovespa | IFIX | IPCA | IPCA+6% | Dólar |" + (hide ? "" : " Ganho R$ |"));
  lines.push("|---|---|---|---|---|---|---|---|---|" + (hide ? "" : "---|"));
  const periods: [PeriodId, string][] = [["1M", "1 mês"], ["6M", "6 meses"], ["YTD", "No ano"], ["12M", "12 meses"], ["24M", "24 meses"], ["MAX", "Desde o início"]];
  for (const [id, label] of periods) {
    const from = periodStart(id, r.firstDate, end);
    const c = ret(idx, from, end);
    const cdi = ret(r.benchmarks.cdi?.points ?? [], from, end);
    const b = (k: string) => p(ret(r.benchmarks[k]?.points ?? [], from, end));
    lines.push(`| ${label} | ${p(c)} | ${p(cdi)} | ${c != null && cdi ? p(c / cdi, 0) : "—"} | ${b("ibov")} | ${b("ifix")} | ${b("ipca")} | ${b("ipca6")} | ${b("usd")} |` + (hide ? "" : ` ${m(gainBetween(r.daily, from, end))} |`));
  }
  const st = stats(r, periodStart("12M", r.firstDate, end), end);
  lines.push("");
  lines.push(`Risco (12 meses): volatilidade anual ${p(st.volatility)}, maior queda ${p(st.maxDrawdown)}, Sharpe ${st.sharpe == null ? "—" : st.sharpe.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}, meses positivos ${st.positiveMonths}/${st.months}, meses acima do CDI ${st.beatCdi}/${st.months}.`);
  const rows = monthlyTable(r).slice(0, 2);
  if (rows.length) {
    lines.push("");
    lines.push("Rentabilidade mensal recente (mês: carteira / % do CDI):");
    for (const row of rows) {
      const ms = row.months.map((x, i) => (x ? `${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][i]} ${p(x.ret)}${x.cdi ? ` (${p(x.ret / x.cdi, 0)})` : ""}` : null)).filter(Boolean);
      lines.push(`- ${row.year}: ${ms.join(", ")}${row.year_ ? ` · ano ${p(row.year_.ret)}` : ""}`);
    }
  }
  lines.push("");

  // Alocação
  lines.push("## Alocação por categoria");
  for (const c of r.categories) {
    lines.push(`- **${c.name}**: ${p(c.weight)} da carteira${hide ? "" : ` (${m(c.value)})`}, retorno sobre custo ${p(c.cost ? (c.value - c.cost) / c.cost : null)} · ${c.subgroups.map((g) => `${g.name} ${p(g.weight, 0)}`).join(", ")}`);
  }
  lines.push("");

  // Posições
  if (opts.positions !== false) {
    lines.push("## Posições");
    lines.push(`| Ativo | Categoria | Tipo/setor |${hide ? "" : " Qtde | Preço médio | Preço | Valor |"} % carteira | % na classe | Retorno s/ custo | Proventos 12m${hide ? "" : " | Yield s/ custo 12m"} |`);
    lines.push(`|---|---|---|${hide ? "" : "---|---|---|---|"}---|---|---|---|${hide ? "" : "---|"}`);
    for (const c of r.categories) {
      for (const x of c.positions) {
        const yoc = x.cost > 0 ? x.income12m / x.cost : null;
        lines.push(
          `| ${x.ticker} | ${c.name} | ${x.subcategory} |` +
            (hide ? "" : ` ${x.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 4 })} | ${m(x.avgPrice)} | ${m(x.price)} | ${m(x.value)} |`) +
            ` ${p(x.weight)} | ${p(x.weightInCategory)} | ${p(x.gainPct)} | ${hide ? (x.income12m > 0 ? "sim" : "não") : m(x.income12m)}` +
            (hide ? " |" : ` | ${p(yoc)} |`),
        );
      }
    }
    lines.push("");
  }

  // Proventos
  const since12 = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const inc12 = r.incomes.filter((i) => i.date >= since12);
  const byMonth = new Map<string, number>();
  for (const i of inc12) byMonth.set(i.date.slice(0, 7), (byMonth.get(i.date.slice(0, 7)) ?? 0) + i.value);
  const byAsset = new Map<string, number>();
  for (const i of inc12) byAsset.set(i.ticker, (byAsset.get(i.ticker) ?? 0) + i.value);
  const total12 = inc12.reduce((t, i) => t + i.value, 0);
  lines.push("## Proventos (12 meses)");
  lines.push(`- Por mês: ${[...byMonth.entries()].sort().map(([k, v]) => `${k.slice(5)}/${k.slice(2, 4)} ${hide ? p(total12 ? v / total12 : 0, 0) : m(v)}`).join(", ")}`);
  lines.push(`- Maiores pagadores: ${[...byAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, v]) => `${t} ${hide ? p(total12 ? v / total12 : 0, 0) : m(v)}`).join(", ")}`);
  const estimated = r.incomes.filter((i) => i.estimated).reduce((t, i) => t + i.value, 0);
  if (estimated > 0) lines.push(`- Estimados a receber (data ex já passou): ${m(estimated)}`);
  lines.push("");

  // Estratégia e simulação
  if (opts.simulation) {
    const { params, quotes } = opts.simulation;
    const positions = r.categories.flatMap((c) => c.positions.map((x) => ({ ticker: x.ticker, category: x.category, value: x.value, price: x.price, quantity: x.quantity })));
    const res = simulate(positions, params, quotes ?? {});
    const targetSum = Object.values(params.targets).reduce((t, v) => t + v, 0) || 1;
    lines.push("## Minha estratégia (metas por categoria)");
    for (const c of res.categories) lines.push(`- ${c.name}: meta ${p((params.targets[c.name] ?? 0) / targetSum)} · hoje ${p(res.totalBefore ? c.current / res.totalBefore : 0)}`);
    const active = params.contribution > 0 || params.sales.length > 0 || (params.buys?.length ?? 0) > 0 || params.allowSells;
    if (active) {
      lines.push("");
      lines.push("## Simulação salva (ainda não executada)");
      lines.push(`- Novo aporte: ${m(params.contribution)} · vendas planejadas: ${params.sales.map((x) => `${x.ticker} (${x.mode === "all" ? "tudo" : x.mode === "qty" ? `${x.amount} cotas` : m(x.amount ?? 0)})`).join(", ") || "nenhuma"} · compras manuais: ${(params.buys ?? []).map((b) => `${b.ticker} (${b.mode === "qty" ? `${b.amount} cotas` : m(b.amount)})`).join(", ") || "nenhuma"}`);
      lines.push(`- Rebalanceamento completo (vender excedente): ${params.allowSells ? "sim" : "não"}`);
      lines.push("- Resultado calculado:");
      for (const c of res.categories) {
        const moves = c.assets.filter((a) => a.buy > 0.5 || a.sell > 0.5).slice(0, 8).map((a) => `${a.ticker} ${a.sell > 0 ? "−" : "+"}${hide ? "" : m(a.buy || a.sell)}`.trim());
        lines.push(`  - ${c.name}: ${c.status}${moves.length ? ` → ${moves.join(", ")}` : ""} (depois ${p(res.totalAfter ? c.final / res.totalAfter : 0)})`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Tarefas prontas para o botão "Analisar com Claude". */
export const TASKS: { id: string; label: string; needsSim?: boolean; prompt: string }[] = [
  {
    id: "diagnostico",
    label: "Diagnóstico geral",
    prompt:
      "Faça um diagnóstico da minha carteira: pontos fortes, pontos fracos, concentração, qualidade dos ativos que você conhecer, comparação com CDI e Ibovespa, e o que mais chama atenção. Termine com 3 a 5 ações práticas, em ordem de prioridade.",
  },
  {
    id: "estrategia",
    label: "Estratégia e rebalanceamento",
    prompt:
      "Avalie minha alocação por categoria e minhas metas. A diversificação faz sentido para um investidor brasileiro de longo prazo? Sugira uma alocação-alvo justificada e como chegar nela usando aportes (sem vender, se possível).",
  },
  {
    id: "proventos",
    label: "Renda passiva e proventos",
    prompt:
      "Analise meus proventos: estabilidade, concentração por pagador, yield sobre custo e tendência. Quais ativos sustentam a renda e quais são arriscados? Como aumentar a renda passiva mantendo qualidade?",
  },
  {
    id: "riscos",
    label: "Riscos e concentração",
    prompt:
      "Liste os principais riscos da carteira: concentração por ativo, setor e tipo de FII, exposição a juros e câmbio, ativos com prejuízo relevante e correlações óbvias. Para cada risco, diga a gravidade e uma forma de mitigar.",
  },
  {
    id: "simulacao",
    label: "Revisar minha simulação",
    needsSim: true,
    prompt:
      "Revise a simulação salva: as compras e vendas propostas fazem sentido? Há ativos melhores dentro de cada categoria para receber o aporte? Algo que eu deveria mudar antes de executar?",
  },
  { id: "livre", label: "Pergunta livre", prompt: "" },
];

export function buildPrompt(context: string, task: string) {
  return [
    "Você é um analista de investimentos experiente no mercado brasileiro (B3, FIIs, Tesouro Direto, tributação de PF).",
    "Responda em português, de forma direta e organizada. Seja honesto sobre incertezas e não invente dados que não estão abaixo; quando usar conhecimento geral sobre um ativo, diga que é geral e pode estar desatualizado. Isto não é recomendação formal de investimento.",
    "",
    `**Tarefa:** ${task || "(escreva sua pergunta aqui)"}`,
    "",
    "---",
    "",
    context,
  ].join("\n");
}
