export const DRY_RUN = process.env.DRY_RUN === "1";
export const UA = { "User-Agent": "Mozilla/5.0 (ghostfolio-sync)" };
export const DAY = 86_400_000;

export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
export const dry = (msg: string) => log(`${DRY_RUN ? "[dry-run] " : ""}${msg}`);
export const isoDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoDay(new Date(Date.parse(iso) + n * DAY));
export const round = (n: number, d = 8) => Math.round(n * 10 ** d) / 10 ** d;

export async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Splits do Yahoo (inclui bonificações da B3): data ex e fator multiplicador da quantidade. */
export async function yahooSplits(symbol: string): Promise<{ date: string; factor: number }[]> {
  const body = await fetchJson<any>(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1mo&events=split`,
  );
  const ev = body?.chart?.result?.[0]?.events?.splits ?? {};
  return Object.values(ev as Record<string, { date: number; numerator: number; denominator: number }>)
    .map((s) => ({ date: isoDay(new Date(s.date * 1000)), factor: s.numerator / s.denominator }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function yahooHasQuote(symbol: string): Promise<boolean> {
  const body = await fetchJson<any>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  return body?.chart?.result?.[0]?.meta?.regularMarketPrice != null;
}

export async function yahooDividends(symbol: string, since: string): Promise<{ exDate: string; amount: number }[]> {
  const p1 = Math.floor(Date.parse(since) / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86_400;
  const body = await fetchJson<any>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1mo&events=div`);
  const events = body?.chart?.result?.[0]?.events?.dividends ?? {};
  // B3: meia-noite local (03:00 UTC); EUA: 13:30 UTC. Subtrair 3h mantém a data certa nos dois.
  return Object.values(events as Record<string, { date: number; amount: number }>)
    .map((d) => ({ exDate: isoDay(new Date((d.date - 3 * 3600) * 1000)), amount: d.amount }))
    .sort((a, b) => a.exDate.localeCompare(b.exDate));
}
