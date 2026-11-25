<script lang="ts">
  // Chat d'une partie en ligne : la conversation, des phrases rapides (une touche, pratique en
  // pleine partie) et une zone de saisie libre.
  import { tick } from 'svelte';
  import { controller as c } from '../lib/controller.svelte';
  import { CHAT_MAX } from '../lib/online';
  import { quickPhrases, shortTime, t } from '../i18n/index.svelte';

  interface Props {
    /** Grand écran : affiché en permanence à côté de l'échiquier, plutôt que dans un panneau. */
    docked?: boolean;
  }
  let { docked = false }: Props = $props();

  let draft = $state('');
  let sending = $state(false);
  let list = $state<HTMLOListElement>();

  // toujours montrer le dernier message
  $effect(() => {
    void c.chat.length;
    void tick().then(() => list?.scrollTo({ top: list.scrollHeight }));
  });

  async function send(text: string) {
    if (sending || !text.trim()) return;
    sending = true;
    const ok = await c.say(text);
    sending = false;
    if (ok && text === draft) draft = '';
  }

</script>

{#if docked}
  <span class="label">{t('chat.title')}</span>
{:else}
  <h2 class="sheet-title">{t('chat.title')}</h2>
{/if}

{#if c.chat.length}
  <ol class="messages" class:docked bind:this={list}>
    {#each c.chat as m (m.id)}
      <li class:mine={m.mine}>
        <span class="text">{m.text}</span>
        <span class="time">{m.mine ? t('chat.you') : t('chat.opp')} · {shortTime(m.t)}</span>
      </li>
    {/each}
  </ol>
{:else}
  <p class="empty">{t('chat.empty')}</p>
{/if}

<div class="quick" class:docked aria-label={t('chat.quick')}>
  {#each quickPhrases() as q (q)}
    <button type="button" class="chip" class:emoji={!/\p{L}/u.test(q)} disabled={sending} onclick={() => send(q)}>{q}</button>
  {/each}
</div>

<form
  class="compose"
  onsubmit={(e) => {
    e.preventDefault();
    void send(draft);
  }}
>
  <input type="text" bind:value={draft} maxlength={CHAT_MAX} placeholder={t('chat.placeholder')} aria-label={t('chat.placeholder')} enterkeyhint="send" autocomplete="off" />
  <button type="submit" class="btn primary" disabled={sending || !draft.trim()}>{t('chat.send')}</button>
</form>

<style>
  .sheet-title {
    margin: 0 0 12px;
    font-family: var(--font-comic);
    font-size: 24px;
    font-weight: 400;
  }
  .label {
    display: block;
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .messages.docked {
    flex: 1;
    max-height: none;
    min-height: 0;
  }
  .docked .text {
    background: var(--paper);
    font-size: 14px;
  }
  .docked .mine .text {
    background: var(--mustard);
  }
  .quick.docked {
    margin-top: auto;
    padding-top: 8px;
    gap: 4px;
  }
  .quick.docked .chip {
    padding: 3px 8px;
    font-size: 13px;
  }
  .quick.docked .chip.emoji {
    padding: 2px 6px;
    font-size: 15px;
  }
  .messages {
    list-style: none;
    margin: 0 0 12px;
    padding: 2px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 40dvh;
    overflow-y: auto;
  }
  li {
    align-self: flex-start;
    max-width: 82%;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li.mine {
    align-self: flex-end;
    align-items: flex-end;
  }
  .text {
    padding: 7px 11px;
    border: 2px solid var(--ink);
    border-radius: 14px 14px 14px 4px;
    background: var(--card);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .mine .text {
    border-radius: 14px 14px 4px 14px;
    background: var(--mustard);
    color: #1d1d1d;
  }
  .time {
    font-size: 11px;
    color: var(--muted);
    padding: 0 4px;
  }
  .empty {
    margin: 0 0 12px;
    color: var(--muted);
  }
  .quick {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
  }
  .chip {
    padding: 6px 10px;
    border: 2px solid var(--ink);
    border-radius: 999px;
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
  }
  .chip.emoji {
    padding: 4px 8px;
    font-size: 18px;
  }
  .chip:active:not(:disabled) {
    transform: translate(1px, 1px);
  }
  .compose {
    display: flex;
    gap: 8px;
  }
  .compose input {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    border: 2px solid var(--ink);
    border-radius: 10px;
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: 16px; /* (en dessous, Safari zoome sur le champ) */
  }
  .compose .btn {
    flex: none;
  }
</style>
