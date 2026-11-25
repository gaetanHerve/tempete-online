# Tempête sur l'échiquier

Les échecs, avec des cartes qui chamboulent tout. On joue contre l'ordinateur, à deux sur le
même appareil, ou en ligne. C'est une appli web statique, installable sur téléphone (PWA) :
le mode en ligne s'appuie sur Firebase, sans serveur à héberger. L'interface existe en
français et en anglais (langue du navigateur au premier lancement, puis au choix).

## Jeu original

Cette appli est une adaptation numérique non officielle du jeu de cartes
**Tempête sur l'échiquier**, de **Pierre Cléquin** et
**[Bruno Faidutti](http://www.faidutti.com/)**
([page du jeu sur son site](http://www.faidutti.com/tempete/tempete.htm)), illustré par
Gérard Mathieu.

Les cartes utilisées sont celles de la **seconde édition**, en couleur, publiée par
[Variantes](https://www.variantes.com/) après la première édition parue chez Ludodélire.
Le jeu est toujours édité par Variantes :
[Tempête sur l'échiquier sur la boutique de l'éditeur](https://www.variantes.com/jeux-societe-voyage-boutique/43783-tempete-sur-l-echiquier-jeu-3558380050919.html).

## Démarrer

```bash
npm install      # copie aussi le moteur Stockfish dans public/stockfish
npm run dev      # http://localhost:5173 (accessible depuis le téléphone sur le réseau local)
npm test         # moteur de règles, cartes, parties aléatoires, bot contre le vrai Stockfish
npm run build    # produit dist/, à servir tel quel
npm run vault    # rechiffre le coffre des cartes, public/vault.bin (voir « Données protégées »)
```

Pour le déploiement, il suffit de pousser sur `main` d'un dépôt GitHub avec Pages activé
(source : « GitHub Actions ») : `.github/workflows/deploy.yml` s'occupe du reste.

Le build ajoute à `index.html` une politique de sécurité du contenu (CSP, voir `vite.config.ts`) :
l'appli ne peut joindre que son propre site, la base Firebase et son authentification. Toute
nouvelle ressource externe (domaine, script, police…) doit y être ajoutée.

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
  cartes ; une contrainte qui ne laisserait aucun coup est suspendue pour ce coup-là. Seule
  exception : pendant Cessez le feu, les cartes ne peuvent pas non plus prendre de pièce
  adverse (retirer une pièce ou prendre l'une des siennes reste permis).
- Je passe, Double jeu et Rebelote touchent au déroulement du tour : passer son tour et
  rejouer plus tard, échanger sa place avec l'adversaire pendant trois tours, jouer deux cartes
  de plus. Tenir Rebelote laisse le tour ouvert après une carte qui l'aurait terminé.
- Après son coup, on termine toujours son tour soi-même (« Terminer mon tour »), même
  sans carte à jouer ou à défausser. Tant qu'on n'a ni joué de carte ni terminé son tour (et
  que l'adversaire n'a pas réagi), on peut annuler son coup.
- Une carte ne peut jamais laisser son propre Roi en échec.
- Une carte devenue définitivement inutile (le matériel qu'elle vise a disparu, ex. Pégase
  sans Cavalier) peut être défaussée, après avoir joué son coup, puis remplacée par une pioche.
  Cela compte comme la carte du tour. Une carte simplement injouable *pour l'instant* ne se défausse pas
  (voir `DEAD_WHEN` dans `cards.ts`).
- On perd quand on n'a plus ni coup légal ni carte « à la place du coup » pour s'en sortir.
  Une carte peut donc sauver d'un mat.

Seules des **cartes entièrement automatisables** sont dans le paquet (53 pour l'instant),
c'est-à-dire celles que l'appli sait appliquer seule, sans arbitrage : l'échiquier reste une
position d'échecs standard, sans pièce féerique (i.e. pièce pour laquelle on modifie de manière permanente la règle de déplacement en un type de déplacement n'existant pas dans le jeu d'échecs). Les cartes à effet durable sont suivies par
le jeu jusqu'à leur fin : règles qui durent (Cessez le feu, Fringale, Planque, Origines),
règles du tour suivant (Provocation, Voyance), échange des places (Double jeu). Une carte
peut être mise de côté sans être supprimée (`SET_ASIDE` dans `cards.ts`).

Seule entorse aux échecs classiques : un pion peut se retrouver sur sa propre première
rangée (Tournez manège, Raton laveur…). Il avance alors d'une case. Stockfish refusant
d'analyser une telle position, l'ordinateur en voit une approximation (`engineFen`).

## Données protégées

Les noms, textes et illustrations des cartes appartiennent aux auteurs du jeu original : ils ne
sont **pas** dans le dépôt. Seul leur version chiffrée l'est (`public/vault.bin`, AES-GCM, clé
dérivée du mot de passe par PBKDF2). Au premier lancement, l'appli demande le mot de passe,
transmis à part aux joueurs, déchiffre le coffre et mémorise la clé sur l'appareil. Sans le mot
de passe, le fichier publié est illisible.

Les traductions des noms et textes sont protégées de la même façon : `private/cards.json` est
la référence (français), `private/cards.<langue>.json` ses traductions (ex. `cards.en.json`),
toutes chiffrées dans le coffre par `npm run vault`. Une carte non traduite s'affiche en français.

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
src/i18n/          textes de l'interface : fr.ts (référence, ses clés font foi), en.ts
src/ui/            composants (plateau animé, cartes, écrans)
```

**Textes et langues** : le cœur ne rédige aucune phrase. Résumés d'options, consignes et
entrées du journal sont des messages `{ k: clé, p: paramètres }` (`core/msg.ts`), mis en mots
par l'interface dans la langue choisie : le journal se retraduit si l'on change de langue, et en
ligne chaque joueur voit la partie dans la sienne. Les `label` d'options restent des
identifiants stables (ils voyagent dans les actions), traduits à l'affichage. Ajouter une
langue : un dictionnaire `src/i18n/<langue>.ts` (le typage exige toutes les clés), son entrée
dans `LOCALES`, et `private/cards.<langue>.json`.

**Ajouter une carte** : ajouter une entrée dans `CARDS` (`cards.ts`) avec une fonction
`options(ctx)` qui renvoie toutes les options possibles (`path` = cases à toucher,
`label` = choix final éventuel, `result` = position obtenue). L'interface et le bot
la prennent en charge automatiquement. Il faut aussi ajouter son nom, son texte et son
illustration au coffre (`npm run vault`), dans chaque langue, et ses consignes d'étapes
(`steps` dans `src/i18n/fr.ts` et `en.ts`).

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
- Un chat accompagne chaque partie (`rooms/<CODE>/chat`) : messages de 200 caractères au plus,
  envoyés par l'un des deux joueurs, jamais modifiés. Les 100 derniers reviennent à la reprise ;
  l'heure du dernier message lu est gardée sur l'appareil pour ne compter que les non-lus.
- Les règles d'accès sont dans `database.rules.json`, à recopier dans la console Firebase
  (Realtime Database → Règles) à chaque modification. La config web (`src/lib/firebase-config.ts`)
  n'a rien de secret.
- Limite assumée : chaque appareil connaît toute la partie, y compris la main adverse. Un joueur
  qui fouille les outils de développement pourrait la voir.

## Licences

- Moteur : [Stockfish.js](https://github.com/nmrugg/stockfish.js), sous GPLv3. L'appli qui
  l'embarque doit donc être distribuée sous GPLv3.
- Pièces : jeu « cburnett » (Colin M.L. Burnett), sous CC BY-SA 3.0.
- Noms, textes et illustrations des cartes : propriété des auteurs du jeu original (Pierre
  Cléquin, Bruno Faidutti, Gérard Mathieu, éditions Variantes, voir « Jeu original »), non
  distribués avec ce code (voir « Données protégées »).
- Police des cartes : [Super Comic](https://www.fontspace.com/super-comic-font-f100103), par
  [All Super Font](https://www.fontspace.com/all-super-font) (2023), gratuite pour un usage
  personnel et commercial (freeware).
