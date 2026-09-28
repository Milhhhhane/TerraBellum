import type {
  AdminLogEntry,
  AdminPlayer,
  AdminStats,
  ApiError,
  AuthResponse,
  CellsResponse,
  ConfigResponse,
  LeaderboardEntry,
  MeResponse,
  PvpState,
} from "../shared/api";
import type { CellKind } from "../shared/pvp";

export type World = "calme" | "pvp";

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
  cells: (b: { west: number; south: number; east: number; north: number }, world: World) =>
    call<CellsResponse>(
      "GET",
      `/cells?world=${world}&west=${b.west}&south=${b.south}&east=${b.east}&north=${b.north}`,
    ),
  buy: (h3: string) => call<MeResponse>("POST", `/cells/${h3}/buy`),
  upgrade: (h3: string) => call<MeResponse>("POST", `/cells/${h3}/upgrade`),
  leaderboard: (world: World) => call<LeaderboardEntry[]>("GET", `/leaderboard?world=${world}`),
};

export const pvpApi = {
  state: () => call<PvpState>("GET", "/pvp/state"),
  join: () => call<{ ok: true }>("POST", "/pvp/join"),
  transfer: (amount: number, direction: "in" | "out") =>
    call<{ ok: true; received?: number }>("POST", "/pvp/transfer", { amount, direction }),
  harvest: () => call<{ harvested: number }>("POST", "/pvp/harvest"),
  buy: (h3: string, kind: CellKind) => call<{ ok: true }>("POST", `/pvp/cells/${h3}/buy`, { kind }),
  upgrade: (h3: string) => call<{ ok: true }>("POST", `/pvp/cells/${h3}/upgrade`),
  recruit: (count: number) => call<{ ok: true }>("POST", "/pvp/recruit", { count }),
  rampart: () => call<{ ok: true }>("POST", "/pvp/rampart"),
  attack: (h3: string, soldiers: number) => call<{ ok: true; arrivesAt: number }>("POST", "/pvp/attack", { h3, soldiers }),
};

export const adminApi = {
  stats: () => call<AdminStats>("GET", "/admin/stats"),
  players: (q: string, sort: "worth" | "recent") =>
    call<AdminPlayer[]>("GET", `/admin/players?q=${encodeURIComponent(q)}&sort=${sort}`),
  coins: (id: string, delta: number) => call<{ ok: true }>("POST", `/admin/players/${id}/coins`, { delta }),
  rename: (id: string, name: string) => call<{ ok: true }>("POST", `/admin/players/${id}/rename`, { name }),
  ban: (id: string, reason: string) => call<{ ok: true }>("POST", `/admin/players/${id}/ban`, { reason }),
  unban: (id: string) => call<{ ok: true }>("POST", `/admin/players/${id}/unban`),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/admin/players/${id}`),
  log: () => call<AdminLogEntry[]>("GET", "/admin/log"),
};
