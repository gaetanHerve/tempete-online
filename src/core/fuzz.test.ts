import { describe, expect, it } from 'vitest';
import { THROWS, actor, apply, canReplay, canSkip, choiceStep, canDiscard, cardOptions, mustAct, newGame, normalMoves, type Action, type GameState } from './game';
import { DECK_CARDS } from './cards';
import { isSane } from './position';

function randomAction(g: GameState, rnd: () => number): Action {
  const step = choiceStep(g);
  if (step) {
    const o = step.options[Math.floor(rnd() * step.options.length)];
    return { type: 'choose', path: o.path, label: o.label };
  }
  if (g.phase === 'duel') {
    const color = mustAct(g, 'w') ? 'w' : 'b';
    return { type: 'duel', color, throw: THROWS[Math.floor(rnd() * 3)] };
  }
  const acts: Action[] = [];
  for (const id of g.hands[actor(g)])
    for (const o of cardOptions(g, id)) acts.push({ type: 'card', card: id, path: o.path, label: o.label });
  for (const id of g.hands[g.active]) if (canDiscard(g, id)) acts.push({ type: 'discard', card: id });
  const cardActs = acts.length;
  for (const m of normalMoves(g)) acts.push({ type: 'move', from: m.from, to: m.to, promotion: m.promotion });
  if (g.phase === 'after') acts.push({ type: 'endTurn' });
  if (g.phase === 'reaction' || g.phase === 'counter') acts.push({ type: 'pass' });
  if (canSkip(g)) acts.push({ type: 'skip' });
  if (canReplay(g)) acts.push({ type: 'replay' });
  // une chance sur trois de privilégier une carte quand c'est possible
  if (cardActs && rnd() < 0.35) return acts[Math.floor(rnd() * cardActs)];
  return acts[Math.floor(rnd() * acts.length)];
}

describe('parties aléatoires', () => {
  it('restent toujours dans des positions valides', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const used = new Set<string>();
    let discards = 0;
    for (let game = 0; game < 25; game++) {
      let g = newGame(game);
      for (let i = 0; i < 120 && g.phase !== 'over'; i++) {
        const a = randomAction(g, rnd);
        if (a.type === 'card') used.add(a.card);
        if (a.type === 'discard') discards++;
        g = apply(g, a);
        // (pendant Roque et rolle, une position de passage peut mettre le Roi adverse en échec)
        if (g.phase !== 'choice') expect(isSane(g.pos), `partie ${game}, coup ${i}`).toBe(true);
        // aucune carte ne se perd : une carte en suspens, Je passe en réserve, et les cartes
        // dont l'effet dure (règles temporaires, Double jeu) ne sont pas encore défaussées
        const reserved = (g.reserve?.w.length ?? 0) + (g.reserve?.b.length ?? 0);
        const inPlay = (g.rules?.length ?? 0) + (g.swap ? 1 : 0) + (g.pending ? 1 : 0);
        expect(g.hands.w.length + g.hands.b.length + g.deck.length + g.discard.length + reserved + inPlay, `partie ${game}, coup ${i}`).toBe(DECK_CARDS.length);
        // et chaque carte n'existe qu'une fois
        const all = [...g.hands.w, ...g.hands.b, ...g.deck, ...g.discard, ...(g.reserve?.w ?? []), ...(g.reserve?.b ?? []), ...(g.rules ?? []).map((r) => r.card)];
        expect(new Set(all).size, `partie ${game}, coup ${i}`).toBe(all.length);
      }
    }
    expect(used.size).toBeGreaterThan(15);
    // les réactions au coup adverse sont bien exercées
    const reactions = DECK_CARDS.filter((c) => c.timing === 'reaction' || c.timing === 'counter').map((c) => c.id);
    expect(reactions.filter((id) => used.has(id)).length).toBeGreaterThanOrEqual(reactions.length - 2);
    expect(discards).toBeGreaterThan(0);
  }, 90_000);
});
