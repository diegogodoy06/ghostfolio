/**
 * Ferramentas de saúde do MCP: peso, dias de academia e treinos, guardados no wger.
 * Dados da Strava NÃO passam por aqui (API Policy §5.3 e §5.16): no Claude, as atividades vêm do
 * conector oficial da Strava.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { currentRoutine, findDay, gymDays, nextDay, readSaude, removeGymDay, saveWeight, saveWorkout, searchExercises, syncGymGoals, todaySP, weights, wgerToken } from "./saude";
import { ownerDir } from "./users";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const kgf = (n: number) => `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} kg`;

async function ctx() {
  const dir = await ownerDir();
  const token = wgerToken(readSaude(dir));
  if (!token) throw new Error("O wger não está conectado. Conecte na aba Saúde dos relatórios.");
  return { dir, token };
}

export function registerHealthTools(server: McpServer) {
  const tool = (name: string, title: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, run: (a: any) => Promise<string>) =>
    server.registerTool(name, { title, description, inputSchema }, async (args: any) => {
      try {
        return text(await run(args));
      } catch (e) {
        return text(`Erro: ${(e as Error).message}`);
      }
    });

  tool("saude_resumo", "Resumo de saúde", "Peso atual e evolução, dias de academia na semana, no mês e no ano. Não inclui a Strava: use o conector oficial dela para corridas e pedais.", {}, async () => {
    const { token } = await ctx();
    const [w, g] = await Promise.all([weights(token), gymDays(token)]);
    const today = todaySP();
    const back = (n: number) => new Date(new Date(`${today}T12:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);
    const last = w.at(-1);
    const near = (n: number) => [...w].reverse().find((x) => x.date <= back(n));
    const lines = ["# Peso"];
    if (last) {
      lines.push(`- Atual: ${kgf(last.weight)} em ${last.date}`);
      for (const n of [30, 90, 365]) {
        const r = near(n);
        if (r) lines.push(`- Há ~${n} dias (${r.date}): ${kgf(r.weight)} · variação ${(last.weight - r.weight).toFixed(1)} kg`);
      }
    } else lines.push("- Nenhum peso lançado.");
    lines.push("", "# Academia");
    lines.push(`- Últimos 7 dias: ${g.filter((d) => d.date > back(7)).length}`, `- Últimos 30 dias: ${g.filter((d) => d.date > back(30)).length}`, `- Neste mês: ${g.filter((d) => d.date.startsWith(today.slice(0, 7))).length}`, `- Neste ano: ${g.filter((d) => d.date.startsWith(today.slice(0, 4))).length}`);
    return lines.join("\n");
  });

  tool("saude_peso", "Histórico de peso", "Todos os pesos lançados, com id.", { desde: ymd.optional() }, async ({ desde }) => {
    const { token } = await ctx();
    const w = (await weights(token)).filter((x) => !desde || x.date >= desde);
    return w.map((x) => `${x.date} | ${kgf(x.weight)} | id ${x.id}`).join("\n") || "Nenhum peso lançado.";
  });

  tool("saude_lancar_peso", "Lançar peso", "Registra o peso do dia. Lançar de novo na mesma data corrige o valor.", { kg: z.number().min(20).max(400), data: ymd.optional().describe("padrão: hoje") }, async ({ kg, data }) => {
    const { token } = await ctx();
    const date = data ?? todaySP();
    await saveWeight(token, date, kg);
    return `Peso de ${date}: ${kgf(kg)}.`;
  });

  tool("saude_academia", "Dias de academia", "Dias marcados e treinos registrados em um período (exercícios, séries, repetições e carga).", { desde: ymd.optional(), ate: ymd.optional() }, async ({ desde, ate }) => {
    const { token } = await ctx();
    const g = (await gymDays(token)).filter((d) => (!desde || d.date >= desde) && (!ate || d.date <= ate));
    return `${g.length} dias\n` + g.map((d) => `${d.date}${d.treino ? ` | ${d.treino}` : ""}${d.notes ? ` | ${d.notes}` : ""}${d.sets.length ? ` | ${[...new Set(d.sets.map((s) => s.name))].map((n) => `${n}: ${d.sets.filter((s) => s.name === n).map((s) => `${s.reps ?? "–"}×${s.kg ?? "–"}kg`).join(", ")}`).join("; ")}` : ""}`).join("\n");
  });

  tool("saude_treinos", "Treinos da rotina", "Os treinos da rotina (A, B, C…) com os exercícios na ordem e os ids, o próximo treino da sequência e a última carga de cada exercício.", {}, async () => {
    const { token } = await ctx();
    const [r, g] = await Promise.all([currentRoutine(token), gymDays(token)]);
    if (!r) return "Nenhuma rotina cadastrada no wger.";
    const lastOf = (ex: number) => {
      const d = [...g].reverse().find((x) => x.sets.some((s) => s.exercise === ex));
      if (!d) return "";
      const sets = d.sets.filter((s) => s.exercise === ex);
      return ` · última vez ${d.date}: ${sets.length}× ${sets[0]!.reps ?? "–"} reps, ${sets[0]!.kg ?? "–"} kg`;
    };
    const lastDone = (id: number) => [...g].reverse().find((x) => x.day === id)?.date;
    const nx = nextDay(r, g);
    return [`# ${r.name} (válida até ${r.end}, renova sozinha)`, `Próximo da sequência: ${nx?.name ?? "—"}`, ...r.days.flatMap((d) => [``, `## ${d.name} · id ${d.id}${lastDone(d.id) ? ` · feito por último em ${lastDone(d.id)}` : ""}`, ...d.exercises.map((e) => `- ${e.name} (exercício ${e.exercise})${lastOf(e.exercise)}`)])].join("\n");
  });

  const dayOf = async (token: string, treino?: string) => {
    if (!treino) return null;
    const r = await currentRoutine(token);
    const d = r && findDay(r, treino);
    if (!d) throw new Error(`Treino "${treino}" não existe na rotina. Veja saude_treinos.`);
    return d.id;
  };

  tool("saude_marcar_academia", "Marcar academia", "Marca um dia de academia, opcionalmente com o treino feito (A, B, C…). As metas ligadas à academia sobem sozinhas.", { data: ymd.optional().describe("padrão: hoje"), treino: z.string().optional().describe("ex.: A ou Treino A"), notas: z.string().optional() }, async ({ data, treino, notas }) => {
    const { token, dir } = await ctx();
    const date = data ?? todaySP();
    await saveWorkout(token, { date, notes: notas, day: await dayOf(token, treino) });
    syncGymGoals(dir, await gymDays(token));
    return `Academia marcada em ${date}${treino ? ` (${treino})` : ""}.`;
  });

  tool("saude_desmarcar_academia", "Desmarcar academia", "Remove o dia de academia e os exercícios registrados nele. Só depois de o usuário confirmar.", { data: ymd, confirmado: z.literal(true) }, async ({ data }) => {
    const { token, dir } = await ctx();
    const n = await removeGymDay(token, data);
    syncGymGoals(dir, await gymDays(token));
    return n ? `${data} desmarcado.` : `${data} não estava marcado.`;
  });

  tool("saude_exercicios", "Buscar exercícios", "Procura exercícios na base do wger, em português e inglês. Devolve o id usado em saude_registrar_treino.", { busca: z.string().min(2) }, async ({ busca }) => {
    const { token } = await ctx();
    return (await searchExercises(token, busca, 15)).map((e) => `${e.id} | ${e.name}`).join("\n") || "Nada encontrado. Tente o nome em inglês (ex.: bench press).";
  });

  tool(
    "saude_registrar_treino",
    "Registrar treino",
    "Marca o dia e registra os exercícios (ids de saude_treinos ou saude_exercicios) com séries, repetições e carga.",
    { data: ymd.optional(), treino: z.string().optional().describe("ex.: A ou Treino A"), notas: z.string().optional(), exercicios: z.array(z.object({ id: z.number().int(), series: z.number().int().min(1).max(30), reps: z.number().optional(), kg: z.number().optional() })).min(1).max(30) },
    async ({ data, treino, notas, exercicios }) => {
      const { token, dir } = await ctx();
      const date = data ?? todaySP();
      await saveWorkout(token, { date, notes: notas, day: await dayOf(token, treino), exercises: exercicios.map((e: any) => ({ exercise: e.id, sets: e.series, reps: e.reps ?? null, kg: e.kg ?? null })) });
      syncGymGoals(dir, await gymDays(token));
      return `Treino de ${date} salvo: ${exercicios.length} exercícios.`;
    },
  );
}
