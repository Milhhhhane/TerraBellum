import { describe, expect, it } from "vitest";
import { latLngToCell } from "h3-js";
import {
  H3_RES,
  STOCK_CAP_MINUTES,
  cellPrice,
  cellRate,
  isInOpenZone,
  locationMultiplier,
  pendingStock,
  upgradeCost,
} from "../src/shared/economy";

const notreDame = latLngToCell(48.8534, 2.3488, H3_RES);
const fontainebleau = latLngToCell(48.4047, 2.7016, H3_RES);
const lyon = latLngToCell(45.764, 4.8357, H3_RES);

describe("multiplicateur de lieu", () => {
  it("vaut presque 10 au centre de Paris et presque 1 loin de Paris", () => {
    expect(locationMultiplier(notreDame)).toBeGreaterThan(9.5);
    expect(locationMultiplier(fontainebleau)).toBeLessThan(1.1);
  });
});

describe("prix", () => {
  it("une case coûte plus cher en ville", () => {
    expect(cellPrice(locationMultiplier(notreDame), 0)).toBeGreaterThan(
      cellPrice(locationMultiplier(fontainebleau), 0),
    );
  });

  it("chaque case supplémentaire coûte plus cher", () => {
    expect(cellPrice(1, 5)).toBeGreaterThan(cellPrice(1, 4));
  });

  it("chaque étage coûte plus cher que le précédent", () => {
    expect(upgradeCost(1, 3)).toBeGreaterThan(upgradeCost(1, 2));
    expect(upgradeCost(1, 2)).toBeGreaterThan(upgradeCost(1, 1));
  });

  it("un joueur qui démarre avec 500 pièces peut s'installer en banlieue, pas au centre", () => {
    expect(cellPrice(locationMultiplier(fontainebleau), 0)).toBeLessThanOrEqual(500);
    expect(cellPrice(locationMultiplier(notreDame), 0)).toBeGreaterThan(500);
  });
});

describe("stock calculé à la demande", () => {
  it("se remplit avec le temps", () => {
    const p = { stock: 0, stockAt: 0, rate: 2 };
    expect(pendingStock(p, 10 * 60000)).toBe(20);
  });

  it("plafonne au bout de STOCK_CAP_MINUTES", () => {
    const p = { stock: 0, stockAt: 0, rate: 2 };
    expect(pendingStock(p, 10_000 * 60000)).toBe(2 * STOCK_CAP_MINUTES);
  });

  it("ne produit rien sans case", () => {
    expect(pendingStock({ stock: 0, stockAt: 0, rate: 0 }, 60000)).toBe(0);
  });

  it("une amélioration augmente la production", () => {
    expect(cellRate(2, 2)).toBeGreaterThan(cellRate(2, 1));
  });
});

describe("zone ouverte", () => {
  it("contient Paris, pas Lyon", () => {
    expect(isInOpenZone(notreDame)).toBe(true);
    expect(isInOpenZone(lyon)).toBe(false);
  });
});
