/**
 * Ferramentas de finanças pessoais do MCP: o Claude opera o Firefly III (lança, edita, importa
 * extratos, cria regras de categoria, previstos e metas por categoria) e analisa os gastos, para o
 * dono não precisar abrir o Firefly. Tudo pelo token do dono guardado em financas.json.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cardBooks, createTx, deleteTx, forecast, monthTransactions, normTxt, suggestPlanned, updateTx, validPlanned } from "./fin-plan";
import { type FinAccount, accounts, categoryNames, existing, ff, importRows, monthlyTotals, parseStatement, readConfig, tokenOf, writeConfig } from "./financas";
import { ownerDir } from "./users";

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const spToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

async function ctx() {
  const dir = await ownerDir();
  const cfg = readConfig(dir);
  const token = tokenOf(cfg);
  if (!token) throw new Error("O Firefly III não está conectado. Conecte na aba Finanças dos relatórios.");
  return { dir, cfg, token };
}

/** Conta por id ou por nome (exato ou parte do nome). */
async function resolveAccount(token: string, q: string): Promise<FinAccount> {
  const accs = await accounts(token);
  const hit = /^\d+$/.test(q) ? accs.find((a) => a.id === q) : (accs.find((a) => normTxt(a.name) === normTxt(q)) ?? accs.find((a) => normTxt(a.name).includes(normTxt(q))));
  if (!hit) throw new Error(`Conta "${q}" não encontrada. Contas: ${accs.map((a) => `${a.name} (${a.id})`).join(", ")}`);
  return hit;
}

const RULE_GROUP = "Categorias automáticas";

export function registerFinanceTools(server: McpServer) {
  const tool = (name: string, title: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, run: (a: any) => Promise<string>) =>
    server.registerTool(name, { title, description, inputSchema }, async (args: any) => {
      try {
        return text(await run(args));
      } catch (e) {
        return text(`Erro: ${(e as Error).message}`);
      }
    });

  // ---------- leitura ----------

  tool("fin_contas", "Contas e cartões", "Contas (saldo, id, se entra no patrimônio) e cartões (saldo devedor, fechamento, vencimento, limite, fatura atual e as próximas). Use os ids nas outras ferramentas.", {}, async () => {
    const { token, cfg } = await ctx();
    const accs = await accounts(token);
    const books = await cardBooks(token, cfg, accs, 0, 3);
    const lines = ["# Contas"];
    for (const a of accs.filter((x) => !x.card)) lines.push(`- ${a.name} (id ${a.id}): ${brl(a.balance)}${a.netWorth ? "" : " · fora do patrimônio"}`);
    lines.push("", "# Cartões");
    for (const b of books) {
      const c = b.config;
      lines.push(`- ${b.name} (id ${b.id}): deve ${brl(Math.max(0, -b.balance))}${c ? ` · fecha dia ${c.closing}, vence dia ${c.due}${c.limit ? ` · limite ${brl(c.limit)}` : ""}` : " · fechamento não informado"}`);
      for (const i of b.invoices) lines.push(`  - fatura que vence ${i.due} (${i.status}): ${brl(i.total)} = lançado ${brl(i.posted)} + parcelas futuras ${brl(i.installments)} + previstos ${brl(i.planned)}${i.paid ? ` · pago ${brl(i.paid)}` : ""}`);
    }
    return lines.join("\n");
  });

  tool(
    "fin_lancamentos",
    "Lançamentos",
    "Lista os lançamentos de um mês (com id, data, tipo, valor, descrição, categoria, origem → destino). Filtros opcionais por conta, categoria, texto e tipo. Use sem_categoria para achar o que falta categorizar.",
    {
      mes: ym.optional().describe("AAAA-MM; padrão: mês atual"),
      conta: z.string().optional().describe("id ou nome da conta/cartão"),
      categoria: z.string().optional(),
      busca: z.string().optional().describe("texto na descrição ou na contraparte"),
      tipo: z.enum(["withdrawal", "deposit", "transfer"]).optional(),
      sem_categoria: z.boolean().optional(),
      limite: z.number().int().min(1).max(500).optional(),
    },
    async (a) => {
      const { token } = await ctx();
      let list = await monthTransactions(token, a.mes ?? spToday().slice(0, 7));
      if (a.conta) {
        const acc = await resolveAccount(token, a.conta);
        list = list.filter((t) => t.sourceId === acc.id || t.destinationId === acc.id);
      }
      if (a.tipo) list = list.filter((t) => t.type === a.tipo);
      if (a.categoria) list = list.filter((t) => normTxt(t.category ?? "") === normTxt(a.categoria));
      if (a.sem_categoria) list = list.filter((t) => !t.category && t.type !== "transfer");
      if (a.busca) list = list.filter((t) => normTxt(`${t.description} ${t.sourceName} ${t.destinationName}`).includes(normTxt(a.busca)));
      const total = list.length;
      list = list.slice(0, a.limite ?? 200);
      const out = sum(list.filter((t) => t.type === "withdrawal").map((t) => t.amount));
      const inn = sum(list.filter((t) => t.type === "deposit").map((t) => t.amount));
      return [`${total} lançamentos${total > list.length ? ` (mostrando ${list.length})` : ""} · saídas ${brl(out)} · entradas ${brl(inn)}`, "", "id | data | tipo | valor | descrição | categoria | origem → destino"]
        .concat(list.map((t) => `${t.id} | ${t.date} | ${t.type} | ${brl(t.amount)} | ${t.description} | ${t.category ?? "—"} | ${t.sourceName} → ${t.destinationName}`))
        .join("\n");
    },
  );

  tool("fin_categorias", "Categorias", "Categorias existentes no Firefly (use estes nomes ao lançar e categorizar; crie uma nova só quando nenhuma servir).", {}, async () => {
    const { token } = await ctx();
    return (await categoryNames(token)).join("\n");
  });

  tool(
    "fin_periodo",
    "Totais por mês",
    "Entradas, saídas, gastos por categoria e entradas por categoria de cada mês do período (até 36 meses). Base para análises e comparações.",
    { de: ym, ate: ym },
    async ({ de, ate }) => {
      const { token } = await ctx();
      const rows = await monthlyTotals(token, de, ate);
      return rows
        .map((m) => {
          const cats = Object.entries(m.categories).sort((x, y) => y[1] - x[1]).map(([c, v]) => `${c} ${brl(v)}`).join("; ");
          const inc = Object.entries(m.incomes).sort((x, y) => y[1] - x[1]).map(([c, v]) => `${c} ${brl(v)}`).join("; ");
          return `## ${m.month}\nentradas ${brl(m.income)} · saídas ${brl(m.expense)} · sobra ${brl(m.income - m.expense)}\ngastos: ${cats || "—"}\nentradas: ${inc || "—"}`;
        })
        .join("\n\n");
    },
  );

  tool(
    "fin_faturas",
    "Faturas dos cartões",
    "Faturas mês a mês de um cartão (ou de todos), passadas e futuras, com o que já foi lançado, as parcelas que vão cair e as assinaturas previstas. Com detalhar=true lista os itens.",
    { cartao: z.string().optional(), meses_atras: z.number().int().min(0).max(12).optional(), meses_a_frente: z.number().int().min(0).max(18).optional(), detalhar: z.boolean().optional() },
    async (a) => {
      const { token, cfg } = await ctx();
      const accs = await accounts(token);
      let books = await cardBooks(token, cfg, accs, a.meses_atras ?? 1, a.meses_a_frente ?? 6);
      if (a.cartao) {
        const c = await resolveAccount(token, a.cartao);
        books = books.filter((b) => b.id === c.id);
      }
      const lines: string[] = [];
      for (const b of books) {
        lines.push(`# ${b.name}`);
        for (const i of b.invoices) {
          if (!i.total && i.status !== "aberta") continue;
          lines.push(`## vence ${i.due} (${i.status}) · ${brl(i.total)} · compras de ${i.start} a ${i.end}${i.paid ? ` · pago ${brl(i.paid)}` : ""}`);
          if (a.detalhar) for (const it of i.items) lines.push(`- ${it.date} ${it.description} · ${brl(it.amount)} · ${it.category ?? "sem categoria"}${it.source === "posted" ? ` · id ${it.id}` : it.source === "installment" ? " · parcela futura" : " · previsto"}`);
        }
      }
      return lines.join("\n") || "Nenhum cartão com fechamento configurado.";
    },
  );

  tool("fin_projecao", "Fluxo de caixa projetado", "Projeção mês a mês: entradas previstas, agendados, contas fixas, faturas por cartão, gasto do dia a dia (mediana de 3 meses) e saldo projetado.", { meses: z.number().int().min(1).max(24).optional() }, async ({ meses }) => {
    const { token, cfg } = await ctx();
    const f = await forecast(token, cfg, meses ?? 12);
    return [`Em contas hoje: ${brl(f.cash)} · dia a dia estimado: ${brl(f.daily)}/mês (contas ${brl(f.dailyParts.bank)} + cartões ${brl(f.dailyParts.card)})`, "", "mês | entradas | agendados | contas fixas | faturas | dia a dia | sobra | saldo"]
      .concat(f.months.map((m) => `${m.month} | ${brl(m.income)} | ${brl(m.scheduled)} | ${brl(m.expense)} | ${brl(m.cardsTotal)} (${m.cards.filter((c) => c.value).map((c) => `${c.name} ${brl(c.value)}`).join(", ")}) | ${brl(m.variable)} | ${brl(m.net)} | ${brl(m.balance)}`))
      .join("\n");
  });

  // ---------- lançar e corrigir ----------

  tool(
    "fin_lancar",
    "Lançar",
    "Cria um gasto, entrada ou transferência. Compra parcelada no cartão vira uma transação por parcela, cada uma na sua fatura. Sem categoria, as regras do Firefly categorizam.",
    {
      tipo: z.enum(["gasto", "entrada", "transferencia"]),
      valor: z.number().positive().describe("valor total (no parcelado, o total da compra)"),
      descricao: z.string().min(1),
      conta: z.string().describe("id ou nome da conta/cartão (origem no gasto e na transferência, destino na entrada)"),
      data: ymd.optional().describe("padrão: hoje"),
      categoria: z.string().optional(),
      para_conta: z.string().optional().describe("transferência: conta de destino"),
      parcelas: z.number().int().min(1).max(48).optional(),
      contraparte: z.string().optional().describe("loja ou pessoa"),
      notas: z.string().optional(),
    },
    async (a) => {
      const { token, cfg } = await ctx();
      const acc = await resolveAccount(token, a.conta);
      const to = a.tipo === "transferencia" ? await resolveAccount(token, a.para_conta ?? "") : null;
      const r = await createTx(token, cfg, {
        kind: a.tipo === "gasto" ? "expense" : a.tipo === "entrada" ? "income" : "transfer",
        date: a.data ?? spToday(),
        amount: a.valor,
        description: a.descricao,
        accountId: acc.id,
        toAccountId: to?.id,
        category: a.categoria ?? null,
        counterparty: a.contraparte ?? null,
        installments: a.parcelas,
        notes: a.notas ?? "Lançado pelo Claude",
      });
      return `Lançado em ${acc.name}${to ? ` → ${to.name}` : ""}: ${a.descricao} ${brl(a.valor)}${(a.parcelas ?? 1) > 1 ? ` em ${a.parcelas}x` : ""} · ids ${r.ids.join(", ")}`;
    },
  );

  tool(
    "fin_editar_lancamento",
    "Editar lançamento",
    "Muda descrição, valor, data ou categoria de um lançamento (id de fin_lancamentos).",
    { id: z.string().regex(/^\d+$/), descricao: z.string().optional(), valor: z.number().positive().optional(), data: ymd.optional(), categoria: z.string().nullable().optional() },
    async (a) => {
      const { token } = await ctx();
      await updateTx(token, a.id, { description: a.descricao, amount: a.valor, date: a.data, category: a.categoria === undefined ? undefined : a.categoria });
      return `Lançamento ${a.id} atualizado.`;
    },
  );

  tool(
    "fin_categorizar",
    "Categorizar em lote",
    "Aplica uma categoria a vários lançamentos de uma vez (ids de fin_lancamentos).",
    { ids: z.array(z.string().regex(/^\d+$/)).min(1).max(300), categoria: z.string().min(1) },
    async ({ ids, categoria }) => {
      const { token } = await ctx();
      let ok = 0;
      for (const id of ids) {
        await updateTx(token, id, { category: categoria });
        ok++;
      }
      return `${ok} lançamentos agora em "${categoria}".`;
    },
  );

  tool(
    "fin_virar_transferencia",
    "Virar transferência",
    "Transforma um gasto/entrada em transferência entre contas próprias (ex.: Pix para a própria XP, pagamento de fatura). Assim deixa de contar como gasto ou renda.",
    { id: z.string().regex(/^\d+$/), outra_conta: z.string().describe("a outra conta própria (destino se era gasto, origem se era entrada)") },
    async ({ id, outra_conta }) => {
      const { token } = await ctx();
      const other = await resolveAccount(token, outra_conta);
      const g = await ff(token, `/transactions/${id}`);
      const t = g.data.attributes.transactions[0];
      const [src, dst] = t.type === "withdrawal" ? [String(t.source_id), other.id] : [other.id, String(t.destination_id)];
      await ff(token, `/transactions/${id}`, { method: "PUT", body: { apply_rules: false, transactions: [{ transaction_journal_id: t.transaction_journal_id, type: "transfer", source_id: src, destination_id: dst, category_name: "" }] } });
      return `Lançamento ${id} agora é transferência ${t.type === "withdrawal" ? `para ${other.name}` : `de ${other.name}`}.`;
    },
  );

  tool("fin_excluir_lancamento", "Excluir lançamento", "Apaga um lançamento no Firefly. Só use depois de o usuário confirmar.", { id: z.string().regex(/^\d+$/), confirmado: z.literal(true) }, async ({ id }) => {
    const { token } = await ctx();
    await deleteTx(token, id);
    return `Lançamento ${id} excluído.`;
  });

  // ---------- importar extrato ----------

  tool(
    "fin_importar_extrato",
    "Importar extrato ou fatura",
    "Importa o texto de um arquivo OFX ou CSV (extrato do banco ou fatura do cartão). Primeiro chame com simular=true para ver o que entra e o que já existe; depois com simular=false. Parcelas antigas da fatura vão para a fatura certa e lançamentos repetidos são ignorados.",
    {
      nome_arquivo: z.string().describe("ex.: Fatura2026-12-10 xp.csv ou Bradesco.ofx"),
      conteudo: z.string().min(10).describe("texto completo do arquivo"),
      conta: z.string().describe("conta ou cartão de destino"),
      inverter_sinal: z.boolean().optional().describe("faturas CSV trazem compras positivas; padrão: o sugerido pelo leitor"),
      simular: z.boolean().optional().describe("padrão: true"),
      pular: z.array(z.number().int()).optional().describe("índices (da simulação) a não importar, ex.: pagamento de fatura"),
    },
    async (a) => {
      const { token, dir, cfg } = await ctx();
      const acc = await resolveAccount(token, a.conta);
      const parsed = parseStatement(Buffer.from(a.conteudo, "utf8"), a.nome_arquivo);
      const invert = a.inverter_sinal ?? parsed.suggestInvert;
      const rows = parsed.rows.map((r) => ({ ...r, amount: invert ? -r.amount : r.amount }));
      const exists = await existing(token, acc.id, rows);
      const skip = new Set(a.pular ?? []);
      const list = rows.map((r, i) => ({ ...r, i, exists: exists[i]! }));
      if (a.simular !== false) {
        return [`${parsed.format.toUpperCase()} · ${rows.length} linhas · conta ${acc.name} · sinais ${invert ? "invertidos" : "como no arquivo"}`, "i | data | valor | descrição | situação"]
          .concat(list.map((r) => `${r.i} | ${r.date} | ${brl(r.amount)} | ${r.description} | ${r.exists ? "já existe" : "novo"}`))
          .join("\n");
      }
      const toImport = list.filter((r) => !r.exists && !skip.has(r.i));
      const res = await importRows(token, acc.id, parsed.accountKey, toImport);
      if (parsed.accountKey) writeConfig(dir, { ...cfg, accounts: { ...cfg.accounts, [parsed.accountKey]: acc.id } });
      return `Importados ${res.created} em ${acc.name}; ${res.duplicates} duplicados; ${list.length - toImport.length} pulados ou já existentes.${res.errors.length ? ` Erros: ${res.errors.join(" · ")}` : ""} Revise com fin_lancamentos(sem_categoria=true).`;
    },
  );

  // ---------- regras de categoria ----------

  tool("fin_regras", "Regras de categoria", "Regras do Firefly que categorizam sozinhas os próximos lançamentos (texto na descrição → categoria).", {}, async () => {
    const { token } = await ctx();
    const all: any[] = [];
    for (let page = 1; page < 20; page++) {
      const r = await ff(token, `/rules?limit=200&page=${page}`);
      all.push(...r.data);
      if (page >= (r.meta?.pagination?.total_pages ?? 1)) break;
    }
    return all
      .map((r) => {
        const at = r.attributes;
        const trig = (at.triggers as any[]).filter((t) => t.type === "description_contains").map((t) => t.value);
        const cat = (at.actions as any[]).find((x) => x.type === "set_category")?.value ?? "—";
        return `${r.id} | ${at.title} | ${at.active ? "ativa" : "inativa"} | → ${cat} | contém: ${trig.join(", ")}`;
      })
      .join("\n");
  });

  tool(
    "fin_criar_regra",
    "Criar regra de categoria",
    "Cria uma regra: quando a descrição contém algum dos textos, aplica a categoria. Com aplicar_desde, já recategoriza os lançamentos antigos a partir dessa data.",
    { categoria: z.string().min(1), textos: z.array(z.string().min(2)).min(1).max(60), titulo: z.string().optional(), aplicar_desde: ymd.optional() },
    async (a) => {
      const { token } = await ctx();
      const r = await ff(token, "/rules", {
        method: "POST",
        body: {
          title: a.titulo ?? a.categoria,
          rule_group_title: RULE_GROUP,
          trigger: "store-journal",
          active: true,
          strict: false,
          stop_processing: true,
          triggers: a.textos.map((v: string) => ({ type: "description_contains", value: v, stop_processing: false, active: true })),
          actions: [{ type: "set_category", value: a.categoria, stop_processing: false, active: true }],
        },
      });
      const id = String(r.data.id);
      if (a.aplicar_desde) await ff(token, `/rules/${id}/trigger?start=${a.aplicar_desde}&end=${spToday()}`, { method: "POST" });
      return `Regra ${id} criada (${a.textos.join(", ")} → ${a.categoria})${a.aplicar_desde ? ` e aplicada desde ${a.aplicar_desde}` : ""}.`;
    },
  );

  tool(
    "fin_editar_regra",
    "Editar regra",
    "Troca os textos, a categoria ou liga/desliga uma regra (id de fin_regras).",
    { id: z.string().regex(/^\d+$/), textos: z.array(z.string().min(2)).optional(), categoria: z.string().optional(), ativa: z.boolean().optional() },
    async (a) => {
      const { token } = await ctx();
      const body: Record<string, unknown> = {};
      if (a.textos) body.triggers = a.textos.map((v: string) => ({ type: "description_contains", value: v, stop_processing: false, active: true }));
      if (a.categoria) body.actions = [{ type: "set_category", value: a.categoria, stop_processing: false, active: true }];
      if (a.ativa != null) body.active = a.ativa;
      await ff(token, `/rules/${a.id}`, { method: "PUT", body });
      return `Regra ${a.id} atualizada.`;
    },
  );

  tool("fin_aplicar_regra", "Aplicar regra no passado", "Roda uma regra (ou todas as do grupo de categorias, com id='todas') sobre os lançamentos de um período.", { id: z.string(), desde: ymd, ate: ymd.optional() }, async ({ id, desde, ate }) => {
    const { token } = await ctx();
    if (id === "todas") {
      const groups = await ff(token, "/rule-groups?limit=100");
      const g = groups.data.find((x: any) => x.attributes.title === RULE_GROUP);
      if (!g) throw new Error("Grupo de regras não encontrado.");
      await ff(token, `/rule-groups/${g.id}/trigger?start=${desde}&end=${ate ?? spToday()}`, { method: "POST" });
      return `Todas as regras de categoria aplicadas de ${desde} a ${ate ?? spToday()}.`;
    }
    await ff(token, `/rules/${id}/trigger?start=${desde}&end=${ate ?? spToday()}`, { method: "POST" });
    return `Regra ${id} aplicada de ${desde} a ${ate ?? spToday()}.`;
  });

  tool("fin_excluir_regra", "Excluir regra", "Apaga uma regra de categoria. Só depois de o usuário confirmar.", { id: z.string().regex(/^\d+$/), confirmado: z.literal(true) }, async ({ id }) => {
    const { token } = await ctx();
    await ff(token, `/rules/${id}`, { method: "DELETE" });
    return `Regra ${id} excluída.`;
  });

  // ---------- previstos e metas por categoria ----------

  tool("fin_previstos", "Previstos", "Contas fixas, assinaturas e entradas previstas (com id), e sugestões do histórico do que se repete e ainda não está previsto.", {}, async () => {
    const { token, cfg } = await ctx();
    const accs = await accounts(token);
    const name = (id: string | null) => (id ? (accs.find((a) => a.id === id)?.name ?? id) : "qualquer conta");
    const items = (cfg.planned ?? []).map((p) => `${p.id} | ${p.kind === "income" ? "entrada" : "saída"} | ${p.description} | ${brl(p.amount)} | dia ${p.day} | ${name(p.accountId)} | ${p.category ?? "—"} | ${p.freq === "once" ? `só ${p.start}` : `desde ${p.start}${p.end ? ` até ${p.end}` : ""}`} | extrato contém: ${p.match ?? p.description}`);
    const sug = await suggestPlanned(token, cfg);
    return ["# Previstos", "id | tipo | descrição | valor | dia | conta | categoria | período | identificação", ...items, "", "# Sugestões (repetiram nos últimos meses)", ...sug.map((s) => `- ${s.kind === "income" ? "entrada" : "saída"} ${s.description} ${brl(s.amount)} dia ${s.day} em ${name(s.accountId)} (${s.months} meses) · texto: ${s.match}`)].join("\n");
  });

  tool(
    "fin_salvar_previsto",
    "Criar ou editar previsto",
    "Cria (sem id) ou atualiza (com id) um previsto. Quando o lançamento real aparece no extrato com o texto de identificação, o previsto fica marcado como pago.",
    {
      id: z.string().optional(),
      tipo: z.enum(["saida", "entrada"]),
      descricao: z.string().min(1),
      valor: z.number().positive(),
      dia: z.number().int().min(1).max(31),
      conta: z.string().optional().describe("conta ou cartão; vazio = qualquer"),
      categoria: z.string().optional(),
      repete: z.enum(["todo_mes", "uma_vez"]).optional(),
      inicio: ym.optional(),
      fim: ym.optional(),
      texto_extrato: z.string().optional().describe("parte do nome como aparece no extrato, ex.: energisa"),
    },
    async (a) => {
      const { token, dir } = await ctx();
      const acc = a.conta ? await resolveAccount(token, a.conta) : null;
      const cfg = readConfig(dir);
      const p = validPlanned({
        id: a.id,
        kind: a.tipo === "entrada" ? "income" : "expense",
        description: a.descricao,
        amount: a.valor,
        day: a.dia,
        accountId: acc?.id ?? null,
        category: a.categoria ?? null,
        freq: a.repete === "uma_vez" ? "once" : "monthly",
        start: a.inicio ?? spToday().slice(0, 7),
        end: a.fim ?? null,
        match: a.texto_extrato ?? null,
      });
      if (!p) throw new Error("Previsto inválido.");
      cfg.planned = [...(cfg.planned ?? []).filter((x) => x.id !== p.id), p];
      writeConfig(dir, cfg);
      return `Previsto salvo: ${p.description} ${brl(p.amount)} dia ${p.day} · id ${p.id}`;
    },
  );

  tool("fin_excluir_previsto", "Excluir previsto", "Remove um previsto (os lançamentos já feitos continuam).", { id: z.string() }, async ({ id }) => {
    const { dir } = await ctx();
    const cfg = readConfig(dir);
    cfg.planned = (cfg.planned ?? []).filter((x) => x.id !== id);
    writeConfig(dir, cfg);
    return `Previsto ${id} removido.`;
  });

  tool("fin_metas_categoria", "Metas por categoria", "Meta mensal de cada categoria comparada com o gasto do mês e a média dos 3 meses anteriores.", { mes: ym.optional() }, async ({ mes }) => {
    const { token, cfg } = await ctx();
    const m = mes ?? spToday().slice(0, 7);
    const [y, mo] = m.split("-").map(Number) as [number, number];
    const from = new Date(Date.UTC(y, mo - 4, 1)).toISOString().slice(0, 7);
    const rows = await monthlyTotals(token, from, m);
    const cur = rows.at(-1)!;
    const prev = rows.slice(0, -1);
    const avg = (c: string) => (prev.length ? prev.reduce((s, r) => s + (r.categories[c] ?? r.incomes[c] ?? 0), 0) / prev.length : 0);
    return Object.entries(cfg.budget ?? {})
      .map(([c, v]) => `${c}: meta ${brl(v)} · neste mês ${brl(cur.categories[c] ?? cur.incomes[c] ?? 0)} · média 3 meses ${brl(avg(c))}`)
      .join("\n") || "Nenhuma meta por categoria.";
  });

  tool("fin_definir_meta_categoria", "Definir meta da categoria", "Define (ou remove, com valor nulo) a meta mensal de uma categoria de gasto ou de entrada.", { categoria: z.string().min(1), valor: z.number().positive().nullable() }, async ({ categoria, valor }) => {
    const { dir } = await ctx();
    const cfg = readConfig(dir);
    cfg.budget ??= {};
    if (valor == null) delete cfg.budget[categoria];
    else cfg.budget[categoria] = Math.round(valor * 100) / 100;
    writeConfig(dir, cfg);
    return valor == null ? `Meta de ${categoria} removida.` : `Meta de ${categoria}: ${brl(valor)} por mês.`;
  });
}

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
