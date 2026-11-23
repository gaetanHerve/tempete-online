// Suivi d'identité des pièces entre deux positions, pour animer les déplacements
// (y compris ceux, farfelus, provoqués par les cartes).

import { fileOf, rankOf, type Board, type Color, type PieceType, type Sq } from '../core/position';

export interface TrackedPiece {
  id: number;
  sq: Sq;
  t: PieceType;
  c: Color;
}

let nextId = 1;

const dist = (a: Sq, b: Sq) => Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));

export function track(prev: TrackedPiece[], board: Board): TrackedPiece[] {
  const out: TrackedPiece[] = [];
  const free = new Set(prev);
  const pending: Sq[] = [];

  // 1. pièces restées en place
  for (let s = 0; s < 64; s++) {
    const pc = board[s];
    if (!pc) continue;
    const same = prev.find((p) => free.has(p) && p.sq === s && p.t === pc.t && p.c === pc.c);
    if (same) {
      free.delete(same);
      out.push(same);
    } else pending.push(s);
  }
  // 2. pièces déplacées : même type et couleur, la plus proche
  // 3. pièces transformées (promotion, vampirisme…) : même couleur, la plus proche
  for (const strict of [true, false]) {
    for (const s of [...pending]) {
      const pc = board[s]!;
      let best: TrackedPiece | null = null;
      for (const p of free) {
        if (p.c !== pc.c || (strict && p.t !== pc.t)) continue;
        if (!best || dist(p.sq, s) < dist(best.sq, s)) best = p;
      }
      if (best && (strict || dist(best.sq, s) <= 1)) {
        free.delete(best);
        out.push({ id: best.id, sq: s, t: pc.t, c: pc.c });
        pending.splice(pending.indexOf(s), 1);
      }
    }
  }
  // 4. pièces apparues
  for (const s of pending) out.push({ id: nextId++, sq: s, t: board[s]!.t, c: board[s]!.c });
  return out.sort((a, b) => a.id - b.id);
}
