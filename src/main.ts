import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { RESUME_KEY, applyTheme, controller } from './lib/controller.svelte';
import { unlockAudio } from './lib/sound';

window.addEventListener('pointerdown', unlockAudio);

applyTheme(controller.prefs.theme);
// en mode automatique, la couleur de la barre du navigateur suit le système
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(controller.prefs.theme));

mount(App, { target: document.getElementById('app')! });

// Mode hors-ligne : en production uniquement (le service worker gênerait le rechargement à chaud).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .then((reg) => {
      // un onglet repris après quelques jours : on vérifie s'il existe une version plus récente
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});

  // une nouvelle version vient de s'installer : on recharge pour l'exécuter (la partie reprend seule)
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    try {
      if (controller.game) sessionStorage.setItem(RESUME_KEY, '1');
    } catch {
      /* stockage indisponible : on reviendra à l'accueil */
    }
    location.reload();
  });
}
