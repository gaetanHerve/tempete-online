// Mise en mots des messages : fonctions pures, sans Svelte (utilisables dans les tests).

import type { Msg, MsgParam } from '../core/msg';
import { PIECE_LABEL, sqName, type Color, type PieceType, type Sq } from '../core/position';
import type { MsgKey } from './fr';

export type Locale = 'fr' | 'en' | 'is';
export const LOCALES: Locale[] = ['fr', 'en', 'is'];

/** Outils passés aux entrées des dictionnaires pour nommer pièces, cases, cartes… */
export interface Helpers {
  /** Titre d'une carte dans la langue courante (à défaut : en français, puis son identifiant). */
  card(id: string): string;
  piece(t: PieceType | null | undefined): string;
  /** Pluriel (« Fous », « Bishops »). */
  pieces(t: PieceType): string;
  sq(s: Sq): string;
  color(c: Color): string;
  /** Message imbriqué (ou texte déjà rédigé, venu d'une ancienne sauvegarde). */
  msg(m: MsgParam): string;
  /** « a, b et c ». */
  list(items: string[]): string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Entry = string | ((p: any, h: Helpers) => string);
export type Dict = Record<MsgKey, Entry>;

/** Textes qui ne sont pas des messages simples : consignes par carte, règles, chat rapide. */
export interface Extras {
  /** Consignes affichées à chaque étape de sélection d'une carte (indexées par position dans `path`). */
  steps: Record<string, string[]>;
  /** Règles du jeu (HTML simple : strong, em ; les titres de cartes y sont échappés). */
  rules: (h: Helpers) => string[];
  /** Phrases rapides du chat. */
  quick: string[];
}

export type CardTexts = Record<string, { title: string; text: string }>;

/** Libellés d'options (identifiants stables, cf. `CardOption.label`) → clé du dictionnaire. */
const LABEL_KEYS: Record<string, MsgKey> = {
  Terminer: 'label.done',
  'Annuler et réessayer': 'label.retry',
  Renoncer: 'label.giveUp',
  'Renoncer au coup': 'label.giveUpMove',
  'Sens horaire': 'label.cw',
  'Sens anti-horaire': 'label.ccw',
};
const PIECE_BY_LABEL = Object.fromEntries(Object.entries(PIECE_LABEL).map(([t, l]) => [l, t as PieceType]));

export class Formatter {
  readonly h: Helpers;

  constructor(
    readonly dict: Dict,
    readonly cards: () => { mine?: CardTexts; fallback?: CardTexts },
  ) {
    const str = (k: MsgKey) => this.t(k);
    this.h = {
      card: (id) => cards().mine?.[id]?.title ?? cards().fallback?.[id]?.title ?? id,
      piece: (t) => (t ? str(`piece.${t}`) : '?'),
      pieces: (t) => str(`pieces.${t}`),
      sq: (s) => sqName(s),
      color: (c) => str(`color.${c}`),
      msg: (m) => this.fmt(m),
      list: (items) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${str('list.and')} ${items.at(-1)}`),
    };
  }

  t(k: MsgKey, p?: Record<string, MsgParam>): string {
    const e = this.dict[k];
    if (e === undefined) return k;
    return typeof e === 'string' ? e : e(p ?? {}, this.h);
  }

  fmt(m: MsgParam): string {
    if (m === null || m === undefined) return '';
    if (typeof m === 'string' || typeof m === 'number' || typeof m === 'boolean') return String(m);
    if (Array.isArray(m)) return m.map((x) => this.fmt(x)).join(' ');
    return this.t(m.k, m.p);
  }

  /** Libellé d'une option de carte (promotion, sens de rotation, Terminer…). */
  label(o: { label?: string; labelMsg?: Msg }): string {
    if (o.labelMsg) return this.fmt(o.labelMsg);
    if (!o.label) return '';
    const key = LABEL_KEYS[o.label];
    if (key) return this.t(key);
    const piece = PIECE_BY_LABEL[o.label];
    return piece ? this.h.piece(piece) : o.label;
  }
}
