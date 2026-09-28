/**
 * Règles du monde PvP. Partagées entre le client (affichage) et le Worker (décision).
 * Tous les chiffres d'équilibrage sont ici.
 */

import { gridDisk } from "h3-js";
import { cellRate } from "./economy";

export const PVP_WORLD = "pvp";

/** Le monde PvP rapporte plus que le monde calme : c'est la contrepartie du risque. */
export const PVP_RATE_MULT = 2;

/** Pécule offert en entrant dans le monde PvP, de quoi acheter une première case. */
export const PVP_START_COINS = 300;

// ---------- Transferts entre mondes ----------
/** On peut envoyer au maximum cette part de ses pièces du monde calme vers le PvP... */
export const TRANSFER_IN_MAX_SHARE = 0.2;
/** ...une fois par période. */
export const TRANSFER_IN_COOLDOWN_MS = 24 * 3600 * 1000;
/** Rapatrier des pièces du PvP vers le monde calme coûte cette taxe. */
export const TRANSFER_OUT_TAX = 0.25;

// ---------- Armée ----------
export const START_SOLDIERS = 20;
/** Capacité de base, sans caserne. */
export const BASE_ARMY_CAP = 20;
/** Places ajoutées par une caserne, selon son niveau (1 à 4). */
export const BARRACKS_CAPACITY = [50, 120, 250, 500] as const;
export const SOLDIER_COST = 10;
export const RECRUIT_MS_PER_SOLDIER = 30 * 1000;

// ---------- Attaque et défense ----------
export const ATTACK_TRAVEL_MS = 60 * 60 * 1000;
/** Défense propre à chaque case (les habitants se défendent), + par étage du bâtiment. */
export const MILITIA_BASE = 5;
export const MILITIA_PER_LEVEL = 5;
/** Bonus de défense par niveau de rempart (+25 % par niveau). */
export const RAMPART_BONUS_PER_LEVEL = 0.25;
/** Coût pour atteindre chaque niveau de rempart (1 à 5). */
export const RAMPART_COSTS = [500, 2000, 6000, 15000, 40000] as const;
export const MAX_RAMPART = RAMPART_COSTS.length;
/** Bonus si la case attaquée est une caserne ou touche une caserne du défenseur. */
export const BARRACKS_DEFENSE_BONUS = 1.25;
/** Part du stock non récolté du défenseur volée en cas de victoire. */
export const PILLAGE_SHARE = 0.3;
/** Part de la valeur investie dans la case rendue au défenseur qui la perd. */
export const LOSS_COMPENSATION = 0.25;

// ---------- Bouclier ----------
export const SHIELD_MS = 24 * 3600 * 1000;
export const LOSS_WINDOW_MS = 24 * 3600 * 1000;
/** Le bouclier s'active après avoir perdu au moins 20 % de son territoire en 24 h (et au moins 2 cases). */
export const SHIELD_LOSS_SHARE = 0.2;
export const SHIELD_MIN_LOSSES = 2;

export type CellKind = "maison" | "caserne";

export function isCellKind(v: unknown): v is CellKind {
  return v === "maison" || v === "caserne";
}

/** Production d'une case PvP (une caserne ne produit rien). */
export function pvpCellRate(kind: CellKind, locMult: number, level: number): number {
  return kind === "caserne" ? 0 : cellRate(locMult, level) * PVP_RATE_MULT;
}

export function barracksCapacity(level: number): number {
  return BARRACKS_CAPACITY[Math.min(level, BARRACKS_CAPACITY.length) - 1] ?? 0;
}

export function armyCap(barracksLevels: number[]): number {
  return BASE_ARMY_CAP + barracksLevels.reduce((sum, lvl) => sum + barracksCapacity(lvl), 0);
}

export function rampartMultiplier(level: number): number {
  return 1 + RAMPART_BONUS_PER_LEVEL * level;
}

export function rampartUpgradeCost(currentLevel: number): number | null {
  return RAMPART_COSTS[currentLevel] ?? null;
}

/** Recrues prêtes à l'instant `now` (le recrutement se calcule à la demande, comme la récolte). */
export function readyRecruits(
  queueCount: number,
  queueStart: number,
  now: number,
  msPerSoldier: number = RECRUIT_MS_PER_SOLDIER,
): number {
  if (queueCount <= 0) return 0;
  return Math.min(queueCount, Math.floor(Math.max(0, now - queueStart) / msPerSoldier));
}

/**
 * Cases de frontière : celles qui touchent au moins une case qui n'est pas au joueur.
 * Seules elles peuvent être attaquées, donc seules elles se partagent l'armée.
 */
export function frontierCells(owned: Set<string>): string[] {
  return [...owned].filter((h) => gridDisk(h, 1).some((n) => n !== h && !owned.has(n)));
}

export interface DefenseInput {
  /** Soldiers du défenseur présents (pas partis en attaque). */
  soldiersHome: number;
  frontierCount: number;
  targetLevel: number;
  rampartLevel: number;
  /** La case attaquée est une caserne ou touche une caserne du défenseur. */
  nearBarracks: boolean;
}

export interface DefenseBreakdown {
  /** Soldiers du défenseur affectés à cette case (armée ÷ frontière). */
  garrison: number;
  militia: number;
  multiplier: number;
  total: number;
}

export function defenseOf(d: DefenseInput): DefenseBreakdown {
  const garrison = d.soldiersHome / Math.max(1, d.frontierCount);
  const militia = MILITIA_BASE + MILITIA_PER_LEVEL * d.targetLevel;
  const multiplier = rampartMultiplier(d.rampartLevel) * (d.nearBarracks ? BARRACKS_DEFENSE_BONUS : 1);
  return { garrison, militia, multiplier, total: (garrison + militia) * multiplier };
}

export interface BattleResult {
  attackerWins: boolean;
  attackerLosses: number;
  defenderLosses: number;
  defense: number;
}

/**
 * Bataille : puissance d'attaque (soldats envoyés) contre défense de la case.
 * - Victoire : l'attaquant perd l'équivalent de la défense, le défenseur perd la garnison de la case.
 * - Défaite : l'attaquant perd tous ses soldats, le défenseur perd ce qu'il a fallu pour les arrêter.
 */
export function resolveBattle(attackers: number, d: DefenseInput): BattleResult {
  const def = defenseOf(d);
  if (attackers > def.total) {
    return {
      attackerWins: true,
      attackerLosses: Math.min(attackers, Math.round(def.total)),
      defenderLosses: Math.min(d.soldiersHome, Math.round(def.garrison)),
      defense: def.total,
    };
  }
  // Les soldats du défenseur tombés = ce qu'il fallait pour absorber l'attaque, milice comprise.
  const soldierShare = def.garrison / (def.garrison + def.militia || 1);
  return {
    attackerWins: false,
    attackerLosses: attackers,
    defenderLosses: Math.min(d.soldiersHome, Math.round((attackers / def.multiplier) * soldierShare)),
    defense: def.total,
  };
}

/** Le défenseur a-t-il perdu assez de territoire pour mériter un bouclier ? */
export function shieldEarned(lossesInWindow: number, cellsAtWindowStart: number): boolean {
  return lossesInWindow >= Math.max(SHIELD_MIN_LOSSES, Math.ceil(SHIELD_LOSS_SHARE * cellsAtWindowStart));
}
