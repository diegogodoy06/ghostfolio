/**
 * Servidor MCP "carteira": ferramentas e prompts sobre a carteira, para o Claude Desktop / Code.
 *
 * Roda dentro do container dos relatórios (que já tem o token do Ghostfolio e a simulação salva),
 * por stdio (mcp-stdio.ts, `docker exec -i ghostfolio-relatorios node mcp.js`) ou por HTTPS em
 * /mcp (main.ts). Só leitura: nada aqui altera o Ghostfolio nem a simulação salva.
 */
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Report } from "../shared";
import { TASKS, buildContext, buildPrompt } from "../context";
import { type Goal, goalsMarkdown } from "../goals";
import { type PeriodId, gainBetween, indexSeries, periodStart, ret, stats } from "../web/calc";
import { type Quote, type SimulationParams, defaultParams, simulate } from "../sim-engine";
import { buildReport, login } from "./report";
import { loadOverrides } from "./categories";
import { quote } from "./quote";

const BASE_URL = (process.env.GHOSTFOLIO_URL ?? "http://ghostfolio:3333").replace(/\/$/, "");
const TOKEN = process.env.GHOSTFOLIO_ACCESS_TOKEN ?? "";
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const OVERRIDES = path.join(process.env.EXTRATOS_DIR ?? "/extratos", "categorias.json");

let cached: { at: number; report: Report } | null = null;
async function getReport(): Promise<Report> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.report;
  loadOverrides(OVERRIDES);
  const report = await buildReport(await login(BASE_URL, TOKEN), [], "carteira");
  if (report.ghostfolioRestricted) throw new Error("A Vista do Apresentador está ligada no Ghostfolio e a API esconde os valores. Desligue em Minha conta.");
  cached = { at: Date.now(), report };
  return report;
}

function savedSimulation(r: Report): SimulationParams | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "simulacao.json"), "utf8")) as SimulationParams;
    return s?.version === 1 ? { ...defaultParams(positionsOf(r)), ...s, buys: s.buys ?? [], autoAllocate: s.autoAllocate ?? true } : null;
  } catch {
    return null;
  }
}

function savedGoals(): Goal[] {
  try {
    return (JSON.parse(fs.readFileSync(path.join(DATA_DIR, "metas.json"), "utf8")) as { goals?: Goal[] }).goals ?? [];
  } catch {
    return [];
  }
}

const positionsOf = (r: Report) =>
  r.categories.flatMap((c) => c.positions.map((p) => ({ ticker: p.ticker, category: p.category, value: p.value, price: p.price, quantity: p.quantity })));

async function quotesFor(tickers: string[], r: Report) {
  const own = new Set(positionsOf(r).map((p) => p.ticker));
  const out: Record<string, Quote> = {};
  for (const t of [...new Set(tickers)].filter((x) => !own.has(x))) {
    const q = await quote(t);
    if (q.price) out[t] = { price: q.price, category: q.category ?? "Outros", name: q.name };
  }
  return out;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`);

const STATUS: Record<string, string> = { comprar: "comprar", vender: "vender", acima: "acima da meta, sem compra", "na-meta": "sem compra neste aporte", "sem-meta": "sem meta" };

export function createMcpServer() {
const server = new McpServer({ name: "carteira", version: "1.0.0" });

server.registerTool(
  "resumo_carteira",
  {
    title: "Resumo da carteira",
    description:
      "Visão completa da carteira do usuário (Brasil): patrimônio, desempenho por período contra CDI/Ibovespa/IFIX/IPCA/dólar, risco, alocação por categoria e subcategoria, todas as posições, proventos de 12 meses, metas e a simulação salva. Use primeiro para qualquer análise.",
    inputSchema: {
      ocultar_valores: z.boolean().optional().describe("Só percentuais, sem valores em R$ nem quantidades"),
      incluir_posicoes: z.boolean().optional().describe("Incluir a tabela de posições (padrão: sim)"),
    },
  },
  async ({ ocultar_valores, incluir_posicoes }) => {
    const r = await getReport();
    const params = savedSimulation(r);
    const quotes = params ? await quotesFor([...(params.buys ?? []).map((b) => b.ticker), ...Object.values(params.assetPlans).flatMap((p) => p.extra ?? [])], r) : {};
    return text(buildContext(r, { hideValues: ocultar_valores, positions: incluir_posicoes, goals: savedGoals(), simulation: params ? { params, quotes } : null }));
  },
);

server.registerTool(
  "posicoes",
  {
    title: "Posições",
    description: "Lista as posições com quantidade, preço médio, preço, valor, peso, retorno e proventos. Filtre por categoria (Ações, FIIs, ETFs, BDRs, Exterior, Tesouro Direto, Renda Fixa, Cripto) ou por ticker.",
    inputSchema: { categoria: z.string().optional(), ticker: z.string().optional() },
  },
  async ({ categoria, ticker }) => {
    const r = await getReport();
    const rows = r.categories
      .filter((c) => !categoria || c.name.toLowerCase() === categoria.toLowerCase())
      .flatMap((c) => c.positions.filter((p) => !ticker || p.ticker === ticker.toUpperCase()));
    if (!rows.length) return text("Nenhuma posição encontrada para esse filtro.");
    return text(
      [
        "| Ativo | Categoria | Tipo/setor | Qtde | Preço médio | Preço | Valor | % carteira | Retorno | Proventos total | Proventos 12m |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
        ...rows.map((p) => `| ${p.ticker} | ${p.category} | ${p.subcategory} | ${p.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 4 })} | ${brl(p.avgPrice)} | ${brl(p.price)} | ${brl(p.value)} | ${pct(p.weight)} | ${pct(p.gainPct)} | ${brl(p.income)} | ${brl(p.income12m)} |`),
      ].join("\n"),
    );
  },
);

server.registerTool(
  "proventos",
  {
    title: "Proventos",
    description: "Proventos recebidos e estimados (dividendos, JCP, rendimentos de FII, amortizações), opcionalmente filtrados por ativo e por número de meses.",
    inputSchema: { meses: z.number().int().min(1).max(240).optional().describe("Padrão: 12"), ativo: z.string().optional() },
  },
  async ({ meses, ativo }) => {
    const r = await getReport();
    const since = new Date(Date.now() - (meses ?? 12) * 30.44 * 86_400_000).toISOString().slice(0, 10);
    const items = r.incomes.filter((i) => i.date >= since && (!ativo || i.ticker === ativo.toUpperCase()));
    const total = items.reduce((s, i) => s + i.value, 0);
    const byMonth = new Map<string, number>();
    for (const i of items) byMonth.set(i.date.slice(0, 7), (byMonth.get(i.date.slice(0, 7)) ?? 0) + i.value);
    return text(
      [
        `Total: ${brl(total)} em ${items.length} lançamentos (desde ${since}).`,
        `Por mês: ${[...byMonth.entries()].sort().map(([k, v]) => `${k} ${brl(v)}`).join(", ")}`,
        "",
        "| Data | Ativo | Categoria | Tipo | Valor | Situação |",
        "|---|---|---|---|---|---|",
        ...items.slice(-150).reverse().map((i) => `| ${i.date} | ${i.ticker} | ${i.category} | ${i.type} | ${brl(i.value)} | ${i.estimated ? "estimado" : "recebido"} |`),
      ].join("\n"),
    );
  },
);

server.registerTool(
  "desempenho",
  {
    title: "Desempenho",
    description: "Rentabilidade da carteira (por cota, com proventos) num período, contra CDI, Ibovespa, IFIX, IPCA, IPCA+6% e dólar, com ganho em R$ e estatísticas de risco.",
    inputSchema: { periodo: z.enum(["1M", "MTD", "6M", "YTD", "12M", "24M", "MAX"]).describe("1M, MTD (no mês), 6M, YTD (no ano), 12M, 24M ou MAX (desde o início)") },
  },
  async ({ periodo }) => {
    const r = await getReport();
    const end = r.daily.at(-1)!.date;
    const from = periodStart(periodo as PeriodId, r.firstDate, end);
    const c = ret(indexSeries(r), from, end);
    const b = (k: string) => ret(r.benchmarks[k]?.points ?? [], from, end);
    const st = stats(r, from, end);
    const cdi = b("cdi");
    return text(
      [
        `Período ${from} → ${end}`,
        `- Carteira: ${pct(c)} (${c != null && cdi ? pct(c / cdi) : "—"} do CDI) · ganho ${brl(gainBetween(r.daily, from, end))}`,
        `- CDI ${pct(cdi)} · Ibovespa ${pct(b("ibov"))} · IFIX ${pct(b("ifix"))} · IPCA ${pct(b("ipca"))} · IPCA+6% ${pct(b("ipca6"))} · Dólar ${pct(b("usd"))}`,
        `- Volatilidade anual ${pct(st.volatility)} · maior queda ${pct(st.maxDrawdown)} · Sharpe ${st.sharpe?.toFixed(2) ?? "—"} · melhor mês ${st.best ? `${st.best.key} ${pct(st.best.ret)}` : "—"} · pior mês ${st.worst ? `${st.worst.key} ${pct(st.worst.ret)}` : "—"}`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "simular_aporte",
  {
    title: "Simular aporte / rebalanceamento",
    description:
      "Calcula o que comprar (e vender, se pedido) para aproximar a carteira das metas por categoria, dado um aporte e vendas opcionais. Usa as metas salvas se não forem informadas. Não salva nada. Metas em % (ex.: {\"Ações\": 30, \"FIIs\": 40}).",
    inputSchema: {
      aporte: z.number().min(0).describe("Valor novo em R$"),
      metas: z.record(z.string(), z.number().min(0)).optional(),
      vender: z.array(z.object({ ticker: z.string(), modo: z.enum(["tudo", "quantidade", "valor"]), valor: z.number().optional() })).optional(),
      rebalancear_vendendo: z.boolean().optional().describe("Vender o que estiver acima da meta"),
    },
  },
  async ({ aporte, metas, vender, rebalancear_vendendo }) => {
    const r = await getReport();
    const positions = positionsOf(r);
    const base = savedSimulation(r) ?? defaultParams(positions);
    const params: SimulationParams = {
      ...base,
      targets: metas ?? base.targets,
      contribution: aporte,
      buys: [],
      sales: (vender ?? []).map((v) => ({ ticker: v.ticker.toUpperCase(), mode: v.modo === "tudo" ? "all" : v.modo === "quantidade" ? "qty" : "value", amount: v.valor })),
      allowSells: !!rebalancear_vendendo,
      autoAllocate: true,
    };
    const res = simulate(positions, params, await quotesFor(Object.values(params.assetPlans).flatMap((p) => p.extra ?? []), r));
    const lines = [`Para investir: ${brl(res.available + res.fromRebalanceSells)} · patrimônio depois ${brl(res.totalAfter)} · sobra ${brl(res.leftover)}`, ""];
    for (const c of res.categories) {
      lines.push(`**${c.name}** — meta ${pct(c.target)}, hoje ${pct(res.totalBefore ? c.current / res.totalBefore : 0)} → depois ${pct(res.totalAfter ? c.final / res.totalAfter : 0)}${c.buy > 0.5 ? ` · comprar ${brl(c.buy)}` : ""}${c.sell > 0.5 ? ` · vender ${brl(c.sell)}` : ""}${c.buy <= 0.5 && c.sell <= 0.5 ? ` · ${STATUS[c.status]}` : ""}`);
      for (const a of c.assets.filter((x) => x.buy > 0.5 || x.sell > 0.5)) {
        const q = a.quantity == null ? "" : ` (${Math.abs(a.quantity).toLocaleString("pt-BR", { maximumFractionDigits: a.whole ? 0 : 4 })} cotas)`;
        lines.push(`  - ${a.ticker}: ${a.sell > 0.5 ? `vender ${brl(a.sell)}` : `comprar ${brl(a.buy)}`}${q}`);
      }
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "metas",
  {
    title: "Metas de patrimônio",
    description: "Metas do usuário (chegar a um patrimônio até uma data), com progresso, se está no ritmo, aporte mensal necessário e quando atinge com o aporte atual.",
    inputSchema: { ocultar_valores: z.boolean().optional() },
  },
  async ({ ocultar_valores }) => {
    const lines = goalsMarkdown(await getReport(), savedGoals(), ocultar_valores);
    return text(lines.length ? lines.join("\n") : "Nenhuma meta cadastrada. Elas são criadas na aba Metas dos relatórios (porta 3334).");
  },
);

// Prompts prontos (aparecem no menu de prompts do Claude Desktop).
for (const t of TASKS.filter((x) => x.id !== "livre")) {
  server.registerPrompt(
    `analise_${t.id}`,
    { title: t.label, description: `${t.label} da carteira com os dados atuais` },
    async () => {
      const r = await getReport();
      const params = savedSimulation(r);
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: buildPrompt(buildContext(r, { goals: savedGoals(), simulation: params ? { params } : null }), t.prompt) } }],
      };
    },
  );
}

return server;
}
