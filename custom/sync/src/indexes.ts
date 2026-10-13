// Séries de índices de referência (CDI, IPCA, IPCA + 6%) a partir do Banco Central (SGS).
import { UA, addDays, isoDay } from "./util";

// Índices calculados a partir das séries do Banco Central (SGS); símbolo manual exige prefixo GF_.
export const BCB_SINCE = "2021-12-31";

async function bcbSeries(code: number, since: string): Promise<{ date: string; value: number }[]> {
  const [y, m, d] = since.split("-");
  const res = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=${d}/${m}/${y}`, {
    headers: UA,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Banco Central série ${code}: ${res.status}`);
  return ((await res.json()) as { data: string; valor: string }[]).map((r) => {
    const [dd, mm, yy] = r.data.split("/");
    return { date: `${yy}-${mm}-${dd}`, value: Number(r.valor) };
  });
}

/** Índices diários (base 100) de CDI, IPCA e IPCA + 6% a.a. */
export async function buildRateIndexes(since = BCB_SINCE) {
  const today = isoDay(new Date());
  const days: string[] = [];
  for (let d = since; d <= today; d = addDays(d, 1)) days.push(d);

  // CDI: taxa diária (% ao dia) em dias úteis; fins de semana repetem o último valor.
  const cdiRates = new Map((await bcbSeries(12, since)).map((r) => [r.date, r.value]));
  let cdi = 100;
  const cdiIndex = days.map((date) => {
    if (date !== since) cdi *= 1 + (cdiRates.get(date) ?? 0) / 100;
    return { date, value: cdi };
  });

  // IPCA: variação mensal, distribuída geometricamente pelos dias do mês. Meses ainda não
  // divulgados ficam sem variação até o IBGE publicar.
  const ipcaMonthly = new Map((await bcbSeries(433, addDays(since, -40))).map((r) => [r.date.slice(0, 7), r.value]));
  let ipca = 100;
  const ipcaIndex = days.map((date) => {
    if (date !== since) {
      const ym = date.slice(0, 7);
      const daysInMonth = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
      ipca *= (1 + (ipcaMonthly.get(ym) ?? 0) / 100) ** (1 / daysInMonth);
    }
    return { date, value: ipca };
  });
  const ipca6Index = ipcaIndex.map(({ date, value }, i) => ({ date, value: value * 1.06 ** (i / 365) }));

  return [
    { symbol: "GF_CDI", name: "CDI", series: cdiIndex },
    { symbol: "GF_IPCA", name: "IPCA", series: ipcaIndex },
    { symbol: "GF_IPCA6", name: "IPCA + 6% a.a.", series: ipca6Index },
  ];
}

