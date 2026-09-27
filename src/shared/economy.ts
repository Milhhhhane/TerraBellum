/**
 * Règles de l'économie de TerraBellum.
 *
 * Ce fichier est partagé : le client s'en sert pour AFFICHER les prix,
 * le Worker s'en sert pour DÉCIDER. Le serveur reste la seule autorité.
 *
 * Principe clé : rien ne tourne en continu. Chaque joueur a un "stock"
 * de pièces non récoltées, figé à une date (stockAt), et un taux de
 * production (pièces/minute). Le stock actuel se calcule à la demande.
 */

import { cellToLatLng } from "h3-js";

/** Taille des cases H3. Résolution 8 ≈ 0,74 km² par case. Ne pas changer une fois lancé. */
export const H3_RES = 8;

/** Monde de la V1. Le monde PvP viendra plus tard. */
export const DEFAULT_WORLD = "calme";

/** Zone ouverte au lancement : un rectangle autour de l'Île-de-France (approximation). */
export const OPEN_ZONE = { west: 1.44, south: 48.12, east: 3.56, north: 49.24 } as const;

/** Centre de référence pour le prix des cases (parvis de Notre-Dame, point zéro des routes de France). */
export const PRICE_CENTER = { lat: 48.8534, lng: 2.3488 } as const;

export const START_COINS = 500;

/** Le stock se remplit pendant au maximum ce nombre de minutes, puis il plafonne. */
export const STOCK_CAP_MINUTES = 120;

/** Prix de base d'une case vide (multiplié par le lieu et par le nombre de cases déjà possédées). */
export const BASE_CELL_PRICE = 100;

/** Chaque case supplémentaire coûte 15 % plus cher que la précédente (grandir en longueur). */
export const CELL_PRICE_GROWTH = 1.15;

export interface BuildingLevel {
  level: number;
  name: string;
  /** Pièces par minute, avant multiplicateur de lieu. */
  ratePerMin: number;
  /** Coût pour ATTEINDRE ce niveau depuis le précédent, avant multiplicateur (0 pour le niveau 1 : inclus dans l'achat). */
  upgradeCost: number;
}

/** Grandir en hauteur : chaque niveau rapporte beaucoup plus, mais coûte de plus en plus cher. */
export const LEVELS: readonly BuildingLevel[] = [
  { level: 1, name: "Maison", ratePerMin: 1, upgradeCost: 0 },
  { level: 2, name: "Immeuble", ratePerMin: 3, upgradeCost: 300 },
  { level: 3, name: "Tour", ratePerMin: 8, upgradeCost: 1500 },
  { level: 4, name: "Gratte-ciel", ratePerMin: 20, upgradeCost: 8000 },
];

export const MAX_LEVEL = LEVELS.length;

export function levelInfo(level: number): BuildingLevel {
  const info = LEVELS[level - 1];
  if (!info) throw new Error(`Niveau inconnu : ${level}`);
  return info;
}

/** Distance en km entre deux points (formule de haversine). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Multiplicateur de lieu, entre 1 (campagne) et 10 (centre de Paris).
 *
 * V1 : approximation par la distance au centre de Paris.
 * TODO V2 : remplacer par la densité de population INSEE (données carroyées)
 * pour que La Défense ou Saint-Denis valent plus qu'une forêt à la même distance.
 */
export function locationMultiplier(h3: string): number {
  const [lat, lng] = cellToLatLng(h3);
  const d = distanceKm({ lat, lng }, PRICE_CENTER);
  const raw = 1 + 9 * Math.exp(-d / 8);
  return Math.round(raw * 10) / 10;
}

/** Prix d'achat d'une case, selon le lieu et le nombre de cases déjà possédées. */
export function cellPrice(locMult: number, ownedCells: number): number {
  return Math.round(BASE_CELL_PRICE * locMult * CELL_PRICE_GROWTH ** ownedCells);
}

/** Coût pour passer une case du niveau `currentLevel` au suivant. */
export function upgradeCost(locMult: number, currentLevel: number): number {
  const next = levelInfo(currentLevel + 1);
  return Math.round(next.upgradeCost * locMult);
}

/** Production d'une case (pièces/minute). */
export function cellRate(locMult: number, level: number): number {
  return levelInfo(level).ratePerMin * locMult;
}

/** Plafond du stock pour un taux donné. */
export function stockCap(ratePerMin: number): number {
  return ratePerMin * STOCK_CAP_MINUTES;
}

/**
 * Stock disponible à l'instant `now` (ms), calculé à la demande.
 * Même formule que le SQL du Worker (voir SETTLE_SQL dans src/worker/db.ts).
 */
export function pendingStock(p: { stock: number; stockAt: number; rate: number }, now: number): number {
  const minutes = Math.max(0, now - p.stockAt) / 60000;
  return Math.min(stockCap(p.rate), p.stock + p.rate * minutes);
}

/** La case est-elle dans la zone ouverte ? */
export function isInOpenZone(h3: string): boolean {
  const [lat, lng] = cellToLatLng(h3);
  return lat >= OPEN_ZONE.south && lat <= OPEN_ZONE.north && lng >= OPEN_ZONE.west && lng <= OPEN_ZONE.east;
}
