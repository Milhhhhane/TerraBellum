# TerraBellum

Jeu de conquête sur la **vraie carte de France**, découpée en hexagones.
On achète des cases, on construit en hauteur, on récolte ses pièces, on grimpe au classement.

> **V1 (en cours)** : Île-de-France uniquement, monde tranquille (pas d'attaques), connexion Google ou compte invité.
> PvP, alliances, bâtiments de défense et monétisation viendront ensuite.

## Ce que fait la V1

- Carte de l'Île-de-France, grille d'hexagones [H3](https://h3geo.org/) (résolution 8, ≈ 0,74 km² par case).
- **Première case** : n'importe où dans la zone, elle devient ta case maison.
- **Grandir en longueur** : acheter une case voisine d'une des tiennes. Chaque case coûte 15 % de plus que la précédente.
- **Grandir en hauteur** : Maison → Immeuble → Tour → Gratte-ciel. Chaque étage rapporte beaucoup plus.
- **Prix selon le lieu** : de ×1 (campagne) à ×10 (centre de Paris). V1 : distance au centre de Paris ; V2 : densité INSEE.
- **Récolte** : les pièces s'accumulent et plafonnent au bout de 2 h. Il faut revenir récolter.
- **Classement** des plus riches (pièces + tout ce qui a été investi).
- **Comptes** : connexion avec Google (compte retrouvable sur tous les appareils) ou compte invité (lié au navigateur). Un invité peut lier Google plus tard sans rien perdre.

Toutes les règles chiffrées sont dans [`src/shared/economy.ts`](src/shared/economy.ts).

## Architecture

```
Navigateur                          Cloudflare
┌──────────────────────────┐        ┌──────────────────────────────────────┐
│ MapLibre + OpenFreeMap   │        │ Worker (Hono)                        │
│ h3-js : dessine la grille│  /api  │  ├─ sert le client compilé (./dist)  │
│ src/web/                 │ ─────▶ │  ├─ /api/* : règles du jeu           │
└──────────────────────────┘        │  └─ D1 (SQLite) : joueurs, cases     │
                                    └──────────────────────────────────────┘
```

- **Un seul déploiement** : le Worker sert à la fois le site et l'API.
- **Économie calculée à la demande** : rien ne tourne en fond. Chaque joueur a un taux de production et un stock daté ; le stock courant se calcule quand on en a besoin (`pendingStock` côté client, `SETTLE_SQL` côté serveur, même formule).
- **Pas de triche sur les achats** : chaque achat/amélioration est un batch D1 (une transaction). La clé primaire `(world, h3)` empêche deux joueurs d'avoir la même case, et le débit n'a lieu que si l'écriture de *cette* requête a réussi.
- **Connexion Google sans secret** : le bouton Google Identity Services renvoie un ID token (JWT). Le Worker vérifie sa signature avec les clés publiques de Google, son émetteur, son destinataire (notre client ID) et son expiration (`src/worker/google.ts`). On ne stocke que l'identifiant Google (`sub`), pas l'e-mail.
- **Sessions** : une session par appareil, on ne stocke que l'empreinte SHA-256 du jeton. Se déconnecter supprime la session de l'appareil.
- **Prévu pour la suite** : colonne `world` (monde tranquille / PvP) et `alliance_id` déjà dans le schéma.

```
src/
  shared/   règles du jeu et types d'API (utilisés des deux côtés)
  worker/   API Cloudflare Worker + schéma D1
  web/      client (Vite + TypeScript, sans framework)
test/       tests unitaires de l'économie (Vitest)
```

## Lancer en local

Prérequis : Node.js 22+.

```bash
npm install
npm run dev        # compile le client et lance le Worker + une base D1 locale sur http://localhost:8787
```

Pour travailler sur l'interface avec rechargement instantané, dans un 2ᵉ terminal :

```bash
npm run dev:web    # http://localhost:5173, les appels /api partent vers le Worker local
```

Autres commandes :

```bash
npm test           # tests de l'économie
npm run typecheck  # vérification TypeScript (Worker + client)
npm run build      # compile le client dans ./dist
```

La base locale vit dans `.wrangler/` (ignorée par Git). La supprimer remet le jeu à zéro.

Pour tester la connexion Google en local, le client ID de `wrangler.jsonc` est utilisé et `http://localhost:8787` doit être dans les « Origines JavaScript autorisées » du client OAuth. On peut aussi surcharger des variables dans un fichier `.dev.vars` (ignoré par Git) :

```
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
```

## Déploiement

Le dépôt est relié à **Cloudflare Workers Builds** : chaque push sur `main` lance `npx wrangler deploy`, qui :

1. installe les dépendances et compile le client (`build.command` dans `wrangler.jsonc`) ;
2. publie le Worker, relié à la base D1 `terrabellum-eu` (Europe de l'Ouest, identifiant fixé dans `wrangler.jsonc`).

Jeu en ligne : https://terrabellum.cmilhane.workers.dev

### Migrations de la base

Le Worker applique lui-même les migrations au premier appel (`src/worker/db.ts`) : chaque migration est numérotée, la table `schema_meta` retient la dernière appliquée, et chaque migration est une transaction. Pour faire évoluer le schéma, **ajouter** une migration à la fin de la liste, ne jamais modifier une migration déjà déployée.

### Connexion Google

Le client ID OAuth (public) est dans `vars.GOOGLE_CLIENT_ID` de `wrangler.jsonc`. S'il est vide, le bouton Google est masqué et seuls les comptes invités sont disponibles. Aucun secret n'est nécessaire.

## Limites connues de la V1

- Zone ouverte = rectangle autour de l'Île-de-France, pas son contour exact.
- Prix du lieu approximé par la distance au centre de Paris.
- Comptes invités : le jeton est dans le navigateur. Vider son navigateur = perdre son compte (d'où la connexion Google).
- Pas de limite de requêtes (rate limiting) sur l'API.
