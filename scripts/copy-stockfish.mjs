// Copie le moteur Stockfish (build "lite single-thread", ~7 Mo) dans public/,
// pour qu'il soit servi tel quel et chargé dans un Web Worker.
// Le build single-thread ne nécessite pas d'en-têtes COOP/COEP (compatible GitHub Pages).
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';

const src = 'node_modules/stockfish/src';
const dest = 'public/stockfish';
if (!existsSync(src)) process.exit(0);
mkdirSync(dest, { recursive: true });
for (const f of ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm']) {
  copyFileSync(`${src}/${f}`, `${dest}/${f}`);
}
console.log('Stockfish copié dans public/stockfish');
