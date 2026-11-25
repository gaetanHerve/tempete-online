// Cartes de Tempête sur l'échiquier entièrement automatisables.
//
// Chaque carte « plateau » énumère toutes ses options concrètes (`options`), avec la
// position résultante déjà calculée. L'interface humaine les sélectionne en touchant
// les cases de `path` dans l'ordre (puis un bouton si `label` départage), et le bot les
// évalue directement. Ajouter une carte = ajouter une entrée dans CARDS.

import type { NormalMove } from './chess';
import { msg, type Msg } from './msg';
import { applyMove, legalMoves } from './chess';
import {
  BISHOP_DIRS,
  KNIGHT_JUMPS,
  PIECE_LABEL,
  QUEEN_DIRS,
  clonePos,
  fileOf,
  inCheck,
  findPieces,
  finishCardEffect,
  forward,
  isLightSquare,
  isSane,
  kingSq,
  normalizeCastling,
  onBoard,
  other,
  rankOf,
  relRank,
  slideDirs,
  sq,
  sqName,
  toFen,
  type Board,
  type Color,
  type Piece,
  type PieceType,
  type Position,
  type Sq,
} from './position';

/**
 * Moment où la carte se joue, pendant son propre tour :
 * - before  : avant son coup (on doit ensuite jouer normalement)
 * - replace : à la place de son coup
 * - after   : juste après son coup
 * - anytime : avant ou après son coup
 * - reaction : pendant le tour adverse, juste après son coup normal
 * - counter  : juste après une carte adverse, pour l'annuler
 */
export type Timing = 'before' | 'replace' | 'after' | 'anytime' | 'reaction' | 'counter';

export interface CardContext {
  pos: Position;
  me: Color;
  /** Le coup normal que `me` vient de jouer (cartes « après votre coup »). */
  lastMove: NormalMove | null;
  /** Réactions : le coup normal que l'adversaire vient de jouer, et la position d'avant. */
  reactTo?: { before: Position; move: NormalMove } | null;
  /** Annulations : la carte adverse visée. */
  counterTo?: string | null;
}

export interface CardOption {
  /** Cases à toucher, dans l'ordre, pour choisir cette option. */
  path: Sq[];
  /**
   * Choix final non spatial (promotion, sens de rotation…). C'est un identifiant, repris tel
   * quel dans les actions (parties sauvegardées, en ligne) : il ne dépend pas de la langue.
   * L'interface le met en mots (src/i18n), ou affiche `labelMsg` quand il est fourni.
   */
  label?: string;
  labelMsg?: Msg;
  result: Position;
  /** Cases à mettre en évidence (pièces retirées, déplacées…). */
  marks: Sq[];
  summary: Msg;
  /** Choix de suivi (Douane) : renoncer au coup, qui doit être remplacé par un autre. */
  replay?: boolean;
  /** Choix de suivi appliqué dès qu'il est désigné, sans validation (étape réversible). */
  instant?: boolean;
  /**
   * Cartes à choix successifs : position finale estimée (choix simulés), pour que
   * l'ordinateur puisse juger la carte. `result` reste la position de départ.
   */
  estimate?: Position;
}

/** Contexte d'un choix de suivi (Zombies, Électrochoc, Douane). */
export interface FollowCtx {
  pos: Position;
  /** Joueur qui a posé la carte. */
  owner: Color;
  /** Cases déjà jouées pendant les choix (pièces placées ou déplacées). */
  moved: Sq[];
  /** Douane : le coup visé et la position d'avant. */
  reactTo?: { before: Position; move: NormalMove } | null;
  /** Position au début des choix. */
  start?: Position;
}

/** Prochain choix à faire : par qui, parmi quelles options, avec quelle consigne. */
export interface FollowStep {
  chooser: Color;
  options: CardOption[];
  prompt: Msg;
}

export interface CardDef {
  /**
   * Le nom et le texte de la carte, protégés par le droit d'auteur, ne figurent pas dans le
   * code : ils sont fournis à l'exécution par le coffre chiffré, dans chaque langue (src/i18n).
   */
  id: string;
  timing: Timing;
  /** Cartes plateau : options possibles dans ce contexte. */
  options?: (ctx: CardContext) => CardOption[];
  /** Cartes qui agissent sur les mains plutôt que sur le plateau. */
  hand?: 'redraw' | 'swap';
  /**
   * Réactions : suite de la partie une fois la carte jouée.
   * - rewrite : le coup adverse est remplacé par la position de l'option
   * - keep    : idem, mais le coup adverse reste valable (cartes « après » de l'adversaire)
   * - replay  : le coup est annulé, l'adversaire doit en jouer un autre
   * - duel    : un duel décide entre la position de l'option (victoire) et le coup tel quel
   */
  reaction?: 'rewrite' | 'keep' | 'replay' | 'duel';
  /** Réactions qui annulent le coup adverse : la sélection se fait sur la position d'avant. */
  showsBefore?: boolean;
  /** Choix successifs après la carte, éventuellement faits par l'adversaire (null = terminé). */
  followUp?: (ctx: FollowCtx) => FollowStep | null;
  /**
   * Règle temporaire posée par la carte (voir `rules` dans game.ts) :
   * - nextTurn : pour le prochain tour adverse seulement
   * - lasting  : jusqu'à ce que sa condition de fin soit remplie
   */
  rule?: 'nextTurn' | 'lasting';
  /**
   * Effets sur le déroulement du tour (traités par game.ts) :
   * - pass     : Je passe (on passe son tour, la carte reste en réserve pour rejouer plus tard)
   * - swap     : Double jeu (on échange sa place avec l'adversaire pendant trois tours)
   * - rebelote : deux cartes de plus ce tour-ci
   */
  turnEffect?: 'pass' | 'swap' | 'rebelote';
}


// ---------- helpers ----------

const PROMO_TYPES: PieceType[] = ['q', 'r', 'b', 'n'];

function neighbors(s: Sq): Sq[] {
  const out: Sq[] = [];
  for (const [df, dr] of QUEEN_DIRS) {
    const f = fileOf(s) + df;
    const r = rankOf(s) + dr;
    if (onBoard(f, r)) out.push(sq(f, r));
  }
  return out;
}

function ray(s: Sq, df: number, dr: number): Sq[] {
  const out: Sq[] = [];
  let f = fileOf(s) + df;
  let r = rankOf(s) + dr;
  while (onBoard(f, r)) {
    out.push(sq(f, r));
    f += df;
    r += dr;
  }
  return out;
}

const isEnemyNonKing = (b: Board, s: Sq, me: Color) => {
  const pc = b[s];
  return !!pc && pc.c !== me && pc.t !== 'k';
};

/**
 * Construit une option : clone la position, applique `mutate` sur le plateau,
 * renormalise, puis rejette le résultat s'il laisse le joueur en échec
 * ou produit une position invalide.
 */
function build(
  ctx: CardContext,
  endTurn: boolean,
  path: Sq[],
  mutate: (b: Board) => void,
  summary: Msg,
  marks: Sq[] = path,
  label?: string,
  labelMsg?: Msg,
): CardOption | null {
  const p = clonePos(ctx.pos);
  mutate(p.board);
  finishCardEffect(p, endTurn);
  if (!isSane(p)) return null;
  return { path, label, ...(labelMsg && { labelMsg }), result: p, marks, summary };
}

function compact(xs: (CardOption | null)[]): CardOption[] {
  return xs.filter((x): x is CardOption => x !== null);
}

function move(b: Board, from: Sq, to: Sq) {
  b[to] = b[from];
  b[from] = null;
}

const START_COUNT: Record<Exclude<PieceType, 'k'>, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/**
 * Types de pièces que `c` a perdus depuis le début, déduits du matériel restant
 * (une pièce en surnombre est comptée comme un pion promu). Approximation suffisante.
 */
export function lostPieces(b: Board, c: Color): PieceType[] {
  const n = (t: PieceType) => findPieces(b, c, t).length;
  const out: PieceType[] = [];
  let promoted = 0;
  for (const t of ['q', 'r', 'b', 'n'] as const) {
    const d = n(t) - START_COUNT[t];
    if (d < 0) out.push(t);
    else promoted += d;
  }
  if (n('p') + promoted < START_COUNT.p) out.push('p');
  return out;
}

/** Cases strictement entre deux cases alignées (vide si elles ne le sont pas). */
function between(a: Sq, b: Sq): Sq[] {
  const df = Math.sign(fileOf(b) - fileOf(a));
  const dr = Math.sign(rankOf(b) - rankOf(a));
  const nf = Math.abs(fileOf(b) - fileOf(a));
  const nr = Math.abs(rankOf(b) - rankOf(a));
  if (!(nf === 0 || nr === 0 || nf === nr)) return [];
  const out: Sq[] = [];
  for (let i = 1; i < Math.max(nf, nr); i++) out.push(sq(fileOf(a) + df * i, rankOf(a) + dr * i));
  return out;
}

/** Cases d'où une pièce de `by` attaque `target` (pour retrouver qui donne échec). */
function attackersOf(b: Board, target: Sq, by: Color): Sq[] {
  return findPieces(b, by).filter((s) => attacksAlone(b, s, target));
}

/** La pièce en `s` attaque-t-elle `target` (en tenant compte des obstacles) ? */
function attacksAlone(b: Board, s: Sq, target: Sq): boolean {
  const pc = b[s]!;
  const df = fileOf(target) - fileOf(s);
  const dr = rankOf(target) - rankOf(s);
  const clear = () => between(s, target).every((x) => !b[x]);
  switch (pc.t) {
    case 'p':
      return Math.abs(df) === 1 && dr === forward(pc.c);
    case 'n':
      return (Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1);
    case 'k':
      return Math.max(Math.abs(df), Math.abs(dr)) === 1;
    case 'b':
      return Math.abs(df) === Math.abs(dr) && df !== 0 && clear();
    case 'r':
      return (df === 0) !== (dr === 0) && clear();
    case 'q':
      return ((df === 0) !== (dr === 0) || (Math.abs(df) === Math.abs(dr) && df !== 0)) && clear();
  }
}

const anyCheck = (p: Position) => inCheck(p.board, 'w') || inCheck(p.board, 'b');

// ---------- réactions ----------

const SLIDERS: PieceType[] = ['b', 'r', 'q'];

/** Direction unitaire et longueur d'un coup en ligne droite. */
function lineOf(m: NormalMove): [number, number, number] {
  const df = fileOf(m.to) - fileOf(m.from);
  const dr = rankOf(m.to) - rankOf(m.from);
  const n = Math.max(Math.abs(df), Math.abs(dr));
  return [Math.sign(df), Math.sign(dr), n];
}

/**
 * Réaction construite à partir de la position d'avant le coup adverse : `mutate` y joue
 * le coup modifié. C'est ensuite à moi de jouer, et l'adversaire ne doit pas être en échec.
 */
function fromBefore(ctx: CardContext, path: Sq[], mutate: (b: Board) => void, summary: Msg, marks: Sq[] = path, label?: string): CardOption | null {
  const p = clonePos(ctx.reactTo!.before);
  mutate(p.board);
  finishCardEffect(p, true);
  if (!isSane(p)) return null;
  return { path, label, result: p, marks, summary };
}

/**
 * Glissade d'une pièce adverse au-delà de `start` (Olé, Verglas) : elle prend la première
 * de mes pièces rencontrée, s'arrête devant une pièce de son camp (ou devant mon Roi),
 * ou tombe de l'échiquier (dest = null).
 */
function slide(b: Board, start: Sq, df: number, dr: number, me: Color): { dest: Sq | null; victim: Sq | null } {
  let prev = start;
  for (const s of ray(start, df, dr)) {
    const o = b[s];
    if (!o) {
      prev = s;
      continue;
    }
    if (o.c === me && o.t !== 'k') return { dest: s, victim: s };
    return { dest: prev, victim: null };
  }
  return { dest: null, victim: null };
}

// ---------- choix de suivi ----------

/** Simule les choix (le premier à chaque fois) pour estimer l'effet d'une carte à choix. */
function simulate(def: Pick<CardDef, 'followUp'>, start: FollowCtx): Position {
  const ctx = { ...start, moved: [...start.moved] };
  for (let i = 0; i < 16; i++) {
    const step = def.followUp!(ctx);
    if (!step?.options.length) break;
    const o = step.options[0];
    ctx.pos = o.result;
    if (o.path.length) ctx.moved.push(o.path[o.path.length - 1]);
    if (o.replay) break;
  }
  return ctx.pos;
}

/** Option d'ouverture d'une carte à choix : rien ne bouge encore, l'estimation sert au bot. */
function opening(def: Pick<CardDef, 'followUp'>, ctx: CardContext, summary: Msg): CardOption[] {
  const start: FollowCtx = { pos: ctx.pos, owner: ctx.me, moved: [], reactTo: ctx.reactTo };
  if (!def.followUp!(start)?.options.length) return [];
  return [{ path: [], result: ctx.pos, marks: [], summary, estimate: simulate(def, start) }];
}

/** Rotation d'un quart de tour (vue des Blancs) : sens horaire si dir = 1. */
function rotateSq(s: Sq, dir: 1 | -1): Sq {
  const f = fileOf(s);
  const r = rankOf(s);
  return dir === 1 ? sq(r, 7 - f) : sq(7 - r, f);
}

// ---------- définitions ----------

export const CARDS: CardDef[] = [
  // ===== À la place de son coup =====
  {
    id: 'amourCourtois',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const targets = new Set<Sq>();
      for (const q of findPieces(b, ctx.me, 'q')) for (const s of neighbors(q)) if (!b[s]) targets.add(s);
      const out: (CardOption | null)[] = [];
      for (const n of findPieces(b, ctx.me, 'n'))
        for (const t of targets)
          out.push(build(ctx, true, [n, t], (bb) => move(bb, n, t), msg('fx.move', { piece: 'n', from: n, to: t })));
      return compact(out);
    },
  },
  {
    id: 'bonnesCopines',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const out: (CardOption | null)[] = [];
      for (const mine of findPieces(b, ctx.me, 'q'))
        for (const theirs of findPieces(b, other(ctx.me), 'q'))
          out.push(
            build(
              ctx,
              true,
              [mine, theirs],
              (bb) => {
                const t = bb[mine];
                bb[mine] = bb[theirs];
                bb[theirs] = t;
              },
              msg('fx.queensSwap', { a: mine, b: theirs }),
            ),
          );
      return compact(out);
    },
  },
  {
    id: 'chasseNeige',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const out: (CardOption | null)[] = [];
      for (const from of findPieces(b, ctx.me)) {
        const pc = b[from]!;
        for (const [df, dr] of slideDirs(pc.t)) {
          const swept: Sq[] = [];
          let dest: Sq | null = null;
          for (const s of ray(from, df, dr)) {
            const o = b[s];
            if (o && (o.c === ctx.me || o.t === 'k')) break;
            if (o) swept.push(s);
            dest = s;
          }
          if (dest === null) continue;
          const d = dest;
          out.push(
            build(
              ctx,
              true,
              [from, d],
              (bb) => {
                for (const s of swept) bb[s] = null;
                move(bb, from, d);
              },
              msg('fx.sweep', { piece: pc.t, from, to: d, count: swept.length }),
              [from, d, ...swept],
            ),
          );
        }
      }
      return compact(out);
    },
  },
  {
    id: 'coupDouble',
    timing: 'replace',
    options: (ctx) => {
      const moves = legalMoves(ctx.pos).filter(
        (m) => ['p', 'n', 'b', 'r'].includes(m.piece) && !m.castle && (!m.promotion || m.promotion === 'q') && !(m.piece === 'p' && m.captured && !ctx.pos.board[m.to]),
      );
      const out: (CardOption | null)[] = [];
      for (const a of moves)
        for (const c of moves) {
          if (a.piece !== c.piece || a.from === c.from || a.to === c.to || a.to === c.from || c.to === a.from) continue;
          out.push(
            build(
              ctx,
              true,
              [a.from, a.to, c.from, c.to],
              (bb) => {
                const pa = bb[a.from]!;
                const pcc = bb[c.from]!;
                bb[a.from] = null;
                bb[c.from] = null;
                bb[a.to] = a.promotion ? { t: a.promotion, c: pa.c } : pa;
                bb[c.to] = c.promotion ? { t: c.promotion, c: pcc.c } : pcc;
              },
              msg('fx.double', { piece: a.piece, a1: a.from, a2: a.to, b1: c.from, b2: c.to }),
            ),
          );
        }
      return compact(out);
    },
  },
  {
    id: 'elementIncontrole',
    timing: 'replace',
    options: (ctx) => {
      const flipped: Position = { ...clonePos(ctx.pos), turn: other(ctx.me), castling: '-', ep: null };
      const out: (CardOption | null)[] = [];
      for (const m of legalMoves(flipped)) {
        if (m.captured || m.castle) continue;
        const promos = m.promotion ? (m.promotion === 'q' ? PROMO_TYPES : []) : [undefined];
        for (const promo of promos)
          out.push(
            build(
              ctx,
              true,
              [m.from, m.to],
              (bb) => {
                const pc = bb[m.from]!;
                bb[m.from] = null;
                bb[m.to] = promo ? { t: promo, c: pc.c } : pc;
              },
              msg('fx.move', { piece: m.piece, foe: true, from: m.from, to: m.to, promo }),
              [m.from, m.to],
              promo ? PIECE_LABEL[promo] : undefined,
            ),
          );
      }
      return compact(out);
    },
  },
  {
    id: 'maison',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const home = ctx.me === 'w' ? 0 : 7;
      const files: Record<PieceType, number[]> = { p: [], n: [1, 6], b: [2, 5], r: [0, 7], q: [3], k: [4] };
      const out: (CardOption | null)[] = [];
      for (const from of findPieces(b, ctx.me)) {
        const pc = b[from]!;
        for (const f of files[pc.t]) {
          const to = sq(f, home);
          const o = b[to];
          if (to === from || (o && (o.c === ctx.me || o.t === 'k'))) continue;
          out.push(
            build(ctx, true, [from, to], (bb) => move(bb, from, to), msg('fx.move', { piece: pc.t, from, to, take: o?.t })),
          );
        }
      }
      return compact(out);
    },
  },
  {
    id: 'modestie',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const fw = forward(ctx.me);
      const out: (CardOption | null)[] = [];
      for (const from of findPieces(b, ctx.me)) {
        const pc = b[from]!;
        if (pc.t === 'p') continue;
        const f = fileOf(from);
        const r = rankOf(from);
        const dests: Sq[] = [];
        if (onBoard(f, r + fw) && !b[sq(f, r + fw)]) {
          dests.push(sq(f, r + fw));
          if (relRank(from, ctx.me) === 1 && !b[sq(f, r + 2 * fw)]) dests.push(sq(f, r + 2 * fw));
        }
        for (const df of [-1, 1]) if (onBoard(f + df, r + fw) && isEnemyNonKing(b, sq(f + df, r + fw), ctx.me)) dests.push(sq(f + df, r + fw));
        for (const to of dests) {
          const promote = relRank(to, ctx.me) === 7 && pc.t !== 'k';
          const kinds: (PieceType | undefined)[] = promote ? PROMO_TYPES : [undefined];
          for (const k of kinds)
            out.push(
              build(
                ctx,
                true,
                [from, to],
                (bb) => {
                  move(bb, from, to);
                  if (k) bb[to] = { t: k, c: ctx.me };
                },
                msg('fx.move', { piece: pc.t, from, to, promo: k && k !== pc.t ? k : null }),
                [from, to],
                k ? PIECE_LABEL[k] : undefined,
              ),
            );
        }
      }
      return compact(out);
    },
  },
  {
    id: 'ohDarling',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const k = kingSq(b, ctx.me);
      if (k === null) return [];
      const out: (CardOption | null)[] = [];
      for (const q of findPieces(b, ctx.me, 'q')) {
        for (const s of neighbors(q)) if (!b[s]) out.push(build(ctx, true, [k, s], (bb) => move(bb, k, s), msg('fx.move', { piece: 'k', from: k, to: s })));
        for (const s of neighbors(k)) if (!b[s]) out.push(build(ctx, true, [q, s], (bb) => move(bb, q, s), msg('fx.move', { piece: 'q', from: q, to: s })));
      }
      return compact(out);
    },
  },
  {
    id: 'paranoia',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const opp = other(ctx.me);
      const out: (CardOption | null)[] = [];
      for (const from of findPieces(b, opp, 'b'))
        for (const [df, dr] of BISHOP_DIRS) {
          const hit = ray(from, df, dr).find((s) => b[s]);
          if (hit === undefined) continue;
          const o = b[hit]!;
          if (o.c !== opp || o.t === 'k') continue;
          out.push(build(ctx, true, [from, hit], (bb) => move(bb, from, hit), msg('fx.paranoia', { from, victim: o.t, at: hit })));
        }
      return compact(out);
    },
  },
  {
    id: 'pegase',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const out: (CardOption | null)[] = [];
      for (const n of findPieces(b, ctx.me, 'n'))
        for (let s = 0; s < 64; s++)
          if (!b[s] && isLightSquare(s) !== isLightSquare(n)) out.push(build(ctx, true, [n, s], (bb) => move(bb, n, s), msg('fx.move', { piece: 'n', from: n, to: s })));
      return compact(out);
    },
  },
  {
    id: 'ratonLaveur',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const out: (CardOption | null)[] = [];
      for (const p of findPieces(b, ctx.me, 'p'))
        for (const s of findPieces(b, ctx.me))
          if (['n', 'b', 'r'].includes(b[s]!.t))
            out.push(
              build(
                ctx,
                true,
                [p, s],
                (bb) => {
                  const t = bb[p];
                  bb[p] = bb[s];
                  bb[s] = t;
                },
                msg('fx.raccoon', { from: p, piece: b[s]?.t, to: s }),
              ),
            );
      return compact(out);
    },
  },
  {
    id: 'remorque',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const fw = forward(ctx.me);
      const out: (CardOption | null)[] = [];
      for (const p of findPieces(b, ctx.me, 'p')) {
        const f = fileOf(p);
        const r = rankOf(p);
        if (!onBoard(f, r - fw) || !b[sq(f, r - fw)] || !onBoard(f, r + fw) || b[sq(f, r + fw)]) continue;
        const behind = sq(f, r - fw);
        const steps = [1];
        if (relRank(p, ctx.me) === 1 && !b[sq(f, r + 2 * fw)]) steps.push(2);
        for (const n of steps) {
          const to = sq(f, r + n * fw);
          const tow = sq(f, r + (n - 1) * fw);
          const kinds: (PieceType | undefined)[] = relRank(to, ctx.me) === 7 ? PROMO_TYPES : [undefined];
          for (const k of kinds)
            out.push(
              build(
                ctx,
                true,
                [p, to],
                (bb) => {
                  const pawn = bb[p]!;
                  const towed = bb[behind];
                  bb[p] = null;
                  bb[behind] = null;
                  bb[to] = k ? { t: k, c: pawn.c } : pawn;
                  bb[tow] = towed;
                },
                msg('fx.tow', { from: p, to, towed: b[behind]?.t }),
                [p, to, behind, tow],
                k ? PIECE_LABEL[k] : undefined,
              ),
            );
        }
      }
      return compact(out);
    },
  },
  {
    id: 'psychopathe',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const out: (CardOption | null)[] = [];
      for (const from of findPieces(b, ctx.me, 'b')) {
        const targets: Sq[] = [];
        for (const [df, dr] of BISHOP_DIRS) {
          const hit = ray(from, df, dr).find((s) => b[s]);
          if (hit !== undefined && isEnemyNonKing(b, hit, ctx.me)) targets.push(hit);
        }
        if (targets.length < 2) continue;
        out.push(
          build(
            ctx,
            true,
            [from],
            (bb) => {
              bb[from] = null;
              for (const t of targets) bb[t] = null;
            },
            msg('fx.psycho', { from, count: targets.length }),
            [from, ...targets],
          ),
        );
      }
      return compact(out);
    },
  },

  {
    id: 'angeGardien',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const k = kingSq(b, ctx.me);
      if (k === null || !inCheck(b, ctx.me)) return [];
      const lost = lostPieces(b, ctx.me);
      if (!lost.length) return [];
      const squares = new Set<Sq>();
      for (const a of attackersOf(b, k, other(ctx.me))) for (const s of between(a, k)) if (!b[s]) squares.add(s);
      const out: (CardOption | null)[] = [];
      for (const s of squares)
        for (const t of lost)
          out.push(
            build(ctx, true, [s], (bb) => (bb[s] = { t, c: ctx.me }), msg('fx.guardian', { piece: t, at: s }), [s], PIECE_LABEL[t]),
          );
      return compact(out);
    },
  },
  {
    id: 'voyageAstral',
    timing: 'replace',
    options: (ctx) => {
      const p = ctx.pos;
      const usual = new Set(legalMoves(p).map((m) => m.uci));
      const out: CardOption[] = [];
      for (let x = 0; x < 64; x++) {
        const traveller = p.board[x];
        if (!traveller || traveller.t === 'k') continue;
        const reduced = clonePos(p);
        reduced.board[x] = null;
        normalizeCastling(reduced); // pas de roque avec une Tour partie en voyage
        for (const m of legalMoves(reduced)) {
          // seuls les coups que le voyage rend possibles ont un intérêt
          if (m.to === x || m.from === x || usual.has(m.uci)) continue;
          const r = applyMove(reduced, m);
          r.board[x] = traveller;
          finishCardEffect(r, false);
          if (!isSane(r)) continue;
          out.push({
            path: [x, m.from, m.to],
            label: m.promotion ? PIECE_LABEL[m.promotion] : undefined,
            result: r,
            marks: [x, m.from, m.to],
            summary: msg('fx.astral', { piece: traveller.t, at: x, san: m.san }),
          });
        }
      }
      return out;
    },
  },

  // ===== Après son coup =====
  {
    id: 'appartheid',
    timing: 'after',
    options: (ctx) => {
      const b = ctx.pos.board;
      const victims: Sq[] = [];
      for (let s = 0; s < 64; s++) {
        const pc = b[s];
        if (pc?.t === 'p' && (pc.c === 'b') === isLightSquare(s)) victims.push(s);
      }
      if (!victims.length) return [];
      return compact([build(ctx, false, [], (bb) => victims.forEach((s) => (bb[s] = null)), msg('fx.pawnsRemoved', { count: victims.length }), victims)]);
    },
  },
  {
    id: 'grosseDeprime',
    timing: 'after',
    options: (ctx) => {
      const b = ctx.pos.board;
      return compact(
        findPieces(b, other(ctx.me), 'p')
          .filter((p) => neighbors(p).every((s) => !b[s]))
          .map((p) => build(ctx, false, [p], (bb) => (bb[p] = null), msg('fx.pawnRemoved', { at: p }))),
      );
    },
  },
  {
    id: 'laser',
    timing: 'after',
    options: (ctx) => {
      const b = ctx.pos.board;
      const out: (CardOption | null)[] = [];
      for (const from of findPieces(b, ctx.me)) {
        const pc = b[from]!;
        for (const [df, dr] of slideDirs(pc.t)) {
          const line = ray(from, df, dr);
          const victims = line.filter((s) => b[s] && b[s]!.t !== 'k');
          if (!victims.length) continue;
          out.push(
            build(ctx, false, [from, line[0]], (bb) => victims.forEach((s) => (bb[s] = null)), msg('fx.laser', { from, count: victims.length }), [
              from,
              ...victims,
            ]),
          );
        }
      }
      return compact(out);
    },
  },
  {
    id: 'majorettes',
    timing: 'after',
    options: (ctx) => {
      const b = ctx.pos.board;
      const steps: [Sq, Sq][] = [];
      for (const p of findPieces(b, ctx.me, 'p'))
        for (const df of [-1, 1]) {
          const f = fileOf(p) + df;
          if (onBoard(f, rankOf(p)) && !b[sq(f, rankOf(p))]) steps.push([p, sq(f, rankOf(p))]);
        }
      const out: (CardOption | null)[] = [];
      for (const [a, ad] of steps)
        for (const [c, cd] of steps) {
          if (a === c || ad === cd) continue;
          out.push(
            build(
              ctx,
              false,
              [a, ad, c, cd],
              (bb) => {
                move(bb, a, ad);
                move(bb, c, cd);
              },
              msg('fx.double', { piece: 'p', a1: a, a2: ad, b1: c, b2: cd }),
            ),
          );
        }
      return compact(out);
    },
  },
  {
    id: 'quadrille',
    timing: 'after',
    options: (ctx) => {
      const b = ctx.pos.board;
      const corners = [0, 56, 63, 7]; // a1 → a8 → h8 → h1 (sens horaire vu des Blancs)
      if (corners.every((s) => !b[s])) return [];
      const rotate = (dir: 1 | -1) => (bb: Board) => {
        const saved = corners.map((s) => bb[s]);
        corners.forEach((s, i) => (bb[corners[(i + dir + 4) % 4]] = saved[i]));
      };
      return compact([
        build(ctx, false, [], rotate(1), msg('fx.cornersCw'), corners, 'Sens horaire'),
        build(ctx, false, [], rotate(-1), msg('fx.cornersCcw'), corners, 'Sens anti-horaire'),
      ]);
    },
  },
  {
    id: 'promotionALAnciennete',
    timing: 'after',
    options: (ctx) => {
      const pawns = findPieces(ctx.pos.board, ctx.me, 'p');
      if (pawns.length < 1 || pawns.length > 2) return [];
      const kinds: PieceType[] = ['r', 'b', 'n'];
      const combos: PieceType[][] = pawns.length === 1 ? kinds.map((k) => [k]) : kinds.flatMap((k) => kinds.map((k2) => [k, k2]));
      return compact(
        combos.map((combo) =>
          build(
            ctx,
            false,
            [],
            (bb) => pawns.forEach((p, i) => (bb[p] = { t: combo[i], c: ctx.me })),
            msg('fx.promotions', { at: pawns, pieces: combo }),
            pawns,
            combo.map((k, i) => `${PIECE_LABEL[k]} (${sqName(pawns[i])})`).join(' + '),
            msg('label.promotions', { at: pawns, pieces: combo }),
          ),
        ),
      );
    },
  },
  {
    id: 'promotionAuMerite',
    timing: 'after',
    options: (ctx) => {
      const m = ctx.lastMove;
      if (!m || m.piece !== 'p' || relRank(m.to, ctx.me) !== 5) return [];
      return compact(
        PROMO_TYPES.map((k) => build(ctx, false, [m.to], (bb) => (bb[m.to] = { t: k, c: ctx.me }), msg('fx.promoted', { at: m.to, piece: k }), [m.to], PIECE_LABEL[k])),
      );
    },
  },
  {
    id: 'vampirisme',
    timing: 'after',
    options: (ctx) => {
      const m = ctx.lastMove;
      const pc = m && ctx.pos.board[m.to];
      if (!m || !m.captured || !pc || pc.t === m.captured) return [];
      const victim = m.captured;
      return compact([
        build(ctx, false, [m.to], (bb) => (bb[m.to] = { t: victim, c: ctx.me }), msg('fx.becomes', { piece: pc.t, at: m.to, into: victim })),
      ]);
    },
  },
  {
    id: 'pasDeDeux',
    timing: 'after',
    options: (ctx) => {
      const m = ctx.lastMove;
      if (!m || m.castle) return [];
      const b = ctx.pos.board;
      const df = fileOf(m.to) - fileOf(m.from);
      const dr = rankOf(m.to) - rankOf(m.from);
      const straight = df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr);
      const n = Math.max(Math.abs(df), Math.abs(dr));
      const out: (CardOption | null)[] = [];
      for (const from of findPieces(b, ctx.me)) {
        if (from === m.to) continue;
        const f = fileOf(from) + df;
        const r = rankOf(from) + dr;
        if (!onBoard(f, r)) continue;
        const to = sq(f, r);
        const o = b[to];
        if (o && (o.c === ctx.me || o.t === 'k')) continue;
        if (straight) {
          let blocked = false;
          for (let i = 1; i < n; i++) if (b[sq(fileOf(from) + (df / n) * i, rankOf(from) + (dr / n) * i)]) blocked = true;
          if (blocked) continue;
        }
        const pc = b[from]!;
        const promote = pc.t === 'p' && relRank(to, ctx.me) === 7;
        out.push(
          build(
            ctx,
            false,
            [from, to],
            (bb) => {
              move(bb, from, to);
              if (promote) bb[to] = { t: 'q', c: ctx.me };
            },
            msg('fx.move', { piece: pc.t, from, to, take: o?.t }),
          ),
        );
      }
      return compact(out);
    },
  },

  {
    id: 'encephalopathieSpongiformeEquine',
    timing: 'after',
    options: (ctx) => {
      const b = ctx.pos.board;
      const out: (CardOption | null)[] = [];
      for (const s of [...findPieces(b, ctx.me, 'n'), ...findPieces(b, other(ctx.me), 'n')]) {
        const pc = b[s]!;
        out.push(build(ctx, false, [s], (bb) => (bb[s] = { t: 'b', c: pc.c }), msg('fx.bse', { foe: pc.c !== ctx.me, at: s })));
      }
      return compact(out);
    },
  },
  {
    id: 'serialKiller',
    timing: 'after',
    options: (ctx) => {
      const m = ctx.lastMove;
      if (!m || m.piece !== 'p' || !m.captured || m.promotion) return [];
      const fw = forward(ctx.me);
      const out: (CardOption | null)[] = [];
      // toutes les séries de prises maximales (le pion s'arrête quand il ne peut plus prendre)
      const walk = (b: Board, at: Sq, chain: Sq[]) => {
        const next: Sq[] = [];
        for (const df of [-1, 1]) {
          const f = fileOf(at) + df;
          const r = rankOf(at) + fw;
          if (onBoard(f, r) && isEnemyNonKing(b, sq(f, r), ctx.me)) next.push(sq(f, r));
        }
        if (!next.length) {
          if (chain.length < 2) return; // il faut au moins une prise supplémentaire
          const final = b.slice();
          out.push(build(ctx, false, chain, (bb) => bb.splice(0, 64, ...final), msg('fx.serial', { count: chain.length - 1 }), chain));
          return;
        }
        for (const t of next) {
          const bb = b.slice();
          bb[t] = relRank(t, ctx.me) === 7 ? { t: 'q', c: ctx.me } : bb[at];
          bb[at] = null;
          // promu, il n'est plus un pion : la frénésie s'arrête là
          if (relRank(t, ctx.me) === 7) {
            const final = bb;
            out.push(build(ctx, false, [...chain, t], (x) => x.splice(0, 64, ...final), msg('fx.serialQueen', { count: chain.length }), [...chain, t]));
          } else walk(bb, t, [...chain, t]);
        }
      };
      walk(ctx.pos.board, m.to, [m.to]);
      return compact(out);
    },
  },
  {
    id: 'tournezManege',
    timing: 'after',
    options: (ctx) => {
      const turn = (dir: 1 | -1) => (bb: Board) => {
        const src = bb.slice();
        bb.fill(null);
        for (let s = 0; s < 64; s++) {
          const pc = src[s];
          if (!pc) continue;
          const t = rotateSq(s, dir);
          bb[t] = pc.t === 'p' && rankOf(t) === (pc.c === 'w' ? 7 : 0) ? { t: 'q', c: pc.c } : pc;
        }
      };
      const all = [...Array(64).keys()].filter((s) => ctx.pos.board[s]);
      return compact([
        build(ctx, false, [], turn(1), msg('fx.boardCw'), all, 'Sens horaire'),
        build(ctx, false, [], turn(-1), msg('fx.boardCcw'), all, 'Sens anti-horaire'),
      ]);
    },
  },
  // ===== Pendant le tour adverse =====
  {
    id: 'brouillard',
    timing: 'reaction',
    reaction: 'rewrite',
    options: (ctx) => {
      const m = ctx.reactTo?.move;
      if (!m || m.castle || !SLIDERS.includes(m.piece)) return [];
      const [df, dr, n] = lineOf(m);
      if (n < 2) return [];
      const stop = sq(fileOf(m.from) + df, rankOf(m.from) + dr);
      return compact([fromBefore(ctx, [], (b) => move(b, m.from, stop), msg('fx.stopped', { piece: m.piece, at: stop }), [m.from, stop])]);
    },
  },
  {
    id: 'contrordre',
    timing: 'reaction',
    reaction: 'replay',
    options: (ctx) => {
      const r = ctx.reactTo;
      if (!r || !legalMoves(r.before).some((x) => x.uci !== r.move.uci)) return [];
      return [{ path: [], result: clonePos(r.before), marks: [r.move.from, r.move.to], summary: msg('fx.moveCancelled', { san: r.move.san }) }];
    },
  },
  {
    id: 'ruade',
    timing: 'reaction',
    reaction: 'rewrite',
    showsBefore: true,
    options: (ctx) => {
      const r = ctx.reactTo;
      const m = r?.move;
      if (!r || !m || m.piece !== 'n') return [];
      const out: (CardOption | null)[] = [];
      for (const [df, dr] of KNIGHT_JUMPS) {
        const f = fileOf(m.from) + df;
        const rk = rankOf(m.from) + dr;
        if (!onBoard(f, rk)) continue;
        const s = sq(f, rk);
        const o = r.before.board[s];
        if (s === m.to || o?.t === 'k') continue;
        out.push(fromBefore(ctx, [m.from, s], (b) => move(b, m.from, s), msg('fx.move', { piece: 'n', foe: true, from: m.from, to: s, take: o?.t }), [m.from, s]));
      }
      return compact(out);
    },
  },
  {
    id: 'dalaiLama',
    timing: 'reaction',
    reaction: 'keep',
    options: (ctx) => {
      const m = ctx.reactTo?.move;
      if (!m?.captured) return [];
      const t = m.captured;
      const home = ctx.me === 'w' ? 0 : 7;
      const files: Record<PieceType, number[]> = { p: [0, 1, 2, 3, 4, 5, 6, 7], n: [1, 6], b: [2, 5], r: [0, 7], q: [3], k: [] };
      const rank = t === 'p' ? home + forward(ctx.me) : home;
      const out: (CardOption | null)[] = [];
      for (const f of files[t]) {
        const s = sq(f, rank);
        if (ctx.pos.board[s]) continue;
        out.push(build(ctx, false, [s], (b) => (b[s] = { t, c: ctx.me }), msg('fx.reincarnated', { piece: t, at: s })));
      }
      return compact(out);
    },
  },
  {
    id: 'duel',
    timing: 'reaction',
    reaction: 'duel',
    options: (ctx) => {
      const m = ctx.reactTo?.move;
      if (!m?.captured || m.piece === 'k') return [];
      return compact([fromBefore(ctx, [], (b) => (b[m.from] = null), msg('fx.duel', { attacker: m.piece, defender: m.captured }), [m.from, m.to])]);
    },
  },
  {
    id: 'toiAussiMonFils',
    timing: 'reaction',
    reaction: 'rewrite',
    options: (ctx) => {
      const b = ctx.pos.board;
      const k = kingSq(b, ctx.me);
      if (!ctx.reactTo || k === null || !inCheck(b, ctx.me)) return [];
      return compact(
        attackersOf(b, k, other(ctx.me)).map((s) => build(ctx, false, [s], (bb) => (bb[s] = { t: bb[s]!.t, c: ctx.me }), msg('fx.defects', { piece: b[s]?.t, at: s }))),
      );
    },
  },
  {
    id: 'pitie',
    timing: 'reaction',
    reaction: 'rewrite',
    options: (ctx) => {
      const m = ctx.reactTo?.move;
      if (!m || m.captured !== 'p' || !SLIDERS.includes(m.piece)) return [];
      const [df, dr] = lineOf(m);
      const stop = sq(fileOf(m.to) - df, rankOf(m.to) - dr);
      return compact([
        fromBefore(ctx, [], (b) => move(b, m.from, stop), msg(stop === m.from ? 'fx.stays' : 'fx.stopped', { piece: m.piece, at: stop }), [m.from, stop, m.to]),
      ]);
    },
  },
  {
    id: 'ole',
    timing: 'reaction',
    reaction: 'rewrite',
    options: (ctx) => {
      const r = ctx.reactTo;
      const m = r?.move;
      if (!r || !m?.captured || !SLIDERS.includes(m.piece) || r.before.board[m.to]?.c !== ctx.me) return [];
      const [df, dr] = lineOf(m);
      const { dest, victim } = slide(r.before.board, m.to, df, dr, ctx.me);
      if (dest === m.to) return []; // bloquée juste derrière ma pièce : elle ne peut aller nulle part
      return compact([fromBefore(ctx, [], (b) => {
        const pc = b[m.from];
        b[m.from] = null;
        if (dest !== null) b[dest] = pc;
      }, dest === null ? msg('fx.falls', { piece: m.piece }) : msg('fx.endsAt', { piece: m.piece, at: dest, take: victim !== null ? r.before.board[victim]?.t : null }), [m.from, m.to, ...(dest !== null ? [dest] : [])])]);
    },
  },
  {
    id: 'verglas',
    timing: 'reaction',
    reaction: 'rewrite',
    options: (ctx) => {
      const r = ctx.reactTo;
      const m = r?.move;
      if (!r || !m || m.captured || m.castle || !SLIDERS.includes(m.piece)) return [];
      const [df, dr] = lineOf(m);
      const before = r.before.board.slice();
      before[m.from] = null; // la pièce a quitté sa case : elle ne se bloque pas sur elle-même
      const { dest, victim } = slide(before, m.to, df, dr, ctx.me);
      if (dest === m.to) return [];
      return compact([fromBefore(ctx, [], (b) => {
        const pc = b[m.from];
        b[m.from] = null;
        if (dest !== null) b[dest] = pc;
      }, dest === null ? msg('fx.slidesOff', { piece: m.piece }) : msg('fx.slidesTo', { piece: m.piece, at: dest, take: victim !== null ? r.before.board[victim]?.t : null }), [m.from, m.to, ...(dest !== null ? [dest] : [])])]);
    },
  },
  // ===== Règles temporaires =====
  {
    id: 'provocation',
    timing: 'after',
    rule: 'nextTurn',
    options: (ctx) => (inCheck(ctx.pos.board, other(ctx.me)) ? [] : [{ path: [], result: ctx.pos, marks: [], summary: msg('fx.provocation') }]),
  },
  {
    id: 'cessezLeFeu',
    timing: 'after',
    rule: 'lasting',
    options: (ctx) => (anyCheck(ctx.pos) ? [] : [{ path: [], result: ctx.pos, marks: [], summary: msg('fx.ceasefire') }]),
  },
  {
    id: 'fringale',
    timing: 'after',
    rule: 'lasting',
    // (en phase « après », c'est déjà à l'adversaire de jouer : il doit pouvoir prendre)
    options: (ctx) => (legalMoves(ctx.pos).some((m) => m.captured) ? [{ path: [], result: ctx.pos, marks: [], summary: msg('fx.fringale') }] : []),
  },
  {
    id: 'planque',
    timing: 'after',
    rule: 'lasting',
    options: (ctx) => {
      const b = ctx.pos.board;
      if (inCheck(b, other(ctx.me))) return [];
      return findPieces(b, other(ctx.me)).map((s) => ({ path: [s], result: ctx.pos, marks: [s], summary: msg('fx.asleep', { piece: b[s]?.t, at: s }) }));
    },
  },
  {
    id: 'origines',
    timing: 'after',
    rule: 'lasting',
    options: (ctx) => (anyCheck(ctx.pos) ? [] : [{ path: [], result: ctx.pos, marks: [], summary: msg('fx.noCards') }]),
  },
  {
    id: 'voyance',
    timing: 'after',
    rule: 'nextTurn',
    options: (ctx) => {
      // annuler le coup d'un Roi en échec l'y laisserait : pas de Voyance dans ce cas
      if (inCheck(ctx.pos.board, other(ctx.me))) return [];
      // (pas de surlignage : le choix doit rester secret pour l'adversaire)
      const from = new Set(legalMoves(ctx.pos).map((m) => m.from));
      return [...from].map((s) => ({ path: [s], result: ctx.pos, marks: [], summary: msg('fx.secret') }));
    },
  },
  // ===== Déroulement du tour =====
  {
    id: 'jePasse',
    timing: 'before',
    turnEffect: 'pass',
    // (passer son tour en échec laisserait son Roi en prise)
    options: (ctx) => (inCheck(ctx.pos.board, ctx.me) ? [] : [{ path: [], result: ctx.pos, marks: [], summary: msg('fx.pass') }]),
  },
  {
    id: 'doubleJeu',
    timing: 'after',
    turnEffect: 'swap',
    options: (ctx) => [{ path: [], result: ctx.pos, marks: [], summary: msg('fx.swap') }],
  },
  {
    id: 'rebeloteEtDixDeDer',
    timing: 'anytime',
    turnEffect: 'rebelote',
    options: (ctx) => [{ path: [], result: ctx.pos, marks: [], summary: msg('fx.rebelote') }],
  },
  // ===== Cartes à choix successifs =====
  zombiesDef(),
  electrochocDef(),
  roqueEtRolleDef(),
  douaneDef(),
  // ===== Annulations =====
  ...(['non', 'niet'] as const).map(
    (id): CardDef => ({
      id,
      timing: 'counter',
      options: (ctx) => (ctx.counterTo ? [{ path: [], result: ctx.pos, marks: [], summary: msg('fx.counter', { card: ctx.counterTo }) }] : []),
    }),
  ),
  // ===== Cartes de main =====
  {
    id: 'coupDeBalai',
    timing: 'anytime',
    hand: 'redraw',
  },
  {
    id: 'donneMoiTaMain',
    timing: 'before',
    hand: 'swap',
  },
];

// ---------- définitions des cartes à choix ----------

function zombiesDef(): CardDef {
  const def: CardDef = {
    id: 'zombies',
    timing: 'before',
    options: (ctx) => opening(def, ctx, msg('fx.zombies')),
    followUp: (ctx) => {
      const opp = other(ctx.owner);
      const placed = (c: Color) => ctx.moved.filter((s) => ctx.pos.board[s]?.c === c).length;
      const placements = (c: Color): CardOption[] => {
        if (!lostPieces(ctx.pos.board, c).includes('p')) return [];
        const rank = c === 'w' ? 1 : 6;
        const out: CardOption[] = [];
        for (let f = 0; f < 8; f++) {
          const s = sq(f, rank);
          if (ctx.pos.board[s]) continue;
          const p = clonePos(ctx.pos);
          p.board[s] = { t: 'p', c };
          normalizeCastling(p);
          // le joueur de la carte jouera ensuite : son adversaire ne doit pas être en échec
          if (!isSane(p)) continue;
          out.push({ path: [s], result: p, marks: [s], summary: msg('fx.pawnBack', { foe: c !== ctx.owner, at: s }) });
        }
        return out;
      };
      // à tour de rôle, l'adversaire d'abord ; deux pions au plus chacun
      const order = placed(opp) <= placed(ctx.owner) ? [opp, ctx.owner] : [ctx.owner, opp];
      for (const c of order) {
        if (placed(c) >= 2) continue;
        const options = placements(c);
        if (options.length) return { chooser: c, options, prompt: msg('prompt.zombies') };
      }
      return null;
    },
  };
  return def;
}

function electrochocDef(): CardDef {
  const def: CardDef = {
    id: 'electrochoc',
    timing: 'after',
    options: (ctx) => opening(def, ctx, msg('fx.electro')),
    followUp: (ctx) => {
      const steps = (c: Color): CardOption[] => {
        const out: CardOption[] = [];
        for (const s of findPieces(ctx.pos.board, c, 'b')) {
          if (ctx.moved.includes(s)) continue;
          for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const f = fileOf(s) + df;
            const r = rankOf(s) + dr;
            if (!onBoard(f, r) || ctx.pos.board[sq(f, r)]) continue;
            const t = sq(f, r);
            const p = clonePos(ctx.pos);
            move(p.board, s, t);
            normalizeCastling(p);
            // c'est ensuite à l'adversaire de la carte : le Roi de son joueur ne doit pas être en échec
            if (!isSane(p)) continue;
            out.push({ path: [s, t], result: p, marks: [s, t], summary: msg('fx.move', { piece: 'b', from: s, to: t }) });
          }
        }
        return out;
      };
      for (const c of [other(ctx.owner), ctx.owner]) {
        const options = steps(c);
        if (options.length) return { chooser: c, options, prompt: msg('prompt.electro') };
      }
      return null;
    },
  };
  return def;
}

/** Existe-t-il un arrangement de la rangée `row` qui ne laisse pas le Roi de `me` en échec ? */
function safeArrangementExists(pos: Position, me: Color, row: Sq[]): boolean {
  const pieces = row.map((s) => pos.board[s]).filter((p): p is Piece => !!p);
  const b = pos.board.slice();
  for (const s of row) b[s] = null;
  const used = new Array(pieces.length).fill(false);
  const place = (i: number): boolean => {
    if (i === row.length) return pieces.every((_, k) => used[k]) && !inCheck(b, me);
    // case laissée vide (s'il reste assez de cases pour les pièces à placer)
    if (row.length - i > used.filter((u) => !u).length && place(i + 1)) return true;
    const tried = new Set<string>();
    for (let k = 0; k < pieces.length; k++) {
      const key = pieces[k].t;
      if (used[k] || tried.has(key)) continue; // deux pièces identiques : un seul essai
      tried.add(key);
      used[k] = true;
      b[row[i]] = pieces[k];
      if (place(i + 1)) return true;
      b[row[i]] = null;
      used[k] = false;
    }
    return false;
  };
  return place(0);
}

function roqueEtRolleDef(): CardDef {
  const firstRank = (c: Color) => [...Array(8).keys()].map((f) => sq(f, c === 'w' ? 0 : 7));
  const def: CardDef = {
    id: 'roqueEtRolle',
    timing: 'replace',
    options: (ctx) => {
      const b = ctx.pos.board;
      const row = firstRank(ctx.me);
      if (row.some((s) => b[s] && b[s]!.c !== ctx.me) || !row.some((s) => b[s])) return [];
      // jouable même en échec, pourvu qu'un arrangement protège le Roi (au joueur de le trouver)
      if (inCheck(b, ctx.me) && !safeArrangementExists(ctx.pos, ctx.me, row)) return [];
      // pas d'estimation : l'ordinateur ne sait pas juger un réarrangement, il ne joue pas cette carte
      return [{ path: [], result: ctx.pos, marks: row, summary: msg('fx.rearrange') }];
    },
    followUp: (ctx) => {
      if (ctx.pos.turn !== ctx.owner) return null; // « Terminer » a été choisi
      const b = ctx.pos.board;
      const row = firstRank(ctx.owner);
      const options: CardOption[] = [];
      // échanger deux cases de la rangée (une case vide : la pièce s'y déplace)
      for (const a of row) {
        if (!b[a]) continue;
        for (const t of row) {
          if (t === a) continue;
          const p = clonePos(ctx.pos);
          [p.board[a], p.board[t]] = [p.board[t], p.board[a]];
          options.push({
            path: [a, t],
            result: p,
            marks: [a, t],
            summary: b[t] ? msg('fx.swapPieces', { pa: b[a]?.t, a, pb: b[t]?.t, b: t }) : msg('fx.move', { piece: b[a]?.t, from: a, to: t }),
            instant: true,
          });
        }
      }
      const done = clonePos(ctx.pos);
      finishCardEffect(done, true);
      if (isSane(done)) options.push({ path: [], label: 'Terminer', result: done, marks: row, summary: msg('fx.rowDone') });
      else if (ctx.start) {
        // Roi en échec ici : tout remettre en place pour repartir du début, ou renoncer à la carte
        if (toFen(ctx.start) !== toFen(ctx.pos))
          options.push({ path: [], label: 'Annuler et réessayer', result: clonePos(ctx.start), marks: row, summary: msg('fx.rowReset') });
        options.push({ path: [], label: 'Renoncer', result: clonePos(ctx.start), marks: row, summary: msg('fx.rowGiveUp'), replay: true });
      }
      return { chooser: ctx.owner, options, prompt: msg('prompt.row') };
    },
  };
  return def;
}

function douaneDef(): CardDef {
  const def: CardDef = {
    id: 'douane',
    timing: 'reaction',
    reaction: 'keep',
    options: (ctx) => {
      const m = ctx.reactTo?.move;
      const mover = other(ctx.me);
      if (!m || !(relRank(m.from, mover) <= 3 && relRank(m.to, mover) >= 4)) return [];
      return opening(def, ctx, msg('fx.douane'));
    },
    followUp: (ctx) => {
      const r = ctx.reactTo;
      if (!r || ctx.moved.length) return null; // un seul choix
      const mover = other(ctx.owner);
      const options: CardOption[] = [];
      for (const s of findPieces(ctx.pos.board, mover, 'p')) {
        const p = clonePos(ctx.pos);
        p.board[s] = null;
        if (isSane(p)) options.push({ path: [s], result: p, marks: [s], summary: msg('fx.douanePay', { at: s }) });
      }
      if (legalMoves(r.before).some((x) => x.uci !== r.move.uci))
        options.push({ path: [], label: 'Renoncer au coup', result: clonePos(r.before), marks: [r.move.from, r.move.to], summary: msg('fx.giveUp', { san: r.move.san }), replay: true });
      return options.length ? { chooser: mover, options, prompt: msg('prompt.douane') } : null;
    },
  };
  return def;
}

export const CARD_BY_ID: Record<string, CardDef> = Object.fromEntries(CARDS.map((c) => [c.id, c]));

/** Étape (position dans `path`) où l'on choisit une direction à partir de la case précédente : flèches sur l'échiquier. */
export const DIRECTION_STEP: Record<string, number> = { laser: 1, chasseNeige: 1 };

// ---------- défausse ----------

const count = (p: Position, c: Color, types: PieceType[]) => findPieces(p.board, c).filter((s) => types.includes(p.board[s]!.t)).length;

/**
 * Une carte est « morte » quand le matériel dont elle a besoin n'existe plus sur l'échiquier
 * (ex. Pégase sans aucun Cavalier). Ce n'est pas la même chose qu'une carte simplement
 * injouable en ce moment (mauvais moment, pas de case libre, pas de cible…) : seule une
 * carte morte peut être défaussée. Les cartes absentes de cette table ne meurent jamais.
 */
const DEAD_WHEN: Record<string, (p: Position, me: Color) => boolean> = {
  amourCourtois: (p, me) => !count(p, me, ['n']) || !count(p, me, ['q']),
  bonnesCopines: (p, me) => !count(p, me, ['q']) || !count(p, other(me), ['q']),
  chasseNeige: (p, me) => !count(p, me, ['r', 'b', 'q']),
  coupDouble: (p, me) => (['p', 'n', 'b', 'r'] as PieceType[]).every((t) => count(p, me, [t]) < 2),
  ohDarling: (p, me) => !count(p, me, ['q']),
  paranoia: (p, me) => !count(p, other(me), ['b']),
  pegase: (p, me) => !count(p, me, ['n']),
  ratonLaveur: (p, me) => !count(p, me, ['p']) || !count(p, me, ['n', 'b', 'r']),
  remorque: (p, me) => !count(p, me, ['p']),
  psychopathe: (p, me) => !count(p, me, ['b']),
  appartheid: (p) => !count(p, 'w', ['p']) && !count(p, 'b', ['p']),
  grosseDeprime: (p, me) => !count(p, other(me), ['p']),
  laser: (p, me) => !count(p, me, ['r', 'b', 'q']),
  majorettes: (p, me) => count(p, me, ['p']) < 2,
  // trois pions ou plus : il suffit d'en perdre pour que la carte redevienne jouable
  promotionALAnciennete: (p, me) => !count(p, me, ['p']),
  // un pion déjà au-delà de la 6e rangée ne peut plus y revenir
  promotionAuMerite: (p, me) => !findPieces(p.board, me, 'p').some((s) => relRank(s, me) < 5),
  vampirisme: (p, me) => !count(p, me, ['p', 'n', 'b', 'r', 'q']),
  pasDeDeux: (p, me) => !count(p, me, ['p', 'n', 'b', 'r', 'q']),
  encephalopathieSpongiformeEquine: (p, me) => !count(p, me, ['n']) && !count(p, other(me), ['n']),
  serialKiller: (p, me) => !count(p, me, ['p']),
  brouillard: (p, me) => !count(p, other(me), SLIDERS),
  verglas: (p, me) => !count(p, other(me), SLIDERS),
  ole: (p, me) => !count(p, other(me), SLIDERS),
  pitie: (p, me) => !count(p, other(me), SLIDERS) || !count(p, me, ['p']),
  ruade: (p, me) => !count(p, other(me), ['n']),
  voyageAstral: (p, me) => !count(p, me, ['p', 'n', 'b', 'r', 'q']) && !count(p, other(me), ['p', 'n', 'b', 'r', 'q']),
};

/**
 * Cartes mises de côté : toujours définies (parties sauvegardées, tests), mais absentes de
 * la pioche et de la galerie (aucune pour l'instant).
 */
export const SET_ASIDE = new Set<string>([]);

/** Les cartes réellement en jeu. */
export const DECK_CARDS: CardDef[] = CARDS.filter((c) => !SET_ASIDE.has(c.id));

export function isDead(cardId: string, pos: Position, me: Color): boolean {
  return DEAD_WHEN[cardId]?.(pos, me) ?? false;
}
