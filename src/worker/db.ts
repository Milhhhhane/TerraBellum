/**
 * Schéma et migrations D1.
 *
 * Le Worker applique lui-même les migrations au premier appel : chaque migration
 * a un numéro, la table `schema_meta` retient le dernier numéro appliqué.
 * Pour faire évoluer le schéma : AJOUTER une migration à la fin de la liste,
 * ne jamais modifier une migration déjà déployée.
 */

import { STOCK_CAP_MINUTES } from "../shared/economy";

interface Migration {
  version: number;
  description: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Tables de base : joueurs et cases",
    statements: [
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
    ],
  },
  {
    version: 2,
    description: "Connexion Google et sessions multi-appareils",
    statements: [
      // Une session = un appareil connecté. On ne stocke que l'empreinte du jeton.
      `CREATE TABLE sessions (
        token_hash  TEXT PRIMARY KEY,
        player_id   TEXT NOT NULL REFERENCES players(id),
        created_at  INTEGER NOT NULL
      )`,
      `CREATE INDEX sessions_by_player ON sessions (player_id)`,
      // Les comptes invités existants gardent leur jeton actuel.
      `INSERT INTO sessions (token_hash, player_id, created_at) SELECT token_hash, id, created_at FROM players`,
      // Identifiant Google stable ("sub"). Pas d'e-mail stocké.
      `ALTER TABLE players ADD COLUMN google_sub TEXT`,
      `CREATE UNIQUE INDEX players_by_google_sub ON players (google_sub) WHERE google_sub IS NOT NULL`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

async function currentVersion(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT version FROM schema_meta WHERE id = 1").first<number>("version")) ?? 0;
}

async function migrate(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    ),
    db.prepare("INSERT OR IGNORE INTO schema_meta (id, version) VALUES (1, 0)"),
  ]);

  let version = await currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    try {
      // Un batch D1 est une transaction : la migration passe entièrement, ou pas du tout.
      await db.batch([
        ...m.statements.map((sql) => db.prepare(sql)),
        db.prepare("UPDATE schema_meta SET version = ? WHERE id = 1").bind(m.version),
      ]);
      console.log(`Migration ${m.version} appliquée : ${m.description}`);
      version = m.version;
    } catch (err) {
      // Une autre instance du Worker l'a peut-être appliquée en même temps.
      version = await currentVersion(db);
      if (version >= m.version) continue;
      throw err;
    }
  }
}

let schemaReady: Promise<void> | null = null;

/** Applique les migrations manquantes, une seule fois par instance du Worker. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = migrate(db).catch((err) => {
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
  google_sub: string | null;
}
