// Coups d'échecs « normaux » : on délègue à chess.js (roque, prise en passant, promotion).
import { Chess } from 'chess.js';
import { fromFen, parseSq, sqName, toFen, type PieceType, type Position, type Sq } from './position';

export interface NormalMove {
  from: Sq;
  to: Sq;
  piece: PieceType;
  captured?: PieceType;
  promotion?: PieceType;
  castle: boolean;
  san: string;
  /** Notation UCI (e2e4, e7e8q) — utile pour Stockfish. */
  uci: string;
}

const FR: Record<string, string> = { K: 'R', Q: 'D', R: 'T', B: 'F', N: 'C' };
/** Notation algébrique française : Cf3, Dxd7+, e8=D… */
export const frenchSan = (san: string) => san.replace(/[KQRBN]/g, (ch) => FR[ch]);

function load(p: Position): Chess {
  return new Chess(toFen(p), { skipValidation: true });
}

export function legalMoves(p: Position): NormalMove[] {
  return load(p)
    .moves({ verbose: true })
    .map((m) => ({
      from: parseSq(m.from),
      to: parseSq(m.to),
      piece: m.piece as PieceType,
      captured: m.captured as PieceType | undefined,
      promotion: m.promotion as PieceType | undefined,
      castle: m.flags.includes('k') || m.flags.includes('q'),
      san: frenchSan(m.san),
      uci: m.from + m.to + (m.promotion ?? ''),
    }));
}

export function applyMove(p: Position, m: Pick<NormalMove, 'from' | 'to' | 'promotion'>): Position {
  const c = load(p);
  c.move({ from: sqName(m.from), to: sqName(m.to), promotion: m.promotion });
  return fromFen(c.fen());
}

export function findMoveByUci(p: Position, uci: string): NormalMove | undefined {
  return legalMoves(p).find((m) => m.uci === uci);
}
