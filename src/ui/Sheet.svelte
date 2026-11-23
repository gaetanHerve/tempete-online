<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';

  interface Props {
    onclose?: () => void;
    center?: boolean;
    label?: string;
    children: Snippet;
  }
  let { onclose, center = false, label = 'Fenêtre', children }: Props = $props();

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose?.();
  }
</script>

<svelte:window onkeydown={key} />

<div class="backdrop" transition:fade={{ duration: 150 }} onclick={() => onclose?.()} role="presentation"></div>
<div class="layer" class:center>
  <div class="sheet" role="dialog" aria-modal="true" aria-label={label} transition:fly={{ y: center ? 30 : 300, duration: 220 }}>
    {@render children()}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 40;
  }
  .layer {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    pointer-events: none;
    z-index: 41;
  }
  .layer.center {
    align-items: center;
    padding: 16px;
  }
  .sheet {
    pointer-events: auto;
    width: min(100%, 520px);
    max-height: 92dvh;
    overflow-y: auto;
    background: var(--paper);
    border: 3px solid var(--ink);
    border-bottom: 0;
    border-radius: 18px 18px 0 0;
    padding: 18px 16px calc(18px + env(safe-area-inset-bottom));
  }
  .center .sheet {
    width: min(100%, 420px);
    border-bottom: 3px solid var(--ink);
    border-radius: 18px;
    box-shadow: 6px 6px 0 var(--shadow);
  }
  /* grand écran : toutes les fenêtres au centre, plutôt que montant du bas */
  @media (min-width: 1000px) and (min-height: 600px) and (min-aspect-ratio: 5/4) {
    .layer {
      align-items: center;
      padding: 16px;
    }
    .sheet {
      border-bottom: 3px solid var(--ink);
      border-radius: 18px;
      box-shadow: 6px 6px 0 var(--shadow);
    }
  }
</style>
