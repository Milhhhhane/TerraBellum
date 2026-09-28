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
import { cellToBoundary, gridDisk, latLngToCell, polygonToCells } from "h3-js";
import "./style.css";
import { api, ApiRequestError, getToken } from "./api";
import { forgetGoogleChoice, initGoogle, renderGoogleButton } from "./google";
import type { AuthResponse, CellView, MeResponse } from "../shared/api";
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

/** En dessous de ce zoom, la grille n'est pas affichée (trop de cases). */
const GRID_MIN_ZOOM = 10.5;
const MAX_GRID_CELLS = 8000;
const STOREY_HEIGHT_M = 220;

// ---------- État ----------
let me: MeResponse | null = null;
let clockOffset = 0; // serveur - client, en ms
let selected: string | null = null;
const cellsInView = new Map<string, CellView>();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.floor(n).toLocaleString("fr-FR");
const now = () => Date.now() + clockOffset;

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
  map.addSource("grid", { type: "geojson", data: emptyFC() });
  map.addSource("owned", { type: "geojson", data: emptyFC() });
  map.addSource("selected", { type: "geojson", data: emptyFC() });

  map.addLayer({
    id: "grid-line",
    type: "line",
    source: "grid",
    paint: { "line-color": "#3a4150", "line-opacity": 0.28, "line-width": 0.7 },
  });
  map.addLayer({
    id: "owned-3d",
    type: "fill-extrusion",
    source: "owned",
    paint: {
      "fill-extrusion-color": [
        "case",
        ["get", "mine"],
        ["case", ["get", "home"], "#d9a441", "#2f6fdb"],
        "#c2463d",
      ],
      "fill-extrusion-height": ["*", ["get", "level"], STOREY_HEIGHT_M],
      "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 0.82,
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

async function loadOwnedCells() {
  const b = viewBounds();
  if (b.west >= b.east || b.south >= b.north) return;
  try {
    const { cells } = await api.cells(b);
    cellsInView.clear();
    for (const c of cells) cellsInView.set(c.h3, c);
    setData("owned", {
      type: "FeatureCollection",
      features: cells.map((c) =>
        hexFeature(c.h3, { mine: c.mine, home: c.isHome, level: c.level, owner: c.ownerName }),
      ),
    });
    if (selected) renderPanel();
  } catch (err) {
    console.error(err);
  }
}

function refreshView() {
  drawGrid();
  updateHint();
  void loadOwnedCells();
}

function updateHint() {
  const zoomedOut = map.getZoom() < GRID_MIN_ZOOM;
  const noHomeYet = !!me && me.ownedCells === 0;
  const hint = $("hint");
  if (me?.banned) {
    hint.hidden = false;
    hint.textContent = "Ton compte est suspendu : tu peux regarder la carte, mais plus jouer.";
    return;
  }
  hint.hidden = !(zoomedOut || noHomeYet);
  hint.textContent = zoomedOut
    ? "Zoome pour voir les cases."
    : "Choisis ta première case : ce sera ta case maison. Le centre est trop cher pour démarrer, vise la banlieue.";
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

function renderPanel() {
  if (!selected) return;
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
    toast(err instanceof ApiRequestError ? err.message : "Connexion impossible, réessaie.");
    renderPanel();
  }
}

// ---------- Barre du haut ----------
function setMe(next: MeResponse) {
  const switchedPlayer = me?.id !== next.id;
  me = next;
  clockOffset = next.serverNow - Date.now();
  $("stats").hidden = false;
  $("open-account").hidden = false;
  $("account-name").textContent = next.name;
  $("account-warn").hidden = next.hasGoogle;
  tick();
  updateHint();
  // Changement de joueur : "mes cases" ne sont plus les mêmes.
  if (switchedPlayer) void loadOwnedCells();
}

function tick() {
  if (!me) return;
  const stock = pendingStock(me, now());
  const cap = stockCap(me.rate);
  $("coins").textContent = fmt(me.coins);
  $("rate").textContent = me.rate.toFixed(1);
  $("stock").textContent = fmt(stock);
  $<HTMLSpanElement>("stock-fill").style.width = cap > 0 ? `${Math.min(100, (stock / cap) * 100)}%` : "0%";
  $<HTMLButtonElement>("harvest").disabled = stock < 1;
  $("harvest").title =
    cap > 0 ? `Le stock plafonne à ${fmt(cap)} pièces (${STOCK_CAP_MINUTES} min de production).` : "Achète une case pour produire.";
}
setInterval(tick, 1000);

$("harvest").addEventListener("click", async () => {
  try {
    const { harvested, me: next } = await api.harvest();
    setMe(next);
    toast(`+${fmt(harvested)} pièces`);
    if (selected) renderPanel();
  } catch (err) {
    toast(err instanceof ApiRequestError ? err.message : "Connexion impossible, réessaie.");
  }
});

// ---------- Classement ----------
$("open-leaderboard").addEventListener("click", async () => {
  const list = $("leaderboard-list");
  list.innerHTML = "<li>Chargement…</li>";
  $<HTMLDialogElement>("leaderboard").showModal();
  try {
    const rows = await api.leaderboard();
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
  error.textContent = err instanceof ApiRequestError ? err.message : "Connexion impossible, réessaie.";
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
    else toast(err instanceof ApiRequestError ? err.message : "Connexion impossible, réessaie.");
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
  toastTimer = window.setTimeout(() => (el.hidden = true), 3200);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
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
