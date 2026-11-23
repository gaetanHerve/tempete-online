// Interface minimale d'un moteur d'échecs, pour que le bot soit testable
// (et remplaçable) indépendamment de Stockfish.

export interface Analysis {
  /** Meilleur coup en notation UCI, ou null si aucun coup. */
  bestmove: string | null;
  /** Évaluation en centipions du point de vue du camp au trait (mat ≈ ±100000). */
  score: number;
  /** Avec `multipv` > 1 : les meilleures variantes, de la meilleure à la moins bonne. */
  lines?: { move: string; score: number }[];
}

export interface SearchLimits {
  depth?: number;
  movetime?: number;
  /** Niveau Stockfish 0..20 (influe sur le choix du coup, pas sur le score). */
  skill?: number;
  /** Nombre de variantes principales à renvoyer (1 par défaut). */
  multipv?: number;
  /** Coups (UCI) auxquels limiter la recherche au premier niveau. */
  searchmoves?: string[];
}

export interface Engine {
  analyse(fen: string, limits: SearchLimits): Promise<Analysis>;
  dispose(): void;
}

export const MATE_SCORE = 100000;
