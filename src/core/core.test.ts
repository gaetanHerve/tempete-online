import { describe, expect, it } from 'vitest';
import { CARD_BY_ID, CARDS, DECK_CARDS, isDead } from './cards';
import { actor, apply, canDiscard, canReplay, canSkip, cardOptions, choiceStep, mustAct, newGame, normalMoves, playableCards, type GameState, type Throw } from './game';
import { engineFen, fromFen, isSane, parseSq, toFen } from './position';
import { legalMoves } from './chess';

const S = parseSq;

/** Donne une main au joueur actif ; l'adversaire perd ses réactions et annulations (sauf test dédié). */
function withHand(state: GameState, ids: string[], fen?: string): GameState {
  const s = structuredClone(state);
  s.hands[s.active] = ids;
  const opp = s.active === 'w' ? 'b' : 'w';
  s.hands[opp] = s.hands[opp].filter((id) => !['reaction', 'counter'].includes(CARD_BY_ID[id].timing));
  s.deck = s.deck.filter((id) => id !== 'rebeloteEtDixDeDer'); // piochée, elle garderait le tour ouvert
  if (fen) s.pos = fromFen(fen);
  return s;
}

describe('position', () => {
  it('FEN aller-retour', () => {
    const fen = 'r3k2r/pp1n1ppp/2p5/8/3P4/8/PPP2PPP/R3K2R b KQkq d3 0 12';
    expect(toFen(fromFen(fen))).toBe(fen);
  });
});

describe('partie', () => {
  it('distribue 5 cartes chacun', () => {
    const g = newGame(42);
    expect(g.hands.w).toHaveLength(5);
    expect(g.hands.b).toHaveLength(5);
    expect(g.deck.length + 10).toBe(DECK_CARDS.length);
    expect([...g.deck, ...g.hands.w, ...g.hands.b]).toContain('laser'); // de retour dans le paquet
  });

  it('est déterministe pour une graine donnée', () => {
    expect(newGame(7).hands).toEqual(newGame(7).hands);
  });

  it('un coup normal sans carte jouable attend la fin de tour du joueur', () => {
    let g = withHand(newGame(1), ['pegase']); // Pégase se joue à la place du coup
    g = apply(g, { type: 'move', from: S('e2'), to: S('e4') });
    expect(g.active).toBe('w');
    expect(g.phase).toBe('after');
    expect(playableCards(g)).toHaveLength(0);
    g = apply(g, { type: 'endTurn' });
    expect(g.active).toBe('b');
    expect(g.phase).toBe('main');
  });

  it('carte « après » : la phase attend le joueur, puis passe la main', () => {
    let g = withHand(newGame(1), ['laser'], 'k7/8/8/n7/8/8/8/R3K3 w - - 0 1');
    g = apply(g, { type: 'move', from: S('e1'), to: S('f1') });
    expect(g.phase).toBe('after');
    expect(playableCards(g)).toEqual(['laser']);
    g = apply(g, { type: 'card', card: 'laser', path: [S('a1'), S('a2')] });
    expect(g.active).toBe('b');
    expect(g.pos.board[S('a5')]).toBeNull();
    expect(g.pos.board[S('a8')]?.t).toBe('k'); // les rois résistent au laser
    expect(g.hands.w).toHaveLength(1); // a pioché
  });
});

describe('cartes', () => {
  const ctxGame = (fen: string, ids: string[]) => withHand(newGame(3), ids, fen);

  it('Pégase : cavalier sur case libre de couleur opposée', () => {
    const g = ctxGame('4k3/8/8/8/8/8/8/1N2K3 w - - 0 1', ['pegase']);
    const opts = cardOptions(g, 'pegase');
    expect(opts.length).toBeGreaterThan(20);
    expect(opts.every((o) => isSane(o.result))).toBe(true);
  });

  it('Bonnes Copines échange les dames', () => {
    let g = ctxGame('3q4/7k/8/8/8/8/K7/3Q4 w - - 0 1', ['bonnesCopines']);
    g = apply(g, { type: 'card', card: 'bonnesCopines', path: [S('d1'), S('d8')] });
    expect(g.pos.board[S('d1')]).toEqual({ t: 'q', c: 'b' });
    expect(g.pos.board[S('d8')]).toEqual({ t: 'q', c: 'w' });
    expect(g.active).toBe('b');
  });

  it('une carte ne peut pas laisser son roi en échec', () => {
    // le cavalier e2 protège son roi de la tour e8
    const g = ctxGame('4r1k1/8/8/8/8/8/4N3/4K3 w - - 0 1', ['pegase']);
    const opts = cardOptions(g, 'pegase');
    // seules restent les cases de la colonne e, où le cavalier continue de faire écran
    expect(opts.length).toBe(3);
    expect(opts.every((o) => o.path[1] % 8 === 4)).toBe(true);
  });

  it('une carte peut sauver d’un mat', () => {
    // Mat du couloir, mais Oh darling permet au roi de rejoindre sa dame
    let g = newGame(5);
    g.hands.b = ['ohDarling'];
    g = withHand(g, ['pegase'], '6k1/1q3ppp/8/8/8/8/8/K3R3 w - - 0 1');
    g = apply(g, { type: 'move', from: S('e1'), to: S('e8') });
    g = apply(g, { type: 'endTurn' });
    expect(g.phase).toBe('main');
    expect(g.active).toBe('b');
    expect(g.result).toBeNull();
  });

  it('mat sans carte de secours', () => {
    let g = newGame(5);
    g.hands.b = ['laser'];
    g = withHand(g, ['pegase'], '6k1/5ppp/8/8/8/8/8/K3R3 w - - 0 1');
    g = apply(g, { type: 'move', from: S('e1'), to: S('e8') });
    g = apply(g, { type: 'endTurn' });
    expect(g.phase).toBe('over');
    expect(g.result?.winner).toBe('w');
  });

  it('Chasse-neige balaie tout jusqu’à une pièce amie', () => {
    const g = ctxGame('4k3/R7/p7/8/n7/8/8/R3K3 w - - 0 1', ['chasseNeige']);
    const o = cardOptions(g, 'chasseNeige').find((x) => x.path[0] === S('a1') && x.path[1] === S('a6'));
    expect(o).toBeDefined();
    expect(o!.result.board[S('a4')]).toBeNull();
    expect(o!.result.board[S('a6')]).toEqual({ t: 'r', c: 'w' });
  });

  it('Quadrille fait tourner les coins', () => {
    let g = ctxGame('r3k3/8/8/8/8/8/8/4K2R w - - 0 1', ['quadrille']);
    g = apply(g, { type: 'move', from: S('e1'), to: S('d1') });
    g = apply(g, { type: 'card', card: 'quadrille', path: [], label: 'Sens horaire' });
    expect(g.pos.board[S('h8')]?.t).toBe('r'); // a8 → h8
    expect(g.pos.board[S('a1')]?.t).toBe('r'); // h1 → a1
  });

  it('Coup de balai renouvelle la main sans finir le tour', () => {
    let g = withHand(newGame(9), ['coupDeBalai', 'laser', 'pegase']);
    g = apply(g, { type: 'card', card: 'coupDeBalai', path: [] });
    expect(g.hands.w).toHaveLength(5);
    expect(g.phase).toBe('main');
    expect(playableCards(g)).toHaveLength(0); // une seule carte par tour
  });

  it('défausse : seulement une carte morte, après le coup, et cela compte comme la carte du tour', () => {
    // pas de cavalier blanc : Pégase est morte ; Laser n'a pas de cible mais la tour existe
    let g = ctxGame('4k3/8/8/8/8/8/P7/R3K3 w - - 0 1', ['pegase', 'laser', 'amourCourtois']);
    expect(canDiscard(g, 'pegase')).toBe(false); // pas avant le coup
    g = apply(g, { type: 'move', from: S('a2'), to: S('a3') });
    expect(canDiscard(g, 'pegase')).toBe(true);
    expect(canDiscard(g, 'laser')).toBe(false);
    g = apply(g, { type: 'discard', card: 'pegase' });
    expect(g.hands.w).toHaveLength(3); // a repioché
    expect(g.hands.w).not.toContain('pegase');
    expect(g.phase).toBe('after'); // le joueur termine lui-même son tour
    expect(g.active).toBe('w');
    expect(canDiscard(g, 'amourCourtois')).toBe(false);
    expect(playableCards(g)).toHaveLength(0);
  });

  it('promotion au mérite meurt quand aucun pion ne peut plus atteindre la 6e rangée', () => {
    const g = ctxGame('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['promotionAuMerite']);
    expect(isDead('promotionAuMerite', g.pos, 'w')).toBe(true);
    const g2 = ctxGame('4k3/8/8/P7/8/8/8/4K3 w - - 0 1', ['promotionAuMerite']);
    expect(isDead('promotionAuMerite', g2.pos, 'w')).toBe(false);
  });

  it('Encéphalopathie : un Cavalier (le sien ou un adverse) devient Fou', () => {
    let g = ctxGame('4k3/8/8/8/8/8/8/1N2K2n w - - 0 1', ['encephalopathieSpongiformeEquine']);
    g = apply(g, { type: 'move', from: S('e1'), to: S('e2') });
    expect(cardOptions(g, 'encephalopathieSpongiformeEquine')).toHaveLength(2);
    g = apply(g, { type: 'card', card: 'encephalopathieSpongiformeEquine', path: [S('h1')] });
    expect(g.pos.board[S('h1')]).toEqual({ t: 'b', c: 'b' });
    expect(g.active).toBe('b');
  });

  it('Serial killer : le pion enchaîne les prises tant qu’il peut', () => {
    let g = ctxGame('4k3/6r1/5b2/4n3/3P4/8/8/4K3 w - - 0 1', ['serialKiller']);
    expect(cardOptions(g, 'serialKiller')).toHaveLength(0); // pas avant le coup
    g = apply(g, { type: 'move', from: S('d4'), to: S('e5') });
    const opts = cardOptions(g, 'serialKiller');
    expect(opts.map((o) => o.path)).toEqual([[S('e5'), S('f6'), S('g7')]]);
    g = apply(g, { type: 'card', card: 'serialKiller', path: opts[0].path });
    expect(g.pos.board[S('g7')]).toEqual({ t: 'p', c: 'w' });
    expect(g.pos.board[S('f6')]).toBeNull();
    expect(g.pos.board[S('e5')]).toBeNull();
  });

  it('Voyage astral : on traverse la case libérée sans s’y arrêter', () => {
    const g = ctxGame('4k3/8/8/8/8/8/P7/R3K3 w - - 0 1', ['voyageAstral']);
    const opts = cardOptions(g, 'voyageAstral');
    expect(opts.some((o) => o.path[2] === S('a2'))).toBe(false);
    const o = opts.find((x) => x.path.join() === [S('a2'), S('a1'), S('a5')].join())!;
    expect(o).toBeDefined();
    expect(o.result.board[S('a2')]).toEqual({ t: 'p', c: 'w' }); // le pion est revenu
    expect(o.result.board[S('a5')]).toEqual({ t: 'r', c: 'w' });
    // seuls les coups rendus possibles par le voyage sont proposés
    const usual = new Set(legalMoves(g.pos).map((m) => `${m.from}-${m.to}`));
    expect(opts.every((x) => !usual.has(`${x.path[1]}-${x.path[2]}`))).toBe(true);
  });

  it('Ange gardien : une pièce perdue revient s’intercaler, même contre un mat', () => {
    let g = newGame(4);
    g.pos = fromFen('6k1/8/8/8/8/8/r4PPP/6K1 b - - 0 1');
    g.active = 'b';
    g.hands.b = [];
    g.hands.w = ['angeGardien'];
    g = apply(g, { type: 'move', from: S('a2'), to: S('a1') }); // mat du couloir
    g = apply(g, { type: 'endTurn' });
    expect(g.phase).toBe('main'); // la carte sauve du mat
    const opts = cardOptions(g, 'angeGardien');
    expect(new Set(opts.map((o) => o.path[0]))).toEqual(new Set(['b1', 'c1', 'd1', 'e1', 'f1'].map(S)));
    g = apply(g, { type: 'card', card: 'angeGardien', path: [S('d1')], label: 'Dame' });
    expect(g.pos.board[S('d1')]).toEqual({ t: 'q', c: 'w' });
    expect(g.active).toBe('b');
  });

  it('Ange gardien : seulement en échec', () => {
    const g = ctxGame('4k3/8/8/8/8/8/8/4K3 w - - 0 1', ['angeGardien']);
    expect(cardOptions(g, 'angeGardien')).toHaveLength(0);
  });

  it('Tournez manège : rotation, promotions, et pion sur sa première rangée conservé', () => {
    let g = ctxGame('4k3/8/8/8/8/8/P6P/4K3 w - - 0 1', ['tournezManege']);
    g = apply(g, { type: 'move', from: S('e1'), to: S('d1') });
    g = apply(g, { type: 'card', card: 'tournezManege', path: [], label: 'Sens horaire' });
    expect(g.pos.board[S('b8')]).toEqual({ t: 'q', c: 'w' }); // a2 → b8 : promu
    expect(g.pos.board[S('b1')]).toEqual({ t: 'p', c: 'w' }); // h2 → b1 : reste un pion
    expect(g.pos.board[S('a5')]?.t).toBe('k');
    expect(g.pos.board[S('h4')]?.t).toBe('k');
    expect(isSane(g.pos)).toBe(true);
    // Stockfish ne voit qu'une approximation : le pion avancé d'une case
    expect(engineFen(g.pos).split(' ')[0]).toBe('1Q6/8/8/K7/7k/8/1P6/8');
  });

  it('un pion sur sa propre première rangée avance d’une case', () => {
    const p = fromFen('4k3/8/8/8/8/8/8/P3K3 w - - 0 1');
    expect(isSane({ ...p, turn: 'b' })).toBe(true);
    expect(legalMoves(p).filter((m) => m.piece === 'p').map((m) => m.uci)).toEqual(['a1a2']);
    expect(isSane(fromFen('P3k3/8/8/8/8/8/8/4K3 b - - 0 1'))).toBe(false); // mais pas sur sa rangée de promotion
  });

  it('pas de doublon parmi les cartes', () => {
    // illustrations et textes : voir src/lib/vault.test.ts
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(CARDS.length);
  });
});

describe('réactions au coup adverse', () => {
  /** Les Blancs jouent `from`→`to` ; les Noirs tiennent `hand`. */
  function after(fen: string, from: string, to: string, hand: string[]): GameState {
    const g = newGame(11);
    g.pos = fromFen(fen);
    g.active = 'w';
    g.hands.w = [];
    g.hands.b = hand;
    return apply(g, { type: 'move', from: S(from), to: S(to) });
  }
  const react = (g: GameState, card: string, path: string[] = [], label?: string) => apply(g, { type: 'card', card, path: path.map(S), label });
  const at = (g: GameState, s: string) => g.pos.board[S(s)];

  it("pas d'étape de réaction sans carte applicable", () => {
    const g = after('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a6', ['pegase', 'ruade']); // Ruade : pas un Cavalier
    expect(g.phase).toBe('after');
  });

  it('Brouillard : la pièce s’arrête après une case', () => {
    let g = after('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a6', ['brouillard']);
    expect(g.phase).toBe('reaction');
    expect(actor(g)).toBe('b');
    g = react(g, 'brouillard');
    expect(at(g, 'a2')).toEqual({ t: 'r', c: 'w' });
    expect(at(g, 'a6')).toBeNull();
    expect(g.phase).toBe('after');
    expect(g.active).toBe('w');
    expect(g.hands.b).toHaveLength(1); // a pioché
  });

  it('Contrordre : le coup est annulé et doit être remplacé, sans seconde réaction', () => {
    let g = after('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a6', ['contrordre', 'brouillard']);
    g = react(g, 'contrordre');
    expect(g.phase).toBe('main');
    expect(at(g, 'a1')?.t).toBe('r');
    expect(normalMoves(g).some((m) => m.uci === 'a1a6')).toBe(false);
    expect(() => apply(g, { type: 'move', from: S('a1'), to: S('a6') })).toThrow();
    g = apply(g, { type: 'move', from: S('a1'), to: S('a5') });
    expect(g.phase).toBe('after'); // une seule carte pendant le tour adverse
    g = apply(g, { type: 'endTurn' });
    expect(g.reacted).toBe(false);
  });

  it('Ruade : je déplace moi-même le Cavalier adverse', () => {
    let g = after('4k3/8/8/8/8/8/8/1N2K3 w - - 0 1', 'b1', 'c3', ['ruade']);
    g = react(g, 'ruade', ['b1', 'a3']); // on touche le Cavalier revenu sur sa case de départ
    expect(at(g, 'a3')).toEqual({ t: 'n', c: 'w' });
    expect(at(g, 'c3')).toBeNull();
    expect(at(g, 'b1')).toBeNull();
    expect(g.lastMove).toBeNull();
  });

  it('Dalaï-Lama : la pièce prise se réincarne sur une case de départ libre', () => {
    let g = after('1n2k3/8/8/8/8/8/8/1R2K3 w - - 0 1', 'b1', 'b8', ['dalaiLama']);
    expect(cardOptions(g, 'dalaiLama').map((o) => o.path[0])).toEqual([S('g8')]); // b8 est occupée
    g = react(g, 'dalaiLama', ['g8']);
    expect(at(g, 'g8')).toEqual({ t: 'n', c: 'b' });
    expect(g.lastMove?.uci).toBe('b1b8'); // le coup adverse reste valable
  });

  it('Toi aussi, mon fils : la pièce qui donne échec change de camp', () => {
    let g = after('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a8', ['toiAussiMonFils']);
    g = react(g, 'toiAussiMonFils', ['a8']);
    expect(at(g, 'a8')).toEqual({ t: 'r', c: 'b' });
  });

  it('Pitié : la pièce s’arrête juste devant le pion', () => {
    let g = after('4k3/8/p7/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a6', ['pitie']);
    g = react(g, 'pitie');
    expect(at(g, 'a5')).toEqual({ t: 'r', c: 'w' });
    expect(at(g, 'a6')).toEqual({ t: 'p', c: 'b' });
  });

  it('Olé : l’attaquante passe au travers, prend plus loin ou tombe', () => {
    let g = after('4k3/p7/n7/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a6', ['ole']);
    g = react(g, 'ole');
    expect(at(g, 'a6')).toEqual({ t: 'n', c: 'b' });
    expect(at(g, 'a7')).toEqual({ t: 'r', c: 'w' }); // a pris le pion
    let h = after('4k3/8/n7/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a6', ['ole']);
    h = react(h, 'ole');
    expect(h.pos.board.filter((p) => p?.c === 'w' && p.t === 'r')).toHaveLength(0); // tombée de l'échiquier
    expect(at(h, 'a6')?.t).toBe('n');
  });

  it('Verglas : la pièce glisse jusqu’à prendre', () => {
    let g = after('4k3/8/n7/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a3', ['verglas']);
    g = react(g, 'verglas');
    expect(at(g, 'a6')).toEqual({ t: 'r', c: 'w' });
    expect(at(g, 'a3')).toBeNull();
  });

  it('Duel : pierre-feuille-ciseaux en trois manches gagnantes', () => {
    const start = after('1n2k3/8/8/8/8/8/8/1R2K3 w - - 0 1', 'b1', 'b8', ['duel']);
    const play = (g: GameState, w: Throw, b: Throw) => apply(apply(g, { type: 'duel', color: 'w', throw: w }), { type: 'duel', color: 'b', throw: b });
    let g = react(start, 'duel');
    expect(g.phase).toBe('duel');
    expect(mustAct(g, 'w') && mustAct(g, 'b')).toBe(true);
    g = play(g, 'pierre', 'pierre'); // égalité : ne compte pas
    expect(g.duel!.score).toEqual({ w: 0, b: 0 });
    for (let i = 0; i < 3; i++) g = play(g, 'feuille', 'ciseaux'); // les Noirs défendent et gagnent
    expect(g.phase).toBe('after');
    expect(at(g, 'b8')).toEqual({ t: 'n', c: 'b' });
    expect(g.pos.board.some((p) => p?.t === 'r')).toBe(false); // l'attaquante est éliminée
    expect(g.lastDuel).toMatchObject({ winner: 'b', defender: 'b', score: { w: 0, b: 3 } });

    let h = react(start, 'duel');
    for (let i = 0; i < 3; i++) h = play(h, 'pierre', 'ciseaux'); // l'attaquant gagne
    expect(at(h, 'b8')).toEqual({ t: 'r', c: 'w' });
    expect(() => apply(h, { type: 'duel', color: 'w', throw: 'pierre' })).toThrow();
  });
});

describe('Non et Niet', () => {
  function game(fen: string, w: string[], b: string[]): GameState {
    const g = newGame(13);
    g.pos = fromFen(fen);
    g.active = 'w';
    g.hands.w = w;
    g.hands.b = b;
    return g;
  }
  const FEN = '4k3/8/8/8/8/8/8/RN2K3 w - - 0 1';
  const pegase = { type: 'card' as const, card: 'pegase', path: [S('b1'), S('d4')] };

  it('la carte reste en suspens tant que l’adversaire peut l’annuler', () => {
    const g = apply(game(FEN, ['pegase'], ['non']), pegase);
    expect(g.phase).toBe('counter');
    expect(actor(g)).toBe('b');
    expect(g.hands.w).not.toContain('pegase');
    expect(g.pos.board[S('b1')]?.t).toBe('n'); // pas encore appliquée
    expect(cardOptions(g, 'non')).toHaveLength(1);
  });

  it('annulée : sans effet, perdue, et le joueur doit encore jouer son coup', () => {
    let g = apply(game(FEN, ['pegase'], ['non']), pegase);
    g = apply(g, { type: 'card', card: 'non', path: [] });
    expect(g.phase).toBe('main');
    expect(g.active).toBe('w');
    expect(g.pos.board[S('b1')]?.t).toBe('n');
    expect(g.cardPlayed).toBe(true); // la carte du tour est perdue
    expect(g.hands.w).toHaveLength(1); // son joueur a pioché
    expect(g.discard).toEqual(expect.arrayContaining(['pegase', 'non']));
    expect(g.log.at(-1)?.text).toBe(`${CARD_BY_ID.non.title} : annule « ${CARD_BY_ID.pegase.title} »`);
  });

  it('laisser passer : la carte s’applique', () => {
    let g = apply(game(FEN, ['pegase'], ['non']), pegase);
    g = apply(g, { type: 'pass' });
    expect(g.pos.board[S('d4')]?.t).toBe('n');
    expect(g.active).toBe('b');
    expect(g.hands.b).toContain('non');
  });

  it('pas de fenêtre d’annulation sans Non ni Niet', () => {
    const g = apply(game(FEN, ['pegase'], ['brouillard']), pegase);
    expect(g.pos.board[S('d4')]?.t).toBe('n');
    expect(g.phase).toBe('main');
  });

  it('dans le quota : on ne peut pas annuler une annulation', () => {
    let g = apply(game(FEN, ['pegase', 'niet'], ['non']), pegase);
    g = apply(g, { type: 'card', card: 'non', path: [] });
    expect(g.phase).toBe('main'); // les Blancs ont déjà joué leur carte du tour
    expect(g.hands.w).toContain('niet');
    expect(cardOptions(g, 'niet')).toHaveLength(0);
  });

  it('annule aussi une réaction, avec la carte de son propre tour', () => {
    let g = apply(game(FEN, ['niet'], ['brouillard']), { type: 'move', from: S('a1'), to: S('a6') });
    g = apply(g, { type: 'card', card: 'brouillard', path: [] });
    expect(g.phase).toBe('counter');
    expect(actor(g)).toBe('w');
    g = apply(g, { type: 'card', card: 'niet', path: [] });
    expect(g.phase).toBe('after');
    expect(g.pos.board[S('a6')]?.t).toBe('r'); // le coup reste tel quel
    expect(g.cardPlayed).toBe(true);
    expect(g.reacted).toBe(true);
  });

  it('une carte qui sauvait du mat, annulée : la partie est perdue', () => {
    let g = newGame(5);
    g.pos = fromFen('6k1/1q3ppp/8/8/8/8/8/K3R3 w - - 0 1');
    g.hands.w = [];
    g.hands.b = ['ohDarling'];
    g = apply(g, { type: 'move', from: S('e1'), to: S('e8') }); // mat, sauf Oh darling
    g.hands.w = ['non'];
    g = apply(g, { type: 'endTurn' });
    const o = cardOptions(g, 'ohDarling')[0];
    g = apply(g, { type: 'card', card: 'ohDarling', path: o.path });
    g = apply(g, { type: 'card', card: 'non', path: [] });
    expect(g.phase).toBe('over');
    expect(g.result?.winner).toBe('w');
  });

  it('ne se joue qu’en réponse à une carte', () => {
    const g = game(FEN, ['non'], []);
    expect(cardOptions(g, 'non')).toHaveLength(0);
  });
});

describe('cartes à choix successifs', () => {
  function game(fen: string, w: string[], b: string[] = []): GameState {
    const g = newGame(17);
    g.pos = fromFen(fen);
    g.active = 'w';
    g.hands.w = w;
    g.hands.b = b;
    return g;
  }
  const choose = (g: GameState, path: string[], label?: string) => apply(g, { type: 'choose', path: path.map(S), label });

  it('Zombies : deux pions chacun, à tour de rôle en commençant par l’adversaire', () => {
    let g = apply(game('4k3/pppp4/8/8/8/8/PPPP4/4K3 w - - 0 1', ['zombies']), { type: 'card', card: 'zombies', path: [] });
    expect(g.phase).toBe('choice');
    const order: string[] = [];
    for (const [w, b] of [['e2', 'e7'], ['f2', 'f7']]) {
      order.push(actor(g));
      g = choose(g, [b]);
      order.push(actor(g));
      g = choose(g, [w]);
    }
    expect(order).toEqual(['b', 'w', 'b', 'w']);
    expect(g.phase).toBe('main'); // les Blancs jouent maintenant leur coup
    expect(g.active).toBe('w');
    expect(g.cardPlayed).toBe(true);
    expect(g.pos.board.filter((p) => p?.t === 'p')).toHaveLength(12);
  });

  it('Zombies : un camp sans pion perdu ne replace rien', () => {
    let g = apply(game('4k3/pppppppp/8/8/8/8/PPPP4/4K3 w - - 0 1', ['zombies']), { type: 'card', card: 'zombies', path: [] });
    expect(actor(g)).toBe('w');
    g = choose(g, ['e2']);
    expect(actor(g)).toBe('w');
    g = choose(g, ['f2']);
    expect(g.phase).toBe('main');
  });

  it('Électrochoc : l’adversaire déplace ses Fous d’abord, puis le tour passe', () => {
    let g = game('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1', ['electrochoc']);
    g = apply(g, { type: 'move', from: S('e1'), to: S('f1') });
    g = apply(g, { type: 'card', card: 'electrochoc', path: [] });
    expect(actor(g)).toBe('b');
    expect(choiceStep(g)!.options.map((o) => o.path[1])).toEqual(expect.arrayContaining([S('g8'), S('f7')]));
    g = choose(g, ['f8', 'f7']);
    expect(actor(g)).toBe('w');
    g = choose(g, ['c1', 'c2']);
    expect(g.active).toBe('b');
    expect(g.phase).toBe('main');
    expect(g.pos.board[S('f7')]?.t).toBe('b');
    expect(g.pos.board[S('c2')]?.t).toBe('b');
  });

  it('Douane : payer un pion, ou renoncer à son coup', () => {
    const crossed = () => {
      const g = game('4k3/8/8/8/8/8/7P/R3K3 w - - 0 1', [], ['douane']);
      return apply(g, { type: 'move', from: S('a1'), to: S('a6') });
    };
    let g = apply(crossed(), { type: 'card', card: 'douane', path: [] });
    expect(g.phase).toBe('choice');
    expect(actor(g)).toBe('w'); // c'est l'adversaire qui choisit
    g = choose(g, ['h2']);
    expect(g.pos.board[S('h2')]).toBeNull();
    expect(g.pos.board[S('a6')]?.t).toBe('r');
    expect(g.phase).toBe('after');

    let h = apply(crossed(), { type: 'card', card: 'douane', path: [] });
    h = choose(h, [], 'Renoncer au coup');
    expect(h.phase).toBe('main');
    expect(h.pos.board[S('a1')]?.t).toBe('r');
    expect(normalMoves(h).some((m) => m.uci === 'a1a6')).toBe(false);
  });

  it('Douane : seulement quand une pièce franchit la frontière', () => {
    const g = apply(game('4k3/8/8/8/8/8/7P/R3K3 w - - 0 1', [], ['douane']), { type: 'move', from: S('a1'), to: S('a4') });
    expect(g.phase).toBe('after');
  });

  it('Roque et rolle : échanges successifs sur la première rangée, puis « Terminer »', () => {
    let g = apply(game('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', ['roqueEtRolle']), { type: 'card', card: 'roqueEtRolle', path: [] });
    expect(g.phase).toBe('choice');
    expect(actor(g)).toBe('w');
    g = choose(g, ['e1', 'h1']); // Roi et Tour échangés
    g = choose(g, ['a1', 'b1']); // la Tour glisse sur une case vide
    expect(g.phase).toBe('choice');
    g = choose(g, [], 'Terminer');
    expect(g.active).toBe('b');
    expect(g.phase).toBe('main');
    expect(g.pos.board[S('h1')]?.t).toBe('k');
    expect(g.pos.board[S('e1')]?.t).toBe('r');
    expect(g.pos.board[S('b1')]?.t).toBe('r');
    expect(g.pos.castling).toBe('-');
  });

  it('Roque et rolle : sortir d’un échec, avec « Annuler et réessayer » en cas de fausse piste', () => {
    // la Tour f1 vient s'interposer entre le Roi e1 et la Tour noire e8
    let g = apply(game('4r1k1/8/8/8/8/8/8/R3KR2 w - - 0 1', ['roqueEtRolle']), { type: 'card', card: 'roqueEtRolle', path: [] });
    const labels = () => choiceStep(g)!.options.flatMap((o) => (o.label ? [o.label] : []));
    expect(labels()).toEqual(['Renoncer']); // rien à annuler pour l'instant
    g = choose(g, ['a1', 'b1']); // fausse piste : toujours en échec
    expect(labels()).toEqual(['Annuler et réessayer', 'Renoncer']);
    g = choose(g, [], 'Annuler et réessayer');
    expect(g.phase).toBe('choice');
    expect(g.pos.board[S('a1')]?.t).toBe('r');
    g = choose(g, ['e1', 'f1']);
    g = choose(g, [], 'Terminer');
    expect(g.active).toBe('b');
    expect(g.pos.board[S('e1')]?.t).toBe('r');
    // renoncer : la rangée revient comme avant, la carte est perdue, il faut jouer un coup
    let h = apply(game('4r1k1/8/8/8/8/8/8/R3KR2 w - - 0 1', ['roqueEtRolle']), { type: 'card', card: 'roqueEtRolle', path: [] });
    h = choose(h, ['a1', 'b1']);
    h = choose(h, [], 'Renoncer');
    expect(h.phase).toBe('main');
    expect(h.active).toBe('w');
    expect(h.cardPlayed).toBe(true);
    expect(h.pos.board[S('a1')]?.t).toBe('r');
  });

  it('Roque et rolle : pas jouable en échec si aucun arrangement ne protège le Roi', () => {
    // les quatre Dames noires attaquent toute la première rangée
    const g = game('4k3/8/8/8/8/q2qq2q/8/4K3 w - - 0 1', ['roqueEtRolle']);
    expect(cardOptions(g, 'roqueEtRolle')).toHaveLength(0);
    // sans la Dame e3, le Roi n'est pas en échec : la carte redevient jouable
    expect(cardOptions(game('4k3/8/8/8/8/q2q3q/8/4K3 w - - 0 1', ['roqueEtRolle']), 'roqueEtRolle')).toHaveLength(1);
  });

  it('Roque et rolle : impossible avec une pièce adverse sur la rangée, et pas de fin en échec', () => {
    expect(cardOptions(game('4k3/8/8/8/8/8/8/R3K1n1 w - - 0 1', ['roqueEtRolle']), 'roqueEtRolle')).toHaveLength(0);
    let g = apply(game('4k1r1/8/8/8/8/8/8/R3K3 w - - 0 1', ['roqueEtRolle']), { type: 'card', card: 'roqueEtRolle', path: [] });
    g = choose(g, ['e1', 'g1']); // le Roi sous la Tour noire
    expect(choiceStep(g)!.options.some((o) => o.label === 'Terminer')).toBe(false);
    g = choose(g, ['g1', 'e1']);
    expect(choiceStep(g)!.options.some((o) => o.label === 'Terminer')).toBe(true);
  });
});

describe('règles temporaires', () => {
  /** Les Blancs jouent `from`→`to` puis posent `card` (chemin éventuel). */
  function posed(fen: string, from: string, to: string, card: string, path: string[] = [], black: string[] = []): GameState {
    const g = newGame(19);
    g.pos = fromFen(fen);
    g.active = 'w';
    g.hands.w = [card];
    g.hands.b = black;
    const m = apply(g, { type: 'move', from: S(from), to: S(to) });
    return apply(m, { type: 'card', card, path: path.map(S) });
  }
  const mv = (g: GameState, from: string, to: string) => apply(g, { type: 'move', from: S(from), to: S(to) });
  const ucis = (g: GameState) => normalMoves(g).map((m) => m.uci);

  it('Provocation : prendre ou passer, pour un seul tour', () => {
    let g = posed('r3k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'e1', 'f2', 'provocation');
    expect(g.active).toBe('b');
    expect(ucis(g)).toEqual(['a8a1']);
    expect(canSkip(g)).toBe(true);
    expect(g.discard).not.toContain('provocation');
    g = apply(g, { type: 'skip' });
    expect(g.discard).toContain('provocation');
    expect(g.active).toBe('w');
    expect(g.pos.turn).toBe('w'); // la position aussi change de camp au trait
    expect(normalMoves(g).length).toBeGreaterThan(0);
    expect(g.rules).toEqual([]);
  });

  it('Provocation : sans prise possible, il ne reste qu’à passer', () => {
    const g = posed('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'e1', 'f2', 'provocation');
    expect(ucis(g)).toEqual([]);
    expect(canSkip(g)).toBe(true);
    expect(g.phase).toBe('main'); // pas de mat : il peut passer
  });

  it('Cessez le feu : plus de prise, jusqu’au premier échec', () => {
    let g = posed('r6k/8/8/8/8/8/8/R3K3 w - - 0 1', 'e1', 'f2', 'cessezLeFeu');
    expect(ucis(g)).not.toContain('a8a1');
    expect(g.discard).not.toContain('cessezLeFeu'); // la carte reste en jeu tant que la règle dure
    g = mv(g, 'a8', 'f8'); // échec au Roi f2
    expect(g.rules).toEqual([]);
    expect(g.log.at(-1)).toMatchObject({ text: `${CARD_BY_ID.cessezLeFeu.title} prend fin`, notice: true });
    expect(g.discard).toContain('cessezLeFeu');
  });

  it('Fringale : prendre à chaque coup, jusqu’à ce que ce soit impossible', () => {
    let g = posed('r3k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'e1', 'f2', 'fringale');
    expect(ucis(g)).toEqual(['a8a1']);
    g = mv(g, 'a8', 'a1');
    g = apply(g, { type: 'endTurn' });
    expect(g.rules).toEqual([]); // les Blancs ne peuvent rien prendre
  });

  it('Planque : la pièce endormie ne bouge plus, jusqu’à un échec à son Roi', () => {
    let g = posed('4k2r/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a2', 'planque', ['h8']);
    expect(ucis(g).some((u) => u.startsWith('h8'))).toBe(false);
    g = mv(g, 'e8', 'd7');
    g = apply(g, { type: 'endTurn' });
    expect(g.rules).toHaveLength(1);
    g = mv(g, 'a2', 'a7'); // échec au Roi noir : la Tour se réveille
    expect(g.rules).toEqual([]);
  });

  it('Origines : plus aucune carte, réactions comprises, jusqu’au premier échec', () => {
    let g = posed('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'e1', 'f1', 'origines', [], ['brouillard']);
    g = mv(g, 'e8', 'e7');
    g = apply(g, { type: 'endTurn' });
    g = mv(g, 'a1', 'a6'); // Brouillard s'appliquerait, mais pas de cartes
    expect(g.phase).toBe('after');
    g = apply(g, { type: 'endTurn' });
    g = mv(g, 'e7', 'e8');
    g = apply(g, { type: 'endTurn' });
    g = mv(g, 'a6', 'a8'); // échec
    expect(g.rules).toEqual([]);
  });

  it('Voyance : si l’adversaire joue la pièce désignée, son tour est perdu', () => {
    let g = posed('r3k3/8/8/8/8/8/8/4K3 w - - 0 1', 'e1', 'f1', 'voyance', ['a8']);
    expect(normalMoves(g).length).toBeGreaterThan(0); // rien ne trahit le choix
    g = mv(g, 'a8', 'a2');
    expect(g.active).toBe('w'); // coup annulé, tour perdu
    expect(g.pos.board[S('a8')]?.t).toBe('r');
    expect(g.log.at(-1)).toMatchObject({ card: 'voyance', notice: true });
    expect(g.rules).toEqual([]);

    let h = posed('r3k3/8/8/8/8/8/8/4K3 w - - 0 1', 'e1', 'f1', 'voyance', ['a8']);
    h = mv(h, 'e8', 'd7'); // une autre pièce : rien ne se passe
    expect(h.phase).toBe('after');
    h = apply(h, { type: 'endTurn' });
    expect(h.rules).toEqual([]);
  });

  it('Fringale puis Cessez le feu : la dernière carte jouée l’emporte', () => {
    // Fringale (posée par les Noirs) est en cours : les Blancs doivent prendre, puis jouent Cessez le feu
    let g = newGame(19);
    g.pos = fromFen('4k3/4P3/n7/8/8/8/8/R3K3 w - - 0 1');
    g.active = 'w';
    g.hands.w = ['cessezLeFeu'];
    g.hands.b = [];
    g.rules = [{ card: 'fringale', owner: 'b' }];
    expect(ucis(g)).toEqual(['a1a6']);
    g = mv(g, 'a1', 'a6');
    g = apply(g, { type: 'card', card: 'cessezLeFeu', path: [] });
    expect(g.rules?.map((r) => r.card)).toEqual(['cessezLeFeu']);
    expect(g.discard).toContain('fringale');
    expect(g.log.some((e) => e.card === 'fringale' && e.notice)).toBe(true);
    // les Noirs pourraient prendre le pion e7 : c'est désormais interdit
    expect(g.active).toBe('b');
    expect(ucis(g)).not.toContain('e8e7');
  });

  it('Historique : chaque entrée garde sa position ; Voyance ne surligne pas la pièce désignée', () => {
    const g = posed('r3k3/8/8/8/8/8/8/4K3 w - - 0 1', 'e1', 'f1', 'voyance', ['a8']);
    const [move, card] = g.log.slice(-2);
    expect(move.fen?.split(' ')[0]).toBe('r3k3/8/8/8/8/8/8/5K2');
    expect(move.event).toMatchObject({ from: S('e1'), to: S('f1') });
    expect(card.card).toBe('voyance');
    expect(card.event?.from).toBeUndefined();
    expect(card.event?.to).toBeUndefined();
    expect(g.lastEvent?.from).toBeUndefined();
  });

  it('Voyance : pas jouable quand l’adversaire est en échec, et sans effet sur un Roi en échec', () => {
    // le coup blanc met le Roi noir en échec : annuler sa parade le laisserait en échec
    const g = newGame(19);
    g.pos = fromFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    g.active = 'w';
    g.hands.w = ['voyance'];
    g.hands.b = [];
    const m = apply(g, { type: 'move', from: S('a1'), to: S('a8') });
    expect(cardOptions(m, 'voyance')).toHaveLength(0);

    // garde-fou : même posée, Voyance n'annule pas le coup d'un Roi en échec
    let h = posed('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'e1', 'f1', 'voyance', ['e8']);
    h.pos = fromFen('R3k3/8/8/8/8/8/8/5K2 b - - 0 1');
    h = mv(h, 'e8', 'e7');
    expect(h.pos.board[S('e7')]?.t).toBe('k');
    expect(h.phase).not.toBe('main');
  });
});

describe('déroulement du tour', () => {
  function game(fen: string, w: string[], b: string[] = []): GameState {
    const g = newGame(23);
    g.pos = fromFen(fen);
    g.active = 'w';
    g.hands.w = w;
    g.hands.b = b;
    return g;
  }
  const mv = (g: GameState, from: string, to: string) => apply(g, { type: 'move', from: S(from), to: S(to) });
  const card = (g: GameState, id: string, path: string[] = [], label?: string) => apply(g, { type: 'card', card: id, path: path.map(S), label });

  it('Je passe : on passe son tour, puis on rejoue plus tard sans que ça compte comme carte', () => {
    let g = card(game('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', ['jePasse']), 'jePasse');
    expect(g.active).toBe('b');
    expect(g.reserve?.w).toEqual(['jePasse']);
    expect(g.hands.w).toHaveLength(1); // a pioché
    g = mv(g, 'e8', 'd8');
    g = apply(g, { type: 'endTurn' });
    g = mv(g, 'a1', 'a2');
    expect(canReplay(g)).toBe(true);
    g = apply(g, { type: 'replay' });
    expect(g.phase).toBe('main');
    expect(g.active).toBe('w');
    expect(g.cardPlayed).toBe(false); // un effet activé, pas une carte jouée
    expect(g.pos.turn).toBe('w');
    expect(g.reserve?.w).toEqual([]);
    g = mv(g, 'a2', 'a3');
    expect(canReplay(g)).toBe(false); // une seule fois
  });

  it('Je passe : pas en échec, et pas de coup en plus après avoir donné échec', () => {
    expect(cardOptions(game('4k3/8/8/8/8/8/8/r3K3 w - - 0 1', ['jePasse']), 'jePasse')).toHaveLength(0);
    const g = game('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', []);
    g.reserve = { w: ['jePasse'], b: [] };
    expect(canReplay(mv(g, 'a1', 'a8'))).toBe(false); // échec au Roi noir
    expect(canReplay(mv(g, 'a1', 'a7'))).toBe(true);
  });

  it('Double jeu : chacun joue l’autre couleur avec sa main pendant trois tours', () => {
    let g = game('4k3/8/8/8/8/8/8/R3K2R w - - 0 1', ['doubleJeu', 'pegase'], ['maison']);
    g = mv(g, 'a1', 'a2');
    g = card(g, 'doubleJeu');
    expect(g.discard).not.toContain('doubleJeu');
    expect(g.active).toBe('b'); // le joueur des Blancs enchaîne avec les Noirs
    expect(g.hands.b).toContain('pegase');
    expect(g.hands.w).toContain('maison');
    for (let i = 0; i < 6; i++) {
      expect(g.swap).toBeTruthy();
      const m = normalMoves(g).find((x) => !x.captured)!;
      g = apply(apply(g, { type: 'move', from: m.from, to: m.to }), { type: 'endTurn' });
    }
    expect(g.swap).toBeNull();
    expect(g.discard).toContain('doubleJeu'); // défaussée à la fin de l'échange seulement
    expect(g.hands.w).toContain('pegase'); // chacun retrouve sa couleur et sa main
    expect(g.log.at(-1)).toMatchObject({ card: 'doubleJeu', notice: true });
  });

  it('Double jeu : on peut gagner avec sa nouvelle couleur', () => {
    let g = game('7k/7r/8/8/8/8/PP4P1/K7 w - - 0 1', ['doubleJeu']);
    g = mv(g, 'g2', 'g3');
    g = card(g, 'doubleJeu');
    g = mv(g, 'h7', 'h1'); // le joueur des Blancs, aux commandes des Noirs, fait mat
    g = apply(g, { type: 'endTurn' });
    expect(g.phase).toBe('over');
    expect(g.result).toMatchObject({ winner: 'w', reason: 'Échec et mat' }); // c'est sa place qui gagne
  });

  it('Rebelote : deux cartes de plus, le tour reste ouvert jusque-là', () => {
    let g = game('4k3/8/8/3p4/8/8/8/RN2K2R w - - 0 1', ['pegase', 'rebeloteEtDixDeDer', 'quadrille', 'grosseDeprime']);
    expect(cardOptions(g, 'rebeloteEtDixDeDer')).toHaveLength(0); // pas en première carte
    g = card(g, 'pegase', ['b1', 'c3']);
    expect(g.phase).toBe('after'); // on tient Rebelote : le tour reste ouvert
    expect(g.active).toBe('w');
    g = card(g, 'rebeloteEtDixDeDer');
    expect(g.extra).toBe(2);
    g = card(g, 'quadrille', [], 'Sens horaire');
    expect(g.active).toBe('w');
    expect(g.extra).toBe(1);
    g = card(g, 'grosseDeprime', ['d5']);
    expect(g.active).toBe('b'); // plus de carte en réserve : le tour se termine
  });
});

