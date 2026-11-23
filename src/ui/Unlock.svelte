<script lang="ts">
  import { VaultUnavailable, unlockWithPassword } from '../lib/vault';

  interface Props {
    onunlock: () => void;
  }
  let { onunlock }: Props = $props();

  let password = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!password || busy) return;
    busy = true;
    error = '';
    try {
      if (await unlockWithPassword(password)) onunlock();
      else error = 'Mot de passe incorrect.';
    } catch (err) {
      error = err instanceof VaultUnavailable ? 'Impossible de charger les cartes. Vérifiez la connexion et réessayez.' : 'Une erreur est survenue. Réessayez.';
    } finally {
      busy = false;
    }
  }
</script>

<main class="unlock">
  <img class="logo" src="{import.meta.env.BASE_URL}logo.jpg" alt="Tempête sur l'échiquier" />
  <form class="panel" onsubmit={submit}>
    <h2>Accès réservé</h2>
    <p>Saisissez le mot de passe qui vous a été transmis. Il ne sera demandé qu'une fois sur cet appareil.</p>
    <!-- svelte-ignore a11y_autofocus -->
    <input type="password" autocomplete="current-password" aria-label="Mot de passe" placeholder="Mot de passe" bind:value={password} autofocus disabled={busy} />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button type="submit" class="btn primary wide" disabled={!password || busy}>{busy ? 'Ouverture…' : 'Entrer'}</button>
  </form>
</main>

<style>
  .unlock {
    width: min(100%, 420px);
    margin: 0 auto;
    min-height: 100dvh;
    padding: calc(24px + env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 20px;
  }
  .logo {
    width: min(72%, 280px);
    margin: 0 auto;
    mix-blend-mode: var(--logo-blend);
    border: var(--logo-frame);
    border-radius: 16px;
    box-shadow: var(--logo-shadow);
  }
  .panel {
    border: 3px solid var(--ink);
    border-radius: 16px;
    background: var(--card);
    padding: 16px;
    box-shadow: 4px 4px 0 var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-family: var(--font-comic);
    font-weight: 400;
    font-size: 22px;
  }
  p {
    margin: 0;
    color: var(--muted);
    line-height: 1.4;
  }
  input {
    border: 2.5px solid var(--ink);
    border-radius: 12px;
    padding: 12px 14px;
    font: inherit;
    font-size: 17px;
    color: var(--ink);
    background: var(--paper);
  }
  .error {
    color: var(--accent);
    font-weight: 700;
  }
</style>
