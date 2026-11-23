# Tempête sur l'échiquier

Les échecs, avec des cartes qui chamboulent tout. On joue contre l'ordinateur, à deux sur le
même appareil, ou en ligne. C'est une appli web statique, installable sur téléphone (PWA) :
le mode en ligne s'appuie sur Firebase, sans serveur à héberger.

## Démarrer

```bash
npm install      # copie aussi le moteur Stockfish dans public/stockfish
npm run dev      # http://localhost:5173 (accessible depuis le téléphone sur le réseau local)
npm test         # moteur de règles, cartes, parties aléatoires, bot contre le vrai Stockfish
npm run build    # produit dist/, à servir tel quel
npm run vault    # rechiffre public/vault.bin depuis private/ (voir « Données protégées »)
```

Pour le déploiement, il suffit de pousser sur `main` d'un dépôt GitHub avec Pages activé
(source : « GitHub Actions ») : `.github/workflows/deploy.yml` s'occupe du reste.

## Règles retenues

- Partie d'échecs classique. Chaque joueur a 5 cartes en main.
- À son tour, on peut jouer **une** carte, au moment qu'elle indique (avant le coup,
  à la place du coup, ou après le coup), puis on pioche.
- Certaines cartes se jouent juste après le coup normal adverse, pour y réagir (Contrordre,
  Verglas, Duel…). Au plus une carte pendant le tour adverse, en plus de celle de son propre
  tour. L'étape de réaction n'est proposée que si une carte en main s'applique au coup.
- Non et Niet annulent la carte que l'adversaire vient de jouer : elle est perdue, sans effet.
  Elles comptent dans la même limite (une carte pendant son tour, une pendant le tour adverse).
- Certaines cartes posent une règle temporaire (Cessez le feu, Fringale, Planque, Origines…),
  affichée sous l'échiquier jusqu'à sa fin. Elles contraignent les coups normaux, pas les
  cartes ; une contrainte qui ne laisserait aucun coup est suspendue pour ce coup-là.
- Je passe, Double jeu et Rebelote touchent au déroulement du tour : passer son tour et
  rejouer plus tard, échanger sa place avec l'adversaire pendant trois tours, jouer deux cartes
  de plus. Tenir Rebelote laisse le tour ouvert après une carte qui l'aurait terminé.
- Après son coup, on termine toujours son tour soi-même (« Terminer mon tour »), même
  sans carte à jouer ou à défausser.
- Une carte ne peut jamais laisser son propre Roi en échec.
- Une carte devenue définitivement inutile (le matériel qu'elle vise a disparu, ex. Pégase
  sans Cavalier) peut être défaussée, après avoir joué son coup, puis remplacée par une pioche.
  Cela compte comme la carte du tour. Une carte simplement injouable *pour l'instant* ne se défausse pas
  (voir `DEAD_WHEN` dans `cards.ts`).
- On perd quand on n'a plus ni coup légal ni carte « à la place du coup » pour s'en sortir.
  Une carte peut donc sauver d'un mat.

Seules des **cartes entièrement automatisables** sont dans le paquet (53 pour l'instant),
c'est-à-dire celles dont l'effet transforme la position en une position d'échecs standard :
pas de pièce féerique, pas de marqueur, pas de règle permanente. Une carte peut être mise
de côté sans être supprimée (`SET_ASIDE` dans `cards.ts`).

Seule entorse aux échecs classiques : un pion peut se retrouver sur sa propre première
rangée (Tournez manège, Raton laveur…). Il avance alors d'une case. Stockfish refusant
d'analyser une telle position, l'ordinateur en voit une approximation (`engineFen`).

## Données protégées

Les noms, textes et illustrations des cartes appartiennent aux auteurs du jeu original : ils ne
sont **pas** dans le dépôt. Seul leur version chiffrée l'est (`public/vault.bin`, AES-GCM, clé
dérivée du mot de passe par PBKDF2). Au premier lancement, l'appli demande le mot de passe,
transmis à part aux joueurs, déchiffre le coffre et mémorise la clé sur l'appareil. Sans le mot
de passe, le fichier publié est illisible.

Les données en clair restent sur le poste de l'auteur, dans `private/` (ignoré par git) :

```
private/cards.json         { "<id>": { "title": "…", "text": "…" } }
private/cards/<id>.webp    une illustration par carte, plus card-back.webp
```

Après toute modification de `private/`, rechiffrer puis commiter `public/vault.bin` :

```bash
npm run vault                  # même mot de passe : les appareils déjà ouverts le restent
npm run vault -- --changer     # nouveau mot de passe : tout le monde devra le ressaisir
```

Dans le code, une carte n'a que son identifiant. `title` et `text` sont renseignés à
l'exécution (`setCardTexts`). En test, sans coffre ouvert, le titre vaut l'identifiant.
Quand `private/` est présent, `npm test` vérifie aussi qu'aucun texte ni illustration n'est
suivi par git.

## Architecture

```
src/core/          logique pure, sans interface (testable sous Node)
  position.ts      plateau 0..63, FEN, détection d'échec, renormalisation après une carte
  chess.ts         coups normaux via chess.js (roque, en passant, promotion)
  cards.ts         définitions des cartes : chacune énumère ses options + leur résultat
  game.ts          état de partie + réducteur `apply(state, action)` (aléa déterministe)
  bot.ts           l'ordinateur : Stockfish pour les coups, évaluation des options de carte
  criticality.ts   criticité habituelle des cartes, dont l'ordinateur se méfie chez l'adversaire
src/engine/        Stockfish 18 lite (WASM, single-thread) dans un Web Worker
src/lib/           contrôleur Svelte (sièges humain/ordinateur, sélection, sauvegarde),
                   coffre chiffré des cartes (vault.ts)
src/ui/            composants (plateau animé, cartes, écrans)
```

**Ajouter une carte** : ajouter une entrée dans `CARDS` (`cards.ts`) avec une fonction
`options(ctx)` qui renvoie toutes les options possibles (`path` = cases à toucher,
`label` = choix final éventuel, `result` = position obtenue). L'interface et le bot
la prennent en charge automatiquement. Il faut aussi ajouter son nom et son texte dans
`private/cards.json`, son illustration `private/cards/<id>.webp`, une consigne dans
`STEP_HINTS`, puis rechiffrer le coffre (`npm run vault`).

**Méfiance de l'ordinateur** : il ne voit pas la main adverse, mais se méfie des cartes qu'il
n'a jamais vues, si leur criticité habituelle (`criticality.ts`) atteint le seuil de son niveau
(Facile 0.30, Moyen 0.20, Redoutable 0.10), ou si le dernier coup adverse semble les préparer.
Après un ajout de cartes, relancer la mesure (une dizaine de minutes) puis reporter la table :

```bash
PARTIES=30 npx vitest run --config scripts/measure.config.ts   # résultat : scripts/card-threat.txt
```

### Parties en ligne

Tout le jeu passe par des actions sérialisables (`move`, `card`, `pass`, `duel`, `endTurn`…)
appliquées par un réducteur pur, avec une graine aléatoire stockée dans l'état. Une partie en
ligne n'est donc qu'un **journal d'actions** dans Firebase Realtime Database (`src/lib/online.ts`) :
chaque appareil recalcule la partie en le rejouant depuis la graine, ce qui permet de la reprendre
après une veille ou un rechargement. Côté contrôleur, l'adversaire prend la place de l'ordinateur.

- Une action ne s'applique qu'une fois revenue du serveur, chez les deux joueurs. Chaque entrée
  du journal ne s'écrit qu'une fois : en cas d'écritures simultanées (duel), la seconde est
  renvoyée à l'index suivant.
- Chaque entrée porte la position obtenue chez son auteur : en cas d'écart (versions différentes
  de l'appli), la partie s'interrompt au lieu de diverger.
- Les parties sont rangées sous un chemin dérivé de la clé du coffre : sans le mot de passe, on
  ne peut ni les trouver ni les lister. Seuls les deux joueurs d'une partie peuvent y écrire.
- Les règles d'accès sont dans `database.rules.json`, à recopier dans la console Firebase
  (Realtime Database → Règles) à chaque modification. La config web (`src/lib/firebase-config.ts`)
  n'a rien de secret.
- Limite assumée : chaque appareil connaît toute la partie, y compris la main adverse. Un joueur
  qui fouille les outils de développement pourrait la voir.

## Licences

- Moteur : [Stockfish.js](https://github.com/nmrugg/stockfish.js), sous GPLv3. L'appli qui
  l'embarque doit donc être distribuée sous GPLv3.
- Pièces : jeu « cburnett » (Colin M.L. Burnett), sous CC BY-SA 3.0.
- Noms, textes et illustrations des cartes : propriété des auteurs du jeu original, non
  distribués avec ce code (voir « Données protégées »).
- Police des cartes : reprise du projet précédent.
