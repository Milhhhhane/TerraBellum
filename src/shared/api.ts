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
