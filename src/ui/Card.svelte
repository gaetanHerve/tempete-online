<script lang="ts">
  import { CARD_BY_ID, TIMING_LABEL } from '../core/cards';
  import { cardImage } from '../lib/vault';

  interface Props {
    id?: string;
    back?: boolean;
    big?: boolean;
    playable?: boolean;
    dim?: boolean;
    onclick?: () => void;
  }
  let { id, back = false, big = false, playable = false, dim = false, onclick }: Props = $props();
  const def = $derived(id ? CARD_BY_ID[id] : null);
</script>

{#if back || !def}
  <div class="card back" class:big aria-label="Carte face cachée">
    <img src={cardImage('card-back')} alt="" draggable="false" />
  </div>
{:else}
  <!-- sans action, la carte n'est pas un bouton : un bouton désactivé bloquerait le clic du parent -->
  <svelte:element
    this={onclick ? 'button' : 'div'}
    type={onclick ? 'button' : undefined}
    class="card face"
    class:clickable={!!onclick}
    class:big
    class:playable
    class:dim
    {onclick}
    aria-label={def.title}
    role={onclick ? undefined : 'img'}
  >
    <div class="art">
      <img src={cardImage(def.id)} alt="" draggable="false" loading="lazy" />
    </div>
    <div class="title">{def.title}</div>
    {#if big}
      <div class="timing timing-{def.timing}">{TIMING_LABEL[def.timing]}</div>
      <p class="text">{def.text}</p>
    {/if}
  </svelte:element>
{/if}

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    aspect-ratio: 5 / 8;
    border: 2px solid var(--ink);
    border-radius: 8px;
    background: var(--card);
    overflow: hidden;
    padding: 0;
    font: inherit;
    color: var(--ink);
    text-align: center;
    box-shadow: 2px 2px 0 var(--shadow);
    transition:
      transform 160ms ease,
      box-shadow 160ms ease,
      opacity 160ms ease;
  }
  .back img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .clickable {
    cursor: pointer;
  }
  .art {
    flex: 0 0 auto;
    aspect-ratio: 1.12;
    border-bottom: 2px solid var(--ink);
    background: #fff;
    overflow: hidden;
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .title {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px 3px;
    font-weight: 800;
    font-size: clamp(9px, 2.55vw, 13px);
    line-height: 1.1;
    background: var(--mustard);
    color: var(--on-bright);
    hyphens: auto;
    overflow-wrap: break-word;
  }
  .playable {
    transform: translateY(-6px);
    box-shadow:
      2px 8px 0 var(--shadow),
      0 0 0 3px var(--accent);
  }
  .dim {
    opacity: 0.55;
    filter: saturate(0.6);
  }

  /* grande carte (fiche détaillée) */
  .big {
    aspect-ratio: auto;
    border-width: 3px;
    border-radius: 14px;
    box-shadow: 5px 5px 0 var(--shadow);
  }
  .big.back {
    aspect-ratio: 5 / 8;
  }
  .big .art {
    border-bottom-width: 3px;
  }
  .big .title {
    flex: none;
    font-family: var(--font-comic);
    font-weight: 400;
    padding: 10px 12px 6px;
    font-size: 26px;
    background: var(--mustard);
    color: var(--on-bright);
  }
  .timing {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 0 12px 8px;
    background: var(--mustard);
    color: var(--on-bright);
    border-bottom: 3px solid var(--ink);
  }
  .text {
    margin: 0;
    padding: 12px 16px 16px;
    font-size: 16px;
    line-height: 1.4;
    text-align: left;
  }
</style>
