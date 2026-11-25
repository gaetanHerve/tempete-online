// Langue de l'interface : choisie d'après le navigateur au premier lancement, puis par le
// joueur (mémorisée sur l'appareil). Tout ce qui s'affiche passe par `t`, `fmt` et les titres
// et textes de cartes ci-dessous : lus dans un gabarit Svelte, ils suivent le changement de langue.

import type { Msg, MsgParam } from '../core/msg';
import { en, enExtras } from './en';
import { Formatter, LOCALES, type CardTexts, type Dict, type Extras, type Locale } from './format';
import { fr, frExtras, type MsgKey } from './fr';

export { LOCALES, type Locale } from './format';
export type { MsgKey } from './fr';

const STORAGE = 'tempete2.langue';
const DICTS: Record<Locale, Dict> = { fr, en };
const EXTRAS: Record<Locale, Extras> = { fr: frExtras, en: enExtras };
/** Nom de chaque langue, dans cette langue (sélecteur). */
export const LOCALE_NAME: Record<Locale, string> = { fr: 'Français', en: 'English' };

function initial(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE);
    if (saved && (LOCALES as string[]).includes(saved)) return saved as Locale;
  } catch {
    /* stockage indisponible */
  }
  const langs = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  for (const l of langs) {
    const base = l.toLowerCase().split('-')[0];
    if ((LOCALES as string[]).includes(base)) return base as Locale;
  }
  return 'en';
}

const state = $state({ locale: initial() });
// noms et textes des cartes, par langue (fournis par le coffre une fois ouvert)
let cards = $state.raw<Partial<Record<Locale, CardTexts>>>({});

const formatters = Object.fromEntries(
  LOCALES.map((l) => [l, new Formatter(DICTS[l], () => ({ mine: cards[l], fallback: cards.fr }))]),
) as Record<Locale, Formatter>;
const current = () => formatters[state.locale];

function applyDocument() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = state.locale;
  document.title = t('app.name');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('app.description'));
}

export function locale(): Locale {
  return state.locale;
}

export function setLocale(l: Locale) {
  state.locale = l;
  try {
    localStorage.setItem(STORAGE, l);
  } catch {
    /* le choix ne sera pas retenu */
  }
  applyDocument();
}

/** Texte d'une clé du dictionnaire. */
export function t(k: MsgKey, p?: Record<string, MsgParam>): string {
  return current().t(k, p);
}

/** Met en mots un message du cœur (ou rend tel quel un texte déjà rédigé). */
export function fmt(m: Msg | string | null | undefined): string {
  return current().fmt(m);
}

/** Libellé d'une option de carte. */
export function optionLabel(o: { label?: string; labelMsg?: Msg }): string {
  return current().label(o);
}

export function cardTitle(id: string): string {
  return current().h.card(id);
}

export function cardText(id: string): string {
  return cards[state.locale]?.[id]?.text ?? cards.fr?.[id]?.text ?? '';
}

/** Consigne de l'étape `i` de la sélection d'une carte (null s'il n'y en a pas). */
export function stepHint(card: string, i: number): string | null {
  return EXTRAS[state.locale].steps[card]?.[i] ?? null;
}

/** Nombre d'étapes de sélection (cases à toucher) d'une carte. */
export function stepCount(card: string): number {
  return EXTRAS.fr.steps[card]?.length ?? 0;
}

/** Règles du jeu, en HTML simple (textes du dictionnaire, titres de cartes échappés). */
export function rulesList(): string[] {
  return EXTRAS[state.locale].rules(current().h);
}

/** Phrases rapides du chat. */
export function quickPhrases(): string[] {
  return EXTRAS[state.locale].quick;
}

/** Heure courte, à la manière de la langue choisie. */
export function shortTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(state.locale, { hour: '2-digit', minute: '2-digit' });
}

/** Installe les noms et textes des cartes, par langue (coffre déchiffré). */
export function setCardTexts(byLocale: Partial<Record<Locale, CardTexts>>) {
  cards = byLocale;
}

applyDocument();
