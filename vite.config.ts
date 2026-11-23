import { execSync } from 'node:child_process';
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

// base relative : l'appli fonctionne servie depuis n'importe quel sous-dossier (GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [svelte(), versionedServiceWorker()],
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
});
