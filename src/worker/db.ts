/**
 * Schéma et requêtes D1.
 *
 * Les tables sont créées au premier appel (CREATE TABLE IF NOT EXISTS),
 * ce qui évite de lancer des migrations à la main. Quand le schéma devra
 * évoluer, on passera aux migrations D1 (`wrangler d1 migrations`).
 */

import { STOCK_CAP_MINUTES } from "../shared/economy";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    token_hash  TEXT NOT NULL UNIQUE,
    coins       REAL NOT NULL,
    stock       REAL NOT NULL DEFAULT 0,
    stock_at    INTEGER NOT NULL,
    rate        REAL NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  )`,
  // Une case = (monde, h3). Le monde permettra d'ajouter le PvP sans tout refaire,
  // alliance_id est prévu pour les alliances.
  `CREATE TABLE IF NOT EXISTS cells (
    world       TEXT NOT NULL,
    h3          TEXT NOT NULL,
    owner_id    TEXT NOT NULL REFERENCES players(id),
    alliance_id TEXT,
    level       INTEGER NOT NULL DEFAULT 1,
    loc_mult    REAL NOT NULL,
    invested    REAL NOT NULL,
    is_home     INTEGER NOT NULL DEFAULT 0,
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    bought_at   INTEGER NOT NULL,
    last_op     TEXT,
    PRIMARY KEY (world, h3)
  )`,
  `CREATE INDEX IF NOT EXISTS cells_by_owner ON cells (world, owner_id)`,
  `CREATE INDEX IF NOT EXISTS cells_by_position ON cells (world, lat, lng)`,
];

let schemaReady: Promise<void> | null = null;

/** Crée les tables une seule fois par instance du Worker. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db
      .batch(SCHEMA.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null; // on retentera au prochain appel
        throw err;
      });
  }
  return schemaReady;
}

/**
 * "Fige" le stock d'un joueur à l'instant `now`, avec l'ANCIEN taux de production.
 * À exécuter avant tout changement de taux (achat, amélioration).
 * Même formule que pendingStock() dans src/shared/economy.ts.
 * Paramètres : ?1 = now (ms), ?2 = id du joueur.
 */
export const SETTLE_SQL = `
  UPDATE players
  SET stock = MIN(rate * ${STOCK_CAP_MINUTES}, stock + rate * (MAX(0, ?1 - stock_at) / 60000.0)),
      stock_at = ?1
  WHERE id = ?2`;

export interface PlayerRow {
  id: string;
  name: string;
  coins: number;
  stock: number;
  stock_at: number;
  rate: number;
}
