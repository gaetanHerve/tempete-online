import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/** Version affichée dans l'appli : commit (avec « + » s'il y a des modifications non commitées) et date du build. */
function appVersion(): string {
  const day = new Date().toISOString().slice(0, 16).replace('T', ' ');
  try {
    const hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? '+' : '';
    return `${hash}${dirty} · ${day}`;
  } catch {
    return day;
  }
}

const VERSION = appVersion();

/**
 * Injecte la version dans le service worker : son contenu change à chaque build, ce qui permet
 * au navigateur de détecter la nouvelle version (et de vider l'ancien cache).
 */
function versionedServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'service-worker-version',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const file = resolve(outDir, 'sw.js');
      writeFileSync(file, readFileSync(file, 'utf8').replace('__APP_VERSION__', VERSION));
    },
  };
}

/**
 * Politique de sécurité du contenu (CSP), posée en balise <meta> puisque GitHub Pages ne permet
 * pas d'en-têtes HTTP. Seulement au build : le serveur de dev de Vite a besoin de scripts en ligne.
 *
 * - scripts : ceux de l'appli, plus le petit script en ligne de index.html (autorisé par son
 *   empreinte, calculée ici) ; 'wasm-unsafe-eval' pour Stockfish, au cas où le navigateur
 *   appliquerait la politique de la page à son worker ;
 * - styles : 'unsafe-inline', car Svelte pose des attributs style (peu risqué : pas de script) ;
 * - images : celles de l'appli, et les blob: des illustrations déchiffrées du coffre ;
 * - connexions : la base Firebase (WebSocket) et l'authentification anonyme. Le repli de Firebase
 *   en « long polling » (balises <script> venues de la base) est volontairement refusé : il
 *   ouvrirait les scripts à un domaine extérieur, et WebSocket suffit partout.
 * (frame-ancestors n'est pas pris en compte dans une balise <meta>.)
 */
function contentSecurityPolicy(): Plugin {
  const db = 'europe-west1.firebasedatabase.app';
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
          (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
        );
        const csp = [
          "default-src 'self'",
          `script-src 'self' 'wasm-unsafe-eval' ${inline.join(' ')}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' blob: data:",
          "font-src 'self'",
          `connect-src 'self' https://*.${db} wss://*.${db} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com`,
          "worker-src 'self'",
          "manifest-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join('; ');
        return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
      },
    },
  };
}

// base relative : l'appli fonctionne servie depuis n'importe quel sous-dossier (GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [svelte(), versionedServiceWorker(), contentSecurityPolicy()],
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
});
