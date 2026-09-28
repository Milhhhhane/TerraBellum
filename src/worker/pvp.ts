/**
 * Monde PvP : routes /api/pvp/* et résolution des batailles.
 *
 * Même principe que le monde calme : rien ne tourne en continu. Le stock, les recrues
 * et les attaques arrivées se calculent quand on en a besoin. Les attaques arrivées sont
 * réglées par une tâche planifiée (toutes les minutes) ET à chaque appel PvP, pour ne
 * jamais dépendre d'une seule source.
 */

import { Hono } from "hono";
import { cellToLatLng, gridDisk } from "h3-js";
import { cellPrice, locationMultiplier, MAX_LEVEL, upgradeCost } from "../shared/economy";
import {
  ATTACK_TRAVEL_MS,
  LOSS_COMPENSATION,
  LOSS_WINDOW_MS,
  PILLAGE_SHARE,
  PVP_START_COINS,
  PVP_WORLD,
  RECRUIT_MS_PER_SOLDIER,
  SHIELD_MS,
  SOLDIER_COST,
  START_SOLDIERS,
  TRANSFER_IN_COOLDOWN_MS,
  TRANSFER_IN_MAX_SHARE,
  TRANSFER_OUT_TAX,
  armyCap,
  frontierCells,
  isCellKind,
  pvpCellRate,
  rampartUpgradeCost,
  resolveBattle,
  shieldEarned,
  type CellKind,
} from "../shared/pvp";
import type { AttackView, BattleReport, PvpState } from "../shared/api";
import { SETTLE_PVP_SQL, SETTLE_RECRUITS_SQL, type PvpRow } from "./db";
import { HttpError, isUniqueViolation, parseCell, requirePlayer, type Ctx, type Env } from "./common";

const W = PVP_WORLD;
const MAX_REPORTS = 15;

// ---------- Durées (accélérables en test local via PVP_TIME_SCALE) ----------
export function timing(env: { PVP_TIME_SCALE?: string }) {
  const scale = Number(env.PVP_TIME_SCALE);
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    recruitMs: Math.max(1, Math.round(RECRUIT_MS_PER_SOLDIER * k)),
    travelMs: Math.max(1, Math.round(ATTACK_TRAVEL_MS * k)),
  };
}

// ---------- Lecture ----------
async function pvpRow(db: D1Database, playerId: string): Promise<PvpRow | null> {
  return db.prepare("SELECT * FROM pvp_players WHERE player_id = ?").bind(playerId).first<PvpRow>();
}

async function ownedCells(db: D1Database, playerId: string) {
  const { results } = await db
    .prepare("SELECT h3, kind, level FROM cells WHERE world = ? AND owner_id = ?")
    .bind(W, playerId)
    .all<{ h3: string; kind: CellKind; level: number }>();
  return results;
}

async function capOf(db: D1Database, playerId: string): Promise<number> {
  const { results } = await db
    .prepare("SELECT level FROM cells WHERE world = ? AND owner_id = ? AND kind = 'caserne'")
    .bind(W, playerId)
    .all<{ level: number }>();
  return armyCap(results.map((r) => r.level));
}

async function requirePvp(c: Ctx): Promise<{ id: string; name: string; row: PvpRow }> {
  const player = await requirePlayer(c);
  const { recruitMs } = timing(c.env);
  await c.env.DB.prepare(SETTLE_RECRUITS_SQL).bind(Date.now(), player.id, recruitMs).run();
  const row = await pvpRow(c.env.DB, player.id);
  if (!row) throw new HttpError(403, "Rejoins d'abord le monde PvP");
  return { id: player.id, name: player.name, row };
}

// ---------- Résolution des batailles ----------

/** Règle les attaques arrivées. Appelée par la tâche planifiée et avant chaque route PvP. */
export async function resolveDueAttacks(db: D1Database, env: { PVP_TIME_SCALE?: string }, now = Date.now()) {
  const { results } = await db
    .prepare("SELECT id FROM attacks WHERE status = 'pending' AND arrives_at <= ? ORDER BY arrives_at LIMIT 10")
    .bind(now)
    .all<{ id: string }>();
  for (const { id } of results) {
    try {
      await resolveAttack(db, env, id, now);
    } catch (err) {
      console.error(`Échec de la résolution de l'attaque ${id}`, err);
      // On relâche l'attaque pour qu'une prochaine passe la retente.
      await db.prepare("UPDATE attacks SET status = 'pending', claim = NULL WHERE id = ? AND status = 'resolving'").bind(id).run();
    }
  }
}

interface AttackRow {
  id: string;
  h3: string;
  attacker_id: string;
  defender_id: string;
  soldiers: number;
  arrives_at: number;
}

async function resolveAttack(db: D1Database, env: { PVP_TIME_SCALE?: string }, id: string, now: number) {
  // 1. Réserver l'attaque : une seule instance du Worker peut la régler.
  const claim = crypto.randomUUID();
  const claimed = await db
    .prepare("UPDATE attacks SET status = 'resolving', claim = ? WHERE id = ? AND status = 'pending'")
    .bind(claim, id)
    .run();
  if (claimed.meta.changes !== 1) return;

  const a = await db.prepare("SELECT * FROM attacks WHERE id = ?").bind(id).first<AttackRow>();
  if (!a) return;

  const { recruitMs } = timing(env);
  await db.prepare(SETTLE_RECRUITS_SQL).bind(now, a.defender_id, recruitMs).run();
  const def = await pvpRow(db, a.defender_id);
  const cell = await db
    .prepare("SELECT kind, level, loc_mult, invested, is_home FROM cells WHERE world = ? AND h3 = ? AND owner_id = ?")
    .bind(W, a.h3, a.defender_id)
    .first<{ kind: CellKind; level: number; loc_mult: number; invested: number; is_home: number }>();

  const finish = (result: string, attackerLosses: number, defenderLosses: number) =>
    db
      .prepare(
        `UPDATE attacks SET status = 'done', result = ?, attacker_losses = ?, defender_losses = ?, resolved_at = ?
         WHERE id = ? AND claim = ?`,
      )
      .bind(result, attackerLosses, defenderLosses, now, id, claim);

  // Case disparue, bouclier activé pendant le trajet… : l'attaque est annulée, les soldats rentrent.
  if (!def || !cell || cell.is_home === 1 || (def.shield_until !== null && def.shield_until > now)) {
    await db.batch([
      db
        .prepare("UPDATE pvp_players SET soldiers = soldiers + ?1, soldiers_away = MAX(0, soldiers_away - ?1) WHERE player_id = ?2")
        .bind(a.soldiers, a.attacker_id),
      finish("annulée", 0, 0),
    ]);
    return;
  }

  // 2. Calcul de la défense de la case.
  const defCells = await ownedCells(db, a.defender_id);
  const owned = new Set(defCells.map((x) => x.h3));
  const barracks = new Set(defCells.filter((x) => x.kind === "caserne").map((x) => x.h3));
  const nearBarracks = gridDisk(a.h3, 1).some((n) => barracks.has(n));
  const battle = resolveBattle(a.soldiers, {
    soldiersHome: def.soldiers,
    frontierCount: frontierCells(owned).length,
    targetLevel: cell.level,
    rampartLevel: def.rampart,
    nearBarracks,
  });

  if (!battle.attackerWins) {
    await db.batch([
      db
        .prepare("UPDATE pvp_players SET soldiers_away = MAX(0, soldiers_away - ?) WHERE player_id = ?")
        .bind(a.soldiers, a.attacker_id),
      db
        .prepare("UPDATE pvp_players SET soldiers = MAX(0, soldiers - ?) WHERE player_id = ?")
        .bind(battle.defenderLosses, a.defender_id),
      finish("défaite", battle.attackerLosses, battle.defenderLosses),
    ]);
    return;
  }

  // 3. Victoire : la case change de main (un étage de moins), pillage, compensation, bouclier éventuel.
  const newLevel = Math.max(1, cell.level - 1);
  const oldRate = pvpCellRate(cell.kind, cell.loc_mult, cell.level);
  const newRate = pvpCellRate(cell.kind, cell.loc_mult, newLevel);
  const compensation = cell.invested * LOSS_COMPENSATION;
  const survivors = a.soldiers - battle.attackerLosses;

  const windowOpen = def.loss_window_start !== null && now - def.loss_window_start < LOSS_WINDOW_MS;
  const lossCount = windowOpen ? def.loss_count + 1 : 1;
  const lossBase = windowOpen ? def.loss_base : defCells.length;
  const shield = shieldEarned(lossCount, lossBase);

  const moved = `EXISTS (SELECT 1 FROM cells WHERE world = '${W}' AND h3 = ?1 AND last_op = ?2)`;
  await db.batch([
    db.prepare(SETTLE_PVP_SQL).bind(now, a.defender_id),
    db.prepare(SETTLE_PVP_SQL).bind(now, a.attacker_id),
    // La case change de propriétaire (seulement si le défenseur la possède toujours).
    db
      .prepare(
        `UPDATE cells SET owner_id = ?, level = ?, invested = invested * 0.5, is_home = 0, bought_at = ?, last_op = ?
         WHERE world = ? AND h3 = ? AND owner_id = ?`,
      )
      .bind(a.attacker_id, newLevel, now, claim, W, a.h3, a.defender_id),
    // Montant pillé, noté dans l'attaque avant d'être déplacé.
    db
      .prepare(`UPDATE attacks SET pillage = (SELECT stock * ${PILLAGE_SHARE} FROM pvp_players WHERE player_id = ?) WHERE id = ?`)
      .bind(a.defender_id, id),
    db
      .prepare(
        `UPDATE pvp_players
         SET coins = coins + (SELECT stock * ${PILLAGE_SHARE} FROM pvp_players WHERE player_id = ?1),
             soldiers = soldiers + ?2,
             soldiers_away = MAX(0, soldiers_away - ?3)
         WHERE player_id = ?4`,
      )
      .bind(a.defender_id, survivors, a.soldiers, a.attacker_id),
    db
      .prepare(
        `UPDATE pvp_players
         SET stock = stock * ${1 - PILLAGE_SHARE},
             soldiers = MAX(0, soldiers - ?3),
             coins = coins + CASE WHEN ${moved} THEN ?4 ELSE 0 END,
             rate = MAX(0, rate - CASE WHEN ${moved} THEN ?5 ELSE 0 END),
             loss_window_start = ?6, loss_count = ?7, loss_base = ?8, shield_until = COALESCE(?9, shield_until)
         WHERE player_id = ?10`,
      )
      .bind(
        a.h3,
        claim,
        battle.defenderLosses,
        compensation,
        oldRate,
        shield ? null : windowOpen ? def.loss_window_start : now,
        shield ? 0 : lossCount,
        shield ? 0 : lossBase,
        shield ? now + SHIELD_MS : null,
        a.defender_id,
      ),
    db
      .prepare(`UPDATE pvp_players SET rate = rate + CASE WHEN ${moved} THEN ?3 ELSE 0 END WHERE player_id = ?4`)
      .bind(a.h3, claim, newRate, a.attacker_id),
    finish("victoire", battle.attackerLosses, battle.defenderLosses),
  ]);
}

// ---------- Routes ----------
export const pvpRoutes = new Hono<Env>();

// Avant chaque route PvP : régler les attaques arrivées.
pvpRoutes.use("*", async (c, next) => {
  await resolveDueAttacks(c.env.DB, c.env);
  await next();
});

async function attackViews(db: D1Database, column: "attacker_id" | "defender_id", playerId: string): Promise<AttackView[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.h3, a.soldiers, a.arrives_at, pa.name AS attacker_name, pd.name AS defender_name
       FROM attacks a JOIN players pa ON pa.id = a.attacker_id JOIN players pd ON pd.id = a.defender_id
       WHERE a.${column} = ? AND a.status IN ('pending', 'resolving')
       ORDER BY a.arrives_at`,
    )
    .bind(playerId)
    .all<{ id: string; h3: string; soldiers: number; arrives_at: number; attacker_name: string; defender_name: string }>();
  return results.map((r) => ({
    id: r.id,
    h3: r.h3,
    soldiers: r.soldiers,
    arrivesAt: r.arrives_at,
    attackerName: r.attacker_name,
    defenderName: r.defender_name,
  }));
}

async function reports(db: D1Database, playerId: string): Promise<BattleReport[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.h3, a.resolved_at, a.attacker_id, a.result, a.soldiers, a.attacker_losses, a.defender_losses,
              a.pillage, pa.name AS attacker_name, pd.name AS defender_name
       FROM attacks a JOIN players pa ON pa.id = a.attacker_id JOIN players pd ON pd.id = a.defender_id
       WHERE (a.attacker_id = ?1 OR a.defender_id = ?1) AND a.status = 'done'
       ORDER BY a.resolved_at DESC LIMIT ${MAX_REPORTS}`,
    )
    .bind(playerId)
    .all<{
      id: string;
      h3: string;
      resolved_at: number;
      attacker_id: string;
      result: BattleReport["result"];
      soldiers: number;
      attacker_losses: number;
      defender_losses: number;
      pillage: number | null;
      attacker_name: string;
      defender_name: string;
    }>();
  return results.map((r) => {
    const attacking = r.attacker_id === playerId;
    return {
      id: r.id,
      h3: r.h3,
      at: r.resolved_at,
      role: attacking ? "attaque" : "défense",
      opponentName: attacking ? r.defender_name : r.attacker_name,
      result: r.result,
      soldiers: r.soldiers,
      attackerLosses: r.attacker_losses ?? 0,
      defenderLosses: r.defender_losses ?? 0,
      pillage: r.result === "victoire" ? r.pillage ?? 0 : 0,
    };
  });
}

pvpRoutes.get("/state", async (c) => {
  const player = await requirePlayer(c);
  const db = c.env.DB;
  const now = Date.now();
  const { recruitMs, travelMs } = timing(c.env);
  await db.prepare(SETTLE_RECRUITS_SQL).bind(now, player.id, recruitMs).run();
  const row = await pvpRow(db, player.id);

  const nextTransfer = row?.last_transfer_in ? row.last_transfer_in + TRANSFER_IN_COOLDOWN_MS : 0;
  const state: PvpState = {
    joined: !!row,
    serverNow: now,
    recruitMs,
    travelMs,
    transferInMax: Math.floor(player.coins * TRANSFER_IN_MAX_SHARE),
    transferInAvailableAt: nextTransfer,
    incoming: [],
    outgoing: [],
    reports: [],
  };
  if (!row) return c.json(state);

  const cells = await ownedCells(db, player.id);
  state.me = {
    coins: row.coins,
    stock: row.stock,
    stockAt: row.stock_at,
    rate: row.rate,
    soldiers: row.soldiers,
    soldiersAway: row.soldiers_away,
    queueCount: row.queue_count,
    queueStart: row.queue_start,
    armyCap: armyCap(cells.filter((x) => x.kind === "caserne").map((x) => x.level)),
    rampart: row.rampart,
    shieldUntil: row.shield_until !== null && row.shield_until > now ? row.shield_until : null,
    ownedCells: cells.length,
    frontierCells: frontierCells(new Set(cells.map((x) => x.h3))).length,
  };
  [state.incoming, state.outgoing, state.reports] = await Promise.all([
    attackViews(db, "defender_id", player.id),
    attackViews(db, "attacker_id", player.id),
    reports(db, player.id),
  ]);
  return c.json(state);
});

// Entrer dans le monde PvP (une seule fois) : on arrive avec quelques soldats et un petit pécule.
pvpRoutes.post("/join", async (c) => {
  const player = await requirePlayer(c);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO pvp_players (player_id, coins, stock_at, soldiers, joined_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(player.id, PVP_START_COINS, now, START_SOLDIERS, now)
    .run();
  return c.json({ ok: true });
});

// Envoyer des pièces du monde calme vers le PvP (max 20 %, une fois par jour),
// ou rapatrier des pièces du PvP vers le monde calme (taxe de 25 %).
pvpRoutes.post("/transfer", async (c) => {
  const { id } = await requirePvp(c);
  const body = await c.req.json<{ amount?: unknown; direction?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount < 1) throw new HttpError(400, "Montant invalide");
  const db = c.env.DB;
  const now = Date.now();
  const op = crypto.randomUUID();

  if (body.direction === "in") {
    const cutoff = now - TRANSFER_IN_COOLDOWN_MS;
    const [first] = (await db.batch([
      db
        .prepare(
          `UPDATE pvp_players SET coins = coins + ?1, last_transfer_in = ?2, last_op = ?3
           WHERE player_id = ?4 AND (last_transfer_in IS NULL OR last_transfer_in <= ?5)
             AND EXISTS (SELECT 1 FROM players WHERE id = ?4 AND ?1 <= FLOOR(coins * ${TRANSFER_IN_MAX_SHARE}))`,
        )
        .bind(amount, now, op, id, cutoff),
      db
        .prepare(
          `UPDATE players SET coins = coins - ?1
           WHERE id = ?2 AND EXISTS (SELECT 1 FROM pvp_players WHERE player_id = ?2 AND last_op = ?3)`,
        )
        .bind(amount, id, op),
    ])) as [D1Result, D1Result];
    if (first.meta.changes === 0) {
      throw new HttpError(403, "Transfert refusé : maximum 20 % de tes pièces, une fois par jour");
    }
    return c.json({ ok: true });
  }

  if (body.direction === "out") {
    const received = Math.floor(amount * (1 - TRANSFER_OUT_TAX));
    const [first] = (await db.batch([
      db
        .prepare("UPDATE pvp_players SET coins = coins - ?1, last_op = ?2 WHERE player_id = ?3 AND coins >= ?1")
        .bind(amount, op, id),
      db
        .prepare(
          `UPDATE players SET coins = coins + ?1
           WHERE id = ?2 AND EXISTS (SELECT 1 FROM pvp_players WHERE player_id = ?2 AND last_op = ?3)`,
        )
        .bind(received, id, op),
    ])) as [D1Result, D1Result];
    if (first.meta.changes === 0) throw new HttpError(402, "Pas assez de pièces dans le monde PvP");
    return c.json({ ok: true, received });
  }

  throw new HttpError(400, "Sens du transfert invalide");
});

pvpRoutes.post("/harvest", async (c) => {
  const { id } = await requirePvp(c);
  const db = c.env.DB;
  const now = Date.now();
  const [, stockRow] = await db.batch([
    db.prepare(SETTLE_PVP_SQL).bind(now, id),
    db.prepare("SELECT stock FROM pvp_players WHERE player_id = ?").bind(id),
    db.prepare("UPDATE pvp_players SET coins = coins + stock, stock = 0 WHERE player_id = ?").bind(id),
  ]);
  const harvested = (stockRow?.results[0] as { stock: number } | undefined)?.stock ?? 0;
  return c.json({ harvested });
});

// Acheter une case vide : maison (produit) ou caserne (loge des soldats).
pvpRoutes.post("/cells/:h3/buy", async (c) => {
  const { id } = await requirePvp(c);
  const h3 = parseCell(c.req.param("h3"));
  const body = await c.req.json<{ kind?: unknown }>().catch(() => ({}) as { kind?: unknown });
  const kind: CellKind = isCellKind(body.kind) ? body.kind : "maison";
  const db = c.env.DB;

  const taken = await db.prepare("SELECT 1 FROM cells WHERE world = ? AND h3 = ?").bind(W, h3).first();
  if (taken) throw new HttpError(409, "Cette case est déjà prise");

  const mine = await ownedCells(db, id);
  if (mine.length > 0) {
    const owned = new Set(mine.map((x) => x.h3));
    if (!gridDisk(h3, 1).some((n) => n !== h3 && owned.has(n))) {
      throw new HttpError(403, "Tu ne peux acheter qu'une case voisine d'une des tiennes");
    }
  }

  const locMult = locationMultiplier(h3);
  const price = cellPrice(locMult, mine.length);
  const addedRate = pvpCellRate(kind, locMult, 1);
  const [lat, lng] = cellToLatLng(h3);
  const now = Date.now();
  const op = crypto.randomUUID();
  let inserted: D1Result;
  try {
    [, inserted] = (await db.batch([
      db.prepare(SETTLE_PVP_SQL).bind(now, id),
      db
        .prepare(
          `INSERT INTO cells (world, h3, owner_id, level, loc_mult, invested, is_home, lat, lng, bought_at, last_op, kind)
           SELECT ?, ?, player_id, 1, ?, ?, ?, ?, ?, ?, ?, ? FROM pvp_players WHERE player_id = ? AND coins >= ?`,
        )
        .bind(W, h3, locMult, price, mine.length === 0 ? 1 : 0, lat, lng, now, op, kind, id, price),
      db
        .prepare(
          `UPDATE pvp_players SET coins = coins - ?, rate = rate + ?
           WHERE player_id = ? AND EXISTS (SELECT 1 FROM cells WHERE world = ? AND h3 = ? AND last_op = ?)`,
        )
        .bind(price, addedRate, id, W, h3, op),
    ])) as [D1Result, D1Result, D1Result];
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "Cette case est déjà prise");
    throw err;
  }
  if (inserted.meta.changes === 0) throw new HttpError(402, `Pas assez de pièces PvP (il en faut ${price})`);
  return c.json({ ok: true });
});

pvpRoutes.post("/cells/:h3/upgrade", async (c) => {
  const { id } = await requirePvp(c);
  const h3 = parseCell(c.req.param("h3"));
  const db = c.env.DB;
  const cell = await db
    .prepare("SELECT level, loc_mult, kind FROM cells WHERE world = ? AND h3 = ? AND owner_id = ?")
    .bind(W, h3, id)
    .first<{ level: number; loc_mult: number; kind: CellKind }>();
  if (!cell) throw new HttpError(404, "Cette case ne t'appartient pas");
  if (cell.level >= MAX_LEVEL) throw new HttpError(400, "Niveau maximum atteint");

  const cost = upgradeCost(cell.loc_mult, cell.level);
  const addedRate = pvpCellRate(cell.kind, cell.loc_mult, cell.level + 1) - pvpCellRate(cell.kind, cell.loc_mult, cell.level);
  const now = Date.now();
  const op = crypto.randomUUID();
  const [, upgraded] = (await db.batch([
    db.prepare(SETTLE_PVP_SQL).bind(now, id),
    db
      .prepare(
        `UPDATE cells SET level = level + 1, invested = invested + ?, last_op = ?
         WHERE world = ? AND h3 = ? AND owner_id = ? AND level = ?
           AND EXISTS (SELECT 1 FROM pvp_players WHERE player_id = ? AND coins >= ?)`,
      )
      .bind(cost, op, W, h3, id, cell.level, id, cost),
    db
      .prepare(
        `UPDATE pvp_players SET coins = coins - ?, rate = rate + ?
         WHERE player_id = ? AND EXISTS (SELECT 1 FROM cells WHERE world = ? AND h3 = ? AND last_op = ?)`,
      )
      .bind(cost, addedRate, id, W, h3, op),
  ])) as [D1Result, D1Result, D1Result];
  if (upgraded.meta.changes === 0) throw new HttpError(402, `Pas assez de pièces PvP (il en faut ${cost})`);
  return c.json({ ok: true });
});

// Recruter des soldats : coûte des pièces et du temps, dans la limite des casernes.
pvpRoutes.post("/recruit", async (c) => {
  const { id, row } = await requirePvp(c);
  const body = await c.req.json<{ count?: unknown }>().catch(() => ({}) as { count?: unknown });
  const count = Math.floor(Number(body.count));
  if (!Number.isFinite(count) || count < 1 || count > 10_000) throw new HttpError(400, "Nombre invalide");
  const db = c.env.DB;
  const cap = await capOf(db, id);
  const room = cap - row.soldiers - row.soldiers_away - row.queue_count;
  if (count > room) {
    throw new HttpError(403, room > 0 ? `Tes casernes n'ont plus que ${room} places` : "Tes casernes sont pleines : construis-en d'autres");
  }
  const cost = count * SOLDIER_COST;
  const now = Date.now();
  const res = await db
    .prepare(
      `UPDATE pvp_players
       SET coins = coins - ?1,
           queue_start = CASE WHEN queue_count = 0 THEN ?2 ELSE queue_start END,
           queue_count = queue_count + ?3
       WHERE player_id = ?4 AND coins >= ?1 AND soldiers + soldiers_away + queue_count + ?3 <= ?5`,
    )
    .bind(cost, now, count, id, cap)
    .run();
  if (res.meta.changes === 0) throw new HttpError(402, `Pas assez de pièces PvP (il en faut ${cost})`);
  return c.json({ ok: true });
});

// Monter le rempart : toutes les cases de frontière en profitent.
pvpRoutes.post("/rampart", async (c) => {
  const { id, row } = await requirePvp(c);
  const cost = rampartUpgradeCost(row.rampart);
  if (cost === null) throw new HttpError(400, "Rempart au niveau maximum");
  const res = await c.env.DB.prepare(
    "UPDATE pvp_players SET rampart = rampart + 1, coins = coins - ? WHERE player_id = ? AND rampart = ? AND coins >= ?",
  )
    .bind(cost, id, row.rampart, cost)
    .run();
  if (res.meta.changes === 0) throw new HttpError(402, `Pas assez de pièces PvP (il en faut ${cost})`);
  return c.json({ ok: true });
});

// Lancer une attaque sur une case ennemie voisine. Attaquer fait perdre son propre bouclier.
pvpRoutes.post("/attack", async (c) => {
  const { id } = await requirePvp(c);
  const body = await c.req.json<{ h3?: unknown; soldiers?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const h3 = parseCell(typeof body.h3 === "string" ? body.h3 : "");
  const soldiers = Math.floor(Number(body.soldiers));
  if (!Number.isFinite(soldiers) || soldiers < 1) throw new HttpError(400, "Nombre de soldats invalide");
  const db = c.env.DB;
  const now = Date.now();

  const target = await db
    .prepare("SELECT owner_id, is_home FROM cells WHERE world = ? AND h3 = ?")
    .bind(W, h3)
    .first<{ owner_id: string; is_home: number }>();
  if (!target) throw new HttpError(404, "Cette case est libre : achète-la plutôt");
  if (target.owner_id === id) throw new HttpError(400, "C'est déjà ta case");
  if (target.is_home === 1) throw new HttpError(403, "Une case maison ne peut pas être attaquée");

  const mine = new Set((await ownedCells(db, id)).map((x) => x.h3));
  if (!gridDisk(h3, 1).some((n) => n !== h3 && mine.has(n))) {
    throw new HttpError(403, "Tu ne peux attaquer qu'une case voisine d'une des tiennes");
  }
  const defender = await pvpRow(db, target.owner_id);
  if (defender?.shield_until && defender.shield_until > now) {
    throw new HttpError(403, "Ce joueur est protégé par un bouclier");
  }

  const attackId = crypto.randomUUID();
  const arrivesAt = now + timing(c.env).travelMs;
  let inserted: D1Result;
  try {
    [inserted] = (await db.batch([
      db
        .prepare(
          `INSERT INTO attacks (id, world, h3, attacker_id, defender_id, soldiers, launched_at, arrives_at)
           SELECT ?, ?, ?, player_id, ?, ?, ?, ? FROM pvp_players WHERE player_id = ? AND soldiers >= ?`,
        )
        .bind(attackId, W, h3, target.owner_id, soldiers, now, arrivesAt, id, soldiers),
      db
        .prepare(
          `UPDATE pvp_players SET soldiers = soldiers - ?1, soldiers_away = soldiers_away + ?1, shield_until = NULL
           WHERE player_id = ?2 AND EXISTS (SELECT 1 FROM attacks WHERE id = ?3)`,
        )
        .bind(soldiers, id, attackId),
    ])) as [D1Result, D1Result];
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "Cette case est déjà attaquée");
    throw err;
  }
  if (inserted.meta.changes === 0) throw new HttpError(403, "Tu n'as pas assez de soldats disponibles");
  return c.json({ ok: true, arrivesAt });
});

