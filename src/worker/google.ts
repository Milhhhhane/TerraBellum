/**
 * Vérification des jetons "Se connecter avec Google" (Google Identity Services).
 *
 * Le navigateur reçoit de Google un ID token (un JWT signé par Google).
 * On vérifie ici sa signature avec les clés publiques de Google, son émetteur,
 * son destinataire (notre client ID) et sa date d'expiration.
 * Aucun secret n'est nécessaire : seul le client ID, qui est public.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Les clés publiques sont gardées en cache par instance du Worker.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(url: string) {
  let set = keySets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    keySets.set(url, set);
  }
  return set;
}

export interface GoogleIdentity {
  /** Identifiant Google stable et unique du compte. */
  sub: string;
}

/**
 * @param jwksUrl Uniquement pour les tests locaux (variable GOOGLE_JWKS_URL dans .dev.vars).
 *                En production, toujours les clés de Google.
 */
export async function verifyGoogleCredential(
  credential: string,
  clientId: string,
  jwksUrl: string = GOOGLE_JWKS_URL,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(credential, keySet(jwksUrl), {
    issuer: GOOGLE_ISSUERS,
    audience: clientId,
    algorithms: ["RS256"],
    clockTolerance: 60,
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Jeton Google sans identifiant");
  }
  return { sub: payload.sub };
}
