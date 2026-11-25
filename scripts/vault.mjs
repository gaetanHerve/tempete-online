// Construit le coffre chiffré public/vault.bin à partir des données protégées de private/ :
//   private/cards.json        { "<id>": { "title": "…", "text": "…" } }   (français, la référence)
//   private/cards.<lang>.json  idem, traduit (ex. cards.en.json) ; une carte absente y reste en français
//   private/cards/<id>.webp, private/cards/card-back.webp
//
//   npm run vault                         (demande le mot de passe)
//   TEMPETE_PASSWORD=… npm run vault
//   npm run vault -- --changer            (nouveau mot de passe : toutes les clés mémorisées tombent)
//
// Sans --changer, le mot de passe doit ouvrir le coffre existant : on réutilise alors son sel,
// pour que la clé mémorisée par les appareils déjà déverrouillés reste valable.
//
// Format : "TPV1" | u32 longueur de l'en-tête | en-tête JSON (en clair) | chiffré AES-GCM.
// L'en-tête (sel, IV, itérations, identifiants) sert de données authentifiées.
// Le clair : u32 longueur du JSON | JSON { texts: { <lang>: { id: { title, text } } }, images: { id: [début, longueur] } } | images.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { webcrypto as crypto } from 'node:crypto';

const OUT = 'public/vault.bin';
const MAGIC = 'TPV1';
const ITERATIONS = 600_000;
const enc = new TextEncoder();

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Lit l'en-tête du coffre existant et vérifie que le mot de passe l'ouvre. */
async function opensExisting(password) {
  const file = new Uint8Array(readFileSync(OUT));
  const len = new DataView(file.buffer, file.byteOffset).getUint32(4, true);
  const headerBytes = file.subarray(8, 8 + len);
  const header = JSON.parse(new TextDecoder().decode(headerBytes));
  const key = await deriveKey(password, unb64(header.salt), header.iterations);
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(header.iv), additionalData: headerBytes }, key, file.subarray(8 + len));
    return header;
  } catch {
    return null;
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : ''); // saisie masquée
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------- données ----------

if (!existsSync('private/cards.json')) fail('private/cards.json introuvable (voir README, « Données protégées »).');
const reference = JSON.parse(readFileSync('private/cards.json', 'utf8'));
const ids = Object.keys(reference).sort();
const texts = { fr: reference };
for (const file of readdirSync('private').filter((f) => /^cards\.[a-z]{2}\.json$/.test(f))) {
  const lang = file.slice(6, 8);
  const t = JSON.parse(readFileSync(`private/${file}`, 'utf8'));
  const missing = ids.filter((id) => !t[id]?.title || !t[id]?.text);
  if (missing.length) console.warn(`⚠ ${file} : ${missing.length} carte(s) non traduite(s) (${missing.join(', ')}), affichées en français.`);
  const extra = Object.keys(t).filter((id) => !reference[id]);
  if (extra.length) fail(`${file} : identifiants inconnus (${extra.join(', ')}).`);
  texts[lang] = t;
}
const imageIds = [...ids, 'card-back'];
const blobs = [];
const images = {};
let offset = 0;
for (const id of imageIds) {
  const file = `private/cards/${id}.webp`;
  if (!existsSync(file)) fail(`illustration manquante : ${file}`);
  const bytes = new Uint8Array(readFileSync(file));
  images[id] = [offset, bytes.length];
  blobs.push(bytes);
  offset += bytes.length;
}
const json = enc.encode(JSON.stringify({ texts, images }));
const plain = concat(u32(json.length), json, ...blobs);

// ---------- mot de passe ----------

const changing = process.argv.includes('--changer');
const fresh = changing || !existsSync(OUT);
let password = process.env.TEMPETE_PASSWORD;
if (!password) {
  password = await ask(fresh ? 'Nouveau mot de passe : ' : 'Mot de passe : ');
  if (fresh && (await ask('Confirmez : ')) !== password) fail('les deux saisies diffèrent.');
}
if (!password) fail('mot de passe vide.');
if (fresh && password.length < 12) console.warn('⚠ mot de passe court : préférez au moins 12 caractères (ou quelques mots).');

let salt;
let iterations = ITERATIONS;
if (fresh) {
  salt = crypto.getRandomValues(new Uint8Array(16));
} else {
  const existing = await opensExisting(password);
  if (!existing) fail("ce mot de passe n'ouvre pas le coffre actuel. Pour en changer : npm run vault -- --changer");
  salt = unb64(existing.salt);
  iterations = existing.iterations;
}

// ---------- chiffrement ----------

const iv = crypto.getRandomValues(new Uint8Array(12));
const headerBytes = enc.encode(JSON.stringify({ v: 1, iterations, salt: b64(salt), iv: b64(iv), ids }));
const key = await deriveKey(password, salt, iterations);
const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerBytes }, key, plain));
writeFileSync(OUT, concat(enc.encode(MAGIC), u32(headerBytes.length), headerBytes, cipher));
console.log(`✓ ${OUT} : ${ids.length} cartes (${Object.keys(texts).join(', ')}), ${(cipher.length / 1024).toFixed(0)} Ko${fresh ? ' (nouveau mot de passe)' : ''}`);
