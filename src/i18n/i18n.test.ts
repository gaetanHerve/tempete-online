import { describe, expect, it } from 'vitest';
import { CARDS } from '../core/cards';
import { THROWS, actor, apply, canDiscard, canReplay, canSkip, cardOptions, choiceStep, mustAct, newGame, normalMoves, type Action, type GameState } from '../core/game';
import type { Msg } from '../core/msg';
import { en, enExtras } from './en';
import { Formatter, LOCALES, type CardTexts, type Dict, type Extras, type Locale } from './format';
import { fr, frExtras } from './fr';
import { is, isExtras } from './is';

// titres factices (les vrais sont dans le coffre) : on vérifie la mise en mots, pas les textes
const cards: CardTexts = Object.fromEntries(CARDS.map((c) => [c.id, { title: `«${c.id}»`, text: '…' }]));
const DICTS: Record<Locale, Dict> = { fr, en, is };
const EXTRAS: Record<Locale, Extras> = { fr: frExtras, en: enExtras, is: isExtras };
const formatters = Object.fromEntries(LOCALES.map((l) => [l, new Formatter(DICTS[l], () => ({ mine: cards }))])) as Record<Locale, Formatter>;

/** Une phrase mal formée trahit un paramètre manquant ou mal nommé. */
function expectClean(text: string, where: string) {
  expect(text, where).not.toMatch(/undefined|NaN|\[object|null|\?/);
  expect(text.trim(), where).not.toBe('');
}

function randomAction(g: GameState, rnd: () => number): Action {
  const step = choiceStep(g);
  if (step) {
    const o = step.options[Math.floor(rnd() * step.options.length)];
    return { type: 'choose', path: o.path, label: o.label };
  }
  if (g.phase === 'duel') return { type: 'duel', color: mustAct(g, 'w') ? 'w' : 'b', throw: THROWS[Math.floor(rnd() * 3)] };
  const acts: Action[] = [];
  for (const id of g.hands[actor(g)]) for (const o of cardOptions(g, id)) acts.push({ type: 'card', card: id, path: o.path, label: o.label });
  for (const id of g.hands[g.active]) if (canDiscard(g, id)) acts.push({ type: 'discard', card: id });
  const cardActs = acts.length;
  for (const m of normalMoves(g)) acts.push({ type: 'move', from: m.from, to: m.to, promotion: m.promotion });
  if (g.phase === 'after') acts.push({ type: 'endTurn' });
  if (g.phase === 'reaction' || g.phase === 'counter') acts.push({ type: 'pass' });
  if (canSkip(g)) acts.push({ type: 'skip' });
  if (canReplay(g)) acts.push({ type: 'replay' });
  if (cardActs && rnd() < 0.5) return acts[Math.floor(rnd() * cardActs)];
  return acts[Math.floor(rnd() * acts.length)];
}

describe('traductions', () => {
  it('chaque langue a les consignes de chaque étape, en même nombre', () => {
    for (const l of LOCALES) {
      for (const [card, steps] of Object.entries(frExtras.steps)) expect(EXTRAS[l].steps[card]?.length, `${l} · ${card}`).toBe(steps.length);
      expect(Object.keys(EXTRAS[l].steps).sort(), l).toEqual(Object.keys(frExtras.steps).sort());
      expect(EXTRAS[l].rules(formatters[l].h), l).toHaveLength(frExtras.rules(formatters.fr.h).length);
      expect(EXTRAS[l].quick.length, l).toBeGreaterThan(0);
    }
  });

  it('les messages des parties se mettent en mots dans chaque langue', () => {
    let seed = 777;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const seen = new Set<string>();
    const check = (m: Msg, where: string) => {
      seen.add(m.k);
      for (const l of LOCALES) expectClean(formatters[l].fmt(m), `${l} · ${where} · ${JSON.stringify(m)}`);
    };
    for (let game = 0; game < 30; game++) {
      let g = newGame(1000 + game);
      for (let i = 0; i < 120 && g.phase !== 'over'; i++) {
        // résumés et libellés de toutes les options proposées
        for (const id of g.hands[actor(g)])
          for (const o of cardOptions(g, id)) {
            check(o.summary, id);
            if (o.labelMsg) check(o.labelMsg, id);
            for (const l of LOCALES) if (o.label) expectClean(formatters[l].label(o), `${l} · libellé ${o.label}`);
          }
        const step = choiceStep(g);
        if (step) {
          check(step.prompt, 'consigne');
          for (const o of step.options) check(o.summary, 'choix');
        }
        g = apply(g, randomAction(g, rnd));
      }
      for (const e of g.log) check(e.msg, 'journal');
    }
    // la plupart des messages ont été rencontrés
    expect(seen.size).toBeGreaterThan(40);
  }, 120_000);

  it('les entrées sans paramètres ne sont pas vides', () => {
    for (const l of LOCALES) {
      const dict = DICTS[l] as Record<string, unknown>;
      for (const [k, v] of Object.entries(dict)) if (typeof v === 'string') expect(v.trim(), `${l} · ${k}`).not.toBe('');
    }
  });
});
