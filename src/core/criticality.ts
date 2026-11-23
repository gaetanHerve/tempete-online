// Criticité habituelle des cartes (0 à 1) : à quel point chacune, tenue par l'adversaire, pèse
// en général sur une partie. L'ordinateur ne se méfie que des cartes au-dessus du seuil de son
// niveau (comme un joueur qui pense aux cartes dangereuses, pas à toutes), sauf préparation
// manifeste de l'adversaire. Valeurs de départ : mesurées par scripts/measure-cards.test.ts,
// puis ajustables à la main.

// Mesure du 18/11/2026 : 2 821 positions, 30 parties (Stockfish contre lui-même). Classement
// validé tel quel. La mesure ne voit que le matériel perdu aussitôt : les cartes qui créent une
// menace pour plus tard (Pégase, Bonnes Copines…) ou qui dépendent du coup adverse (Vampirisme,
// Serial killer…) y valent 0, mais restent rattrapées par la détection de préparation.
export const CARD_CRITICALITY: Record<string, number> = {
  laser: 1.00,
  paranoia: 0.42,
  tournezManege: 0.37,
  chasseNeige: 0.32,
  voyageAstral: 0.28,
  verglas: 0.23,
  ruade: 0.12,
  dalaiLama: 0.11,
  duel: 0.10,
  modestie: 0.10,
  toiAussiMonFils: 0.10,
  coupDouble: 0.09,
  ole: 0.09,
  brouillard: 0.07,
  appartheid: 0.05,
  angeGardien: 0.04,
  douane: 0.04,
  contrordre: 0.03,
  promotionALAnciennete: 0.03,
  grosseDeprime: 0.03,
  maison: 0.03,
  pitie: 0.03,
  encephalopathieSpongiformeEquine: 0.01,
  psychopathe: 0.00,
  elementIncontrole: 0.00,
  ohDarling: 0.00,
  pegase: 0.00,
  majorettes: 0.00,
  remorque: 0.00,
  electrochoc: 0.00,
  amourCourtois: 0.00,
  bonnesCopines: 0.00,
  quadrille: 0.00,
  ratonLaveur: 0.00,
  promotionAuMerite: 0.00,
  vampirisme: 0.00,
  pasDeDeux: 0.00,
  serialKiller: 0.00,
  roqueEtRolle: 0.00,
};

/** Criticité d'une carte (1 par défaut : une carte inconnue de la table est prise au sérieux). */
export const criticality = (id: string): number => CARD_CRITICALITY[id] ?? 1;
