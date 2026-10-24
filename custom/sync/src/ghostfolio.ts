// Cliente mínimo da API do Ghostfolio.

export interface Activity {
  id: string;
  accountId: string | null;
  comment: string | null;
  currency: string;
  date: string;
  fee: number;
  quantity: number;
  type: "BUY" | "SELL" | "DIVIDEND" | "FEE" | "INTEREST" | "LIABILITY";
  unitPrice: number;
  assetProfile: { dataSource: string; symbol: string; name: string | null; currency: string };
}

export interface Account {
  id: string;
  name: string;
  currency: string;
}

export type Api = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export async function connect(baseUrl: string, token?: string): Promise<Api> {
  const url = baseUrl.replace(/\/$/, "");
  let jwt = token ? undefined : process.env.GHOSTFOLIO_BEARER; // só para testes locais
  if (!jwt) {
    const accessToken = token ?? process.env.GHOSTFOLIO_ACCESS_TOKEN;
    if (!accessToken) throw new Error("Defina GHOSTFOLIO_ACCESS_TOKEN em custom/sync/sync.env (token de segurança do Ghostfolio).");
    const res = await fetch(`${url}/api/v1/auth/anonymous`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken }),
    });
    if (!res.ok) throw new Error(`Falha na autenticação (${res.status}). Confira o token.`);
    jwt = ((await res.json()) as { authToken: string }).authToken;
  }
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
}

/** Espera a API responder (o Ghostfolio leva alguns segundos para subir). */
export async function waitForGhostfolio(baseUrl: string, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/health`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("Ghostfolio não respondeu a tempo");
}

export async function getActivities(api: Api): Promise<Activity[]> {
  return (await api<{ activities: Activity[] }>("GET", "/v1/activities")).activities;
}

export async function getAccounts(api: Api): Promise<Account[]> {
  return (await api<{ accounts: Account[] }>("GET", "/v1/account")).accounts;
}

export const isAuto = (a: { comment: string | null }) => !!a.comment?.startsWith("Auto (Yahoo)");
