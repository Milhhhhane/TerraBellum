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
