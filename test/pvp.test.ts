import { describe, expect, it } from "vitest";
import { gridDisk, latLngToCell } from "h3-js";
import { H3_RES, cellRate } from "../src/shared/economy";
import {
  BASE_ARMY_CAP,
  RECRUIT_MS_PER_SOLDIER,
  armyCap,
  defenseOf,
  frontierCells,
  pvpCellRate,
  readyRecruits,
  resolveBattle,
  shieldEarned,
} from "../src/shared/pvp";

const center = latLngToCell(48.7, 2.2, H3_RES);

describe("frontière", () => {
  it("un bloc de 7 cases (centre + 6 voisines) a 6 cases de frontière", () => {
    const blob = new Set(gridDisk(center, 1));
    const frontier = frontierCells(blob);
    expect(frontier).toHaveLength(6);
    expect(frontier).not.toContain(center);
  });

  it("une case seule est entièrement frontière", () => {
    expect(frontierCells(new Set([center]))).toEqual([center]);
  });

  it("un territoire compact a proportionnellement moins de frontière", () => {
    const blob = new Set(gridDisk(center, 2)); // 19 cases
    expect(frontierCells(blob)).toHaveLength(12);
  });
});

describe("armée", () => {
  it("la capacité grandit avec les casernes", () => {
    expect(armyCap([])).toBe(BASE_ARMY_CAP);
    expect(armyCap([1, 2])).toBeGreaterThan(armyCap([1]));
  });

  it("les recrues arrivent une par une avec le temps", () => {
    expect(readyRecruits(10, 0, RECRUIT_MS_PER_SOLDIER * 3.5)).toBe(3);
    expect(readyRecruits(10, 0, RECRUIT_MS_PER_SOLDIER * 100)).toBe(10);
    expect(readyRecruits(0, 0, 1e9)).toBe(0);
  });

  it("une caserne ne produit rien, une maison PvP rapporte le double du monde calme", () => {
    expect(pvpCellRate("caserne", 3, 2)).toBe(0);
    expect(pvpCellRate("maison", 3, 2)).toBe(cellRate(3, 2) * 2);
  });
});

describe("défense", () => {
  const base = { soldiersHome: 60, frontierCount: 6, targetLevel: 1, rampartLevel: 0, nearBarracks: false };

  it("l'armée est diluée sur la frontière", () => {
    expect(defenseOf(base).garrison).toBe(10);
    expect(defenseOf({ ...base, frontierCount: 12 }).garrison).toBe(5);
  });

  it("le rempart et la caserne renforcent la défense", () => {
    const plain = defenseOf(base).total;
    expect(defenseOf({ ...base, rampartLevel: 2 }).total).toBeCloseTo(plain * 1.5);
    expect(defenseOf({ ...base, nearBarracks: true }).total).toBeCloseTo(plain * 1.25);
  });
});

describe("bataille", () => {
  const d = { soldiersHome: 60, frontierCount: 6, targetLevel: 1, rampartLevel: 0, nearBarracks: false };
  // défense = (60/6 + 5 + 5) × 1 = 20

  it("l'attaquant gagne s'il dépasse la défense", () => {
    const r = resolveBattle(30, d);
    expect(r.attackerWins).toBe(true);
    expect(r.attackerLosses).toBe(20);
    expect(r.defenderLosses).toBe(10);
  });

  it("l'attaquant perd tout s'il est trop faible", () => {
    const r = resolveBattle(15, d);
    expect(r.attackerWins).toBe(false);
    expect(r.attackerLosses).toBe(15);
    expect(r.defenderLosses).toBeGreaterThan(0);
    expect(r.defenderLosses).toBeLessThanOrEqual(10);
  });

  it("un défenseur sans soldat ne perd aucun soldat", () => {
    const r = resolveBattle(5, { ...d, soldiersHome: 0 });
    expect(r.defenderLosses).toBe(0);
  });
});

describe("bouclier", () => {
  it("s'active après une vraie perte, pas pour une case isolée", () => {
    expect(shieldEarned(1, 20)).toBe(false);
    expect(shieldEarned(4, 20)).toBe(true);
    expect(shieldEarned(2, 3)).toBe(true);
  });
});
