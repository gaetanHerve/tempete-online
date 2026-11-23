<script lang="ts">
  import { RESUME_KEY, controller } from './lib/controller.svelte';
  import { unlockFromStorage } from './lib/vault';
  import Game from './ui/Game.svelte';
  import Home from './ui/Home.svelte';
  import Unlock from './ui/Unlock.svelte';

  /** Après un rechargement pour une nouvelle version en pleine partie, on la reprend directement. */
  async function resumeAfterUpdate(): Promise<boolean> {
    try {
      if (!sessionStorage.getItem(RESUME_KEY)) return false;
      sessionStorage.removeItem(RESUME_KEY);
    } catch {
      return false;
    }
    // (en ligne, la reprise passe par le réseau : en cas d'échec, retour à l'accueil)
    return controller.resume().catch(() => false);
  }

  // les cartes (noms, textes, illustrations) ne sont disponibles qu'une fois le coffre ouvert
  let screen = $state<'loading' | 'locked' | 'home' | 'game'>('loading');
  async function unlocked() {
    screen = (await resumeAfterUpdate()) ? 'game' : 'home';
  }
  unlockFromStorage()
    .catch(() => false)
    .then((ok) => (ok ? void unlocked() : (screen = 'locked')));
</script>

{#if screen === 'loading'}
  <!-- ouverture du coffre avec la clé mémorisée : un instant -->
{:else if screen === 'locked'}
  <Unlock onunlock={unlocked} />
{:else if screen === 'game' && controller.game}
  <Game
    onquit={() => {
      controller.quit();
      screen = 'home';
    }}
  />
{:else}
  <Home onplay={() => (screen = 'game')} />
{/if}
