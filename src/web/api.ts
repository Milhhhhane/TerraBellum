import type { ApiError, AuthResponse, CellsResponse, ConfigResponse, LeaderboardEntry, MeResponse } from "../shared/api";

const TOKEN_KEY = "terrabellum.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* navigation privée : la session ne survivra pas au rechargement */
  }
}

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({ error: "Réponse illisible du serveur" }))) as T | ApiError;
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/google") setToken(null);
    throw new ApiRequestError(res.status, (data as ApiError).error ?? `Erreur ${res.status}`);
  }
  return data as T;
}

/** Garde le nouveau jeton s'il y en a un, et renvoie la réponse telle quelle. */
function keepToken(res: AuthResponse): AuthResponse {
  if ("token" in res && res.token) setToken(res.token);
  return res;
}

export const api = {
  config: () => call<ConfigResponse>("GET", "/config"),
  createGuest: async (name: string) => keepToken(await call<AuthResponse>("POST", "/players", { name })),
  google: async (credential: string, name?: string) =>
    keepToken(await call<AuthResponse>("POST", "/auth/google", { credential, name })),
  logout: async () => {
    await call<{ ok: boolean }>("POST", "/logout").catch(() => undefined);
    setToken(null);
  },
  me: () => call<MeResponse>("GET", "/me"),
  harvest: () => call<{ harvested: number; me: MeResponse }>("POST", "/harvest"),
  cells: (b: { west: number; south: number; east: number; north: number }) =>
    call<CellsResponse>("GET", `/cells?west=${b.west}&south=${b.south}&east=${b.east}&north=${b.north}`),
  buy: (h3: string) => call<MeResponse>("POST", `/cells/${h3}/buy`),
  upgrade: (h3: string) => call<MeResponse>("POST", `/cells/${h3}/upgrade`),
  leaderboard: () => call<LeaderboardEntry[]>("GET", "/leaderboard"),
};
