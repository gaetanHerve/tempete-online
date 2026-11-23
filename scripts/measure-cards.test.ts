// Mesure de la « criticité habituelle » des cartes : à quel point chacune, tenue par l'adversaire,
// ferait du tort dans des positions de jeu réalistes.
//
// Stockfish joue des parties contre lui-même (ouvertures variées, un peu de hasard, sans cartes).
// Après chaque coup, on mesure pour chaque carte le tort qu'elle ferait au joueur qui vient de
// jouer (cardHarms : réaction immédiate ou carte du tour suivant, en évaluation rapide).
// Résultat : tort moyen, fréquence des « coups durs », et une criticité normalisée entre 0 et 1.
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { cardHarms, threatens } from '../src/core/bot';
import { DECK_CARDS } from '../src/core/cards';
import { apply, newGame, normalMoves, type GameState } from '../src/core/game';
import { engineFen } from '../src/core/position';
import { NodeStockfish } from '../src/engine/nodeStockfish';

const GAMES = Number(process.env.PARTIES ?? 30);
const MAX_PLIES = 100;
const HARD = 300; // un « coup dur » : au moins l'équivalent de trois pions

it('mesure la criticité des cartes', async () => {
  const engine = new NodeStockfish();
  const ids = DECK_CARDS.map((c) => c.id).filter(threatens);
  const stats = new Map(ids.map((id) => [id, { sum: 0, hard: 0, applies: 0, max: 0 }]));
  let seed = 2024;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let positions = 0;

  for (let game = 0; game < GAMES; game++) {
    let g: GameState = newGame(game);
    g.hands = { w: [], b: [] }; // positions d'échecs pures : ni cartes, ni réactions
    g.deck = [];
    for (let ply = 0; ply < MAX_PLIES && g.phase !== 'over'; ply++) {
      const moves = normalMoves(g);
      if (!moves.length) break;
      let m = moves[Math.floor(rnd() * moves.length)]; // ouvertures variées
      if (ply >= 4) {
        const a = await engine.analyse(engineFen(g.pos), { depth: 6, skill: 12, multipv: 2 });
        const pick = a.lines && a.lines.length > 1 && rnd() < 0.25 ? a.lines[1].move : a.bestmove;
        m = moves.find((x) => x.uci === pick) ?? m;
      }
      const before = g.pos;
      const mover = g.active;
      g = apply(g, { type: 'move', from: m.from, to: m.to, promotion: m.promotion });
      for (const [id, harm] of cardHarms(g, before, m, mover, ids)) {
        const s = stats.get(id)!;
        s.sum += harm;
        s.max = Math.max(s.max, harm);
        if (harm > 0) s.applies++;
        if (harm >= HARD) s.hard++;
      }
      positions++;
      g = apply(g, { type: 'endTurn' });
    }
    process.stdout.write(`partie ${game + 1}/${GAMES} · ${positions} positions\n`);
  }
  engine.dispose();

  const rows = [...stats].map(([id, s]) => ({ id, mean: s.sum / positions, hard: s.hard / positions, applies: s.applies / positions, max: s.max }));
  rows.sort((a, b) => b.mean - a.mean);
  const top = rows[0].mean || 1;
  const pct = (x: number) => `${(x * 100).toFixed(1)} %`.padStart(7);
  const lines = rows.map((r) => `${r.id.padEnd(36)} ${r.mean.toFixed(0).padStart(5)} ${pct(r.hard)} ${pct(r.applies)} ${String(r.max).padStart(5)}   ${(r.mean / top).toFixed(2)}`);
  const report = [
    `${positions} positions, ${GAMES} parties`,
    `${'Carte'.padEnd(36)} ${'moyen'.padStart(5)} ${'durs'.padStart(7)} ${'utile'.padStart(7)} ${'max'.padStart(5)}   criticité`,
    ...lines,
    '',
    '// criticité mesurée (tort moyen / plus fort tort moyen)',
    'export const MEASURED_THREAT: Record<string, number> = {',
    ...rows.map((r) => `  ${r.id}: ${(r.mean / top).toFixed(2)},`),
    '};',
  ].join('\n');
  writeFileSync('scripts/card-threat.txt', report + '\n');
  process.stdout.write('\n' + report + '\n');
});
