// Parties en ligne : transport des actions entre deux appareils, via Firebase Realtime Database.
//
// Une partie n'est qu'un journal d'actions. Comme le réducteur est déterministe (graine stockée
// avec la partie), chaque appareil recalcule la même partie en rejouant le journal ; on reprend
// donc une partie après une mise en veille ou un rechargement simplement en relisant le journal.
//
//   v1/<espace>/rooms/<CODE>/meta          { host, hostColor, seed, created, build, guest? }
//   v1/<espace>/rooms/<CODE>/actions/00000 { by, a, fen }   (a : action en JSON, fen : position après)
//   v1/<espace>/rooms/<CODE>/presence/<uid> true            (retiré à la déconnexion)
//
// L'espace est dérivé de la clé du coffre : sans le mot de passe, on ne peut ni trouver ni lister
// les parties (les règles interdisent la lecture au-dessus d'une partie). Chaque entrée du journal
// ne s'écrit qu'une fois : en cas d'écritures simultanées (duel), la seconde est refusée et
// l'appareil la renvoie à l'index suivant.
//
// Le SDK Firebase n'est chargé qu'au premier usage (le jeu contre l'ordinateur s'en passe).

import type { Database } from 'firebase/database';
import type { Action } from '../core/game';
import type { Color } from '../core/position';
import { FIREBASE_CONFIG } from './firebase-config';
import { vaultKey } from './vault';

/** Une action du journal : celles du réducteur, plus l'abandon (qui n'en est pas une). */
export type NetAction = Action | { type: 'resign'; color: Color };

export interface NetEntry {
  by: string;
  action: NetAction;
  /** Position après l'action, chez son auteur : de quoi détecter une désynchronisation. */
  fen: string;
}

export interface RoomMeta {
  host: string;
  hostColor: Color;
  seed: number;
  created: number;
  /** Version de l'appli qui a créé la partie (les deux appareils doivent appliquer les mêmes règles). */
  build: string;
  guest?: string;
}

/** Erreur à montrer telle quelle au joueur. */
export class OnlineError extends Error {}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans 0/O, 1/I/L
export const CODE_LENGTH = 4;
const pad = (n: number) => String(n).padStart(5, '0');

type Db = typeof import('firebase/database');
interface Session {
  db: Database;
  fb: Db;
  uid: string;
  /** Chemin de l'espace des parties. */
  base: string;
}

let session: Promise<Session> | null = null;

async function hmacHex(key: Uint8Array, label: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(label)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function connect(): Promise<Session> {
  session ??= (async () => {
    const key = vaultKey();
    if (!key) throw new OnlineError('Le jeu doit d’abord être déverrouillé.');
    const [{ initializeApp }, auth, fb] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/database')]);
    const app = initializeApp(FIREBASE_CONFIG);
    const a = auth.getAuth(app);
    await a.authStateReady(); // identité anonyme gardée par l'appareil : on retrouve sa place
    const user = a.currentUser ?? (await auth.signInAnonymously(a)).user;
    return { db: fb.getDatabase(app), fb, uid: user.uid, base: `v1/${await hmacHex(key, 'tempete/salons/v1')}/rooms` };
  })();
  session.catch(() => (session = null));
  return session;
}

/** Un code saisi à la main : majuscules, sans espaces ni caractères ambigus. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((ch) => CODE_CHARS.includes(ch));
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function netError(e: unknown): never {
  if (e instanceof OnlineError) throw e;
  console.error(e);
  const msg = e instanceof Error ? e.message : '';
  if (/permission/i.test(msg)) throw new OnlineError('Accès refusé par le serveur de parties.');
  throw new OnlineError('Connexion au serveur de parties impossible. Vérifiez le réseau et réessayez.');
}

/** Crée une partie : renvoie son code. L'hôte y joue `hostColor`. */
export async function createRoom(hostColor: Color, seed: number, build: string): Promise<string> {
  try {
    const { db, fb, uid, base } = await connect();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode();
      const meta: RoomMeta = { host: uid, hostColor, seed, created: Date.now(), build };
      const res = await fb.runTransaction(fb.ref(db, `${base}/${code}/meta`), (cur) => (cur === null ? meta : undefined), { applyLocally: false });
      if (res.committed) return code;
    }
    throw new OnlineError('Impossible de créer la partie, réessayez.');
  } catch (e) {
    netError(e);
  }
}

/** Prend place dans une partie (ou y revient) : renvoie sa description et la couleur jouée. */
export async function joinRoom(code: string): Promise<{ meta: RoomMeta; seat: Color }> {
  try {
    const { db, fb, uid, base } = await connect();
    const snap = await fb.get(fb.ref(db, `${base}/${code}/meta`));
    const meta = snap.val() as RoomMeta | null;
    if (!meta) throw new OnlineError(`Aucune partie ${code}. Vérifiez le code.`);
    const guestColor: Color = meta.hostColor === 'w' ? 'b' : 'w';
    if (meta.host === uid) return { meta, seat: meta.hostColor };
    if (meta.guest === uid) return { meta, seat: guestColor };
    if (meta.guest) throw new OnlineError(`La partie ${code} a déjà ses deux joueurs.`);
    const res = await fb.runTransaction(fb.ref(db, `${base}/${code}/meta/guest`), (cur) => (cur === null || cur === uid ? uid : undefined), { applyLocally: false });
    if (!res.committed) throw new OnlineError(`La partie ${code} a déjà ses deux joueurs.`);
    return { meta: { ...meta, guest: uid }, seat: guestColor };
  } catch (e) {
    netError(e);
  }
}

export interface RoomHandlers {
  /** Nouvelle entrée du journal, dans l'ordre (index = position dans le journal). */
  entry: (index: number, entry: NetEntry) => void;
  meta: (meta: RoomMeta) => void;
  /** L'adversaire a l'appli ouverte sur cette partie. */
  presence: (opponentHere: boolean) => void;
}

export interface Room {
  code: string;
  uid: string;
  /** Écrit l'entrée `index` du journal ; faux si elle était déjà prise (écriture simultanée). */
  send(index: number, entry: NetEntry): Promise<boolean>;
  close(): void;
}

function decode(raw: { by: string; a: string; fen: string }): NetEntry {
  return { by: raw.by, action: JSON.parse(raw.a), fen: raw.fen };
}

/** Ouvre une partie : renvoie le journal existant, puis signale chaque nouvelle entrée. */
export async function openRoom(code: string, on: RoomHandlers): Promise<{ room: Room; history: NetEntry[] }> {
  try {
    const { db, fb, uid, base } = await connect();
    const root = `${base}/${code}`;
    const snap = await fb.get(fb.ref(db, `${root}/actions`));
    const history: NetEntry[] = [];
    snap.forEach((child) => {
      history.push(decode(child.val()));
    });

    const offs: (() => void)[] = [];
    let next = history.length;
    const pending = new Map<number, NetEntry>();
    const tail = history.length ? fb.query(fb.ref(db, `${root}/actions`), fb.orderByKey(), fb.startAfter(pad(history.length - 1))) : fb.ref(db, `${root}/actions`);
    offs.push(
      fb.onChildAdded(tail, (child) => {
        pending.set(Number(child.key), decode(child.val()));
        // (dans l'ordre, même si une entrée arrivait avant la précédente)
        while (pending.has(next)) {
          const e = pending.get(next)!;
          pending.delete(next);
          on.entry(next++, e);
        }
      }),
    );
    offs.push(fb.onValue(fb.ref(db, `${root}/meta`), (s) => s.exists() && on.meta(s.val())));

    const mine = fb.ref(db, `${root}/presence/${uid}`);
    // (re)déclarée à chaque reconnexion : après une coupure, le serveur a retiré la présence
    offs.push(
      fb.onValue(fb.ref(db, '.info/connected'), (s) => {
        if (s.val() !== true) return;
        void fb.onDisconnect(mine).remove().then(() => fb.set(mine, true));
      }),
    );
    offs.push(fb.onValue(fb.ref(db, `${root}/presence`), (s) => on.presence(Object.keys(s.val() ?? {}).some((id) => id !== uid))));

    const room: Room = {
      code,
      uid,
      async send(index, entry) {
        const value = { by: entry.by, a: JSON.stringify(entry.action), fen: entry.fen };
        const res = await fb.runTransaction(fb.ref(db, `${root}/actions/${pad(index)}`), (cur) => (cur === null ? value : undefined), { applyLocally: false });
        return res.committed;
      },
      close() {
        for (const off of offs) off();
        void fb.onDisconnect(mine).cancel();
        void fb.remove(mine).catch(() => {});
      },
    };
    return { room, history };
  } catch (e) {
    netError(e);
  }
}
