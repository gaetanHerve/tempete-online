// Messages destinés au joueur (résumés d'options, consignes, journal de la partie).
//
// Le cœur ne produit pas de phrases : il produit une clé et des paramètres bruts (types de
// pièces, cases, identifiants de cartes, coups en notation SAN). L'interface les met en mots
// dans la langue choisie (src/i18n). Ainsi le journal se retraduit quand on change de langue,
// et en ligne chaque joueur voit la partie dans la sienne.

import type { MsgKey } from '../i18n/fr';

export type MsgParam = string | number | boolean | null | undefined | Msg | MsgParam[];

export interface Msg {
  k: MsgKey;
  p?: Record<string, MsgParam>;
}

export const msg = (k: MsgKey, p?: Record<string, MsgParam>): Msg => (p ? { k, p } : { k });
