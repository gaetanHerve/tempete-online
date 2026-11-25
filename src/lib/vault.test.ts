import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARDS } from '../core/cards';

/** En-tête en clair du coffre : identifiants des cartes qu'il contient. */
function vaultIds(): string[] {
  const file = readFileSync('public/vault.bin');
  expect(file.subarray(0, 4).toString()).toBe('TPV1');
  const len = file.readUInt32LE(4);
  return JSON.parse(file.subarray(8, 8 + len).toString()).ids;
}

describe('coffre des cartes', () => {
  it('contient chaque carte du jeu (sinon : npm run vault)', () => {
    const ids = new Set(vaultIds());
    for (const c of CARDS) expect(ids.has(c.id), `carte absente du coffre : ${c.id}`).toBe(true);
  });

  // données protégées présentes seulement sur le poste de l'auteur (jamais dans le dépôt public)
  const priv = existsSync('private/cards.json');
  // traductions des noms et textes (private/cards.<lang>.json), protégées au même titre
  const translations = priv ? readdirSync('private').filter((f) => /^cards\.[a-z]{2}\.json$/.test(f)) : [];
  const read = (f: string): Record<string, { title: string; text: string }> => JSON.parse(readFileSync(`private/${f}`, 'utf8'));

  it.skipIf(!priv)('les données protégées couvrent chaque carte', () => {
    const texts = JSON.parse(readFileSync('private/cards.json', 'utf8'));
    for (const c of CARDS) {
      expect(texts[c.id]?.title && texts[c.id]?.text, `textes de ${c.id}`).toBeTruthy();
      expect(existsSync(`private/cards/${c.id}.webp`), `illustration de ${c.id}`).toBe(true);
    }
  });

  it.skipIf(!translations.length)('les traductions couvrent chaque carte', () => {
    for (const f of translations) {
      const texts = read(f);
      for (const c of CARDS) expect(texts[c.id]?.title && texts[c.id]?.text, `${f} : textes de ${c.id}`).toBeTruthy();
      expect(Object.keys(texts).filter((id) => !CARDS.some((c) => c.id === id)), `${f} : identifiants inconnus`).toEqual([]);
    }
  });

  it.skipIf(!priv)('aucun texte de carte ni illustration dans les fichiers suivis par git', () => {
    const tracked = execSync('git ls-files -z', { encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(tracked.filter((f) => f.startsWith('private/') || /\.webp$/i.test(f))).toEqual([]);
    const texts = ['cards.json', ...translations].flatMap((f) => Object.values(read(f)));
    // un fragment suffit à repérer une copie, même légèrement retouchée
    const fragments = texts.map((t) => t.text.slice(0, 40));
    for (const f of tracked.filter((f) => /\.(ts|svelte|js|mjs|md|json|txt|html|css)$/.test(f) && existsSync(f))) {
      const content = readFileSync(f, 'utf8');
      for (const frag of fragments) expect(content.includes(frag), `${f} contient « ${frag}… »`).toBe(false);
    }
  });
});
