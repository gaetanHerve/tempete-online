// Représentation de position indépendante de chess.js, pensée pour les cartes :
// les effets de cartes manipulent librement le plateau, puis on renormalise
// (droits de roque, prise en passant) avant de revenir au FEN.

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export interface Piece {
  t: PieceType;
  c: Color;
}
/** Index de case 0..63 : file + 8 * rang (a1 = 0, h1 = 7, a8 = 56). */
export type Sq = number;
export type Board = (Piece | null)[];

export interface Position {
  board: Board;
  turn: Color;
  castling: string; // "KQkq" ou "-"
  ep: Sq | null;
  halfmove: number;
  fullmove: number;
}

export const PIECE_VALUE: Record<PieceType, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
/** Noms des pièces servant d'identifiants aux options de promotion (`CardOption.label`) : ne pas traduire ici. */
export const PIECE_LABEL: Record<PieceType, string> = {
  p: 'Pion',
  n: 'Cavalier',
  b: 'Fou',
  r: 'Tour',
  q: 'Dame',
  k: 'Roi',
};

export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
export const fileOf = (s: Sq) => s & 7;
export const rankOf = (s: Sq) => s >> 3;
export const sq = (file: number, rank: number): Sq => rank * 8 + file;
export const onBoard = (file: number, rank: number) => file >= 0 && file < 8 && rank >= 0 && rank < 8;
export const sqName = (s: Sq) => 'abcdefgh'[fileOf(s)] + (rankOf(s) + 1);
export const parseSq = (n: string): Sq => sq(n.charCodeAt(0) - 97, Number(n[1]) - 1);
export const isLightSquare = (s: Sq) => (fileOf(s) + rankOf(s)) % 2 === 1;
/** Rang relatif (0 = première rangée du joueur). */
export const relRank = (s: Sq, c: Color) => (c === 'w' ? rankOf(s) : 7 - rankOf(s));
export const forward = (c: Color) => (c === 'w' ? 1 : -1);

export const ROOK_DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
export const BISHOP_DIRS: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
export const QUEEN_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS];
export const KNIGHT_JUMPS: [number, number][] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

export function slideDirs(t: PieceType): [number, number][] {
  if (t === 'r') return ROOK_DIRS;
  if (t === 'b') return BISHOP_DIRS;
  if (t === 'q') return QUEEN_DIRS;
  return [];
}

// ---------- FEN ----------

const FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function startPosition(): Position {
  return fromFen(FEN_START);
}

export function fromFen(fen: string): Position {
  const [placement, turn, castling, ep, half, full] = fen.trim().split(/\s+/);
  const board: Board = new Array(64).fill(null);
  const rows = placement.split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) f += Number(ch);
      else {
        const c: Color = ch === ch.toUpperCase() ? 'w' : 'b';
        board[sq(f, 7 - r)] = { t: ch.toLowerCase() as PieceType, c };
        f++;
      }
    }
  }
  return {
    board,
    turn: turn === 'b' ? 'b' : 'w',
    castling: castling || '-',
    ep: ep && ep !== '-' ? parseSq(ep) : null,
    halfmove: Number(half ?? 0),
    fullmove: Number(full ?? 1),
  };
}

export function toFen(p: Position): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const pc = p.board[sq(f, r)];
      if (!pc) empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += pc.c === 'w' ? pc.t.toUpperCase() : pc.t;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${p.turn} ${p.castling || '-'} ${p.ep === null ? '-' : sqName(p.ep)} ${p.halfmove} ${p.fullmove}`;
}

/**
 * FEN présentée à Stockfish, qui refuse de chercher si un pion est sur sa propre première
 * rangée : on l'avance d'une case (ou on l'ignore si la case est prise). Approximation.
 */
export function engineFen(p: Position): string {
  const firstRankPawn = (s: Sq) => {
    const pc = p.board[s];
    return pc?.t === 'p' && rankOf(s) === (pc.c === 'w' ? 0 : 7);
  };
  if (!p.board.some((_, s) => firstRankPawn(s))) return toFen(p);
  const q = clonePos(p);
  for (let s = 0; s < 64; s++) {
    if (!firstRankPawn(s)) continue;
    const pc = q.board[s]!;
    const up = s + (pc.c === 'w' ? 8 : -8);
    q.board[s] = null;
    if (!q.board[up]) q.board[up] = pc;
  }
  return toFen(q);
}

export function clonePos(p: Position): Position {
  return { ...p, board: p.board.slice() };
}

// ---------- Requêtes ----------

export function findPieces(board: Board, c: Color, t?: PieceType): Sq[] {
  const out: Sq[] = [];
  for (let s = 0; s < 64; s++) {
    const pc = board[s];
    if (pc && pc.c === c && (!t || pc.t === t)) out.push(s);
  }
  return out;
}

export function kingSq(board: Board, c: Color): Sq | null {
  for (let s = 0; s < 64; s++) {
    const pc = board[s];
    if (pc && pc.c === c && pc.t === 'k') return s;
  }
  return null;
}

/** La case `s` est-elle attaquée par une pièce de couleur `by` ? */
export function isAttacked(board: Board, s: Sq, by: Color): boolean {
  const f = fileOf(s);
  const r = rankOf(s);
  // pions
  const pr = r - forward(by);
  for (const df of [-1, 1]) {
    if (onBoard(f + df, pr)) {
      const pc = board[sq(f + df, pr)];
      if (pc && pc.c === by && pc.t === 'p') return true;
    }
  }
  for (const [df, dr] of KNIGHT_JUMPS) {
    if (onBoard(f + df, r + dr)) {
      const pc = board[sq(f + df, r + dr)];
      if (pc && pc.c === by && pc.t === 'n') return true;
    }
  }
  for (const [df, dr] of QUEEN_DIRS) {
    if (onBoard(f + df, r + dr)) {
      const pc = board[sq(f + df, r + dr)];
      if (pc && pc.c === by && pc.t === 'k') return true;
    }
  }
  for (const [df, dr] of QUEEN_DIRS) {
    const diag = df !== 0 && dr !== 0;
    let ff = f + df;
    let rr = r + dr;
    while (onBoard(ff, rr)) {
      const pc = board[sq(ff, rr)];
      if (pc) {
        if (pc.c === by && (pc.t === 'q' || (diag ? pc.t === 'b' : pc.t === 'r'))) return true;
        break;
      }
      ff += df;
      rr += dr;
    }
  }
  return false;
}

export function inCheck(board: Board, c: Color): boolean {
  const k = kingSq(board, c);
  return k !== null && isAttacked(board, k, other(c));
}

/**
 * Une position est jouable si : un seul roi par camp, aucun pion sur sa rangée de promotion,
 * et le camp qui vient de jouer n'est pas en échec. Un pion sur sa propre première rangée
 * est permis (certaines cartes l'y amènent) : il avance alors d'une case. chess.js le gère ;
 * Stockfish non, d'où `engineFen`.
 */
export function isSane(p: Position): boolean {
  let wk = 0;
  let bk = 0;
  for (let s = 0; s < 64; s++) {
    const pc = p.board[s];
    if (!pc) continue;
    if (pc.t === 'k') pc.c === 'w' ? wk++ : bk++;
    if (pc.t === 'p' && rankOf(s) === (pc.c === 'w' ? 7 : 0)) return false;
  }
  if (wk !== 1 || bk !== 1) return false;
  return !inCheck(p.board, other(p.turn));
}

/** Recalcule les droits de roque d'après le placement (roi et tour sur leurs cases d'origine). */
export function normalizeCastling(p: Position): void {
  const b = p.board;
  const has = (s: string, t: PieceType, c: Color) => {
    const pc = b[parseSq(s)];
    return !!pc && pc.t === t && pc.c === c;
  };
  let out = '';
  for (const [flag, k, r, c] of [
    ['K', 'e1', 'h1', 'w'],
    ['Q', 'e1', 'a1', 'w'],
    ['k', 'e8', 'h8', 'b'],
    ['q', 'e8', 'a8', 'b'],
  ] as const) {
    if (p.castling.includes(flag) && has(k, 'k', c) && has(r, 'r', c)) out += flag;
  }
  p.castling = out || '-';
}

/**
 * Termine un « coup » de carte : renormalise la position et, si `endTurn`, passe la main.
 * Les captures éventuelles remettent le compteur des 50 coups à zéro (approximation suffisante).
 */
export function finishCardEffect(p: Position, endTurn: boolean): Position {
  normalizeCastling(p);
  p.ep = null;
  if (endTurn) {
    if (p.turn === 'b') p.fullmove++;
    p.turn = other(p.turn);
    p.halfmove = 0;
  }
  return p;
}

export function materialBalance(board: Board, c: Color): number {
  let s = 0;
  for (const pc of board) if (pc) s += pc.c === c ? PIECE_VALUE[pc.t] : -PIECE_VALUE[pc.t];
  return s;
}
