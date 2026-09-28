/** Éléments partagés par les routes du jeu et les routes admin. */

import type { Context } from "hono";
import { getResolution, isValidCell } from "h3-js";
import { H3_RES, isInOpenZone } from "../shared/economy";
import { NAME_PATTERN, bearerToken, hashToken } from "./auth";
import type { PlayerRow } from "./db";

export type Env = {
  Bindings: {
    DB: D1Database;
    ASSETS: Fetcher;
    /** Client ID OAuth Google (public). Vide = connexion Google désactivée. */
    GOOGLE_CLIENT_ID?: string;
    /** Tests locaux uniquement : adresse de fausses clés publiques "Google". */
    GOOGLE_JWKS_URL?: string;
    /** Tests locaux uniquement : accélère les durées du PvP (ex. "0.001"). */
    PVP_TIME_SCALE?: string;
  };
  Variables: { admin: PlayerRow };
};
export type Ctx = Context<Env>;

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 402 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export function checkName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!NAME_PATTERN.test(name)) {
    throw new HttpError(400, "Pseudo invalide : 3 à 20 caractères, lettres, chiffres, _ ou -");
  }
  return name;
}

export const PLAYER_COLUMNS = "p.id, p.name, p.coins, p.stock, p.stock_at, p.rate, p.google_sub, p.is_admin, p.banned_at";

/** Le joueur de la session envoyée (en-tête Authorization), ou null. */
export async function findPlayer(c: Ctx): Promise<PlayerRow | null> {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return null;
  const hash = await hashToken(token);
  return c.env.DB.prepare(
    `SELECT ${PLAYER_COLUMNS} FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<PlayerRow>();
}

/** Joueur connecté ET autorisé à jouer (pas suspendu). */
export async function requirePlayer(c: Ctx): Promise<PlayerRow> {
  const player = await findPlayer(c);
  if (!player) throw new HttpError(401, "Session inconnue : crée un joueur d'abord");
  if (player.banned_at !== null) throw new HttpError(403, "Ton compte est suspendu");
  return player;
}

/** Vérifie qu'un identifiant de case est valide et dans la zone ouverte. */
export function parseCell(raw: string): string {
  if (!isValidCell(raw) || getResolution(raw) !== H3_RES) throw new HttpError(400, "Case invalide");
  if (!isInOpenZone(raw)) throw new HttpError(403, "Cette zone n'est pas encore ouverte");
  return raw;
}
