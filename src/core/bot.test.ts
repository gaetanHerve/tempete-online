// Teste le bot avec le vrai Stockfish, lancé en sous-processus Node.
import { afterAll, describe, expect, it } from 'vitest';
import { type Engine } from '../engine/engine';
import { NodeStockfish } from '../engine/nodeStockfish';
import { BOT_LEVELS, cardPotential, decide, duelThrow, suspects, threat, unseenCards, watchedCards } from './bot';
import { legalMoves } from './chess';
import { actor, apply, canSkip, choiceStep, cardOptions, mustAct, newGame, normalMoves, type GameState } from './game';
import { fromFen, parseSq } from './position';


const engine = new NodeStockfish();

/** Moteur factice : renvoie les variantes demandées, et 0 pour toute autre position. */
const fake = (rootFen: string, lines: { move: string; score: number }[]): Engine => ({
  analyse: async (fen) => (fen === rootFen ? { bestmove: lines[0].move, score: lines[0].score, lines } : { bestmove: null, score: 0 }),
  dispose() {},
});
afterAll(() => engine.dispose());
const fort = BOT_LEVELS[2];

function setup(fen: string, botHand: string[]): GameState {
  const g = newGame(1);
  g.pos = fromFen(fen);
  g.active = g.pos.turn;
  g.hands[g.active] = botHand;
  g.hands[g.active === 'w' ? 'b' : 'w'] = []; // pas de réaction adverse parasite
  g.deck = g.deck.filter((id) => id !== 'rebeloteEtDixDeDer'); // piochée, elle garderait le tour ouvert
  return g;
}

describe('bot', () => {
  it('joue un coup légal en début de partie', async () => {
    const g = setup('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', []);
    const a = await decide(g, engine, fort);
    expect(a.type).toBe('move');
    expect(() => apply(g, a)).not.toThrow();
  });

  it('utilise Paranoïa quand elle gagne une dame', async () => {
    // le fou noir c5 peut prendre sa propre dame g1 ; sinon position calme
    const g = setup('4k3/8/8/2b5/8/8/8/4K1q1 w - - 0 1'.replace('4K1q1', 'K5q1'), ['paranoia']);
    expect(cardOptions(g, 'paranoia').length).toBeGreaterThan(0);
    const a = await decide(g, engine, fort);
    expect(a).toMatchObject({ type: 'card', card: 'paranoia' });
  });

  it('se sert d’une carte pour échapper au mat', async () => {
    const g = setup('6k1/1q3ppp/8/8/8/8/8/K3R3 w - - 0 1', ['pegase']);
    let s = apply({ ...g, hands: { w: ['pegase'], b: ['ohDarling'] } }, { type: 'move', from: 4, to: 60 });
    s = apply(s, { type: 'endTurn' });
    expect(s.phase).toBe('main');
    const a = await decide(s, engine, fort);
    expect(a).toMatchObject({ type: 'card', card: 'ohDarling' });
  });

  it('choisit son coup en vue d’une carte « après le coup »', async () => {
    // Sans carte, Fxg5 est le meilleur coup (Txa6 n'est que 3e : la dame reste dangereuse).
    // Avec Laser en main, Txa6 gagne le cavalier ET aligne la tour sur c6-d6-f6 : le rayon vers l'est
    // désintègre pion, dame et tour.
    const g = setup('6k1/5ppp/n1pq1r2/6b1/8/4B2P/5PP1/R5K1 w - - 0 1', ['laser']);
    const a = await decide(g, engine, fort, () => 0);
    expect(a).toMatchObject({ type: 'move', from: parseSq('a1'), to: parseSq('a6') });
    const s = apply(g, a);
    const b = await decide(s, engine, fort, () => 0);
    expect(b).toMatchObject({ type: 'card', card: 'laser' });
    const end = apply(s, b);
    expect(end.pos.board[parseSq('d6')]).toBeNull(); // la dame noire a disparu
    expect(end.pos.board[parseSq('f6')]).toBeNull(); // la tour aussi
  });

  it('réagit à une grosse prise par Contrordre', async () => {
    // la Tour blanche prend la Dame noire : l'ordinateur (Noirs) annule le coup
    const g = setup('q3k3/8/8/8/8/8/8/R3K3 w - - 0 1', []);
    g.hands.b = ['contrordre'];
    const s = apply(g, { type: 'move', from: parseSq('a1'), to: parseSq('a8') });
    expect(s.phase).toBe('reaction');
    expect(await decide(s, engine, fort, () => 0)).toMatchObject({ type: 'card', card: 'contrordre' });
  });

  it('annule par Non une carte qui lui coûte sa Dame', async () => {
    let g = setup('3qk3/8/8/8/8/8/8/3RK3 w - - 0 1', ['laser']);
    g.hands.b = ['non'];
    g = apply(g, { type: 'move', from: parseSq('e1'), to: parseSq('f1') });
    g = apply(g, { type: 'card', card: 'laser', path: [parseSq('d1'), parseSq('d2')] });
    expect(g.phase).toBe('counter');
    expect(await decide(g, engine, fort, () => 0)).toEqual({ type: 'card', card: 'non', path: [] });
  });

  it('provoqué, préfère passer son tour que perdre sa Dame', async () => {
    // la seule prise possible, Dxa2, perd la Dame (Txa2)
    let g = setup('q3k3/8/8/8/8/8/P7/R3K3 w - - 0 1', ['provocation']);
    g = apply(g, { type: 'move', from: parseSq('e1'), to: parseSq('f1') });
    g = apply(g, { type: 'card', card: 'provocation', path: [] });
    expect(await decide(g, engine, fort, () => 0)).toEqual({ type: 'skip' });
  });

  it('laisse passer un coup anodin', async () => {
    const g = setup('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', []);
    g.hands.b = ['brouillard'];
    const s = apply(g, { type: 'move', from: parseSq('a1'), to: parseSq('a3') });
    expect(s.phase).toBe('reaction');
    expect(await decide(s, engine, fort, () => 0)).toEqual({ type: 'pass' });
  });

  describe('méfiance envers les cartes adverses', () => {
    // les Blancs (ordinateur) hésitent entre Da4, dans la ligne de la Tour a8, et Dd2, à l'abri
    const FEN = 'r3k3/8/8/8/8/8/8/3QK3 w - - 0 1';
    const HIDDEN = ['pegase', 'maison', 'modestie', 'paranoia', 'remorque']; // ce que l'ordinateur ne voit pas
    const withHidden = () => {
      const g = setup(FEN, ['coupDouble']);
      g.hands.b = [...HIDDEN];
      return g;
    };

    it('ne compte que les cartes qu’il n’a jamais vues', () => {
      const g = withHidden();
      g.discard = ['ole'];
      const u = unseenCards(g, 'w');
      expect(u.ids).not.toContain('coupDouble'); // sa propre main
      expect(u.ids).not.toContain('ole'); // la défausse
      expect(u.ids).toEqual(expect.arrayContaining(HIDDEN)); // la main adverse reste parmi les possibles
      expect(u.p).toBeCloseTo(5 / u.ids.length);
    });

    it('estime plus de risque pour la Dame exposée', () => {
      const g = withHidden();
      const u = unseenCards(g, 'w');
      const risk = (to: string) => {
        const m = normalMoves(g).find((x) => x.uci === 'd1' + to)!;
        const after = apply({ ...g, hands: { ...g.hands, b: [] } }, { type: 'move', from: m.from, to: m.to });
        return threat(after, g.pos, m, 'w', u);
      };
      expect(risk('a4')).toBeGreaterThan(risk('d2') + 50); // Laser, Chasse-neige… sur la colonne a
    });

    it('préfère un coup un peu moins bon mais moins exposé', async () => {
      const g = withHidden();
      const e = fake(FEN, [{ move: 'd1a4', score: 10 }, { move: 'd1d2', score: 0 }]);
      expect(await decide(g, e, fort, () => 0.99)).toMatchObject({ type: 'move', from: parseSq('d1'), to: parseSq('d2') });
    });

    it('repère un coup qui prépare une carte', () => {
      // la Tour noire vient se placer sur la colonne de la Dame blanche : Laser devient menaçant
      const prepared = (from: string, to: string, fen: string) => {
        const before = fromFen('k6r/8/8/8/8/8/8/3QK3 b - - 0 1');
        const g = setup(fen, []);
        g.lastPly = { before, move: legalMoves(before).find((m) => m.uci === from + to)!, color: 'b' };
        return suspects(g, 'w', ['laser']);
      };
      expect(prepared('h8', 'd8', 'k2r4/8/8/8/8/8/8/3QK3 w - - 0 1').has('laser')).toBe(true);
      expect(prepared('h8', 'g8', 'k5r1/8/8/8/8/8/8/3QK3 w - - 0 1').has('laser')).toBe(false);
    });

    it('se méfie d’autant plus de cartes que le niveau est élevé', () => {
      const g = withHidden();
      const u = unseenCards(g, 'w');
      const watched = (i: number) => watchedCards(g, 'w', BOT_LEVELS[i], u).ids;
      // Laser (1.00) : tous ; Verglas (0.23) : Moyen et Redoutable ; Ruade (0.12) : Redoutable seul
      expect(watched(0)).toContain('laser');
      expect(watched(0)).not.toContain('verglas');
      expect(watched(1)).toContain('verglas');
      expect(watched(1)).not.toContain('ruade');
      expect(watched(2)).toContain('ruade');
      expect(watched(2)).not.toContain('pegase'); // mineure, et rien ne la prépare
    });
  });

  describe('préparation des cartes', () => {
    // même position que ci-dessus : la tour a1 peut venir s'aligner sur c6-d6-f6
    const FEN = '6k1/5ppp/n1pq1r2/6b1/8/4B2P/5PP1/R5K1 w - - 0 1';
    const play = (g: GameState, from: string, to: string) => apply(g, { type: 'move', from: parseSq(from), to: parseSq(to) });

    it('mesure ce que les cartes rapporteraient au tour suivant', () => {
      const g = setup(FEN, ['laser']);
      expect(cardPotential(play(g, 'a1', 'a6'), 'w', ['laser'])).toBeGreaterThanOrEqual(900);
      expect(cardPotential(play(g, 'h3', 'h4'), 'w', ['laser'])).toBeLessThan(500); // seulement le cavalier a6
    });


    it('préfère un coup un peu moins bon qui prépare une carte', async () => {
      const g = setup(FEN, ['laser']);
      const e = fake(FEN, [{ move: 'h3h4', score: 10 }, { move: 'a1a6', score: -20 }]);
      expect(await decide(g, e, fort, () => 0)).toMatchObject({ type: 'move', from: parseSq('a1'), to: parseSq('a6') });
    });

    it('ne sacrifie pas trop pour préparer', async () => {
      const g = setup(FEN, ['laser']);
      const e = fake(FEN, [{ move: 'h3h4', score: 10 }, { move: 'a1a6', score: -60 }]);
      expect(await decide(g, e, fort, () => 0)).toMatchObject({ type: 'move', from: parseSq('h3'), to: parseSq('h4') });
    });
  });

  it('ne joue pas Roque et rolle, et s’il le faut, ne tourne pas en rond', async () => {
    const FEN = '4k3/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQ - 0 1';
    // un moteur qui trouve toujours la position de départ meilleure que le coup normal
    const e: Engine = { analyse: async (fen) => ({ bestmove: 'a2a3', score: fen === FEN ? 0 : 500 }), dispose() {} };
    const g = setup(FEN, ['roqueEtRolle']);
    expect(await decide(g, e, fort, () => 0)).toMatchObject({ type: 'move' });

    let c = apply(g, { type: 'card', card: 'roqueEtRolle', path: [] });
    for (let i = 0; i < 4 && c.phase === 'choice'; i++) c = apply(c, await decide(c, e, fort, () => 0));
    expect(c.phase).not.toBe('choice');
  });

  it('mène une partie complète contre un joueur aléatoire', async () => {
    let g = newGame(2024);
    for (let i = 0; i < 80 && g.phase !== 'over'; i++) {
      if (g.phase === 'duel') {
        g = apply(g, duelThrow(mustAct(g, 'b') ? 'b' : 'w'));
      } else if (actor(g) === 'b') {
        g = apply(g, await decide(g, engine, BOT_LEVELS[1]));
      } else if (g.phase === 'choice') {
        const opts = choiceStep(g)!.options;
        const o = opts.find((x) => x.label === 'Terminer') ?? opts[0];
        g = apply(g, { type: 'choose', path: o.path, label: o.label });
      } else if (g.phase === 'reaction' || g.phase === 'counter') {
        g = apply(g, { type: 'pass' });
      } else if (g.phase === 'after') {
        g = apply(g, { type: 'endTurn' });
      } else {
        const ms = normalMoves(g);
        if (!ms.length && canSkip(g)) {
          g = apply(g, { type: 'skip' });
        } else if (!ms.length) {
          const id = g.hands.w.find((c) => cardOptions(g, c).length)!;
          const o = cardOptions(g, id)[0];
          g = apply(g, { type: 'card', card: id, path: o.path, label: o.label });
        } else {
          const m = ms[i % ms.length];
          g = apply(g, { type: 'move', from: m.from, to: m.to, promotion: m.promotion });
        }
      }
    }
    const botCards = g.log.filter((l) => l.color === 'b' && l.card).map((l) => l.text);
    console.log('Cartes jouées par le bot :', botCards, g.result);
    // la partie va loin, ou l'ordinateur a gagné (le joueur aléatoire peut se faire mater vite)
    expect(g.log.length > 20 || g.result?.winner === 'b').toBe(true);
  }, 110_000);
});
