// Coffre des données protégées (noms, textes et illustrations des cartes, dans chaque langue).
//
// Le dépôt public ne contient que leur version chiffrée (public/vault.bin, construit par
// scripts/vault.mjs). Le mot de passe, transmis à part, est la clé de déchiffrement :
// sans lui, les données ne sont pas lisibles, même en téléchargeant le fichier.
// Une fois le coffre ouvert, la clé dérivée est mémorisée sur l'appareil.

import { LOCALES, type CardTexts, type Locale } from '../i18n/format';
import { setCardTexts } from '../i18n/index.svelte';

const KEY_STORAGE = 'tempete2.cle';
const MAGIC = 'TPV1';

interface Header {
  v: 1;
  iterations: number;
  salt: string;
  iv: string;
  ids: string[];
}

interface Sealed {
  header: Header;
  headerBytes: Uint8Array<ArrayBuffer>;
  cipher: Uint8Array<ArrayBuffer>;
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

let sealed: Promise<Sealed> | null = null;
let images: Record<string, string> = {};
let rawKey: Uint8Array | null = null;

/** Le coffre n'a pas pu être téléchargé (hors ligne au premier lancement, fichier absent). */
export class VaultUnavailable extends Error {}

function fetchSealed(): Promise<Sealed> {
  sealed ??= (async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}vault.bin`).catch(() => null);
    if (!res?.ok) throw new VaultUnavailable();
    const file = new Uint8Array(await res.arrayBuffer());
    if (new TextDecoder().decode(file.subarray(0, 4)) !== MAGIC) throw new VaultUnavailable();
    const len = new DataView(file.buffer).getUint32(4, true);
    const headerBytes = file.slice(8, 8 + len);
    return { header: JSON.parse(new TextDecoder().decode(headerBytes)), headerBytes, cipher: file.slice(8 + len) };
  })();
  sealed.catch(() => (sealed = null)); // on retentera au prochain essai
  return sealed;
}

/** Déchiffre et installe le contenu ; faux si la clé ne convient pas. */
async function open(key: CryptoKey): Promise<boolean> {
  const { header, headerBytes, cipher } = await fetchSealed();
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(header.iv), additionalData: headerBytes }, key, cipher));
  } catch {
    return false;
  }
  const len = new DataView(plain.buffer).getUint32(0, true);
  const data: { texts: Texts; images: Record<string, [number, number]> } = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + len)));
  setCardTexts(byLocale(data.texts));
  const base = 4 + len;
  for (const url of Object.values(images)) URL.revokeObjectURL(url);
  images = Object.fromEntries(
    Object.entries(data.images).map(([id, [start, size]]) => [id, URL.createObjectURL(new Blob([plain.slice(base + start, base + start + size)], { type: 'image/webp' }))]),
  );
  rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return true;
}

/** Textes des cartes : par langue (`{ fr: {…}, en: {…} }`), ou en français seul (anciens coffres). */
type Texts = CardTexts | Partial<Record<Locale, CardTexts>>;

export function byLocale(texts: Texts): Partial<Record<Locale, CardTexts>> {
  const keys = Object.keys(texts);
  return keys.length && keys.every((k) => (LOCALES as string[]).includes(k)) ? (texts as Partial<Record<Locale, CardTexts>>) : { fr: texts as CardTexts };
}

const importRaw = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['decrypt']);

/** Ouvre le coffre avec le mot de passe saisi, et mémorise la clé si c'est le bon. */
export async function unlockWithPassword(password: string): Promise<boolean> {
  const { header } = await fetchSealed();
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(header.salt), iterations: header.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['decrypt'],
  );
  if (!(await open(key))) return false;
  try {
    localStorage.setItem(KEY_STORAGE, b64(rawKey!));
  } catch {
    /* stockage indisponible : il faudra ressaisir le mot de passe */
  }
  return true;
}

/** Ouvre le coffre avec la clé mémorisée ; faux s'il n'y en a pas ou si elle ne convient plus. */
export async function unlockFromStorage(): Promise<boolean> {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY_STORAGE);
  } catch {
    return false;
  }
  if (!stored) return false;
  if (await open(await importRaw(unb64(stored)))) return true;
  forget(); // mot de passe changé depuis
  return false;
}

export function forget(): void {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* rien à oublier */
  }
}

/** Adresse de l'illustration d'une carte (ou du dos : `card-back`). */
export function cardImage(id: string): string {
  return images[id] ?? '';
}

/** Clé du coffre ouvert : le secret partagé, dont dériveront aussi les accès aux parties en ligne. */
export function vaultKey(): Uint8Array | null {
  return rawKey;
}
