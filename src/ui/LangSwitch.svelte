<script lang="ts">
  // Choix de la langue : chaque langue est écrite dans sa propre langue, pour qu'on la reconnaisse.
  import { LOCALES, LOCALE_NAME, locale, setLocale, t } from '../i18n/index.svelte';
</script>

<div class="lang" role="radiogroup" aria-label={t('lang.label')}>
  {#each LOCALES as l (l)}
    <button type="button" role="radio" aria-checked={locale() === l} class:on={locale() === l} lang={l} onclick={() => setLocale(l)}>
      {LOCALE_NAME[l]}
    </button>
  {/each}
</div>

<style>
  .lang {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
  }
  button {
    border: 2px solid var(--ink);
    border-radius: 999px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    font-weight: 700;
    padding: 4px 14px;
    cursor: pointer;
  }
  .on {
    background: var(--mustard);
    color: var(--on-bright);
    box-shadow: 2px 2px 0 var(--shadow);
  }
</style>
