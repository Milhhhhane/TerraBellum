/**
 * Comptes "invités" pour la V1 : à l'inscription, le joueur reçoit un jeton secret
 * (gardé dans son navigateur). La base ne stocke que l'empreinte SHA-256 du jeton,
 * jamais le jeton lui-même. Une vraie connexion (Google, Discord…) viendra plus tard.
 */

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

export const NAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;
