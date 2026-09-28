import "./style.css";
import { adminApi, api, ApiRequestError, getToken } from "./api";
import type { AdminPlayer } from "../shared/api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.floor(n).toLocaleString("fr-FR");
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

let players: AdminPlayer[] = [];
let current: AdminPlayer | null = null;
let myId = "";

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

function date(ms: number): string {
  return new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

let toastTimer: number | undefined;
function toast(message: string) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3200);
}

function errorText(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : "Connexion impossible, réessaie.";
}

// ---------- Chiffres clés ----------
async function loadStats() {
  const s = await adminApi.stats();
  const cards: [string, string][] = [
    ["Joueurs", fmt(s.players)],
    ["Liés à Google", fmt(s.playersGoogle)],
    ["Actifs (24 h)", fmt(s.activeLast24h)],
    ["Cases possédées", fmt(s.cells)],
    ["Pièces en circulation", fmt(s.totalCoins)],
    ["Suspendus", fmt(s.banned)],
  ];
  $("stats").innerHTML = cards
    .map(([label, value]) => `<div class="stat-card"><span class="stat-label">${label}</span><strong>${value}</strong></div>`)
    .join("");
}

// ---------- Joueurs ----------
function badges(p: AdminPlayer): string {
  const b = [p.hasGoogle ? `<span class="badge">Google</span>` : `<span class="badge muted">Invité</span>`];
  if (p.isAdmin) b.push(`<span class="badge gold">Admin</span>`);
  if (p.bannedAt) b.push(`<span class="badge red">Suspendu</span>`);
  return b.join("");
}

async function loadPlayers() {
  const q = $<HTMLInputElement>("search").value;
  const sort = $<HTMLSelectElement>("sort").value === "recent" ? "recent" : "worth";
  players = await adminApi.players(q, sort);
  $("players").innerHTML = players.length
    ? players
        .map(
          (p) => `<tr class="${p.bannedAt ? "is-banned" : ""}">
            <td><span class="pname">${esc(p.name)}</span>${badges(p)}</td>
            <td class="num">${fmt(p.coins)}</td>
            <td class="num">${p.cells}</td>
            <td class="num opt">${fmt(p.worth)}</td>
            <td class="opt">${ago(p.lastSeen)}</td>
            <td class="num"><button type="button" class="ghost small-btn" data-id="${p.id}">Gérer</button></td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="empty">Aucun joueur trouvé.</td></tr>`;
}

$("players").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]")?.dataset.id;
  const p = players.find((x) => x.id === id);
  if (p) openManage(p);
});

let searchTimer: number | undefined;
$("search").addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void loadPlayers().catch((err) => toast(errorText(err))), 250);
});
$("sort").addEventListener("change", () => void loadPlayers().catch((err) => toast(errorText(err))));

// ---------- Fiche joueur ----------
const manage = $<HTMLDialogElement>("manage");

function openManage(p: AdminPlayer) {
  current = p;
  const self = p.id === myId;
  $("manage-title").textContent = p.name;
  $("manage-info").innerHTML = [
    `${fmt(p.coins)} pièces · ${p.cells} case${p.cells > 1 ? "s" : ""} · ${p.rate.toFixed(1)} pièces/min`,
    `${p.hasGoogle ? "Compte Google" : "Compte invité"}${p.isAdmin ? " · admin" : ""}`,
    `Inscrit le ${date(p.createdAt)} · vu ${ago(p.lastSeen)}`,
    p.bannedAt ? `<strong class="red-text">Suspendu le ${date(p.bannedAt)}${p.banReason ? ` : ${esc(p.banReason)}` : ""}</strong>` : "",
  ]
    .filter(Boolean)
    .join("<br>");
  $<HTMLInputElement>("coins-amount").value = "";
  $<HTMLInputElement>("rename-input").value = p.name;
  $<HTMLInputElement>("ban-reason").value = "";
  $<HTMLInputElement>("delete-confirm").value = "";
  $("ban-label").textContent = p.bannedAt ? "Réactiver" : "Suspendre";
  $("ban-button").textContent = p.bannedAt ? "Réactiver" : "Suspendre";
  $("ban-button").classList.toggle("danger", !p.bannedAt);
  $("ban-reason").hidden = !!p.bannedAt;
  // On ne peut ni se suspendre ni se supprimer soi-même.
  $("form-ban").hidden = self;
  $("form-delete").hidden = self;
  $("manage-error").hidden = true;
  manage.showModal();
}

$("close-manage").addEventListener("click", () => manage.close());

async function act(run: () => Promise<unknown>, success: string, close = false) {
  $("manage-error").hidden = true;
  try {
    await run();
    toast(success);
    await Promise.all([loadPlayers(), loadStats(), loadLog()]);
    const fresh = players.find((p) => p.id === current?.id);
    if (close || !fresh) manage.close();
    else openManage(fresh);
  } catch (err) {
    $("manage-error").textContent = errorText(err);
    $("manage-error").hidden = false;
  }
}

$("form-coins").addEventListener("submit", (e) => {
  e.preventDefault();
  const sign = Number((e as SubmitEvent).submitter?.dataset.sign ?? 1);
  const amount = Math.floor(Number($<HTMLInputElement>("coins-amount").value));
  if (!current || !(amount > 0)) return;
  const delta = sign * amount;
  void act(() => adminApi.coins(current!.id, delta), `${delta > 0 ? "+" : ""}${fmt(delta)} pièces pour ${current.name}`);
});

$("form-rename").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("rename-input").value.trim();
  if (!current || name === current.name) return;
  void act(() => adminApi.rename(current!.id, name), `Renommé en ${name}`);
});

$("form-ban").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!current) return;
  if (current.bannedAt) void act(() => adminApi.unban(current!.id), `${current.name} réactivé`);
  else void act(() => adminApi.ban(current!.id, $<HTMLInputElement>("ban-reason").value), `${current.name} suspendu`);
});

$("form-delete").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!current) return;
  if ($<HTMLInputElement>("delete-confirm").value.trim() !== current.name) {
    $("manage-error").textContent = "Le pseudo tapé ne correspond pas.";
    $("manage-error").hidden = false;
    return;
  }
  void act(() => adminApi.remove(current!.id), `${current.name} supprimé`, true);
});

// ---------- Journal ----------
const ACTION_LABELS: Record<string, string> = {
  pieces: "a modifié les pièces de",
  renommer: "a renommé",
  suspendre: "a suspendu",
  "réactiver": "a réactivé",
  supprimer: "a supprimé",
};

async function loadLog() {
  const entries = await adminApi.log();
  $("log").innerHTML = entries.length
    ? entries
        .map(
          (e) => `<li>
            <span class="log-date">${date(e.at)}</span>
            <span><strong>${esc(e.adminName)}</strong> ${ACTION_LABELS[e.action] ?? e.action}
            <strong>${esc(e.targetName ?? "?")}</strong>${e.details ? ` <span class="muted-text">(${esc(e.details)})</span>` : ""}</span>
          </li>`,
        )
        .join("")
    : `<li class="empty">Aucune action pour l'instant.</li>`;
}

// ---------- Onglets ----------
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
      const active = t === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
      $(`tab-${t.dataset.tab}`).hidden = !active;
    });
  }),
);

// ---------- Démarrage ----------
function deny(reason: string) {
  $("denied-reason").textContent = reason;
  $("denied").hidden = false;
}

async function start() {
  if (!getToken()) return deny("Connecte-toi d'abord sur le jeu avec ton compte Google.");
  try {
    const me = await api.me();
    if (!me.isAdmin) return deny("Ton compte n'a pas les droits d'administration.");
    myId = me.id;
    $("content").hidden = false;
    await Promise.all([loadStats(), loadPlayers(), loadLog()]);
  } catch (err) {
    deny(errorText(err));
  }
}
void start();
