/**
 * Ferramentas de escrita no Ghostfolio pelo MCP: o Claude registra compras, vendas, proventos e
 * aplicações feitas FORA da B3 (exchanges de cripto, corretoras no exterior, fundos e a reserva
 * de emergência), em contas próprias. As contas da B3 são do ghostfolio-sync (extratos em
 * extratos/) e ficam bloqueadas aqui, para não duplicar nada.
 *
 * Usa o mesmo usuário do resto do MCP (GHOSTFOLIO_ACCESS_TOKEN).
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TAG_EMERGENCY_FUND } from "./report";

const BASE_URL = (process.env.GHOSTFOLIO_URL ?? "http://ghostfolio:3333").replace(/\/$/, "");
const TOKEN = process.env.GHOSTFOLIO_ACCESS_TOKEN ?? "";
/** Comentário que o ghostfolio-sync põe nas contas que ele gerencia (extratos da B3). */
const B3_MARK = "ghostfolio-sync";

interface GfAccount {
  id: string;
  name: string;
  currency: string;
  comment?: string | null;
}
interface GfActivity {
  id: string;
  accountId: string | null;
  comment: string | null;
  currency?: string;
  date: string;
  fee: number;
  quantity: number;
  type: string;
  unitPrice: number;
  tags?: { id: string; name?: string }[];
  assetProfile: { dataSource: string; symbol: string; name: string | null; currency: string };
}

let jwt: { value: string; at: number } | null = null;
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!TOKEN) throw new Error("GHOSTFOLIO_ACCESS_TOKEN não está definido no container dos relatórios.");
  if (!jwt || Date.now() - jwt.at > 30 * 60_000) {
    const res = await fetch(`${BASE_URL}/api/v1/auth/anonymous`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: TOKEN }),
    });
    if (!res.ok) throw new Error(`Ghostfolio recusou o token (${res.status})`);
    jwt = { value: ((await res.json()) as { authToken: string }).authToken, at: Date.now() };
  }
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.value}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${txt.slice(0, 300)}`);
  return (txt ? JSON.parse(txt) : {}) as T;
}
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const num = (n: number, d = 8) => n.toLocaleString("pt-BR", { maximumFractionDigits: d });
/**
 * Conta da B3: criada pelo ghostfolio-sync (comentário) ou com ativos da B3 (Yahoo ".SA"). O sync
 * reconhece as contas pelo nome da instituição, então contas antigas como "XP Investimentos" não
 * têm a marca no comentário; nelas, um registro manual seria refeito ou desfeito pelos extratos.
 */
const isB3 = (a: GfAccount, acts: GfActivity[]) => !!a.comment?.includes(B3_MARK) || acts.some((x) => x.accountId === a.id && /\.SA$/i.test(x.assetProfile.symbol));

const TYPES = { compra: "BUY", venda: "SELL", provento: "DIVIDEND", juros: "INTEREST", taxa: "FEE" } as const;
const TYPE_PT: Record<string, string> = { BUY: "compra", SELL: "venda", DIVIDEND: "provento", INTEREST: "juros", FEE: "taxa", LIABILITY: "passivo" };

/** Classe do ativo manual → assetClass/assetSubClass do Ghostfolio (decide a categoria nos relatórios). */
const CLASSES = {
  renda_fixa: { assetClass: "FIXED_INCOME", assetSubClass: "BOND" },
  fundo: { assetClass: "FIXED_INCOME", assetSubClass: "MUTUALFUND" },
  acao: { assetClass: "EQUITY", assetSubClass: "STOCK" },
  etf: { assetClass: "EQUITY", assetSubClass: "ETF" },
  cripto: { assetClass: "LIQUIDITY", assetSubClass: "CRYPTOCURRENCY" },
  caixa: { assetClass: "LIQUIDITY", assetSubClass: "CASH" },
} as const;

async function getAccounts() {
  return (await api<{ accounts: GfAccount[] }>("GET", "/v1/account")).accounts;
}
async function getActivities() {
  return (await api<{ activities: GfActivity[] }>("GET", "/v1/activities")).activities;
}
function resolveAccount(accs: GfAccount[], q: string): GfAccount {
  const hit = accs.find((a) => a.id === q) ?? accs.find((a) => norm(a.name) === norm(q)) ?? accs.find((a) => norm(a.name).includes(norm(q)));
  if (!hit) throw new Error(`Conta "${q}" não encontrada. Contas: ${accs.map((a) => a.name).join(", ")}. Crie com ghostfolio_criar_conta.`);
  return hit;
}
const label = (a: GfActivity) => (a.assetProfile.dataSource === "MANUAL" ? (a.assetProfile.name ?? a.assetProfile.symbol) : a.assetProfile.symbol);
const line = (a: GfActivity, accName: string) =>
  `- ${a.date.slice(0, 10)} · ${TYPE_PT[a.type] ?? a.type} · ${label(a)} (${a.assetProfile.dataSource}) · ${num(a.quantity)} × ${num(a.unitPrice, 6)} ${a.currency ?? a.assetProfile.currency}` +
  `${a.fee ? ` · taxa ${num(a.fee)}` : ""} · conta ${accName}${a.tags?.some((t) => t.id === TAG_EMERGENCY_FUND) ? " · reserva" : ""}${a.comment ? ` · "${a.comment}"` : ""} · id ${a.id}`;

export function registerActivityTools(server: McpServer, onChange: () => void) {
  const tool = (name: string, title: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, run: (a: any) => Promise<string>) =>
    server.registerTool(name, { title, description, inputSchema }, async (args: any) => {
      try {
        return text(await run(args));
      } catch (e) {
        return text(`Erro: ${(e as Error).message}`);
      }
    });

  tool(
    "ghostfolio_contas",
    "Contas do Ghostfolio",
    "Contas do Ghostfolio com id e moeda, indicando quais são da B3 (preenchidas pelos extratos, só leitura aqui) e quais aceitam registro manual (exchanges, corretoras no exterior, reserva).",
    {},
    async () => {
      const [accs, acts] = await Promise.all([getAccounts(), getActivities()]);
      return accs.map((a) => `- ${a.name} · ${a.currency} · id ${a.id}${isB3(a, acts) ? " · B3 (extratos, só leitura)" : " · manual"}`).join("\n") || "Nenhuma conta.";
    },
  );

  tool(
    "ghostfolio_buscar_ativo",
    "Buscar ativo",
    "Procura o símbolo e a fonte de dados de um ativo no Ghostfolio (ex.: 'bitcoin', 'SCHD', 'IVVB11'). Use antes de registrar um ativo novo com cotação (YAHOO ou COINGECKO).",
    { busca: z.string().min(2) },
    async ({ busca }) => {
      const r = await api<{ items: { symbol: string; dataSource: string; name: string; currency: string; assetSubClass?: string }[] }>("GET", `/v1/symbol/lookup?query=${encodeURIComponent(busca)}`);
      return r.items.length ? r.items.slice(0, 15).map((i) => `- ${i.symbol} · ${i.dataSource} · ${i.name} · ${i.currency}${i.assetSubClass ? ` · ${i.assetSubClass}` : ""}`).join("\n") : "Nada encontrado.";
    },
  );

  tool(
    "ghostfolio_atividades",
    "Atividades do Ghostfolio",
    "Lista atividades (compras, vendas, proventos…) com id, filtrando por conta, ativo e data. Use para conferir antes de registrar e para achar o id a excluir.",
    {
      conta: z.string().optional(),
      ativo: z.string().optional().describe("Símbolo ou parte do nome"),
      desde: ymd.optional(),
      limite: z.number().int().min(1).max(200).optional().describe("Padrão: 30"),
    },
    async ({ conta, ativo, desde, limite }) => {
      const [accs, acts] = await Promise.all([getAccounts(), getActivities()]);
      const acc = conta ? resolveAccount(accs, conta) : null;
      const names = new Map(accs.map((a) => [a.id, a.name]));
      const rows = acts
        .filter((a) => (!acc || a.accountId === acc.id) && (!desde || a.date.slice(0, 10) >= desde))
        .filter((a) => !ativo || norm(a.assetProfile.symbol).includes(norm(ativo)) || norm(a.assetProfile.name ?? "").includes(norm(ativo)))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limite ?? 30);
      return rows.length ? rows.map((a) => line(a, names.get(a.accountId ?? "") ?? "sem conta")).join("\n") : "Nenhuma atividade com esse filtro.";
    },
  );

  tool(
    "ghostfolio_criar_conta",
    "Criar conta no Ghostfolio",
    "Cria uma conta para registros manuais (ex.: 'Bybit', 'Reserva XP'). Confirme o nome com o usuário antes.",
    { nome: z.string().min(2).max(60), moeda: z.string().length(3).optional().describe("Padrão: BRL"), comentario: z.string().max(200).optional() },
    async ({ nome, moeda, comentario }) => {
      const accs = await getAccounts();
      const dup = accs.find((a) => norm(a.name) === norm(nome));
      if (dup) return `Já existe a conta ${dup.name} (id ${dup.id}).`;
      const created = await api<{ id: string }>("POST", "/v1/account", { balance: 0, comment: comentario ?? "Registros manuais (MCP)", currency: (moeda ?? "BRL").toUpperCase(), name: nome, platformId: null });
      onChange();
      return `Conta criada: ${nome} (${(moeda ?? "BRL").toUpperCase()}) · id ${created.id}`;
    },
  );

  tool(
    "ghostfolio_registrar",
    "Registrar atividade no Ghostfolio",
    "Registra compra, venda, provento, juros ou taxa numa conta manual do Ghostfolio (nunca nas contas da B3, que vêm dos extratos). " +
      "Ativo com cotação: informe simbolo e fonte (YAHOO, ex. BTCUSD, SCHD; ou COINGECKO, ex. bitcoin), achados com ghostfolio_buscar_ativo; o preço vai na moeda informada. " +
      "Ativo sem cotação (fundo, CDB, aplicação da reserva): fonte MANUAL com nome e classe; para que o saldo some certo, use quantidade = valor em R$ e preco_unitario = 1. " +
      "reserva=true marca como Fundo de Emergência (fica fora da carteira nos relatórios). Recusa duplicatas, a menos que forcar=true. " +
      "Confirme os valores com o usuário antes de registrar.",
    {
      conta: z.string().describe("Nome ou id da conta (ghostfolio_contas)"),
      tipo: z.enum(["compra", "venda", "provento", "juros", "taxa"]),
      fonte: z.enum(["YAHOO", "COINGECKO", "MANUAL"]),
      simbolo: z.string().optional().describe("YAHOO/COINGECKO: símbolo do ativo"),
      nome: z.string().optional().describe("MANUAL: nome do ativo (reaproveita o ativo manual de mesmo nome)"),
      classe: z.enum(["renda_fixa", "fundo", "acao", "etf", "cripto", "caixa"]).optional().describe("MANUAL: classe do ativo novo"),
      data: ymd,
      quantidade: z.number().positive(),
      preco_unitario: z.number().nonnegative(),
      moeda: z.string().length(3).optional().describe("Moeda do preço e da taxa. Padrão: moeda da conta"),
      taxa: z.number().nonnegative().optional(),
      comentario: z.string().max(300).optional(),
      reserva: z.boolean().optional(),
      forcar: z.boolean().optional().describe("Registrar mesmo se já existir igual"),
    },
    async (p) => {
      const [accs, acts] = await Promise.all([getAccounts(), getActivities()]);
      const acc = resolveAccount(accs, p.conta);
      if (isB3(acc, acts)) throw new Error(`A conta ${acc.name} é da B3 e é preenchida pelos extratos. Solte o extrato de movimentação em extratos/ (ou envie pelo botão de nuvem dos relatórios).`);
      const type = TYPES[p.tipo as keyof typeof TYPES];
      const currency = (p.moeda ?? acc.currency).toUpperCase();
      const date = `${p.data}T00:00:00.000Z`;
      const tags = p.reserva ? [TAG_EMERGENCY_FUND] : [];

      let symbol: string;
      let profiles: unknown[] = [];
      if (p.fonte === "MANUAL") {
        if (!p.nome) throw new Error("Para fonte MANUAL, informe o nome do ativo.");
        const existing = acts.find((a) => a.assetProfile.dataSource === "MANUAL" && a.assetProfile.name && norm(a.assetProfile.name) === norm(p.nome));
        if (existing) symbol = existing.assetProfile.symbol;
        else {
          symbol = crypto.randomUUID();
          const cls = p.classe ? CLASSES[p.classe as keyof typeof CLASSES] : {};
          profiles = [{ ...cls, countries: [], currency, dataSource: "MANUAL", holdings: [], isActive: true, name: p.nome, sectors: [], symbol }];
        }
      } else {
        if (!p.simbolo) throw new Error("Informe o simbolo (use ghostfolio_buscar_ativo).");
        symbol = p.simbolo.trim();
      }

      const same = acts.find(
        (a) =>
          a.accountId === acc.id &&
          a.type === type &&
          a.date.slice(0, 10) === p.data &&
          (a.assetProfile.symbol === symbol || (p.fonte === "MANUAL" && norm(a.assetProfile.name ?? "") === norm(p.nome ?? ""))) &&
          Math.abs(a.quantity - p.quantidade) < 1e-9 &&
          Math.abs(a.unitPrice - p.preco_unitario) < 1e-6,
      );
      if (same && !p.forcar) return `Já existe uma atividade igual (não registrei de novo):\n${line(same, acc.name)}\nSe for mesmo outra operação, chame de novo com forcar=true.`;

      const activity = {
        accountId: acc.id,
        comment: p.comentario ?? null,
        currency,
        dataSource: p.fonte,
        date,
        fee: p.taxa ?? 0,
        quantity: p.quantidade,
        symbol,
        tags,
        type,
        unitPrice: p.preco_unitario,
      };
      if (profiles.length) await api("POST", "/v1/import", { activities: [activity], assetProfiles: profiles });
      else await api("POST", "/v1/activities", activity);
      onChange();

      const after = (await getActivities()).find(
        (a) => a.accountId === acc.id && a.type === type && a.date.slice(0, 10) === p.data && Math.abs(a.quantity - p.quantidade) < 1e-9 && Math.abs(a.unitPrice - p.preco_unitario) < 1e-6,
      );
      const total = p.quantidade * p.preco_unitario;
      return `Registrado: ${p.tipo} de ${p.fonte === "MANUAL" ? p.nome : symbol} em ${p.data} · ${num(p.quantidade)} × ${num(p.preco_unitario, 6)} ${currency} = ${num(total, 2)} ${currency}${p.taxa ? ` · taxa ${num(p.taxa)}` : ""} · conta ${acc.name}${p.reserva ? " · reserva" : ""}${after ? ` · id ${after.id}` : ""}`;
    },
  );

  tool(
    "ghostfolio_excluir",
    "Excluir atividade do Ghostfolio",
    "Exclui uma atividade registrada manualmente, pelo id (ghostfolio_atividades). Não mexe em contas da B3 nem em proventos automáticos. Confirme com o usuário antes de excluir.",
    { id: z.string().min(8) },
    async ({ id }) => {
      const [accs, acts] = await Promise.all([getAccounts(), getActivities()]);
      const a = acts.find((x) => x.id === id);
      if (!a) return `Atividade ${id} não encontrada.`;
      const acc = accs.find((x) => x.id === a.accountId);
      if (acc && isB3(acc, acts)) throw new Error(`A atividade é da conta ${acc.name}, que vem dos extratos da B3. Corrija pelo extrato (ou extratos/ajustes.json).`);
      if (a.comment?.startsWith("Auto (Yahoo)")) throw new Error("Proventos automáticos são mantidos pelo ghostfolio-sync.");
      await api("DELETE", `/v1/activities/${id}`);
      onChange();
      return `Excluída:\n${line(a, acc?.name ?? "sem conta")}`;
    },
  );
}
