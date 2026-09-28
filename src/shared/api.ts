/** Formes des réponses de l'API, partagées entre le Worker et le client. */

export interface MeResponse {
  id: string;
  name: string;
  coins: number;
  /** Stock non récolté, figé à `stockAt`. Le client recalcule le stock courant avec pendingStock(). */
  stock: number;
  stockAt: number;
  /** Production totale, en pièces/minute. */
  rate: number;
  ownedCells: number;
  /** Le compte est-il lié à Google (récupérable sur n'importe quel appareil) ? */
  hasGoogle: boolean;
  /** Accès à la page d'administration. */
  isAdmin: boolean;
  /** Compte suspendu : il peut se connecter mais plus jouer. */
  banned: boolean;
  /** Heure du serveur, pour corriger le décalage d'horloge du client. */
  serverNow: number;
}

export interface CellView {
  h3: string;
  ownerName: string;
  mine: boolean;
  /** "maison" ou "caserne" (les casernes n'existent que dans le monde PvP). */
  kind: "maison" | "caserne";
  level: number;
  isHome: boolean;
}

export interface CellsResponse {
  cells: CellView[];
  truncated: boolean;
}

export interface LeaderboardEntry {
  name: string;
  /** Patrimoine = pièces + tout ce qui a été investi dans les cases. */
  worth: number;
  cells: number;
}

export interface ApiError {
  error: string;
}

export interface ConfigResponse {
  /** Client ID OAuth Google, ou null si la connexion Google n'est pas configurée. */
  googleClientId: string | null;
}

/**
 * Réponse des routes de connexion.
 * - token : nouveau jeton de session à garder côté client (null = garder le jeton actuel)
 * - needsName : nouveau joueur Google, il doit choisir un pseudo
 */
export type AuthResponse = { token: string | null; me: MeResponse } | { needsName: true };

// ---------- Administration ----------

export interface AdminStats {
  players: number;
  playersGoogle: number;
  activeLast24h: number;
  banned: number;
  cells: number;
  totalCoins: number;
}

export interface AdminPlayer {
  id: string;
  name: string;
  coins: number;
  rate: number;
  cells: number;
  worth: number;
  hasGoogle: boolean;
  isAdmin: boolean;
  bannedAt: number | null;
  banReason: string | null;
  createdAt: number;
  lastSeen: number;
}

export interface AdminLogEntry {
  at: number;
  adminName: string;
  action: string;
  targetName: string | null;
  details: string | null;
}

// ---------- Monde PvP ----------

export interface AttackView {
  id: string;
  h3: string;
  soldiers: number;
  arrivesAt: number;
  attackerName: string;
  defenderName: string;
}

export interface BattleReport {
  id: string;
  h3: string;
  at: number;
  /** Du point de vue du joueur qui lit le rapport. */
  role: "attaque" | "défense";
  opponentName: string;
  /** victoire / défaite (du point de vue de l'attaquant), ou annulée (bouclier, case disparue). */
  result: "victoire" | "défaite" | "annulée";
  soldiers: number;
  attackerLosses: number;
  defenderLosses: number;
  pillage: number;
}

export interface PvpState {
  joined: boolean;
  serverNow: number;
  /** Durées effectives (accélérées en test local). */
  recruitMs: number;
  travelMs: number;
  /** Pièces du monde calme transférables maintenant, et quand le prochain transfert sera possible. */
  transferInMax: number;
  transferInAvailableAt: number;
  me?: {
    coins: number;
    stock: number;
    stockAt: number;
    rate: number;
    soldiers: number;
    soldiersAway: number;
    queueCount: number;
    queueStart: number;
    armyCap: number;
    rampart: number;
    shieldUntil: number | null;
    ownedCells: number;
    frontierCells: number;
  };
  incoming: AttackView[];
  outgoing: AttackView[];
  reports: BattleReport[];
}
