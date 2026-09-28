/**
 * Routes d'administration : /api/admin/*
 *
 * Accès : joueur connecté, marqué is_admin = 1 dans la base, lié à Google
 * et non suspendu. Chaque action qui modifie quelque chose est inscrite
 * dans la table admin_log.
 */

import { Hono } from "hono";
import type { AdminLogEntry, AdminPlayer, AdminStats } from "../shared/api";
import { HttpError, checkName, findPlayer, isUniqueViolation, type Env } from "./common";

export const adminRoutes = new Hono<Env>();

const MAX_COIN_CHANGE = 1_000_000_000;

adminRoutes.use("*", async (c, next) => {
  const player = await findPlayer(c);
  if (!player) throw new HttpError(401, "Connecte-toi d'abord");
  // Un compte invité (jeton dans un seul navigateur) ne peut jamais être admin.
  if (player.is_admin !== 1 || player.google_sub === null || player.banned_at !== null) {
    throw new HttpError(403, "Accès réservé aux administrateurs");
  }
  c.set("admin", player);
  await next();
});

async function target(db: D1Database, id: string): Promise<{ id: string; name: string }> {
  const row = await db.prepare("SELECT id, name FROM players WHERE id = ?").bind(id).first<{ id: string; name: string }>();
  if (!row) throw new HttpError(404, "Joueur introuvable");
  return row;
}

function logStatement(
  db: D1Database,
  admin: { id: string; name: string },
  action: string,
  t: { id: string; name: string } | null,
  details: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO admin_log (at, admin_id, admin_name, action, target_id, target_name, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(Date.now(), admin.id, admin.name, action, t?.id ?? null, t?.name ?? null, details);
}

async function body<T>(c: { req: { json: <U>() => Promise<U> } }): Promise<Partial<T>> {
  return c.req.json<Partial<T>>().catch(() => ({}));
}

adminRoutes.get("/stats", async (c) => {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM players) AS players,
       (SELECT COUNT(*) FROM players WHERE google_sub IS NOT NULL) AS playersGoogle,
       (SELECT COUNT(*) FROM players WHERE last_seen >= ?) AS activeLast24h,
       (SELECT COUNT(*) FROM players WHERE banned_at IS NOT NULL) AS banned,
       (SELECT COUNT(*) FROM cells) AS cells,
       (SELECT COALESCE(SUM(coins), 0) FROM players) AS totalCoins`,
  )
    .bind(dayAgo)
    .first<AdminStats>();
  return c.json(row);
});

adminRoutes.get("/players", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const sort = c.req.query("sort") === "recent" ? "p.last_seen DESC" : "worth DESC";
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.coins, p.rate, p.google_sub IS NOT NULL AS has_google, p.is_admin,
            p.banned_at, p.ban_reason, p.created_at, p.last_seen,
            COUNT(c.h3) AS cells, p.coins + COALESCE(SUM(c.invested), 0) AS worth
     FROM players p LEFT JOIN cells c ON c.owner_id = p.id
     WHERE p.name LIKE ? ESCAPE '\\'
     GROUP BY p.id
     ORDER BY ${sort}
     LIMIT 100`,
  )
    .bind(like)
    .all<{
      id: string;
      name: string;
      coins: number;
      rate: number;
      has_google: number;
      is_admin: number;
      banned_at: number | null;
      ban_reason: string | null;
      created_at: number;
      last_seen: number;
      cells: number;
      worth: number;
    }>();
  return c.json<AdminPlayer[]>(
    results.map((r) => ({
      id: r.id,
      name: r.name,
      coins: r.coins,
      rate: r.rate,
      cells: r.cells,
      worth: r.worth,
      hasGoogle: r.has_google === 1,
      isAdmin: r.is_admin === 1,
      bannedAt: r.banned_at,
      banReason: r.ban_reason,
      createdAt: r.created_at,
      lastSeen: r.last_seen,
    })),
  );
});

// Donner (delta > 0) ou retirer (delta < 0) des pièces. Le solde ne descend jamais sous 0.
adminRoutes.post("/players/:id/coins", async (c) => {
  const { delta } = await body<{ delta: unknown }>(c);
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > MAX_COIN_CHANGE) {
    throw new HttpError(400, "Montant invalide");
  }
  const db = c.env.DB;
  const t = await target(db, c.req.param("id"));
  await db.batch([
    db.prepare("UPDATE players SET coins = MAX(0, coins + ?) WHERE id = ?").bind(delta, t.id),
    logStatement(db, c.get("admin"), "pieces", t, `${delta > 0 ? "+" : ""}${delta}`),
  ]);
  return c.json({ ok: true });
});

adminRoutes.post("/players/:id/rename", async (c) => {
  const { name } = await body<{ name: unknown }>(c);
  const newName = checkName(name);
  const db = c.env.DB;
  const t = await target(db, c.req.param("id"));
  try {
    await db.batch([
      db.prepare("UPDATE players SET name = ? WHERE id = ?").bind(newName, t.id),
      logStatement(db, c.get("admin"), "renommer", t, `${t.name} → ${newName}`),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "Ce pseudo est déjà pris");
    throw err;
  }
  return c.json({ ok: true });
});

// Suspendre : le joueur peut encore se connecter mais ne peut plus jouer, et disparaît du classement.
adminRoutes.post("/players/:id/ban", async (c) => {
  const { reason } = await body<{ reason: unknown }>(c);
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : null;
  const db = c.env.DB;
  const t = await target(db, c.req.param("id"));
  if (t.id === c.get("admin").id) throw new HttpError(400, "Tu ne peux pas te suspendre toi-même");
  await db.batch([
    db.prepare("UPDATE players SET banned_at = ?, ban_reason = ? WHERE id = ?").bind(Date.now(), why, t.id),
    logStatement(db, c.get("admin"), "suspendre", t, why),
  ]);
  return c.json({ ok: true });
});

adminRoutes.post("/players/:id/unban", async (c) => {
  const db = c.env.DB;
  const t = await target(db, c.req.param("id"));
  await db.batch([
    db.prepare("UPDATE players SET banned_at = NULL, ban_reason = NULL WHERE id = ?").bind(t.id),
    logStatement(db, c.get("admin"), "réactiver", t, null),
  ]);
  return c.json({ ok: true });
});

// Supprimer définitivement : sessions, cases (libérées pour les autres) et joueur.
adminRoutes.delete("/players/:id", async (c) => {
  const db = c.env.DB;
  const t = await target(db, c.req.param("id"));
  if (t.id === c.get("admin").id) throw new HttpError(400, "Tu ne peux pas te supprimer toi-même");
  const cells = (await db.prepare("SELECT COUNT(*) AS n FROM cells WHERE owner_id = ?").bind(t.id).first<number>("n")) ?? 0;
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE player_id = ?").bind(t.id),
    db.prepare("DELETE FROM cells WHERE owner_id = ?").bind(t.id),
    db.prepare("DELETE FROM players WHERE id = ?").bind(t.id),
    logStatement(db, c.get("admin"), "supprimer", t, `${cells} case(s) libérée(s)`),
  ]);
  return c.json({ ok: true });
});

adminRoutes.get("/log", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT at, admin_name AS adminName, action, target_name AS targetName, details
     FROM admin_log ORDER BY at DESC LIMIT 100`,
  ).all<AdminLogEntry>();
  return c.json(results);
});
