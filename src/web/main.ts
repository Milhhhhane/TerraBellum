import {
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
} from "maplibre-gl";
// MapLibre v6 fait tourner une partie du rendu dans un web worker séparé :
// on demande à Vite de le compiler et on donne son adresse à MapLibre.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Feature, FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { cellToBoundary, cellToLatLng, gridDisk, latLngToCell, polygonToCells } from "h3-js";
import "./style.css";
import { api, pvpApi, ApiRequestError, getToken, type World } from "./api";
import { forgetGoogleChoice, initGoogle, renderGoogleButton } from "./google";
import type { AuthResponse, BattleReport, CellView, MeResponse, PvpState } from "../shared/api";
import {
  H3_RES,
  MAX_LEVEL,
  OPEN_ZONE,
  PRICE_CENTER,
  STOCK_CAP_MINUTES,
  cellPrice,
  cellRate,
  isInOpenZone,
  levelInfo,
  locationMultiplier,
  pendingStock,
  stockCap,
  upgradeCost,
} from "../shared/economy";
import {
  BARRACKS_CAPACITY,
  MAX_RAMPART,
  MILITIA_BASE,
  MILITIA_PER_LEVEL,
  PILLAGE_SHARE,
  SOLDIER_COST,
  TRANSFER_OUT_TAX,
  barracksCapacity,
  pvpCellRate,
  rampartMultiplier,
  rampartUpgradeCost,
  readyRecruits,
} from "../shared/pvp";

/** En dessous de ce zoom, la grille n'est pas affichée (trop de cases). */
const GRID_MIN_ZOOM = 10.5;
const MAX_GRID_CELLS = 8000;
const STOREY_HEIGHT_M = 220;
const PVP_REFRESH_MS = 15000;
const WORLD_KEY = "terrabellum.world";

// ---------- État ----------
let me: MeResponse | null = null;
let clockOffset = 0; // serveur - client, en ms
let selected: string | null = null;
const cellsInView = new Map<string, CellView>();
let world: World = loadWorld();
let pvp: PvpState | null = null;
const seenReports = new Set<string>();
const seenIncoming = new Set<string>();
let pvpPrimed = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.floor(n).toLocaleString("fr-FR");
const now = () => Date.now() + clockOffset;
const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : "Connexion impossible, réessaie.");

function loadWorld(): World {
  try {
    return localStorage.getItem(WORLD_KEY) === "pvp" ? "pvp" : "calme";
  } catch {
    return "calme";
  }
}

/** Ce qu'affiche la barre du haut : le portefeuille du monde affiché. */
function wallet(): { coins: number; stock: number; stockAt: number; rate: number; ownedCells: number } | null {
  return world === "pvp" ? (pvp?.me ?? null) : me;
}

// ---------- Carte ----------
setWorkerUrl(maplibreWorkerUrl);
const pad = 0.15;
const map = new MapLibreMap({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [PRICE_CENTER.lng, PRICE_CENTER.lat],
  zoom: 11.2,
  pitch: 40,
  maxBounds: [
    [OPEN_ZONE.west - pad, OPEN_ZONE.south - pad],
    [OPEN_ZONE.east + pad, OPEN_ZONE.north + pad],
  ] as LngLatBoundsLike,
  attributionControl: { compact: true },
  // La position de la carte est gardée dans l'adresse : on peut la partager ou la retrouver.
  hash: true,
});
map.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");

const emptyFC = (): FeatureCollection => ({ type: "FeatureCollection", features: [] });

function hexFeature(h3: string, properties: Record<string, unknown> = {}): Feature {
  return {
    type: "Feature",
    properties: { h3, ...properties },
    geometry: { type: "Polygon", coordinates: [cellToBoundary(h3, true)] },
  };
}

function setData(source: string, data: FeatureCollection) {
  (map.getSource(source) as GeoJSONSource | undefined)?.setData(data);
}

map.on("load", () => {
  for (const s of ["grid", "owned", "walls", "attacks", "selected"]) map.addSource(s, { type: "geojson", data: emptyFC() });

  map.addLayer({
    id: "grid-line",
    type: "line",
    source: "grid",
    paint: { "line-color": "#3a4150", "line-opacity": 0.28, "line-width": 0.7 },
  });
  map.addLayer({
    id: "attacks-fill",
    type: "fill",
    source: "attacks",
    paint: {
      "fill-color": ["case", ["==", ["get", "dir"], "in"], "#e0352b", "#f08a24"],
      "fill-opacity": 0.3,
    },
  });
  map.addLayer({
    id: "owned-3d",
    type: "fill-extrusion",
    source: "owned",
    paint: {
      "fill-extrusion-color": [
        "case",
        ["get", "mine"],
        ["case", ["get", "home"], "#d9a441", ["==", ["get", "kind"], "caserne"], "#7a5ce0", "#2f6fdb"],
        ["==", ["get", "kind"], "caserne"],
        "#8e2d27",
        "#c2463d",
      ],
      "fill-extrusion-height": ["*", ["get", "level"], STOREY_HEIGHT_M],
      "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 0.82,
    },
  });
  // Mes cases de bordure = mes murs (monde PvP).
  map.addLayer({
    id: "walls-line",
    type: "line",
    source: "walls",
    paint: { "line-color": "#d9a441", "line-width": 2.5, "line-opacity": 0.9 },
  });
  // Plaque de couleur posée sur le toit des cases attaquées, visible même vue de haut.
  map.addLayer({
    id: "attacks-cap",
    type: "fill-extrusion",
    source: "attacks",
    paint: {
      "fill-extrusion-color": ["case", ["==", ["get", "dir"], "in"], "#e0352b", "#f08a24"],
      "fill-extrusion-base": ["*", ["get", "level"], STOREY_HEIGHT_M],
      "fill-extrusion-height": ["+", ["*", ["get", "level"], STOREY_HEIGHT_M], 40],
      "fill-extrusion-opacity": 0.95,
    },
  });
  map.addLayer({
    id: "attacks-line",
    type: "line",
    source: "attacks",
    paint: {
      "line-color": ["case", ["==", ["get", "dir"], "in"], "#e0352b", "#f08a24"],
      "line-width": 4,
      "line-dasharray": [1.5, 1],
    },
  });
  map.addLayer({
    id: "selected-line",
    type: "line",
    source: "selected",
    paint: { "line-color": "#14171c", "line-width": 3 },
  });

  refreshView();
});

map.on("moveend", () => refreshView());

map.on("click", (e) => {
  const h3 = latLngToCell(e.lngLat.lat, e.lngLat.lng, H3_RES);
  select(isInOpenZone(h3) ? h3 : null);
  if (!isInOpenZone(h3)) toast("Cette zone n'est pas encore ouverte.");
});

function viewBounds() {
  const b = map.getBounds();
  return {
    west: Math.max(b.getWest(), OPEN_ZONE.west),
    south: Math.max(b.getSouth(), OPEN_ZONE.south),
    east: Math.min(b.getEast(), OPEN_ZONE.east),
    north: Math.min(b.getNorth(), OPEN_ZONE.north),
  };
}

function drawGrid() {
  if (map.getZoom() < GRID_MIN_ZOOM) {
    setData("grid", emptyFC());
    return;
  }
  const b = viewBounds();
  if (b.west >= b.east || b.south >= b.north) return setData("grid", emptyFC());
  const ring = [
    [b.south, b.west],
    [b.north, b.west],
    [b.north, b.east],
    [b.south, b.east],
    [b.south, b.west],
  ];
  const cells = polygonToCells([ring], H3_RES);
  if (cells.length > MAX_GRID_CELLS) return setData("grid", emptyFC());
  setData("grid", { type: "FeatureCollection", features: cells.map((h) => hexFeature(h)) });
}

/** Case à moi qui touche une case qui n'est pas à moi (d'après les cases chargées). */
function isFrontier(h3: string): boolean {
  return gridDisk(h3, 1).some((n) => n !== h3 && !cellsInView.get(n)?.mine);
}

let cellsRequest = 0;
async function loadOwnedCells() {
  const b = viewBounds();
  if (b.west >= b.east || b.south >= b.north) return;
  const request = ++cellsRequest;
  const w = world;
  try {
    const { cells } = await api.cells(b, w);
    // Une réponse plus récente (ou un changement de monde) est passée entre-temps.
    if (request !== cellsRequest || w !== world) return;
    cellsInView.clear();
    for (const c of cells) cellsInView.set(c.h3, c);
    setData("owned", {
      type: "FeatureCollection",
      features: cells.map((c) =>
        hexFeature(c.h3, { mine: c.mine, home: c.isHome, level: c.level, kind: c.kind, owner: c.ownerName }),
      ),
    });
    setData("walls", {
      type: "FeatureCollection",
      features: w === "pvp" ? cells.filter((c) => c.mine && isFrontier(c.h3)).map((c) => hexFeature(c.h3)) : [],
    });
    drawAttacks();
    if (selected) renderPanel();
  } catch (err) {
    console.error(err);
  }
}

function drawAttacks() {
  const features =
    world === "pvp" && pvp
      ? [
          ...pvp.incoming.map((a) => hexFeature(a.h3, { dir: "in", level: cellsInView.get(a.h3)?.level ?? 0 })),
          ...pvp.outgoing.map((a) => hexFeature(a.h3, { dir: "out", level: cellsInView.get(a.h3)?.level ?? 0 })),
        ]
      : [];
  setData("attacks", { type: "FeatureCollection", features });
}

function refreshView() {
  drawGrid();
  updateHint();
  void loadOwnedCells();
}

function updateHint() {
  const hint = $("hint");
  if (me?.banned) {
    hint.hidden = false;
    hint.textContent = "Ton compte est suspendu : tu peux regarder la carte, mais plus jouer.";
    return;
  }
  let text = "";
  if (map.getZoom() < GRID_MIN_ZOOM) text = "Zoome pour voir les cases.";
  else if (world === "pvp") {
    if (pvp && !pvp.joined) text = "Monde PvP : ici, on peut te prendre tes cases. Clique sur une case pour entrer.";
    else if (pvp?.me && pvp.me.ownedCells === 0)
      text = "Choisis ta première case PvP : ce sera ta case maison, impossible à attaquer.";
  } else if (me && me.ownedCells === 0) {
    text = "Choisis ta première case : ce sera ta case maison. Le centre est trop cher pour démarrer, vise la banlieue.";
  }
  hint.hidden = !text;
  hint.textContent = text;
}

// ---------- Sélection et panneau ----------
function select(h3: string | null) {
  selected = h3;
  setData("selected", h3 ? { type: "FeatureCollection", features: [hexFeature(h3)] } : emptyFC());
  $("panel").hidden = !h3;
  if (h3) renderPanel();
}

$("close-panel").addEventListener("click", () => select(null));

function touchesMyCells(h3: string): boolean {
  return gridDisk(h3, 1).some((n) => n !== h3 && cellsInView.get(n)?.mine);
}

/** Remplace le contenu d'un bloc sans perdre ce que le joueur est en train de taper. */
function rerender(container: HTMLElement, html: string) {
  const values = new Map<string, string>();
  container.querySelectorAll<HTMLInputElement>("input[id]").forEach((i) => values.set(i.id, i.value));
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement.id : null;
  container.innerHTML = html;
  container.querySelectorAll<HTMLInputElement>("input[id]").forEach((i) => {
    const v = values.get(i.id);
    if (v !== undefined) i.value = v;
  });
  if (focused) container.querySelector<HTMLInputElement>(`#${focused}`)?.focus();
}

function renderPanel() {
  if (!selected) return;
  if (world === "pvp") {
    renderPvpPanel(selected);
    return updateCountdowns();
  }
  const h3 = selected;
  const mult = locationMultiplier(h3);
  const cell = cellsInView.get(h3);
  const body = $("panel-body");
  const coins = me?.coins ?? 0;
  const zone = `<p class="small">Valeur du lieu : <strong>×${mult.toFixed(1)}</strong></p>`;

  if (!cell) {
    const owned = me?.ownedCells ?? 0;
    const price = cellPrice(mult, owned);
    const firstCell = owned === 0;
    const reachable = firstCell || touchesMyCells(h3);
    body.innerHTML = `
      <h2>Case libre</h2>
      ${zone}
      <dl>
        <dt>Prix</dt><dd>${fmt(price)} pièces</dd>
        <dt>Rapporte</dt><dd>${cellRate(mult, 1).toFixed(1)} pièces/min (maison)</dd>
      </dl>
      ${firstCell ? `<p class="small">Ta première case devient ta <strong>case maison</strong>.</p>` : ""}
      ${reachable ? "" : `<p class="small warn">Tu ne peux acheter qu'une case voisine d'une des tiennes.</p>`}
      <button class="primary" id="action" ${coins >= price && reachable ? "" : "disabled"}>
        ${coins >= price ? "Acheter" : `Il te manque ${fmt(price - coins)} pièces`}
      </button>`;
    $("action").addEventListener("click", () => act(() => api.buy(h3), "Case achetée !"));
    return;
  }

  const info = levelInfo(cell.level);
  const head = `
    <h2>${info.name}${cell.isHome ? " · case maison" : ""}</h2>
    ${zone}
    <dl>
      <dt>Propriétaire</dt><dd>${escapeHtml(cell.ownerName)}${cell.mine ? " (toi)" : ""}</dd>
      <dt>Étage</dt><dd>${cell.level} / ${MAX_LEVEL}</dd>
      <dt>Rapporte</dt><dd>${cellRate(mult, cell.level).toFixed(1)} pièces/min</dd>
    </dl>`;

  if (!cell.mine) {
    body.innerHTML = head;
    return;
  }
  if (cell.level >= MAX_LEVEL) {
    body.innerHTML = `${head}<p class="small">Niveau maximum atteint.</p>`;
    return;
  }
  const next = levelInfo(cell.level + 1);
  const cost = upgradeCost(mult, cell.level);
  body.innerHTML = `${head}
    <p class="small">Étage suivant : <strong>${next.name}</strong>, ${cellRate(mult, next.level).toFixed(1)} pièces/min.</p>
    <button class="primary" id="action" ${coins >= cost ? "" : "disabled"}>
      ${coins >= cost ? `Construire (${fmt(cost)} pièces)` : `Il te manque ${fmt(cost - coins)} pièces`}
    </button>`;
  $("action").addEventListener("click", () => act(() => api.upgrade(h3), `${next.name} construit !`));
}

async function act(request: () => Promise<MeResponse>, success: string) {
  const button = document.getElementById("action") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  try {
    setMe(await request());
    toast(success);
    await loadOwnedCells();
  } catch (err) {
    toast(errorText(err));
    renderPanel();
  }
}

// ---------- Panneau PvP ----------
function cellTitle(cell: CellView): string {
  return cell.kind === "caserne" ? `Caserne niv. ${cell.level}` : levelInfo(cell.level).name;
}

function availableSoldiers(): number {
  const pm = pvp?.me;
  if (!pvp || !pm) return 0;
  return pm.soldiers + readyRecruits(pm.queueCount, pm.queueStart, now(), pvp.recruitMs);
}

function renderPvpPanel(h3: string) {
  const body = $("panel-body");
  const mult = locationMultiplier(h3);
  const cell = cellsInView.get(h3);
  const zone = `<p class="small">Valeur du lieu : <strong>×${mult.toFixed(1)}</strong></p>`;

  if (!pvp) {
    body.innerHTML = `<h2>Monde PvP</h2><p class="small">Chargement…</p>`;
    return;
  }
  const pm = pvp.me;
  if (!pvp.joined || !pm) {
    body.innerHTML = `
      <h2>Monde PvP</h2>
      <p>Tu n'es pas encore entré dans le monde PvP.</p>
      <button class="primary" id="action">Voir les règles et entrer</button>`;
    $("action").addEventListener("click", openJoin);
    return;
  }
  const coins = pm.coins;
  const missing = (n: number) => `Il te manque ${fmt(n - coins)} pièces PvP`;

  // Case libre : maison ou caserne.
  if (!cell) {
    const price = cellPrice(mult, pm.ownedCells);
    const first = pm.ownedCells === 0;
    const reachable = first || touchesMyCells(h3);
    const canBuy = coins >= price && reachable;
    rerender(
      body,
      `
      <h2>Case libre</h2>
      ${zone}
      <dl>
        <dt>Prix</dt><dd>${fmt(price)} pièces</dd>
        <dt>Maison</dt><dd>${pvpCellRate("maison", mult, 1).toFixed(1)} pièces/min</dd>
        <dt>Caserne</dt><dd>+${BARRACKS_CAPACITY[0]} soldats, défense +25 % autour</dd>
      </dl>
      ${first ? `<p class="small">Ta première case devient ta <strong>case maison</strong> : personne ne peut l'attaquer.</p>` : ""}
      ${reachable ? "" : `<p class="small warn">Tu ne peux acheter qu'une case voisine d'une des tiennes.</p>`}
      ${
        coins < price
          ? `<button class="primary" disabled>${missing(price)}</button>`
          : `<div class="row">
              <button class="primary" id="buy-maison" ${canBuy ? "" : "disabled"}>Maison</button>
              <button class="primary alt" id="buy-caserne" ${canBuy ? "" : "disabled"}>Caserne</button>
            </div>`
      }`,
    );
    document.getElementById("buy-maison")?.addEventListener("click", () =>
      actPvp(() => pvpApi.buy(h3, "maison"), first ? "Case maison posée !" : "Maison achetée !"),
    );
    document.getElementById("buy-caserne")?.addEventListener("click", () =>
      actPvp(() => pvpApi.buy(h3, "caserne"), "Caserne construite !"),
    );
    return;
  }

  const incoming = pvp.incoming.find((a) => a.h3 === h3);
  const outgoing = pvp.outgoing.find((a) => a.h3 === h3);
  const militia = MILITIA_BASE + MILITIA_PER_LEVEL * cell.level;
  const head = `
    <h2>${cellTitle(cell)}${cell.isHome ? " · case maison" : ""}</h2>
    ${zone}
    <dl>
      <dt>Propriétaire</dt><dd>${escapeHtml(cell.ownerName)}${cell.mine ? " (toi)" : ""}</dd>
      <dt>Étage</dt><dd>${cell.level} / ${MAX_LEVEL}</dd>
      ${
        cell.kind === "caserne"
          ? `<dt>Loge</dt><dd>${barracksCapacity(cell.level)} soldats</dd>`
          : `<dt>Rapporte</dt><dd>${pvpCellRate("maison", mult, cell.level).toFixed(1)} pièces/min</dd>`
      }
      <dt>Milice</dt><dd>${militia} défenseurs</dd>
    </dl>`;

  // Ma case.
  if (cell.mine) {
    let notes = "";
    if (cell.isHome) notes += `<p class="small">🏠 Case maison : impossible à attaquer.</p>`;
    else if (isFrontier(h3))
      notes += `<p class="small">🧱 Case de bordure : c'est un <strong>mur</strong>, ton armée et ton rempart la défendent.</p>`;
    else notes += `<p class="small">Case intérieure : à l'abri tant que la bordure tient.</p>`;
    if (incoming) {
      notes += `<p class="alert">⚠ <strong>${escapeHtml(incoming.attackerName)}</strong> arrive avec ${fmt(incoming.soldiers)} soldats dans <span data-until="${incoming.arrivesAt}"></span>. Recrute ou monte ton rempart !</p>`;
    }
    let action = `<p class="small">Niveau maximum atteint.</p>`;
    if (cell.level < MAX_LEVEL) {
      const cost = upgradeCost(mult, cell.level);
      const gain =
        cell.kind === "caserne"
          ? `+${barracksCapacity(cell.level + 1) - barracksCapacity(cell.level)} places`
          : `${pvpCellRate("maison", mult, cell.level + 1).toFixed(1)} pièces/min`;
      action = `
        <p class="small">Étage suivant : ${gain}, +${MILITIA_PER_LEVEL} milice.</p>
        <button class="primary" id="action" ${coins >= cost ? "" : "disabled"}>
          ${coins >= cost ? `Construire (${fmt(cost)} pièces)` : missing(cost)}
        </button>`;
    }
    body.innerHTML = head + notes + action;
    document.getElementById("action")?.addEventListener("click", () =>
      actPvp(() => pvpApi.upgrade(h3), "Étage construit !"),
    );
    return;
  }

  // Case ennemie.
  if (cell.isHome) {
    body.innerHTML = `${head}<p class="small">🏠 Case maison de ${escapeHtml(cell.ownerName)} : intouchable.</p>`;
    return;
  }
  if (outgoing) {
    body.innerHTML = `${head}<p class="alert out">⚔ Tes ${fmt(outgoing.soldiers)} soldats arrivent dans <span data-until="${outgoing.arrivesAt}"></span>.</p>`;
    return;
  }
  if (!touchesMyCells(h3)) {
    body.innerHTML = `${head}<p class="small">Pour attaquer, il te faut une case voisine de celle-ci.</p>`;
    return;
  }
  const avail = availableSoldiers();
  rerender(
    body,
    `${head}
    <p class="small">Sa défense : la milice + une part de son armée, × son rempart. Tu ne vois pas son armée : envoie large.</p>
    <label class="field" for="attack-count">Soldats à envoyer <span class="muted-text">(${fmt(avail)} dispo)</span></label>
    <input id="attack-count" type="number" min="1" max="${avail}" value="${avail}" inputmode="numeric" />
    ${pm.shieldUntil ? `<p class="small warn">Attaquer retire ton bouclier.</p>` : ""}
    <button class="primary danger-fill" id="action" ${avail > 0 ? "" : "disabled"}>
      ${avail > 0 ? `Attaquer (trajet : ${fmtDuration(pvp.travelMs)})` : "Aucun soldat disponible"}
    </button>`,
  );
  document.getElementById("action")?.addEventListener("click", () => {
    const n = Math.floor(Number($<HTMLInputElement>("attack-count").value));
    if (!(n >= 1)) return toast("Indique un nombre de soldats.");
    void actPvp(() => pvpApi.attack(h3, n), `Attaque lancée : ${fmt(n)} soldats en route`);
  });
}

async function actPvp(request: () => Promise<unknown>, success: string) {
  document.querySelectorAll<HTMLButtonElement>("#panel-body button, #army-body button").forEach((b) => (b.disabled = true));
  try {
    await request();
    toast(success);
    await refreshPvp(true);
  } catch (err) {
    toast(errorText(err));
    renderPanel();
    renderArmy();
  }
}

// ---------- État PvP ----------
let pvpTimer: number | undefined;

function reportText(r: BattleReport, html = true): string {
  const who = html ? escapeHtml(r.opponentName) : r.opponentName;
  if (r.result === "annulée")
    return r.role === "attaque" ? `Attaque sur ${who} annulée : tes soldats sont rentrés.` : `L'attaque de ${who} a été annulée.`;
  if (r.role === "attaque") {
    return r.result === "victoire"
      ? `Victoire contre ${who} : case prise${r.pillage >= 1 ? `, ${fmt(r.pillage)} pièces pillées` : ""}. Pertes : ${fmt(r.attackerLosses)}.`
      : `Défaite contre ${who} : tes ${fmt(r.soldiers)} soldats sont tombés.`;
  }
  return r.result === "victoire"
    ? `${who} t'a pris une case${r.pillage >= 1 ? ` et pillé ${fmt(r.pillage)} pièces` : ""}. Pertes : ${fmt(r.defenderLosses)}.`
    : `Tu as repoussé ${who} ! Pertes : ${fmt(r.defenderLosses)}.`;
}

function reportClass(r: BattleReport): string {
  if (r.result === "annulée") return "neutral";
  const won = (r.role === "attaque") === (r.result === "victoire");
  return won ? "good" : "bad";
}

function attackKey(s: PvpState | null): string {
  return s ? [...s.incoming, ...s.outgoing].map((a) => a.id).join(",") : "";
}

async function refreshPvp(forceCells = false) {
  window.clearTimeout(pvpTimer);
  if (!me || world !== "pvp") return;
  try {
    const next = await pvpApi.state();
    if (world !== "pvp") return;
    clockOffset = next.serverNow - Date.now();
    const newReports = next.reports.filter((r) => !seenReports.has(r.id));
    const newIncoming = next.incoming.filter((a) => !seenIncoming.has(a.id));
    const changed =
      forceCells || !pvp || newReports.length > 0 || attackKey(pvp) !== attackKey(next) || pvp.joined !== next.joined;
    for (const r of next.reports) seenReports.add(r.id);
    for (const a of next.incoming) seenIncoming.add(a.id);
    pvp = next;

    // Pas d'alerte pour ce qui existait déjà au premier chargement.
    if (pvpPrimed) {
      const [a] = newIncoming;
      const [r] = newReports;
      if (a) {
        toast(`⚠ ${a.attackerName} t'attaque avec ${fmt(a.soldiers)} soldats ! Arrivée dans ${fmtDuration(a.arrivesAt - now())}.`);
      } else if (r) toast(reportText(r, false));
    }
    pvpPrimed = true;

    updateArmyButton();
    tick();
    updateHint();
    renderArmy();
    if (changed) await loadOwnedCells();
    else if (selected) renderPanel();
  } catch (err) {
    console.error(err);
  } finally {
    schedulePvpRefresh();
  }
}

/** Prochain rafraîchissement : toutes les 15 s, ou juste après l'arrivée d'une attaque. */
function schedulePvpRefresh() {
  window.clearTimeout(pvpTimer);
  if (world !== "pvp" || !me) return;
  let delay = PVP_REFRESH_MS;
  for (const a of [...(pvp?.incoming ?? []), ...(pvp?.outgoing ?? [])]) {
    const d = a.arrivesAt - now() + 1500;
    if (d > 0) delay = Math.min(delay, d);
  }
  pvpTimer = window.setTimeout(() => {
    if (document.hidden) schedulePvpRefresh();
    else void refreshPvp();
  }, Math.max(1000, delay));
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && world === "pvp") void refreshPvp();
});

function updateArmyButton() {
  const pm = pvp?.me;
  $("army-count").textContent = pm ? `${fmt(availableSoldiers())}/${fmt(pm.armyCap)}` : "—";
  $("army-alert").hidden = !pvp?.incoming.length;
}

// ---------- Monde ----------
function applyWorldUi() {
  document.body.dataset.world = world;
  document.querySelectorAll<HTMLButtonElement>(".world-switch button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.world === world));
  });
  $("open-army").hidden = world !== "pvp";
  $("coins-label").textContent = world === "pvp" ? "Pièces ⚔" : "Pièces";
}

function setWorld(next: World) {
  if (next === world) return;
  world = next;
  try {
    localStorage.setItem(WORLD_KEY, next);
  } catch {
    /* pas grave : le choix ne sera pas retenu */
  }
  applyWorldUi();
  cellsInView.clear();
  for (const s of ["owned", "walls", "attacks"]) setData(s, emptyFC());
  select(null);
  tick();
  updateHint();
  void loadOwnedCells();
  if (world === "pvp") {
    void refreshPvp().then(() => {
      if (pvp && !pvp.joined) openJoin();
    });
  } else {
    window.clearTimeout(pvpTimer);
  }
}

document.querySelectorAll<HTMLButtonElement>(".world-switch button").forEach((b) =>
  b.addEventListener("click", () => setWorld(b.dataset.world === "pvp" ? "pvp" : "calme")),
);
applyWorldUi();

// Entrée dans le monde PvP.
function openJoin() {
  $<HTMLDialogElement>("pvp-join").showModal();
}
$("close-pvp-join").addEventListener("click", () => $<HTMLDialogElement>("pvp-join").close());
$("pvp-join-btn").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("pvp-join-btn");
  button.disabled = true;
  try {
    await pvpApi.join();
    $<HTMLDialogElement>("pvp-join").close();
    await refreshPvp(true);
    toast("Bienvenue dans le monde PvP ! Choisis ta case maison.");
  } catch (err) {
    toast(errorText(err));
  } finally {
    button.disabled = false;
  }
});

// ---------- Armée ----------
const armyDialog = $<HTMLDialogElement>("army");
let armyRenderedReady = -1;

$("open-army").addEventListener("click", () => {
  if (!pvp?.joined) return openJoin();
  renderArmy(true);
  armyDialog.showModal();
});
$("close-army").addEventListener("click", () => armyDialog.close());

function renderArmy(force = false) {
  if (!force && !armyDialog.open) return;
  const pm = pvp?.me;
  const body = $("army-body");
  if (!pvp || !pm) {
    body.innerHTML = `<p class="small">Chargement…</p>`;
    return;
  }
  const t = now();
  const ready = readyRecruits(pm.queueCount, pm.queueStart, t, pvp.recruitMs);
  armyRenderedReady = ready;
  const avail = pm.soldiers + ready;
  const training = pm.queueCount - ready;
  const room = Math.max(0, pm.armyCap - avail - pm.soldiersAway - training);
  const perWall = pm.frontierCells > 0 ? avail / pm.frontierCells : 0;
  const rampartCost = rampartUpgradeCost(pm.rampart);
  const canTransferIn = pvp.transferInAvailableAt <= t;

  const attackRow = (a: PvpState["incoming"][number], dir: "in" | "out") => `
    <li class="attack ${dir}" data-h3="${a.h3}">
      <span>${dir === "in" ? `⚠ ${escapeHtml(a.attackerName)}` : `⚔ vers ${escapeHtml(a.defenderName)}`} · ${fmt(a.soldiers)} soldats</span>
      <span data-until="${a.arrivesAt}"></span>
    </li>`;

  rerender(
    body,
    `
    <div class="army-grid">
      <div><span class="stat-label">Disponibles</span><strong>${fmt(avail)}</strong></div>
      <div><span class="stat-label">En attaque</span><strong>${fmt(pm.soldiersAway)}</strong></div>
      <div><span class="stat-label">En formation</span><strong>${fmt(training)}</strong>
        ${training > 0 ? `<span class="small">prochain : <span data-until="${pm.queueStart + (ready + 1) * pvp.recruitMs}"></span></span>` : ""}</div>
      <div><span class="stat-label">Capacité</span><strong>${fmt(pm.armyCap)}</strong></div>
    </div>
    <p class="small">${pm.frontierCells} mur${pm.frontierCells > 1 ? "s" : ""} à défendre : ≈ ${perWall.toFixed(1)} soldat${perWall >= 2 ? "s" : ""} par mur, plus la milice de chaque case.</p>
    ${pm.shieldUntil ? `<p class="alert shield">🛡 Bouclier actif encore <span data-until="${pm.shieldUntil}"></span>. Attaquer le retire.</p>` : ""}

    ${
      pvp.incoming.length || pvp.outgoing.length
        ? `<h3>Attaques en cours</h3><ul class="attack-list">${pvp.incoming.map((a) => attackRow(a, "in")).join("")}${pvp.outgoing.map((a) => attackRow(a, "out")).join("")}</ul>`
        : ""
    }

    <h3>Recruter</h3>
    <p class="small">${SOLDIER_COST} pièces et ${fmtDuration(pvp.recruitMs)} par soldat. ${
      room > 0 ? `Place pour ${fmt(room)} de plus.` : `Casernes pleines : construis une caserne (+${BARRACKS_CAPACITY[0]} places).`
    }</p>
    <div class="row">
      <input id="recruit-count" type="number" min="1" max="${room}" value="${Math.min(room, 10) || ""}" inputmode="numeric" ${room > 0 ? "" : "disabled"} />
      <button class="primary" id="recruit-btn" ${room > 0 ? "" : "disabled"}>Recruter</button>
    </div>

    <h3>Rempart · niveau ${pm.rampart}/${MAX_RAMPART}</h3>
    <p class="small">Tous tes murs se défendent ×${rampartMultiplier(pm.rampart).toFixed(2)}.</p>
    ${
      rampartCost === null
        ? `<p class="small">Niveau maximum.</p>`
        : `<button class="primary" id="rampart-btn" ${pm.coins >= rampartCost ? "" : "disabled"}>
            Niveau ${pm.rampart + 1} → ×${rampartMultiplier(pm.rampart + 1).toFixed(2)} (${fmt(rampartCost)} pièces)
          </button>`
    }

    <h3>Pièces entre les mondes</h3>
    <p class="small">Du monde calme vers le PvP : 20 % max, une fois par jour ${
      canTransferIn ? `(jusqu'à <strong>${fmt(pvp.transferInMax)}</strong> maintenant).` : `(prochain envoi dans <span data-until="${pvp.transferInAvailableAt}"></span>).`
    }</p>
    <div class="row">
      <input id="transfer-in" type="number" min="1" max="${pvp.transferInMax}" placeholder="Montant" inputmode="numeric" ${canTransferIn && pvp.transferInMax > 0 ? "" : "disabled"} />
      <button class="ghost" id="transfer-in-btn" ${canTransferIn && pvp.transferInMax > 0 ? "" : "disabled"}>Envoyer</button>
    </div>
    <p class="small">Du PvP vers le monde calme : taxe de ${Math.round(TRANSFER_OUT_TAX * 100)} %.</p>
    <div class="row">
      <input id="transfer-out" type="number" min="1" max="${Math.floor(pm.coins)}" placeholder="Montant" inputmode="numeric" />
      <button class="ghost" id="transfer-out-btn">Rapatrier</button>
    </div>

    <h3>Rapports de bataille</h3>
    ${
      pvp.reports.length
        ? `<ul class="report-list">${pvp.reports
            .map(
              (r) =>
                `<li class="${reportClass(r)}" data-h3="${r.h3}"><span>${reportText(r)}</span><span class="muted-text">${timeAgo(r.at)}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="small">Aucune bataille pour l'instant. Récolte souvent : un attaquant qui gagne pille ${Math.round(PILLAGE_SHARE * 100)} % de ton stock.</p>`
    }`,
  );

  updateCountdowns();
  body.querySelectorAll<HTMLElement>("[data-h3]").forEach((el) => el.addEventListener("click", () => flyTo(el.dataset.h3!)));
  document.getElementById("recruit-btn")?.addEventListener("click", () => {
    const n = Math.floor(Number($<HTMLInputElement>("recruit-count").value));
    if (!(n >= 1)) return toast("Indique un nombre de soldats.");
    void actPvp(() => pvpApi.recruit(n), `${fmt(n)} recrue${n > 1 ? "s" : ""} en formation`);
  });
  document.getElementById("rampart-btn")?.addEventListener("click", () =>
    actPvp(() => pvpApi.rampart(), `Rempart niveau ${pm.rampart + 1} !`),
  );
  document.getElementById("transfer-in-btn")?.addEventListener("click", () => {
    const n = Math.floor(Number($<HTMLInputElement>("transfer-in").value));
    if (!(n >= 1)) return toast("Indique un montant.");
    void actPvp(async () => {
      await pvpApi.transfer(n, "in");
      setMe(await api.me());
    }, `${fmt(n)} pièces envoyées dans le monde PvP`);
  });
  document.getElementById("transfer-out-btn")?.addEventListener("click", () => {
    const n = Math.floor(Number($<HTMLInputElement>("transfer-out").value));
    if (!(n >= 1)) return toast("Indique un montant.");
    void (async () => {
      let received = 0;
      await actPvp(async () => {
        received = (await pvpApi.transfer(n, "out")).received ?? 0;
        setMe(await api.me());
      }, "Transfert effectué");
      if (received) toast(`${fmt(received)} pièces arrivées dans le monde calme (taxe de ${fmt(n - received)}).`);
    })();
  });
}

function flyTo(h3: string) {
  const [lat, lng] = cellToLatLng(h3);
  armyDialog.close();
  map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 13) });
  select(h3);
}

// ---------- Barre du haut ----------
function setMe(next: MeResponse) {
  const switchedPlayer = me?.id !== next.id;
  me = next;
  clockOffset = next.serverNow - Date.now();
  $("stats").hidden = false;
  $("open-account").hidden = false;
  $("map-controls").hidden = false;
  $("account-name").textContent = next.name;
  $("account-warn").hidden = next.hasGoogle;
  tick();
  updateHint();
  // Changement de joueur : "mes cases" ne sont plus les mêmes.
  if (switchedPlayer) {
    pvp = null;
    pvpPrimed = false;
    seenReports.clear();
    seenIncoming.clear();
    void loadOwnedCells();
    if (world === "pvp") void refreshPvp();
  }
}

function tick() {
  const w = wallet();
  if (w) {
    const stock = pendingStock(w, now());
    const cap = stockCap(w.rate);
    $("coins").textContent = fmt(w.coins);
    $("rate").textContent = w.rate.toFixed(1);
    $("stock").textContent = fmt(stock);
    $<HTMLSpanElement>("stock-fill").style.width = cap > 0 ? `${Math.min(100, (stock / cap) * 100)}%` : "0%";
    $<HTMLButtonElement>("harvest").disabled = stock < 1;
    $("harvest").title =
      cap > 0
        ? `Le stock plafonne à ${fmt(cap)} pièces (${STOCK_CAP_MINUTES} min de production).`
        : "Achète une case pour produire.";
  } else if (me) {
    // Monde PvP pas encore rejoint.
    $("coins").textContent = "—";
    $("rate").textContent = "0";
    $("stock").textContent = "0";
    $<HTMLSpanElement>("stock-fill").style.width = "0%";
    $<HTMLButtonElement>("harvest").disabled = true;
  }

  updateCountdowns();
  const t = now();

  if (world === "pvp" && pvp?.me) {
    updateArmyButton();
    // Une recrue vient de finir sa formation : on met la fenêtre à jour.
    const pm = pvp.me;
    if (armyDialog.open && readyRecruits(pm.queueCount, pm.queueStart, t, pvp.recruitMs) !== armyRenderedReady) renderArmy();
  }
}
setInterval(tick, 1000);

$("harvest").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("harvest");
  button.disabled = true;
  try {
    if (world === "pvp") {
      const { harvested } = await pvpApi.harvest();
      await refreshPvp();
      toast(`+${fmt(harvested)} pièces PvP`);
    } else {
      const { harvested, me: next } = await api.harvest();
      setMe(next);
      toast(`+${fmt(harvested)} pièces`);
    }
    if (selected) renderPanel();
  } catch (err) {
    toast(errorText(err));
  } finally {
    tick();
  }
});

// ---------- Classement ----------
$("open-leaderboard").addEventListener("click", async () => {
  const list = $("leaderboard-list");
  const w = world;
  $("leaderboard-title").textContent = w === "pvp" ? "⚔ Classement PvP" : "Les plus riches";
  list.innerHTML = "<li>Chargement…</li>";
  $<HTMLDialogElement>("leaderboard").showModal();
  try {
    const rows = await api.leaderboard(w);
    list.innerHTML = rows.length
      ? rows
          .map(
            (r) =>
              `<li class="${r.name === me?.name ? "me" : ""}"><span>${escapeHtml(r.name)}</span><span>${fmt(r.worth)} · ${r.cells} case${r.cells > 1 ? "s" : ""}</span></li>`,
          )
          .join("")
      : "<li>Personne pour l'instant.</li>";
  } catch {
    list.innerHTML = "<li>Impossible de charger le classement.</li>";
  }
});
$("close-leaderboard").addEventListener("click", () => $<HTMLDialogElement>("leaderboard").close());

// ---------- Inscription et connexion ----------
const signup = $<HTMLDialogElement>("signup");
/** Jeton Google en attente quand un nouveau joueur Google doit choisir son pseudo. */
let pendingCredential: string | null = null;
let googleEnabled = false;

function showSignupError(err: unknown) {
  const error = $("signup-error");
  error.textContent = errorText(err);
  error.hidden = false;
}

/** Applique une réponse de connexion ; renvoie false s'il faut encore choisir un pseudo. */
function applyAuth(res: AuthResponse): boolean {
  if ("needsName" in res) return false;
  setMe(res.me);
  return true;
}

function askNameForGoogle(credential: string) {
  pendingCredential = credential;
  $("signup-intro").textContent = "Dernière étape : choisis ton pseudo. C'est lui que les autres joueurs verront.";
  $("google-block").hidden = true;
  $("guest-warning").hidden = true;
  $("signup-submit").textContent = "Commencer";
  $("signup-error").hidden = true;
  $<HTMLDialogElement>("account").close();
  if (!signup.open) signup.showModal();
  $<HTMLInputElement>("pseudo").focus();
}

/** Appelé par Google après chaque connexion réussie, depuis l'inscription OU depuis "Lier Google". */
async function onGoogleCredential(credential: string) {
  const wasGuest = !!me && !me.hasGoogle;
  try {
    const res = await api.google(credential);
    if (!applyAuth(res)) return askNameForGoogle(credential);
    signup.close();
    $<HTMLDialogElement>("account").close();
    toast(wasGuest && me?.hasGoogle ? "Compte lié à Google ✓" : `Connecté : ${me?.name}`);
  } catch (err) {
    if (signup.open) showSignupError(err);
    else toast(errorText(err));
  }
}

$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("signup-error").hidden = true;
  const name = $<HTMLInputElement>("pseudo").value.trim();
  try {
    const res = pendingCredential ? await api.google(pendingCredential, name) : await api.createGuest(name);
    if (applyAuth(res)) {
      pendingCredential = null;
      signup.close();
    }
  } catch (err) {
    // Le jeton Google expire au bout d'une heure : on repropose le bouton.
    if (pendingCredential && err instanceof ApiRequestError && err.status === 401) resetSignup();
    showSignupError(err);
  }
});

function resetSignup() {
  pendingCredential = null;
  $("signup-intro").textContent =
    "Achète des cases sur la vraie carte, construis en hauteur, deviens le plus riche de l'Île-de-France.";
  $("google-block").hidden = !googleEnabled;
  $("guest-warning").hidden = false;
  $("signup-submit").textContent = "Jouer en invité";
}

function openSignup() {
  resetSignup();
  signup.showModal();
  if (googleEnabled) void renderGoogleButton($("google-signin"));
}

// Pas de fermeture avec Échap tant qu'on n'a pas de joueur.
signup.addEventListener("cancel", (e) => {
  if (!me) e.preventDefault();
});

// ---------- Compte ----------
$("open-account").addEventListener("click", () => {
  if (!me) return;
  $("account-title").textContent = me.name;
  $("account-guest").hidden = me.hasGoogle;
  $("account-google").hidden = !me.hasGoogle;
  $("admin-link").hidden = !me.isAdmin;
  $("google-unavailable").hidden = googleEnabled;
  $<HTMLDialogElement>("account").showModal();
  if (!me.hasGoogle && googleEnabled) void renderGoogleButton($("google-link"));
});
$("close-account").addEventListener("click", () => $<HTMLDialogElement>("account").close());

$("logout").addEventListener("click", async () => {
  await api.logout();
  await forgetGoogleChoice();
  location.reload();
});

// ---------- Utilitaires ----------
let toastTimer: number | undefined;
function toast(message: string) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 4000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Met à jour tous les comptes à rebours affichés (éléments avec data-until). */
function updateCountdowns() {
  const t = now();
  document.querySelectorAll<HTMLElement>("[data-until]").forEach((el) => {
    const left = Number(el.dataset.until) - t;
    el.textContent = left > 0 ? fmtDuration(left) : "quelques secondes";
  });
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")}`;
  if (m > 0) return `${m} min ${String(sec).padStart(2, "0")}`;
  return `${sec} s`;
}

function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((now() - at) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

// ---------- Démarrage ----------
async function start() {
  const config = await api.config().catch(() => ({ googleClientId: null }));
  if (config.googleClientId) {
    googleEnabled = true;
    initGoogle(config.googleClientId, (credential) => void onGoogleCredential(credential)).catch((err) => {
      console.error(err);
      googleEnabled = false;
      $("google-block").hidden = true;
    });
  }
  if (getToken()) {
    try {
      setMe(await api.me());
      return;
    } catch {
      /* session inconnue : on repasse par l'inscription */
    }
  }
  openSignup();
}
void start();

// Voir les cases des autres joueurs apparaître sans recharger.
setInterval(() => {
  if (!document.hidden) void loadOwnedCells();
}, 30000);
