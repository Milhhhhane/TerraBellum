# TerraBellum

Jeu de conquête sur la **vraie carte de France**, découpée en hexagones.
On achète des cases, on construit en hauteur, on récolte ses pièces, on grimpe au classement.

> **V1 (en cours)** : Île-de-France uniquement, un monde calme et un monde PvP séparé, connexion Google ou compte invité.
> Alliances et monétisation viendront ensuite.

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

## Le monde PvP

Une carte à part (même grille, cases séparées), qui rapporte 2× plus mais où l'on peut se faire prendre ses cases. On passe d'un monde à l'autre avec le sélecteur en haut à gauche de la carte.

- **Entrée** : 300 pièces PvP et 20 soldats. Les pièces du monde calme restent à l'abri : on peut en envoyer au plus 20 % par jour vers le PvP ; rapatrier du PvP vers le calme coûte 25 %.
- **Case maison** (la première) : intouchable.
- **Maison** produit des pièces ; **caserne** ne produit rien mais loge des soldats (50 / 120 / 250 / 500 selon l'étage) et donne +25 % de défense à elle-même et à ses voisines.
- **Armée globale** : recruter coûte 10 pièces et 30 s par soldat, dans la limite de la capacité (20 de base + casernes).
- **Murs** : seules les cases de bordure peuvent être attaquées. L'armée présente se répartit entre elles ; chaque case a en plus sa milice (5 + 5 par étage). Le **rempart** (5 niveaux, +25 % chacun) renforce toutes les bordures.
- **Attaque** : sur une case ennemie voisine, les soldats partent et arrivent au bout d'**1 h** ; le défenseur la voit venir (alerte, compte à rebours, case marquée en rouge sur la carte).
- **Bataille** : attaque > défense → la case change de main avec un étage de moins, l'attaquant pille 30 % du stock non récolté du défenseur, qui récupère 25 % de ce qu'il avait investi. Sinon l'attaquant perd tous les soldats envoyés.
- **Bouclier de 24 h** si on perd au moins 20 % de ses cases (et au moins 2) en 24 h. Attaquer retire son propre bouclier.

Règles chiffrées : [`src/shared/pvp.ts`](src/shared/pvp.ts). Les batailles sont réglées par une tâche planifiée (toutes les minutes, `triggers.crons`) **et** à chaque appel `/api/pvp/*`, avec une réservation (`claim`) pour qu'une attaque ne soit jamais réglée deux fois.

Pour tester en local sans attendre, accélérer les durées dans `.dev.vars` (`PVP_TIME_SCALE=0.02` → trajet de 72 s, recrue en 0,6 s) et lancer `npx wrangler dev --test-scheduled` (la tâche planifiée se déclenche via `/cdn-cgi/handler/scheduled`).

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
- **Mondes** : la colonne `world` des cases sépare le monde calme (`calme`) et le PvP (`pvp`). Le portefeuille PvP est dans `pvp_players`. `alliance_id` est déjà dans le schéma pour la suite.

```
src/
  shared/   règles du jeu et types d'API (utilisés des deux côtés)
  worker/   API Cloudflare Worker + schéma D1
  web/      client (Vite + TypeScript, sans framework)
test/       tests unitaires de l'économie et du PvP (Vitest)
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

### Administration

Page `/admin` (lien dans le menu Compte pour les admins) : chiffres clés, recherche de joueurs, donner/retirer des pièces, renommer, suspendre/réactiver, supprimer. Chaque action est inscrite dans la table `admin_log` (onglet Journal).

Accès : compte **lié à Google** et marqué `is_admin = 1`. Pour nommer un admin, dans la console D1 :

```sql
UPDATE players SET is_admin = 1 WHERE name = 'Pseudo';
```

Un joueur suspendu peut se connecter et voir la carte, mais ne peut plus jouer et disparaît du classement.

### Connexion Google

Le client ID OAuth (public) est dans `vars.GOOGLE_CLIENT_ID` de `wrangler.jsonc`. S'il est vide, le bouton Google est masqué et seuls les comptes invités sont disponibles. Aucun secret n'est nécessaire.

## Limites connues de la V1

- Zone ouverte = rectangle autour de l'Île-de-France, pas son contour exact.
- Prix du lieu approximé par la distance au centre de Paris.
- Comptes invités : le jeton est dans le navigateur. Vider son navigateur = perdre son compte (d'où la connexion Google).
- Pas de limite de requêtes (rate limiting) sur l'API.
