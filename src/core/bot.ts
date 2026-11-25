// L'ordinateur : Stockfish pour les coups, et une évaluation des cartes par
// comparaison « position après la carte » vs « position après le meilleur coup ».

import { legalMoves, type NormalMove } from './chess';
import { MATE_SCORE, type Analysis, type Engine } from '../engine/engine';
import { CARD_BY_ID, DECK_CARDS, isDead, type CardOption } from './cards';
import { criticality } from './criticality';
import { THROWS, actor, apply, canDiscard, canReplay, canSkip, cardOptions, choiceStep, normalMoves, playableCards, type Action, type GameState } from './game';
import { PIECE_VALUE, engineFen, isAttacked, inCheck, materialBalance, other, sqName, toFen, type Color, type Position } from './position';

export interface BotLevel {
  id: string;
  /** Skill Level Stockfish (0..20) et profondeur pour le coup normal. */
  skill: number;
  depth: number;
  /** Profondeur et temps max pour évaluer chaque option de carte. */
  cardDepth: number;
  cardMovetime: number;
  /** Gain minimal (centipions) pour « dépenser » une carte. */
  margin: number;
  /** Probabilité de seulement envisager ses cartes à un tour donné. */
  cardEagerness: number;
  /**
   * Combinaisons « coup + carte après le coup » : nombre de meilleurs coups Stockfish
   * examinés (MultiPV), et nombre maximal de combinaisons évaluées par le moteur.
   */
  comboMoves: number;
  comboEvals: number;
  /**
   * Préparation des cartes : part du gain potentiel des cartes au tour suivant ajoutée au score
   * d'un coup (0 = aucune préparation), et perte maximale (centipions) acceptée pour préparer.
   */
  prepWeight: number;
  prepTolerance: number;
  /**
   * Méfiance envers les cartes que l'adversaire tient peut-être : part du tort estimé retirée au
   * score d'un coup (0 = aucune méfiance), et écart maximal (centipions) accepté pour l'éviter.
   */
  riskWeight: number;
  riskTolerance: number;
  /** Criticité habituelle (0 à 1) sous laquelle une carte adverse possible est ignorée. */
  riskThreshold: number;
}

export const BOT_LEVELS: BotLevel[] = [
  {
    id: 'facile',
    skill: 1,
    depth: 5,
    cardDepth: 4,
    cardMovetime: 120,
    margin: 150,
    cardEagerness: 0.5,
    comboMoves: 2,
    comboEvals: 2,
    prepWeight: 0,
    prepTolerance: 0,
    riskWeight: 0.3,
    riskTolerance: 50,
    riskThreshold: 0.3,
  },
  {
    id: 'moyen',
    skill: 8,
    depth: 9,
    cardDepth: 7,
    cardMovetime: 200,
    margin: 80,
    cardEagerness: 0.85,
    comboMoves: 3,
    comboEvals: 4,
    prepWeight: 0.25,
    prepTolerance: 40,
    riskWeight: 0.5,
    riskTolerance: 80,
    riskThreshold: 0.2,
  },
  {
    id: 'fort',
    skill: 20,
    depth: 13,
    cardDepth: 9,
    cardMovetime: 300,
    margin: 40,
    cardEagerness: 1,
    comboMoves: 4,
    comboEvals: 6,
    prepWeight: 0.4,
    prepTolerance: 50,
    riskWeight: 1,
    riskTolerance: 120,
    riskThreshold: 0.1,
  },
];

/** Évaluation statique rapide, pour présélectionner les options de carte. */
function quickEval(p: Position, me: Color): number {
  let score = materialBalance(p.board, me);
  const opp = other(me);
  // une pièce laissée en prise sans défense ne se perd que si l'adversaire est au trait ;
  // si c'est à moi de jouer, je peux la mettre à l'abri… ou prendre la sienne
  if (p.turn === me) score += hanging(p, opp) * 0.8;
  else score -= hanging(p, me) * 0.8;
  if (inCheck(p.board, opp)) score += 30;
  return score;
}

/** Valeur de la pièce la plus précieuse de `c` attaquée et non défendue (hors Roi). */
function hanging(p: Position, c: Color): number {
  let worst = 0;
  for (let s = 0; s < 64; s++) {
    const pc = p.board[s];
    if (!pc || pc.c !== c || pc.t === 'k') continue;
    if (isAttacked(p.board, s, other(c)) && !isAttacked(p.board, s, c)) worst = Math.max(worst, PIECE_VALUE[pc.t]);
  }
  return worst;
}

/** Position produite par une option (estimée pour les cartes à choix successifs). */
const effect = (o: CardOption): Position => o.estimate ?? o.result;

// ---------- ce que l'ordinateur sait (et ignore) des cartes adverses ----------

/**
 * La partie telle que la voit l'ordinateur : la main adverse lui est cachée. Toutes ses
 * simulations (« et si je jouais ce coup ? ») partent de cette vue, jamais de l'état réel.
 */
function botView(state: GameState, me: Color): GameState {
  return { ...state, hands: { ...state.hands, [other(me)]: [] } as GameState['hands'] };
}

/** Cartes jamais vues par l'ordinateur, et probabilité que chacune soit dans la main adverse. */
interface Unseen {
  ids: string[];
  p: number;
}

export function unseenCards(state: GameState, me: Color): Unseen {
  const seen = new Set<string>([
    ...state.hands[me],
    ...state.discard,
    ...(state.rules ?? []).map((r) => r.card),
    ...(state.reserve?.w ?? []),
    ...(state.reserve?.b ?? []),
  ]);
  if (state.swap) seen.add('doubleJeu');
  if (state.pending) seen.add(state.pending.card);
  const ids = DECK_CARDS.map((c) => c.id).filter((id) => !seen.has(id));
  // la main adverse est tirée parmi ces cartes (le reste est dans la pioche)
  return { ids, p: ids.length ? Math.min(1, state.hands[other(me)].length / ids.length) : 0 };
}

/**
 * Tort que chacune des cartes `ids` ferait si l'adversaire la tenait, après mon coup `move`
 * (déjà joué dans `after`) : réactions immédiates, puis cartes de son tour. C'est le pire de
 * ses effets, en évaluation rapide (0 si elle ne s'applique pas ou ne fait pas de tort).
 */
export function cardHarms(after: GameState, before: Position, move: NormalMove, me: Color, ids: string[]): Map<string, number> {
  const opp = other(me);
  const base = quickEval(after.pos, me);
  const holding = (st: GameState, id: string): GameState => ({ ...st, hands: { ...st.hands, [opp]: [id] } as GameState['hands'] });
  const reaction: GameState = { ...after, phase: 'reaction', reactTo: { before, move }, reacted: false };
  const theirTurn: GameState = { ...after, phase: 'main', active: opp, cardPlayed: false, extra: 0, reacted: false, lastMove: null, reactTo: null, forbidden: null };
  // ses cartes « après le coup » : approximées sur la position actuelle (comme cardPotential)
  const theirAfter: GameState = { ...theirTurn, phase: 'after', pos: { ...after.pos, turn: me, ep: null } };
  const harms = new Map<string, number>();
  for (const id of ids) {
    const def = CARD_BY_ID[id];
    if (!threatens(id)) continue;
    const st = def.timing === 'reaction' ? reaction : def.timing === 'replace' ? theirTurn : theirAfter;
    let worst = 0;
    for (const o of cardOptions(holding(st, id), id)) {
      const harm = base - quickEval(effect(o), me);
      worst = Math.max(worst, def.reaction === 'duel' ? harm / 2 : harm);
    }
    harms.set(id, Math.min(worst, 1000));
  }
  return harms;
}

/** Cartes dont l'effet sur l'échiquier se mesure ainsi (pas les cartes de main, de règle ou de tour). */
export function threatens(id: string): boolean {
  const def = CARD_BY_ID[id];
  return !def.hand && !def.rule && !def.turnEffect && ['reaction', 'replace', 'after'].includes(def.timing);
}

/**
 * Tort que les cartes adverses possibles pourraient faire après mon coup : chaque carte non vue
 * pèse sa probabilité d'être en main multipliée par le pire de ses effets.
 */
export function threat(after: GameState, before: Position, move: NormalMove, me: Color, unseen: Unseen): number {
  let risk = 0;
  for (const harm of cardHarms(after, before, move, me, unseen.ids).values()) risk += unseen.p * harm;
  return risk;
}

/** Saut de tort qui trahit une préparation : au moins l'équivalent de deux pions. */
const PREPARATION_JUMP = 200;

/**
 * Pire tort qu'une carte de son tour (`id`) ferait si l'adversaire pouvait la jouer dans `pos`
 * (comme si c'était à lui) : sert à repérer un coup qui la prépare.
 */
function turnHarm(state: GameState, pos: Position, me: Color, id: string): number {
  const opp = other(me);
  const theirs: GameState = {
    ...state,
    pos: { ...pos, turn: opp, ep: null },
    phase: 'main',
    active: opp,
    cardPlayed: false,
    extra: 0,
    reacted: false,
    lastMove: null,
    reactTo: null,
    forbidden: null,
    hands: { ...state.hands, [opp]: [id] } as GameState['hands'],
  };
  const st = CARD_BY_ID[id].timing === 'replace' ? theirs : { ...theirs, phase: 'after' as const, pos: { ...pos, turn: me, ep: null } };
  const base = quickEval(theirs.pos, me);
  let worst = 0;
  for (const o of cardOptions(st, id)) worst = Math.max(worst, base - quickEval(effect(o), me));
  return worst;
}

/**
 * Cartes « mineures » que le dernier coup adverse semble préparer : celles dont le tort possible
 * a nettement augmenté avec ce coup (une Tour qui vient s'aligner derrière ma Dame, par exemple).
 */
export function suspects(state: GameState, me: Color, ids: string[]): Set<string> {
  const last = state.lastPly;
  const out = new Set<string>();
  if (!last || last.color === me) return out;
  for (const id of ids) {
    const t = CARD_BY_ID[id].timing;
    if (t !== 'replace' && t !== 'after') continue; // une réaction répond à mon coup : rien à préparer
    if (turnHarm(state, state.pos, me, id) - turnHarm(state, last.before, me, id) >= PREPARATION_JUMP) out.add(id);
  }
  return out;
}

/**
 * Les cartes adverses dont l'ordinateur se méfie : celles dont la criticité habituelle atteint
 * le seuil de son niveau, plus celles que le dernier coup adverse semble préparer.
 */
export function watchedCards(state: GameState, me: Color, level: BotLevel, unseen: Unseen): Unseen {
  const minor = unseen.ids.filter((id) => threatens(id) && criticality(id) < level.riskThreshold);
  const prepared = suspects(state, me, minor);
  return { ids: unseen.ids.filter((id) => threatens(id) && (criticality(id) >= level.riskThreshold || prepared.has(id))), p: unseen.p };
}

/** Probabilité que l'adversaire annule ma carte (Non, Niet), s'il le peut encore. */
function counterRisk(state: GameState, me: Color, unseen: Unseen): number {
  const opp = other(me);
  const slotUsed = opp === state.active ? state.cardPlayed && !state.extra : !!state.reacted;
  if (slotUsed || state.rules?.some((r) => r.card === 'origines')) return 0;
  const counters = unseen.ids.filter((id) => CARD_BY_ID[id].timing === 'counter').length;
  return Math.min(1, counters * unseen.p);
}

/** Gain d'une carte ramené à ce qu'il vaut si elle risque d'être annulée. */
const discounted = (score: number, base: number, pc: number) => base + (score - base) * (1 - pc);

interface Candidate {
  card: string;
  option: CardOption;
  quick: number;
}

function candidates(state: GameState, ids: string[], me: Color): Candidate[] {
  const out: Candidate[] = [];
  for (const card of ids) {
    const seen = new Set<string>();
    const local: Candidate[] = [];
    for (const option of cardOptions(state, card)) {
      // carte à choix sans estimation (Roque et rolle) : l'ordinateur ne sait pas la jouer
      if (CARD_BY_ID[card].followUp && !option.estimate) continue;
      const fen = toFen(effect(option));
      if (seen.has(fen)) continue;
      seen.add(fen);
      local.push({ card, option, quick: quickEval(effect(option), me) });
    }
    local.sort((a, b) => b.quick - a.quick);
    out.push(...local.slice(0, local.length <= 5 ? 5 : 3));
  }
  return out;
}

/**
 * Évaluation d'une position du point de vue de `me`, quel que soit le camp au trait.
 * `forbidden` : coup que le camp au trait n'a pas le droit de jouer (Contrordre).
 */
async function evalFor(engine: Engine, level: BotLevel, p: Position, me: Color, forbidden?: string, only?: string[]): Promise<number> {
  const searchmoves = only ?? (forbidden ? legalMoves(p).map((m) => m.uci).filter((u) => u !== forbidden) : undefined);
  const a = await engine.analyse(engineFen(p), { depth: level.cardDepth, movetime: level.cardMovetime, searchmoves });
  return p.turn === me ? a.score : -a.score;
}

async function bestCard(engine: Engine, level: BotLevel, cands: Candidate[], me: Color): Promise<{ c: Candidate; score: number } | null> {
  let best: { c: Candidate; score: number } | null = null;
  for (const c of cands) {
    const score = await evalFor(engine, level, effect(c.option), me);
    if (!best || score > best.score) best = { c, score };
  }
  return best;
}

/**
 * Réagir au coup adverse ? On compare chaque réaction à la position telle quelle.
 * Pour un Duel, l'issue est un pile ou face : on n'en compte que la moitié du gain.
 */
async function decideReaction(state: GameState, engine: Engine, level: BotLevel, rnd: () => number): Promise<Action> {
  const me = actor(state);
  const ids = state.hands[me].filter((id) => CARD_BY_ID[id].timing === 'reaction');
  const cands = candidates(state, ids, me);
  if (!cands.length || rnd() >= level.cardEagerness) return { type: 'pass' };
  const base = await evalFor(engine, level, state.pos, me);
  const forbidden = state.reactTo?.move.uci;
  const pc = level.riskWeight > 0 ? counterRisk(state, me, unseenCards(state, me)) : 0;
  let best: { c: Candidate; score: number } | null = null;
  for (const c of cands) {
    const replay = CARD_BY_ID[c.card].reaction === 'replay';
    let score = await evalFor(engine, level, effect(c.option), me, replay ? forbidden : undefined);
    if (CARD_BY_ID[c.card].reaction === 'duel') score = base + (score - base) / 2;
    score = discounted(score, base, pc);
    if (!best || score > best.score) best = { c, score };
  }
  return best && best.score > base + level.margin ? toAction(best.c) : { type: 'pass' };
}

const toAction = (c: Candidate): Action => ({ type: 'card', card: c.card, path: c.option.path, label: c.option.label });

/**
 * Carte « après le coup » prévue lors du choix du coup (combinaison coup + carte).
 * Repérée par la position obtenue après le coup, pour ne servir que dans ce tour-là.
 */
let plan: { key: string; action: Extract<Action, { type: 'card' }> } | null = null;
const planKey = (s: GameState) => `${s.active}|${s.ply}|${toFen(s.pos)}`;

/** Le coup prévu est-il encore jouable tel quel ? */
function stillValid(state: GameState, a: Extract<Action, { type: 'card' }>): boolean {
  return cardOptions(state, a.card).some(
    (o) => o.path.length === a.path.length && o.path.every((x, i) => x === a.path[i]) && (o.label ?? undefined) === (a.label ?? undefined),
  );
}

interface Combo {
  move: Extract<Action, { type: 'move' }>;
  after: GameState;
  cand: Candidate;
}

/**
 * Pour chacun des meilleurs coups, quelles cartes « après le coup » deviennent intéressantes ?
 * On présélectionne avec l'évaluation rapide, puis seuls les plus prometteurs passent au moteur.
 */
async function bestCombo(state: GameState, engine: Engine, level: BotLevel, ucis: string[], afterIds: string[]) {
  const me = state.active;
  const view = botView(state, me); // (sans la main adverse : pas d'étape de réaction simulée)
  const moves = normalMoves(view);
  const combos: Combo[] = [];
  for (const uci of ucis) {
    const m = moves.find((x) => x.uci === uci);
    if (!m) continue;
    const move = { type: 'move' as const, from: m.from, to: m.to, promotion: m.promotion };
    const after = apply(view, move);
    if (after.phase !== 'after') continue;
    for (const cand of candidates(after, afterIds, me)) combos.push({ move, after, cand });
  }
  combos.sort((a, b) => b.cand.quick - a.cand.quick);
  let best: { combo: Combo; score: number } | null = null;
  for (const combo of combos.slice(0, level.comboEvals)) {
    const a = await engine.analyse(engineFen(effect(combo.cand.option)), { depth: level.cardDepth, movetime: level.cardMovetime });
    const score = -a.score;
    if (!best || score > best.score) best = { combo, score };
  }
  return best;
}

/**
 * Potentiel des cartes en main après un coup : le meilleur gain (évaluation rapide) qu'elles
 * offriraient si la position restait telle quelle jusqu'au tour suivant. C'est optimiste
 * (l'adversaire jouera entre-temps), d'où la pondération `prepWeight`.
 */
export function cardPotential(after: GameState, me: Color, ids: string[]): number {
  const base = quickEval(after.pos, me);
  // tour suivant, avant le coup : c'est de nouveau à moi
  const nextMain: GameState = { ...after, phase: 'main', active: me, cardPlayed: false, lastMove: null, pos: { ...after.pos, turn: me, ep: null } };
  // tour suivant, après le coup : approximé par la position actuelle
  const nextAfter: GameState = { ...after, cardPlayed: false };
  let best = 0;
  for (const id of ids) {
    const st = CARD_BY_ID[id].timing === 'replace' ? nextMain : nextAfter;
    for (const o of cardOptions(st, id)) best = Math.max(best, quickEval(o.result, me) - base);
  }
  return Math.min(best, 1000);
}

/**
 * Parmi les meilleurs coups de Stockfish, préfère celui qui rend mes cartes plus efficaces au tour
 * suivant (`prepIds`), et qui expose le moins aux cartes que l'adversaire tient peut-être
 * (`unseen`). Renvoie null pour garder le coup prévu.
 */
function rerank(state: GameState, normal: Analysis, level: BotLevel, prepIds: string[], unseen: Unseen | null): string | null {
  const lines = normal.lines ?? [];
  if (lines.length < 2 || Math.abs(lines[0].score) > MATE_SCORE / 2) return null; // un mat se joue, il ne se prépare pas
  const me = state.active;
  const view = botView(state, me);
  const moves = normalMoves(view);
  const tolerance = Math.max(prepIds.length ? level.prepTolerance : 0, unseen ? level.riskTolerance : 0);
  const memo = new Map<string, number>();
  const adjusted = (l: { move: string; score: number }) => {
    const known = memo.get(l.move);
    if (known !== undefined) return known;
    const m = moves.find((x) => x.uci === l.move);
    if (!m) return -Infinity;
    const after = apply(view, { type: 'move', from: m.from, to: m.to, promotion: m.promotion });
    let s = l.score;
    if (prepIds.length) s += level.prepWeight * cardPotential(after, me, prepIds);
    if (unseen) s -= level.riskWeight * threat(after, state.pos, m, me, unseen);
    memo.set(l.move, s);
    return s;
  };
  const ref = lines.find((l) => l.move === normal.bestmove) ?? lines[0];
  const refScore = adjusted(ref);
  let best: { move: string; score: number } | null = null;
  for (const l of lines) {
    if (l === ref || l.score < lines[0].score - tolerance) continue;
    const s = adjusted(l);
    if (!best || s > best.score) best = { move: l.move, score: s };
  }
  // il faut un vrai gain pour s'écarter du coup prévu
  return best && best.score > refScore + 20 ? best.move : null;
}

/**
 * Annuler la carte en suspens (Non, Niet) ? On compare la position avec et sans son effet.
 * Les cartes qui n'agissent que sur les mains ne sont pas évaluées.
 */
async function decideCounter(state: GameState, engine: Engine, level: BotLevel, rnd: () => number): Promise<Action> {
  const me = actor(state);
  const p = state.pending!;
  const counter = playableCards(state)[0];
  const def = CARD_BY_ID[p.card];
  if (!counter || def.hand || rnd() >= level.cardEagerness) return { type: 'pass' };
  const without = await evalFor(engine, level, state.pos, me);
  let withEffect = await evalFor(engine, level, effect(p.option), me, def.reaction === 'replay' ? state.reactTo?.move.uci : undefined);
  if (def.reaction === 'duel') withEffect = without + (withEffect - without) / 2;
  const gain = withEffect - without; // ce que l'effet me rapporte
  const applies = p.counters.length % 2 === 0; // si je laisse passer
  const flip = applies ? gain < -level.margin : gain > level.margin;
  return flip ? { type: 'card', card: counter, path: [] } : { type: 'pass' };
}

/** Choix demandé par une carte : les options les plus prometteuses passent au moteur. */
async function decideChoice(state: GameState, engine: Engine, level: BotLevel): Promise<Action> {
  const step = choiceStep(state)!;
  const me = step.chooser;
  const toChoice = (o: CardOption): Action => ({ type: 'choose', path: o.path, label: o.label });
  if (step.options.length === 1) return toChoice(step.options[0]);
  if (state.choice?.card === 'roqueEtRolle') {
    // chaque échange laisse l'ordinateur au trait, et le moteur le préférerait toujours à « Terminer » :
    // on termine dès que possible, sinon on cherche un échange qui met le Roi à l'abri, sinon on renonce
    const pick =
      step.options.find((o) => o.label === 'Terminer') ??
      step.options.find((o) => o.path.length && !inCheck(o.result.board, me)) ??
      step.options.find((o) => o.label === 'Renoncer');
    if (pick) return toChoice(pick);
  }
  const ranked = [...step.options].sort((a, b) => quickEval(b.result, me) - quickEval(a.result, me)).slice(0, 4);
  const forbidden = state.choice?.reactTo?.move.uci;
  let best: { o: CardOption; score: number } | null = null;
  for (const o of ranked) {
    const score = await evalFor(engine, level, o.result, me, o.replay ? forbidden : undefined);
    if (!best || score > best.score) best = { o, score };
  }
  return toChoice(best!.o);
}

/** Même position, mais c'est à l'autre camp de jouer (« passer son tour »). */
function nullMove(p: Position): Position {
  return { ...p, board: p.board.slice(), turn: other(p.turn), ep: null };
}

/**
 * Valeur d'une carte à règle temporaire, jouée après mon coup (l'adversaire est au trait) :
 * on fait jouer l'adversaire sous la contrainte qu'elle impose. Renvoie aussi l'option retenue.
 */
async function ruleValue(state: GameState, engine: Engine, level: BotLevel, card: string, base: number): Promise<{ score: number; option: CardOption } | null> {
  const me = state.active;
  const options = cardOptions(state, card);
  if (!options.length) return null;
  const pos = state.pos;
  const theirs = legalMoves(pos);
  const ucis = (ms: typeof theirs) => ms.map((m) => m.uci);
  const caps = theirs.filter((m) => m.captured);
  const quiet = theirs.filter((m) => !m.captured);
  switch (card) {
    case 'provocation': {
      const pass = await evalFor(engine, level, nullMove(pos), me);
      const take = caps.length ? await evalFor(engine, level, pos, me, undefined, ucis(caps)) : Infinity;
      return { score: Math.min(pass, take), option: options[0] }; // il choisit ce qui l'arrange
    }
    case 'cessezLeFeu':
      return { score: quiet.length && caps.length ? await evalFor(engine, level, pos, me, undefined, ucis(quiet)) : base, option: options[0] };
    case 'fringale':
      return { score: caps.length ? await evalFor(engine, level, pos, me, undefined, ucis(caps)) : base, option: options[0] };
    case 'planque': {
      // les pièces adverses les plus précieuses qui ont des coups
      const ranked = options
        .filter((o) => pos.board[o.path[0]]?.t !== 'k' && theirs.some((m) => m.from === o.path[0]))
        .sort((a, b) => PIECE_VALUE[pos.board[b.path[0]]!.t] - PIECE_VALUE[pos.board[a.path[0]]!.t])
        .slice(0, 4);
      let best: { score: number; option: CardOption } | null = null;
      for (const o of ranked) {
        const rest = theirs.filter((m) => m.from !== o.path[0]);
        if (!rest.length) continue;
        const score = await evalFor(engine, level, pos, me, undefined, ucis(rest));
        if (!best || score > best.score) best = { score, option: o };
      }
      return best;
    }
    case 'origines':
      // figer la partie n'a d'intérêt que si l'on mène nettement
      return { score: base > 300 ? base + level.margin + 1 : base, option: options[0] };
    case 'voyance': {
      // on parie sur le meilleur coup adverse ; s'il le joue, il perd son tour
      const guess = (await engine.analyse(engineFen(pos), { depth: level.cardDepth, movetime: level.cardMovetime })).bestmove;
      const option = options.find((o) => guess?.startsWith(sqName(o.path[0])));
      if (!option) return null;
      const trapped = await evalFor(engine, level, nullMove(pos), me);
      return { score: base + (trapped - base) / 2, option };
    }
  }
  return null;
}

/** Manche de pierre-feuille-ciseaux : au hasard, sans regarder le choix adverse. */
export function duelThrow(color: Color, rnd: () => number = Math.random): Action {
  return { type: 'duel', color, throw: THROWS[Math.floor(rnd() * THROWS.length)] };
}

export async function decide(state: GameState, engine: Engine, level: BotLevel, rnd: () => number = Math.random): Promise<Action> {
  const me = actor(state);
  const hand = state.hands[me];

  if (state.phase === 'duel') throw new Error('Duel : utiliser duelThrow');
  if (state.phase === 'reaction') return decideReaction(state, engine, level, rnd);
  if (state.phase === 'counter') return decideCounter(state, engine, level, rnd);
  if (state.phase === 'choice') return decideChoice(state, engine, level);

  if (state.phase === 'after') {
    // carte prévue en même temps que le coup qui vient d'être joué
    const planned = plan && plan.key === planKey(state) ? plan.action : null;
    plan = null;
    if (planned && stillValid(state, planned)) return planned;

    const ids = hand.filter((id) => CARD_BY_ID[id].timing === 'after' && !CARD_BY_ID[id].rule);
    const ruleIds = hand.filter((id) => CARD_BY_ID[id].timing === 'after' && CARD_BY_ID[id].rule && cardOptions(state, id).length);
    const cands = candidates(state, ids, me);
    if ((cands.length || ruleIds.length || canReplay(state)) && rnd() < level.cardEagerness) {
      const base = await evalFor(engine, level, state.pos, me);
      // une carte peut être annulée (Non, Niet) ; rejouer avec Je passe, non (ce n'est pas une carte jouée)
      const pc = level.riskWeight > 0 ? counterRisk(state, me, unseenCards(state, me)) : 0;
      let best: { action: Action; score: number } | null = null;
      // Je passe en réserve : rejouer un coup tout de suite
      if (canReplay(state)) best = { action: { type: 'replay' }, score: await evalFor(engine, level, nullMove(state.pos), me) };
      const found = cands.length ? await bestCard(engine, level, cands, me) : null;
      const foundScore = found ? discounted(found.score, base, pc) : -Infinity;
      if (found && (!best || foundScore > best.score)) best = { action: toAction(found.c), score: foundScore };
      for (const id of ruleIds) {
        const r = await ruleValue(state, engine, level, id, base);
        const score = r ? discounted(r.score, base, pc) : -Infinity;
        if (r && (!best || score > best.score)) best = { action: { type: 'card', card: id, path: r.option.path, label: r.option.label }, score };
      }
      if (best && best.score > base + level.margin) return best.action;
    }
    const dead = hand.find((id) => canDiscard(state, id));
    if (dead) return { type: 'discard', card: dead };
    return { type: 'endTurn' };
  }

  // ----- phase principale -----
  const moves = normalMoves(state);
  const replaceIds = hand.filter((id) => CARD_BY_ID[id].timing === 'replace');

  if (canSkip(state)) {
    // Provocation : prendre (au mieux) ou passer son tour
    if (!moves.length) return { type: 'skip' };
    const pass = await evalFor(engine, level, nullMove(state.pos), me);
    const take = await engine.analyse(engineFen(state.pos), { depth: level.depth, skill: level.skill, searchmoves: moves.map((m) => m.uci) });
    if (pass > take.score) return { type: 'skip' };
    const m = moves.find((x) => x.uci === take.bestmove) ?? moves[0];
    return { type: 'move', from: m.from, to: m.to, promotion: m.promotion };
  }

  if (!moves.length) {
    // sans coup légal, une carte « à la place du coup » est forcément disponible
    const best = await bestCard(engine, level, candidates(state, replaceIds, me), me);
    if (best) return toAction(best.c);
  }

  const eager = rnd() < level.cardEagerness;
  // cartes « après le coup » encore vivantes : elles peuvent orienter le choix du coup
  const afterIds = hand.filter((id) => CARD_BY_ID[id].timing === 'after' && !isDead(id, state.pos, me));
  const lookCombos = eager && !state.cardPlayed && afterIds.length > 0 && level.comboMoves > 1;
  // cartes de plateau encore vivantes : on peut préparer le terrain pour le tour suivant
  const prepIds = hand.filter((id) => {
    const d = CARD_BY_ID[id];
    return !d.hand && (d.timing === 'replace' || d.timing === 'after') && !isDead(id, state.pos, me);
  });
  const lookPrep = eager && level.prepWeight > 0 && prepIds.length > 0 && level.comboMoves > 1;
  // méfiance envers les cartes adverses possibles (les plus dangereuses, ou manifestement
  // préparées) : il faut plusieurs coups à comparer
  const unseen = unseenCards(state, me);
  const watched = level.riskWeight > 0 && unseen.p > 0 && moves.length > 1 ? watchedCards(state, me, level, unseen) : null;
  const lookRisk = !!watched?.ids.length && level.comboMoves > 1;

  const normal = await engine.analyse(engineFen(state.pos), {
    depth: level.depth,
    skill: level.skill,
    multipv: lookCombos || lookPrep || lookRisk ? level.comboMoves : undefined,
    // coups restreints (coup annulé par Contrordre, Cessez le feu, Fringale, Planque…)
    searchmoves: moves.length < legalMoves(state.pos).length ? moves.map((m) => m.uci) : undefined,
  });

  if (eager) {
    const threshold = normal.score + level.margin;
    // mes cartes risquent d'être annulées : leur gain attendu en tient compte
    const pc = level.riskWeight > 0 ? counterRisk(state, me, unseen) : 0;
    const worth = (score: number) => discounted(score, normal.score, pc);
    const cands = candidates(state, replaceIds, me);
    const best = cands.length ? await bestCard(engine, level, cands, me) : null;
    // le meilleur coup reste examiné même si le niveau « affaibli » ne l'a pas choisi
    const ucis = lookCombos ? [...new Set([normal.bestmove, ...(normal.lines ?? []).map((l) => l.move)])].filter((x): x is string => !!x) : [];
    const combo = ucis.length ? await bestCombo(state, engine, level, ucis, afterIds) : null;

    const replaceScore = best && worth(best.score) > threshold ? worth(best.score) : -Infinity;
    const comboScore = combo && worth(combo.score) > threshold ? worth(combo.score) : -Infinity;
    if (comboScore > replaceScore) {
      plan = { key: planKey(combo!.combo.after), action: toAction(combo!.combo.cand) as Extract<Action, { type: 'card' }> };
      return combo!.combo.move;
    }
    if (best && replaceScore > -Infinity) return toAction(best.c);

    // Je passe : passer son tour vaut-il mieux que tous ses coups (zugzwang) ?
    if (cardOptions(state, 'jePasse').length) {
      const pass = await evalFor(engine, level, nullMove(state.pos), me);
      if (worth(pass) > threshold) return { type: 'card', card: 'jePasse', path: [] };
    }

    // cartes de main : utiles surtout quand la main ne sert à rien
    const usefulReplace = replaceIds.some((id) => cardOptions(state, id).length > 0);
    if (!usefulReplace && !state.cardPlayed) {
      if (hand.includes('coupDeBalai') && cardOptions(state, 'coupDeBalai').length && rnd() < 0.25) return { type: 'card', card: 'coupDeBalai', path: [] };
      if (hand.includes('donneMoiTaMain') && cardOptions(state, 'donneMoiTaMain').length && rnd() < 0.15) return { type: 'card', card: 'donneMoiTaMain', path: [] };
    }
  }

  const uci = ((lookPrep || lookRisk) && rerank(state, normal, level, lookPrep ? prepIds : [], lookRisk ? watched : null)) || normal.bestmove;
  // (la position vue par Stockfish peut différer un peu, cf. engineFen : on retombe sur un coup légal)
  const m =
    moves.find((x) => x.uci === uci) ??
    (normal.lines ?? []).map((l) => moves.find((x) => x.uci === l.move)).find((x) => !!x) ??
    moves[Math.floor(rnd() * moves.length)];
  return { type: 'move', from: m.from, to: m.to, promotion: m.promotion };
}
