import { Hono, type Context } from "hono";
import { cellToLatLng, getResolution, gridDisk, isValidCell } from "h3-js";
import {
  DEFAULT_WORLD,
  H3_RES,
  MAX_LEVEL,
  START_COINS,
  cellPrice,
  cellRate,
  isInOpenZone,
  locationMultiplier,
  upgradeCost,
} from "../shared/economy";
import type { AuthResponse, CellView, CellsResponse, ConfigResponse, LeaderboardEntry, MeResponse } from "../shared/api";
import { NAME_PATTERN, bearerToken, hashToken, newToken } from "./auth";
import { SETTLE_SQL, ensureSchema, type PlayerRow } from "./db";
import { verifyGoogleCredential } from "./google";

type Env = {
  Bindings: {
    DB: D1Database;
    ASSETS: Fetcher;
    /** Client ID OAuth Google (public). Vide = connexion Google désactivée. */
    GOOGLE_CLIENT_ID?: string;
    /** Tests locaux uniquement : adresse de fausses clés publiques "Google". */
    GOOGLE_JWKS_URL?: string;
  };
  Variables: { player: PlayerRow };
};
type Ctx = Context<Env>;

const app = new Hono<Env>().basePath("/api");
const WORLD = DEFAULT_WORLD;
const MAX_CELLS_PER_QUERY = 3000;

class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 402 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Erreur interne du serveur" }, 500);
});

// Toutes les routes ont besoin des tables.
app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

async function findPlayer(c: Ctx): Promise<PlayerRow | null> {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return null;
  const hash = await hashToken(token);
  return c.env.DB.prepare(
    `SELECT p.id, p.name, p.coins, p.stock, p.stock_at, p.rate, p.google_sub
     FROM sessions s JOIN players p ON p.id = s.player_id
     WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<PlayerRow>();
}

/** Ouvre une session (un appareil) pour ce joueur et renvoie le jeton secret. */
async function openSession(db: D1Database, playerId: string): Promise<string> {
  const token = newToken();
  await db
    .prepare("INSERT INTO sessions (token_hash, player_id, created_at) VALUES (?, ?, ?)")
    .bind(await hashToken(token), playerId, Date.now())
    .run();
  return token;
}

function checkName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!NAME_PATTERN.test(name)) {
    throw new HttpError(400, "Pseudo invalide : 3 à 20 caractères, lettres, chiffres, _ ou -");
  }
  return name;
}

/** Crée un joueur (invité si googleSub est null) et sa première session. */
async function createPlayer(db: D1Database, name: string, googleSub: string | null): Promise<AuthResponse> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const token = newToken();
  const tokenHash = await hashToken(token);
  try {
    await db.batch([
      // players.token_hash est une ancienne colonne (V1) : on y met l'empreinte de la 1re session.
      db
        .prepare(
          `INSERT INTO players (id, name, token_hash, coins, stock, stock_at, rate, created_at, last_seen, google_sub)
           VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`,
        )
        .bind(id, name, tokenHash, START_COINS, now, now, now, googleSub),
      db
        .prepare("INSERT INTO sessions (token_hash, player_id, created_at) VALUES (?, ?, ?)")
        .bind(tokenHash, id, now),
    ]);
  } catch (err) {
    if (isUniqueViolation(err) && /name/i.test(String(err))) throw new HttpError(409, "Ce pseudo est déjà pris");
    if (isUniqueViolation(err)) throw new HttpError(409, "Ce compte Google a déjà un joueur");
    throw err;
  }
  return { token, me: await meFor(db, id) };
}

async function requirePlayer(c: Ctx): Promise<PlayerRow> {
  const player = await findPlayer(c);
  if (!player) throw new HttpError(401, "Session inconnue : crée un joueur d'abord");
  return player;
}

async function meFor(db: D1Database, playerId: string): Promise<MeResponse> {
  const row = await db
    .prepare(
      `SELECT p.id, p.name, p.coins, p.stock, p.stock_at, p.rate, p.google_sub,
              (SELECT COUNT(*) FROM cells c WHERE c.world = ?2 AND c.owner_id = p.id) AS owned
       FROM players p WHERE p.id = ?1`,
    )
    .bind(playerId, WORLD)
    .first<PlayerRow & { owned: number }>();
  if (!row) throw new HttpError(404, "Joueur introuvable");
  return {
    id: row.id,
    name: row.name,
    coins: row.coins,
    stock: row.stock,
    stockAt: row.stock_at,
    rate: row.rate,
    ownedCells: row.owned,
    hasGoogle: row.google_sub !== null,
    serverNow: Date.now(),
  };
}

function parseCell(raw: string): string {
  if (!isValidCell(raw) || getResolution(raw) !== H3_RES) throw new HttpError(400, "Case invalide");
  if (!isInOpenZone(raw)) throw new HttpError(403, "Cette zone n'est pas encore ouverte");
  return raw;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

app.get("/health", (c) => c.json({ ok: true }));

app.get("/config", (c) => c.json<ConfigResponse>({ googleClientId: c.env.GOOGLE_CLIENT_ID || null }));

// Créer un joueur invité. Renvoie le jeton secret, à garder côté client.
app.post("/players", async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  return c.json(await createPlayer(c.env.DB, checkName(body.name), null), 201);
});

/**
 * Connexion avec Google. Trois cas :
 * 1. Ce compte Google a déjà un joueur → nouvelle session sur cet appareil.
 * 2. Un invité connecté clique "Lier Google" → on attache Google à SON joueur (il garde tout).
 * 3. Nouveau joueur → il faut un pseudo : on répond needsName, le client renvoie avec `name`.
 */
app.post("/auth/google", async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new HttpError(404, "Connexion Google non configurée");
  const body = await c.req
    .json<{ credential?: unknown; name?: unknown }>()
    .catch(() => ({}) as { credential?: unknown; name?: unknown });
  if (typeof body.credential !== "string") throw new HttpError(400, "Jeton Google manquant");

  let sub: string;
  try {
    ({ sub } = await verifyGoogleCredential(body.credential, clientId, c.env.GOOGLE_JWKS_URL || undefined));
  } catch (err) {
    console.warn("Jeton Google refusé", err);
    throw new HttpError(401, "Connexion Google refusée, réessaie");
  }
  const db = c.env.DB;

  const existing = await db.prepare("SELECT id FROM players WHERE google_sub = ?").bind(sub).first<string>("id");
  if (existing) {
    return c.json<AuthResponse>({ token: await openSession(db, existing), me: await meFor(db, existing) });
  }

  const current = await findPlayer(c);
  if (current && current.google_sub === null) {
    await db
      .prepare("UPDATE players SET google_sub = ? WHERE id = ? AND google_sub IS NULL")
      .bind(sub, current.id)
      .run();
    // Le client garde son jeton actuel.
    return c.json<AuthResponse>({ token: null, me: await meFor(db, current.id) });
  }

  if (body.name === undefined) return c.json<AuthResponse>({ needsName: true });
  return c.json(await createPlayer(db, checkName(body.name), sub), 201);
});

// Se déconnecter de cet appareil.
app.post("/logout", async (c) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const player = await requirePlayer(c);
  return c.json(await meFor(c.env.DB, player.id));
});

// Récolter : le stock (plafonné) passe dans le porte-monnaie.
app.post("/harvest", async (c) => {
  const player = await requirePlayer(c);
  const now = Date.now();
  const db = c.env.DB;
  const [, stockRow] = await db.batch([
    db.prepare(SETTLE_SQL).bind(now, player.id),
    db.prepare("SELECT stock FROM players WHERE id = ?").bind(player.id),
    db.prepare("UPDATE players SET coins = coins + stock, stock = 0, last_seen = ?1 WHERE id = ?2").bind(
      now,
      player.id,
    ),
  ]);
  const harvested = (stockRow?.results[0] as { stock: number } | undefined)?.stock ?? 0;
  return c.json({ harvested, me: await meFor(db, player.id) });
});

// Cases possédées dans un rectangle de la carte.
app.get("/cells", async (c) => {
  const q = (k: string) => Number(c.req.query(k));
  const [west, south, east, north] = [q("west"), q("south"), q("east"), q("north")];
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
    throw new HttpError(400, "Rectangle invalide");
  }
  const player = await findPlayer(c);
  const { results } = await c.env.DB.prepare(
    `SELECT c.h3, c.owner_id, c.level, c.is_home, p.name AS owner_name
     FROM cells c JOIN players p ON p.id = c.owner_id
     WHERE c.world = ? AND c.lat BETWEEN ? AND ? AND c.lng BETWEEN ? AND ?
     LIMIT ?`,
  )
    .bind(WORLD, south, north, west, east, MAX_CELLS_PER_QUERY + 1)
    .all<{ h3: string; owner_id: string; level: number; is_home: number; owner_name: string }>();

  const cells: CellView[] = results.slice(0, MAX_CELLS_PER_QUERY).map((r) => ({
    h3: r.h3,
    ownerName: r.owner_name,
    mine: r.owner_id === player?.id,
    level: r.level,
    isHome: r.is_home === 1,
  }));
  return c.json<CellsResponse>({ cells, truncated: results.length > MAX_CELLS_PER_QUERY });
});

// Acheter une case vide. La première case est libre d'emplacement (et devient la case maison) ;
// les suivantes doivent toucher une case déjà possédée.
app.post("/cells/:h3/buy", async (c) => {
  const player = await requirePlayer(c);
  const h3 = parseCell(c.req.param("h3"));
  const db = c.env.DB;

  // Message clair si la case est déjà prise (la clé primaire reste la vraie protection).
  const taken = await db.prepare("SELECT 1 FROM cells WHERE world = ? AND h3 = ?").bind(WORLD, h3).first();
  if (taken) throw new HttpError(409, "Cette case est déjà prise");

  const owned =
    (await db
      .prepare("SELECT COUNT(*) AS n FROM cells WHERE world = ? AND owner_id = ?")
      .bind(WORLD, player.id)
      .first<number>("n")) ?? 0;

  if (owned > 0) {
    const neighbours = gridDisk(h3, 1).filter((n) => n !== h3);
    const touching = await db
      .prepare(
        `SELECT 1 FROM cells WHERE world = ? AND owner_id = ? AND h3 IN (${neighbours.map(() => "?").join(",")}) LIMIT 1`,
      )
      .bind(WORLD, player.id, ...neighbours)
      .first();
    if (!touching) throw new HttpError(403, "Tu ne peux acheter qu'une case voisine d'une des tiennes");
  }

  const locMult = locationMultiplier(h3);
  const price = cellPrice(locMult, owned);
  const addedRate = cellRate(locMult, 1);
  const [lat, lng] = cellToLatLng(h3);
  const now = Date.now();
  const op = crypto.randomUUID();

  let inserted: D1Result;
  try {
    // Un batch D1 est une transaction : tout passe, ou rien.
    [, inserted] = (await db.batch([
      db.prepare(SETTLE_SQL).bind(now, player.id),
      // N'insère la case que si le joueur a assez de pièces. Si quelqu'un l'a déjà, la clé primaire bloque.
      db
        .prepare(
          `INSERT INTO cells (world, h3, owner_id, level, loc_mult, invested, is_home, lat, lng, bought_at, last_op)
           SELECT ?, ?, id, 1, ?, ?, ?, ?, ?, ?, ? FROM players WHERE id = ? AND coins >= ?`,
        )
        .bind(WORLD, h3, locMult, price, owned === 0 ? 1 : 0, lat, lng, now, op, player.id, price),
      // Ne débite que si l'insertion de CETTE requête a eu lieu (repérée par son identifiant `op`).
      db
        .prepare(
          `UPDATE players SET coins = coins - ?, rate = rate + ?, last_seen = ?
           WHERE id = ? AND EXISTS (SELECT 1 FROM cells WHERE world = ? AND h3 = ? AND last_op = ?)`,
        )
        .bind(price, addedRate, now, player.id, WORLD, h3, op),
    ])) as [D1Result, D1Result, D1Result];
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "Cette case est déjà prise");
    throw err;
  }
  if (inserted.meta.changes === 0) throw new HttpError(402, `Pas assez de pièces (il en faut ${price})`);
  return c.json(await meFor(db, player.id));
});

// Monter d'un étage : maison → immeuble → tour → gratte-ciel.
app.post("/cells/:h3/upgrade", async (c) => {
  const player = await requirePlayer(c);
  const h3 = parseCell(c.req.param("h3"));
  const db = c.env.DB;

  const cell = await db
    .prepare("SELECT level, loc_mult FROM cells WHERE world = ? AND h3 = ? AND owner_id = ?")
    .bind(WORLD, h3, player.id)
    .first<{ level: number; loc_mult: number }>();
  if (!cell) throw new HttpError(404, "Cette case ne t'appartient pas");
  if (cell.level >= MAX_LEVEL) throw new HttpError(400, "Niveau maximum atteint");

  const cost = upgradeCost(cell.loc_mult, cell.level);
  const addedRate = cellRate(cell.loc_mult, cell.level + 1) - cellRate(cell.loc_mult, cell.level);
  const now = Date.now();
  const op = crypto.randomUUID();

  const [, upgraded] = (await db.batch([
    db.prepare(SETTLE_SQL).bind(now, player.id),
    db
      .prepare(
        `UPDATE cells SET level = level + 1, invested = invested + ?, last_op = ?
         WHERE world = ? AND h3 = ? AND owner_id = ? AND level = ?
           AND EXISTS (SELECT 1 FROM players WHERE id = ? AND coins >= ?)`,
      )
      .bind(cost, op, WORLD, h3, player.id, cell.level, player.id, cost),
    db
      .prepare(
        `UPDATE players SET coins = coins - ?, rate = rate + ?, last_seen = ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM cells WHERE world = ? AND h3 = ? AND last_op = ?)`,
      )
      .bind(cost, addedRate, now, player.id, WORLD, h3, op),
  ])) as [D1Result, D1Result, D1Result];

  if (upgraded.meta.changes === 0) throw new HttpError(402, `Pas assez de pièces (il en faut ${cost})`);
  return c.json(await meFor(db, player.id));
});

app.get("/leaderboard", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.name,
            p.coins + COALESCE(SUM(c.invested), 0) AS worth,
            COUNT(c.h3) AS cells
     FROM players p LEFT JOIN cells c ON c.owner_id = p.id AND c.world = ?
     GROUP BY p.id
     ORDER BY worth DESC
     LIMIT 20`,
  )
    .bind(WORLD)
    .all<LeaderboardEntry>();
  return c.json(results);
});

app.notFound((c) => c.json({ error: "Route inconnue" }, 404));

export default app;
