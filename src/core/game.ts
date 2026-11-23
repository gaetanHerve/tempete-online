// Machine d'état d'une partie. Tout est piloté par des actions sérialisables
// appliquées par un réducteur pur, avec un aléa déterministe (graine dans l'état) :
// un futur mode 2 joueurs n'aura qu'à échanger les actions entre appareils.

import { applyMove, legalMoves, type NormalMove } from './chess';
import { CARD_BY_ID, DECK_CARDS, isDead, type CardContext, type CardOption, type FollowStep } from './cards';
import { clonePos, finishCardEffect, inCheck, other, startPosition, toFen, type Color, type Piece, type PieceType, type Position, type Sq } from './position';

export const HAND_SIZE = 5;

/**
 * - main     : le joueur actif joue son coup (ou une carte avant / à la place)
 * - reaction : l'autre joueur peut réagir au coup qui vient d'être joué
 * - duel     : pierre-feuille-ciseaux en cours (carte Duel)
 * - counter  : une carte vient d'être jouée, l'autre joueur peut l'annuler (Non, Niet)
 * - choice   : choix successifs demandés par une carte (Zombies, Électrochoc, Douane)
 * - after    : le joueur actif peut jouer une carte après son coup, puis termine son tour
 */
export type Phase = 'main' | 'reaction' | 'counter' | 'choice' | 'duel' | 'after' | 'over';

/** Choix en cours après une carte (qui choisit est recalculé à chaque étape). */
export interface Choice {
  card: string;
  owner: Color;
  moved: Sq[];
  reactTo: { before: Position; move: NormalMove } | null;
  start: Position;
}

/** Carte jouée mais pas encore appliquée : l'adversaire peut encore l'annuler. */
export interface Pending {
  color: Color;
  card: string;
  option: CardOption;
  /** Phase à reprendre une fois la carte appliquée ou annulée. */
  resume: Phase;
  /** Annulations successives (Non, Niet) : la carte s'applique si leur nombre est pair. */
  counters: { color: Color; card: string }[];
}

export type Throw = 'pierre' | 'feuille' | 'ciseaux';
export const THROWS: Throw[] = ['pierre', 'feuille', 'ciseaux'];
export const BEATS: Record<Throw, Throw> = { pierre: 'ciseaux', feuille: 'pierre', ciseaux: 'feuille' };
export const DUEL_WINS = 3;

export interface Duel {
  attacker: Color;
  defender: Color;
  score: Record<Color, number>;
  /** Choix de la manche en cours (secrets tant que les deux n'ont pas joué). */
  throws: Partial<Record<Color, Throw>>;
  /** Dernière manche jouée, pour l'affichage. */
  last: Record<Color, Throw> | null;
  /** Position si le défenseur l'emporte (sinon, le coup reste tel quel). */
  win: Position;
}

export interface LogEntry {
  color: Color;
  text: string;
  card?: string;
  /** Événement à signaler au joueur (fin d'une règle, Voyance qui se réalise…). */
  notice?: boolean;
  /** Pendant Double jeu : `color` est la couleur jouée, pas celle du joueur. */
  swapped?: boolean;
  /** Position juste après cette entrée (FEN), pour revoir la partie. Absente des anciennes sauvegardes. */
  fen?: string;
  /** Ce que l'échiquier mettait en évidence à ce moment-là. */
  event?: LastEvent;
}

/** Règle temporaire posée par une carte (Provocation, Cessez le feu, Planque…). */
export interface Rule {
  card: string;
  owner: Color;
  /** Planque, Voyance : la pièce visée (case et nature). */
  sq?: Sq;
  piece?: Piece;
  /** Règles d'un seul tour : numéro du tour adverse concerné. */
  turn?: number;
}

/** Dernier événement visible, pour les surlignages de l'interface. */
export interface LastEvent {
  color: Color;
  from?: Sq;
  to?: Sq;
  marks: Sq[];
  card?: string;
}

export interface GameState {
  pos: Position;
  /** Joueur dont c'est le tour (en phase « after », pos.turn est déjà l'adversaire). */
  active: Color;
  phase: Phase;
  hands: Record<Color, string[]>;
  deck: string[];
  discard: string[];
  cardPlayed: boolean;
  /** L'autre joueur a déjà joué sa carte pendant ce tour (une seule par tour adverse). */
  reacted?: boolean;
  /** Pendant la réaction : le coup auquel on réagit et la position d'avant. */
  reactTo?: { before: Position; move: NormalMove } | null;
  /** Coup interdit (annulé par Contrordre), en notation UCI. */
  forbidden?: string | null;
  duel?: Duel | null;
  pending?: Pending | null;
  rules?: Rule[];
  /** Nombre de tours terminés depuis le début de la partie. */
  turn?: number;
  /** Cartes gardées devant soi (Je passe), comme les mains : par couleur jouée. */
  reserve?: Record<Color, string[]>;
  /** Double jeu : les joueurs ont échangé leurs places jusqu'au tour `until`. */
  swap?: { until: number } | null;
  /** Rebelote : cartes supplémentaires encore permises ce tour-ci, et carte déjà jouée. */
  extra?: number;
  rebelote?: boolean;
  choice?: Choice | null;
  /** Issue du dernier duel, pour l'affichage. */
  lastDuel?: { score: Record<Color, number>; last: Record<Color, Throw>; defender: Color; winner: Color } | null;
  /** Dernier coup normal joué (par l'un ou l'autre), avec la position d'avant : information publique. */
  lastPly?: { before: Position; move: NormalMove; color: Color } | null;
  /** Coup normal joué ce tour-ci par `active` (pour les cartes « après votre coup »). */
  lastMove: NormalMove | null;
  lastEvent: LastEvent | null;
  log: LogEntry[];
  result: { winner: Color | null; reason: string } | null;
  rng: number;
  ply: number;
  /** L'état d'avant le coup qui vient d'être joué, tant qu'il peut encore être annulé. */
  undo?: GameState | null;
}

export type Action =
  | { type: 'move'; from: Sq; to: Sq; promotion?: PieceType }
  | { type: 'card'; card: string; path: Sq[]; label?: string }
  /** Défausser une carte devenue définitivement injouable (compte comme la carte du tour). */
  | { type: 'discard'; card: string }
  /** Ne pas réagir au coup adverse. */
  | { type: 'pass' }
  /** Une manche de duel. */
  | { type: 'duel'; color: Color; throw: Throw }
  /** Un choix demandé par une carte (Zombies, Électrochoc, Douane). */
  | { type: 'choose'; path: Sq[]; label?: string }
  /** Provocation : passer son tour plutôt que de prendre. */
  | { type: 'skip' }
  /** Je passe (en réserve) : rejouer un coup. */
  | { type: 'replay' }
  /** Reprendre son coup, juste après l'avoir joué (rien d'autre depuis). */
  | { type: 'undo' }
  | { type: 'endTurn' };

// ---------- aléa déterministe (mulberry32) ----------

function nextRandom(state: GameState): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle<T>(state: GameState, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

function draw(state: GameState, c: Color, n = 1) {
  for (let i = 0; i < n; i++) {
    if (!state.deck.length) {
      if (!state.discard.length) return;
      state.deck = shuffle(state, state.discard);
      state.discard = [];
    }
    state.hands[c].push(state.deck.pop()!);
  }
}

// ---------- création ----------

export function newGame(seed = Date.now()): GameState {
  const state: GameState = {
    pos: startPosition(),
    active: 'w',
    phase: 'main',
    hands: { w: [], b: [] },
    deck: [],
    discard: [],
    cardPlayed: false,
    lastMove: null,
    lastEvent: null,
    log: [],
    result: null,
    rng: seed | 0,
    ply: 0,
  };
  state.deck = shuffle(
    state,
    DECK_CARDS.map((c) => c.id),
  );
  draw(state, 'w', HAND_SIZE);
  draw(state, 'b', HAND_SIZE);
  return state;
}

// ---------- requêtes ----------

/** Joueur qui doit agir (pendant une réaction, c'est l'adversaire du joueur actif). */
export function actor(state: GameState): Color {
  if (state.phase === 'reaction') return other(state.active);
  if (state.phase === 'counter' && state.pending) return other(lastPlayer(state.pending));
  if (state.phase === 'choice') return choiceStep(state)?.chooser ?? state.active;
  return state.active;
}

/** Étape de choix en cours : qui choisit, et parmi quelles options. */
export function choiceStep(state: GameState): FollowStep | null {
  const c = state.choice;
  if (state.phase !== 'choice' || !c) return null;
  return CARD_BY_ID[c.card].followUp!({ pos: state.pos, owner: c.owner, moved: c.moved, reactTo: c.reactTo, start: c.start });
}

/** Dernier joueur à avoir posé une carte dans la chaîne en suspens. */
function lastPlayer(p: Pending): Color {
  return p.counters.length ? p.counters[p.counters.length - 1].color : p.color;
}

/**
 * Chaque joueur a droit à une carte pendant son tour (`cardPlayed`) et à une pendant
 * le tour adverse (`reacted`), Non et Niet compris.
 */
function slotUsed(state: GameState, c: Color): boolean {
  return c === state.active ? state.cardPlayed && !state.extra : !!state.reacted;
}
function useSlot(state: GameState, c: Color) {
  if (c !== state.active) state.reacted = true;
  else if (state.cardPlayed && state.extra) state.extra--; // carte permise par Rebelote
  else state.cardPlayed = true;
}

/**
 * Je passe, gardé en réserve, peut servir à rejouer après son coup… sauf si ce coup met le Roi
 * adverse en échec : rejouer permettrait de le prendre.
 */
export function canReplay(state: GameState): boolean {
  return (
    state.phase === 'after' && (state.reserve?.[state.active] ?? []).includes('jePasse') && !inCheck(state.pos.board, other(state.active))
  );
}

/** Double jeu : chacun emporte sa main (et sa réserve) vers sa nouvelle couleur. */
function swapSeats(state: GameState) {
  state.hands = { w: state.hands.b, b: state.hands.w };
  const r = state.reserve ?? { w: [], b: [] };
  state.reserve = { w: r.b, b: r.w };
}

/** `c` peut-il annuler la carte en suspens ? */
function canCounter(state: GameState, c: Color): boolean {
  return !slotUsed(state, c) && !rule(state, 'origines') && state.hands[c].some((id) => CARD_BY_ID[id].timing === 'counter');
}

/** `c` doit-il agir maintenant ? (pendant un duel, chacun doit choisir sa manche) */
export function mustAct(state: GameState, c: Color): boolean {
  if (state.phase === 'over') return false;
  if (state.phase === 'duel') return !state.duel?.throws[c];
  return actor(state) === c;
}

export function cardContext(state: GameState): CardContext {
  return {
    pos: state.pos,
    me: actor(state),
    lastMove: state.phase === 'after' ? state.lastMove : null,
    reactTo: state.phase === 'reaction' ? state.reactTo : null,
    counterTo: state.phase === 'counter' && state.pending ? (state.pending.counters.at(-1)?.card ?? state.pending.card) : null,
  };
}

function timingAllowed(state: GameState, cardId: string): boolean {
  const t = CARD_BY_ID[cardId].timing;
  if (state.phase === 'main') return t === 'before' || t === 'replace' || t === 'anytime';
  if (state.phase === 'after') return t === 'after' || t === 'anytime';
  if (state.phase === 'reaction') return t === 'reaction';
  if (state.phase === 'counter') return t === 'counter';
  return false;
}

/**
 * Options jouables pour une carte de la main du joueur qui doit agir.
 * Renvoie [] si la carte n'est pas jouable maintenant ; pour une carte de main
 * jouable, renvoie une option unique sans chemin.
 */
export function cardOptions(state: GameState, cardId: string): CardOption[] {
  if (state.phase === 'over' || state.phase === 'duel') return [];
  if (CARD_BY_ID[cardId].turnEffect === 'rebelote') {
    // seulement après une première carte de son propre tour, et une fois
    if (!state.cardPlayed || state.rebelote || state.extra || actor(state) !== state.active) return [];
  } else if (slotUsed(state, actor(state))) return [];
  if (!state.hands[actor(state)].includes(cardId) || !timingAllowed(state, cardId)) return [];
  if (rule(state, 'origines')) return []; // plus aucune carte tant qu'aucun Roi n'est en échec
  const def = CARD_BY_ID[cardId];
  if (def.timing === 'replace' && canSkip(state)) return []; // Provocation : prendre ou passer
  if (def.hand) return [{ path: [], result: state.pos, marks: [], summary: def.title }];
  return def.options!(cardContext(state));
}

export function playableCards(state: GameState): string[] {
  return state.hands[actor(state)].filter((id) => cardOptions(state, id).length > 0);
}

/** La carte peut-elle être défaussée maintenant ? (seulement après le coup du tour) */
export function canDiscard(state: GameState, cardId: string): boolean {
  if (state.phase !== 'after' || state.cardPlayed || !state.hands[state.active].includes(cardId)) return false;
  return isDead(cardId, state.pos, state.active);
}

export function normalMoves(state: GameState): NormalMove[] {
  if (state.phase !== 'main') return [];
  let moves = legalMoves(state.pos).filter((m) => m.uci !== state.forbidden);
  const me = state.active;
  for (const r of state.rules ?? []) {
    let next = moves;
    if (r.card === 'cessezLeFeu') next = moves.filter((m) => !m.captured);
    else if (r.card === 'fringale') next = moves.filter((m) => m.captured);
    else if (r.card === 'planque' && other(r.owner) === me) next = moves.filter((m) => m.from !== r.sq);
    else if (provokes(state, r)) next = moves.filter((m) => m.captured);
    // une contrainte qui ne laisse aucun coup est suspendue (sauf Provocation : on passe son tour)
    if (next.length || r.card === 'provocation') moves = next;
  }
  return moves;
}

/** Règles temporaires qui se contredisent : obligation de prendre contre interdiction de prendre. */
const RULE_CLASHES: Record<string, string[]> = {
  cessezLeFeu: ['fringale', 'provocation'],
  fringale: ['cessezLeFeu'],
  provocation: ['cessezLeFeu'],
};

/** Règles en cours auxquelles cette carte, si on la joue, mettrait fin (identifiants de cartes). */
export function clashingRules(state: GameState, cardId: string): string[] {
  const clashes = RULE_CLASHES[cardId] ?? [];
  return (state.rules ?? []).filter((r) => clashes.includes(r.card)).map((r) => r.card);
}

/** Règle d'un tour qui vise le joueur actif en ce moment (Provocation, Voyance). */
function targets(state: GameState, r: Rule): boolean {
  return r.turn === (state.turn ?? 0) && other(r.owner) === state.active;
}
const provokes = (state: GameState, r: Rule) => r.card === 'provocation' && targets(state, r);
const rule = (state: GameState, card: string) => (state.rules ?? []).find((r) => r.card === card);

/** Provocation : le joueur actif peut passer son tour plutôt que de prendre. */
/** Le coup qui vient d'être joué peut-il être repris ? (rien d'autre ne s'est passé depuis) */
export function canUndo(state: GameState): boolean {
  return state.phase === 'after' && !!state.undo;
}

export function canSkip(state: GameState): boolean {
  return state.phase === 'main' && (state.rules ?? []).some((r) => provokes(state, r));
}

// ---------- réducteur ----------

export class IllegalAction extends Error {}

export function apply(prev: GameState, action: Action): GameState {
  if (action.type === 'undo') {
    if (!canUndo(prev)) throw new IllegalAction('Plus rien à reprendre');
    return structuredClone(prev.undo!);
  }
  const state = applyAction(prev, action);
  // seul un coup qui laisse la main à son auteur peut être repris ; toute autre action l'empêche
  state.undo = action.type === 'move' && state.phase === 'after' && state.active === prev.active ? { ...prev, undo: null } : null;
  refreshRules(state);
  const added = state.log.slice(prev.log.length);
  if (prev.swap) for (const e of added) e.swapped = true;
  // de quoi revoir la partie plus tard : la position et ce qui était mis en évidence
  if (added.length) {
    const fen = toFen(state.pos);
    const event = state.lastEvent ? structuredClone(state.lastEvent) : undefined;
    for (const e of added) {
      e.fen = fen;
      e.event = event;
    }
  }
  return state;
}

function applyAction(prev: GameState, action: Action): GameState {
  if (prev.phase === 'over') throw new IllegalAction('Partie terminée');
  const state: GameState = structuredClone(prev);
  const me = state.active;

  switch (action.type) {
    case 'move': {
      if (state.phase !== 'main') throw new IllegalAction('Vous avez déjà joué votre coup');
      const m = normalMoves(state).find(
        (x) => x.from === action.from && x.to === action.to && (x.promotion ?? undefined) === (action.promotion ?? (x.promotion ? 'q' : undefined)),
      );
      if (!m) throw new IllegalAction('Coup illégal');
      const seer = (state.rules ?? []).find((r) => r.card === 'voyance' && targets(state, r));
      // (pas d'annulation pour un Roi en échec : il y resterait, ce qui est illégal)
      if (seer && seer.sq === m.from && !inCheck(state.pos.board, me)) {
        // Voyance avait vu juste : le coup est annulé et le tour s'arrête là
        state.rules = state.rules!.filter((r) => r !== seer);
        endRule(state, seer);
        state.ply++;
        state.lastEvent = { color: seer.owner, marks: [m.from], card: 'voyance' };
        state.log.push({ color: seer.owner, card: 'voyance', text: `${CARD_BY_ID.voyance.title} avait vu juste : ${m.san} est annulé`, notice: true });
        // (tour perdu : la position passe aussi à l'adversaire, sinon il ne pourrait pas jouer)
        passTurn(state);
        return state;
      }
      state.pos = applyMove(state.pos, m);
      state.lastMove = m;
      state.lastPly = { before: prev.pos, move: m, color: me };
      state.phase = 'after';
      state.lastEvent = { color: me, from: m.from, to: m.to, marks: [] };
      state.log.push({ color: me, text: m.san });
      state.ply++;
      state.forbidden = null;
      // l'adversaire peut-il réagir ? sinon, phase « après » : le joueur valide lui-même la fin de son tour
      state.phase = 'reaction';
      state.reactTo = { before: prev.pos, move: m };
      if (state.reacted || playableCards(state).length === 0) {
        state.phase = 'after';
        state.reactTo = null;
      }
      return state;
    }

    case 'card': {
      const options = cardOptions(prev, action.card);
      const opt = options.find((o) => samePath(o.path, action.path) && (o.label ?? undefined) === (action.label ?? undefined));
      if (!opt) throw new IllegalAction('Carte non jouable ainsi');
      const who = actor(prev);
      const def = CARD_BY_ID[action.card];
      const hand = state.hands[who];
      hand.splice(hand.indexOf(action.card), 1);
      if (def.turnEffect !== 'rebelote') useSlot(state, who);
      state.ply++;

      if (def.timing === 'counter') {
        // Non / Niet : sans effet propre, ils s'ajoutent à la chaîne en suspens
        const p = state.pending!;
        state.discard.push(action.card);
        draw(state, who);
        const target = CARD_BY_ID[p.counters.at(-1)?.card ?? p.card];
        p.counters.push({ color: who, card: action.card });
        state.log.push({ color: who, card: action.card, text: `${def.title} : annule « ${target.title} »` });
        return canCounter(state, other(who)) ? state : resolvePending(state);
      }

      // l'adversaire peut-il annuler cette carte ? elle reste alors en suspens
      if (canCounter(state, other(who))) {
        state.pending = { color: who, card: action.card, option: opt, resume: state.phase, counters: [] };
        state.phase = 'counter';
        return state;
      }
      return applyCard(state, action.card, opt);
    }

    case 'discard': {
      if (!canDiscard(prev, action.card)) throw new IllegalAction('Cette carte ne peut pas être défaussée');
      const hand = state.hands[me];
      hand.splice(hand.indexOf(action.card), 1);
      state.discard.push(action.card);
      draw(state, me);
      state.cardPlayed = true;
      state.ply++;
      state.log.push({ color: me, card: action.card, text: `Défausse : ${CARD_BY_ID[action.card].title}` });
      // toujours en phase « après » : le joueur termine ensuite son tour
      return state;
    }

    case 'undo':
      throw new IllegalAction('Plus rien à reprendre'); // (traité par apply)

    case 'replay': {
      if (!canReplay(state)) throw new IllegalAction('Rien à rejouer');
      const r = state.reserve![me];
      r.splice(r.indexOf('jePasse'), 1);
      state.discard.push('jePasse');
      state.ply++;
      state.log.push({ color: me, card: 'jePasse', text: `${CARD_BY_ID.jePasse.title} : rejoue un coup` });
      // l'adversaire « passe » : c'est de nouveau à moi dans la position
      state.pos = finishCardEffect(clonePos(state.pos), true);
      state.phase = 'main';
      state.lastMove = null;
      return state;
    }

    case 'skip': {
      if (!canSkip(state)) throw new IllegalAction('Vous ne pouvez pas passer votre tour');
      state.ply++;
      state.log.push({ color: me, card: 'provocation', text: `${CARD_BY_ID.provocation.title} : passe son tour` });
      passTurn(state);
      return state;
    }

    case 'pass': {
      if (state.phase === 'counter') return resolvePending(state);
      if (state.phase !== 'reaction') throw new IllegalAction('Rien à laisser passer');
      state.phase = 'after';
      state.reactTo = null;
      return state;
    }

    case 'duel':
      return duelRound(state, action.color, action.throw);

    case 'choose': {
      const step = choiceStep(prev);
      const opt = step?.options.find((o) => samePath(o.path, action.path) && (o.label ?? undefined) === (action.label ?? undefined));
      if (!step || !opt) throw new IllegalAction('Choix impossible');
      const c = state.choice!;
      state.pos = opt.result;
      if (opt.path.length) c.moved.push(opt.path[opt.path.length - 1]);
      state.lastEvent = { color: step.chooser, marks: opt.marks, card: c.card };
      state.log.push({ color: step.chooser, card: c.card, text: `${CARD_BY_ID[c.card].title} : ${opt.summary}` });
      if (opt.replay || !choiceStep(state)) finishChoice(state, !!opt.replay);
      return state;
    }

    case 'endTurn': {
      if (state.phase !== 'after') throw new IllegalAction('Jouez d’abord votre coup');
      endTurn(state);
      return state;
    }
  }
}

function samePath(a: Sq[], b: Sq[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Applique l'effet d'une carte déjà retirée de la main (son quota est déjà compté). */
function applyCard(state: GameState, cardId: string, opt: CardOption): GameState {
  const def = CARD_BY_ID[cardId];
  if (def.timing === 'reaction') return react(state, cardId, opt);
  const me = state.active;
  const hand = state.hands[me];
  if (def.turnEffect === 'pass') {
    // Je passe : la carte reste devant soi, et le tour s'arrête là
    state.reserve ??= { w: [], b: [] };
    state.reserve[me].push(cardId);
    draw(state, me);
    state.log.push({ color: me, card: cardId, text: `${def.title} : passe son tour (carte gardée en réserve)` });
    passTurn(state);
    return state;
  }
  if (def.turnEffect === 'rebelote') {
    state.discard.push(cardId);
    draw(state, me);
    state.extra = 2;
    state.rebelote = true;
    state.log.push({ color: me, card: cardId, text: `${def.title} : deux cartes de plus ce tour-ci` });
    return state;
  }
  if (def.turnEffect === 'swap') {
    // la carte reste en jeu pendant l'échange, et ne part à la défausse qu'à la fin
    draw(state, me);
    state.log.push({ color: me, card: cardId, text: `${def.title} : les joueurs échangent leurs places pour trois tours` });
    swapSeats(state);
    // trois tours chacun à partir du tour suivant
    state.swap = { until: (state.turn ?? 0) + 7 };
    closeCardTurn(state, false);
    return state;
  }
  if (def.hand === 'redraw') {
    state.discard.push(cardId, ...hand);
    state.hands[me] = [];
    draw(state, me, HAND_SIZE);
    state.log.push({ color: me, card: def.id, text: `${def.title} : nouvelle main` });
  } else if (def.hand === 'swap') {
    state.discard.push(cardId);
    const mine = state.hands[me];
    state.hands[me] = state.hands[other(me)];
    state.hands[other(me)] = mine;
    draw(state, other(me));
    state.log.push({ color: me, card: def.id, text: `${def.title} : les mains sont échangées` });
  } else {
    // une carte à règle temporaire reste en jeu tant que sa règle dure (cf. endRule)
    if (!def.rule) state.discard.push(cardId);
    draw(state, me);
    state.pos = opt.result;
    // (Voyance : la pièce désignée reste secrète, rien n'est surligné)
    const secret = def.id === 'voyance';
    state.lastEvent = { color: me, marks: opt.marks, card: def.id, from: secret ? undefined : opt.path[0], to: secret ? undefined : opt.path[opt.path.length - 1] };
    state.log.push({ color: me, card: def.id, text: `${def.title} : ${opt.summary}` });
    if (def.rule) {
      const sq = opt.path[0];
      for (const r of state.rules ?? []) if (r.card === cardId) endRule(state, r); // (une seule carte de chaque : par prudence)
      // une règle contraire déjà en cours prend fin : la dernière carte jouée l'emporte
      const clashes = RULE_CLASHES[cardId] ?? [];
      for (const r of state.rules ?? [])
        if (clashes.includes(r.card)) {
          endRule(state, r);
          state.log.push({ color: r.owner, card: r.card, text: `${def.title} met fin à ${CARD_BY_ID[r.card].title}`, notice: true });
        }
      state.rules = [
        ...(state.rules ?? []).filter((r) => r.card !== cardId && !clashes.includes(r.card)),
        { card: cardId, owner: me, sq, piece: sq === undefined ? undefined : (state.pos.board[sq] ?? undefined), turn: def.rule === 'nextTurn' ? (state.turn ?? 0) + 1 : undefined },
      ];
    }
    if (def.followUp) return startChoice(state, cardId, me, null);
    if (def.timing === 'replace' || def.timing === 'after') {
      closeCardTurn(state, def.timing === 'replace');
      return state;
    }
  }
  // carte de main : on reste dans la même phase
  if (state.phase === 'main') checkGameOver(state);
  return state;
}

/** Résout la chaîne en suspens : la carte s'applique si elle n'a pas été annulée. */
function resolvePending(state: GameState): GameState {
  const p = state.pending!;
  state.pending = null;
  state.phase = p.resume;
  if (p.counters.length % 2 === 0) return applyCard(state, p.card, p.option);
  // annulée : la carte est perdue (son joueur pioche quand même)
  state.discard.push(p.card);
  draw(state, p.color);
  if (state.phase === 'reaction') {
    state.phase = 'after';
    state.reactTo = null;
  }
  // la carte devait peut-être sauver d'un mat : sans elle, plus rien à jouer ?
  if (state.phase === 'main') checkGameOver(state);
  return state;
}

/** Applique une carte de réaction (pendant le tour de `state.active`). */
function react(state: GameState, cardId: string, opt: CardOption): GameState {
  const me = actor(state);
  const def = CARD_BY_ID[cardId];
  state.discard.push(cardId);
  draw(state, me);
  state.log.push({ color: me, card: cardId, text: `${def.title} : ${opt.summary}` });
  state.lastEvent = { color: me, marks: opt.marks, card: cardId };
  const reactTo = state.reactTo!;
  const move = reactTo.move;
  state.reactTo = null;
  if (def.followUp) return startChoice(state, cardId, me, reactTo);
  switch (def.reaction) {
    case 'replay':
      state.pos = opt.result;
      state.phase = 'main';
      state.lastMove = null;
      state.forbidden = move.uci;
      break;
    case 'duel':
      state.phase = 'duel';
      state.duel = { attacker: state.active, defender: me, score: { w: 0, b: 0 }, throws: {}, last: null, win: opt.result };
      break;
    default:
      state.pos = opt.result;
      state.phase = 'after';
      if (def.reaction !== 'keep') state.lastMove = null;
  }
  return state;
}

function startChoice(state: GameState, card: string, owner: Color, reactTo: Choice['reactTo']): GameState {
  state.choice = { card, owner, moved: [], reactTo, start: state.pos };
  state.phase = 'choice';
  if (!choiceStep(state)) finishChoice(state, false);
  return state;
}

/** Fin des choix : la partie reprend selon le moment de la carte. */
function finishChoice(state: GameState, replay: boolean) {
  const c = state.choice!;
  state.choice = null;
  const def = CARD_BY_ID[c.card];
  if (def.timing === 'reaction') {
    // Douane : soit le coup est payé (il reste valable), soit il faut en jouer un autre
    if (replay) {
      state.phase = 'main';
      state.lastMove = null;
      state.forbidden = c.reactTo!.move.uci;
    } else state.phase = 'after';
  } else if (replay) {
    // Roque et rolle abandonné : la carte est perdue, il faut jouer un coup (ou c'est le mat)
    state.phase = 'main';
    checkGameOver(state);
  } else if (def.timing === 'after' || def.timing === 'replace') {
    closeCardTurn(state, true);
  } else {
    state.phase = 'main';
    checkGameOver(state);
  }
}

function duelRound(state: GameState, c: Color, t: Throw): GameState {
  const d = state.duel;
  if (state.phase !== 'duel' || !d) throw new IllegalAction('Pas de duel en cours');
  if (d.throws[c]) throw new IllegalAction('Déjà joué pour cette manche');
  d.throws[c] = t;
  const w = d.throws.w;
  const b = d.throws.b;
  if (!w || !b) return state;
  d.last = { w, b };
  d.throws = {};
  if (BEATS[w] === b) d.score.w++;
  else if (BEATS[b] === w) d.score.b++;
  const winner = d.score.w >= DUEL_WINS ? 'w' : d.score.b >= DUEL_WINS ? 'b' : null;
  if (!winner) return state;
  const defended = winner === d.defender;
  if (defended) {
    state.pos = d.win;
    state.lastMove = null;
  }
  state.lastDuel = { score: { ...d.score }, last: d.last, defender: d.defender, winner };
  state.log.push({ color: winner, card: 'duel', text: `${CARD_BY_ID.duel.title} ${d.score[d.defender]}–${d.score[d.attacker]} : ${defended ? 'la pièce attaquante est éliminée' : 'la prise a lieu'}` });
  state.duel = null;
  state.phase = 'after';
  return state;
}

/**
 * Une carte « après » ou « à la place du coup » termine le tour… sauf s'il reste des cartes
 * à jouer grâce à Rebelote, ou si l'on tient Rebelote (qui se joue après une première carte) :
 * on reste alors en phase « après ».
 */
function closeCardTurn(state: GameState, replacedMove: boolean) {
  if (replacedMove) state.lastMove = null;
  const holdsRebelote = !state.rebelote && state.hands[state.active].some((id) => CARD_BY_ID[id].turnEffect === 'rebelote');
  if (state.extra || holdsRebelote) state.phase = 'after';
  else endTurn(state);
}

/** Fin d'une règle temporaire : sa carte, restée en jeu jusque-là, part à la défausse. */
function endRule(state: GameState, r: Rule) {
  state.discard.push(r.card);
}

/** Passer son tour sans jouer : c'est à l'adversaire, dans la même position. */
function passTurn(state: GameState) {
  state.pos = finishCardEffect(clonePos(state.pos), true);
  state.lastMove = null;
  endTurn(state);
}

function endTurn(state: GameState) {
  const turn = state.turn ?? 0;
  // les règles d'un seul tour (Provocation, Voyance) prennent fin avec le tour visé
  state.rules = (state.rules ?? []).filter((r) => {
    const keep = r.turn === undefined || r.turn > turn;
    if (!keep) endRule(state, r);
    return keep;
  });
  state.turn = turn + 1;
  state.active = other(state.active);
  state.phase = 'main';
  state.cardPlayed = false;
  state.reacted = false;
  state.forbidden = null;
  state.lastMove = null;
  state.extra = 0;
  state.rebelote = false;
  if (state.swap && state.turn >= state.swap.until) {
    // fin de Double jeu : chacun retrouve sa couleur (avec sa main)
    swapSeats(state);
    state.swap = null;
    state.discard.push('doubleJeu');
    state.log.push({ color: state.active, card: 'doubleJeu', text: `${CARD_BY_ID.doubleJeu.title} prend fin : chacun retrouve sa couleur`, notice: true });
  }
  checkGameOver(state);
}

/** Fin des règles durables : échec au Roi, pièce endormie disparue, plus de prise possible… */
function refreshRules(state: GameState) {
  if (!state.rules?.length || state.phase === 'over') return;
  const b = state.pos.board;
  const check = inCheck(b, 'w') || inCheck(b, 'b');
  state.rules = state.rules.filter((r) => {
    let keep = true;
    if (r.card === 'cessezLeFeu' || r.card === 'origines') keep = !check;
    else if (r.card === 'planque') {
      const victim = other(r.owner);
      const pc = r.sq === undefined ? null : b[r.sq];
      keep = !inCheck(b, victim) && !!pc && pc.c === victim && pc.t === r.piece?.t;
    } else if (r.card === 'fringale' && state.phase === 'main') keep = legalMoves(state.pos).some((m) => m.captured);
    if (!keep) {
      endRule(state, r);
      state.log.push({ color: r.owner, card: r.card, text: `${CARD_BY_ID[r.card].title} prend fin`, notice: true });
    }
    return keep;
  });
}

/**
 * Le joueur actif a perdu s'il n'a ni coup légal, ni carte « à la place du coup »
 * pour s'en sortir (une carte peut donc sauver d'un mat !).
 */
function checkGameOver(state: GameState) {
  if (legalMoves(state.pos).length > 0) return;
  const me = state.active;
  // une carte « à la place du coup » (ou Je passe, hors échec) peut encore sauver la partie
  const rescue = state.hands[me].some((id) => (CARD_BY_ID[id].timing === 'replace' || id === 'jePasse') && cardOptions(state, id).length > 0);
  if (rescue) return;
  state.phase = 'over';
  if (inCheck(state.pos.board, me)) {
    // pendant Double jeu, c'est le joueur assis à l'autre couleur qui l'emporte
    state.result = { winner: state.swap ? me : other(me), reason: 'Échec et mat' };
  } else {
    state.result = { winner: null, reason: 'Pat' };
  }
}

export function resign(prev: GameState, c: Color): GameState {
  const state = structuredClone(prev);
  state.phase = 'over';
  state.result = { winner: other(c), reason: 'Abandon' };
  return state;
}
