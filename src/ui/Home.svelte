<script lang="ts">
  import { BOT_LEVELS } from '../core/bot';
  import { DECK_CARDS } from '../core/cards';
  import { THEME_LABEL, controller as c, type Mode, type Prefs } from '../lib/controller.svelte';
  import { install } from '../lib/install.svelte';
  import { CODE_LENGTH, OnlineError, isValidCode, normalizeCode } from '../lib/online';
  import Card from './Card.svelte';
  import Sheet from './Sheet.svelte';

  interface Props {
    onplay: () => void;
  }
  let { onplay }: Props = $props();

  let mode = $state<Mode>(c.prefs.mode ?? 'bot');
  let color = $state<Prefs['color']>(c.prefs.color);
  let level = $state(c.prefs.level);
  let gallery = $state(false);
  let rules = $state(false);
  let zoom = $state<string | null>(null);
  let iosHelp = $state(false);

  function installApp() {
    if (install.canPrompt) void install.prompt();
    else iosHelp = true;
  }
  const canResume = c.hasSave();

  // en ligne : création ou arrivée dans une partie (réseau), avec son attente et ses erreurs
  let busy = $state(false);
  let error = $state('');
  let code = $state('');
  const codeOk = $derived(isValidCode(normalizeCode(code)));

  async function run(task: () => Promise<boolean | void>) {
    busy = true;
    error = '';
    try {
      if ((await task()) !== false) onplay();
    } catch (e) {
      console.error(e);
      error = e instanceof OnlineError ? e.message : 'Une erreur est survenue. Réessayez.';
    } finally {
      busy = false;
    }
  }

  function play() {
    if (mode === 'online') {
      c.setPrefs({ ...c.prefs, color, mode });
      void run(() => c.createOnline(color));
      return;
    }
    c.start({ ...c.prefs, color, level, mode });
    onplay();
  }
  function resume() {
    void run(() => c.resume());
  }
  function join() {
    if (codeOk) void run(() => c.joinOnline(normalizeCode(code)));
  }

  // lien d'invitation (…?partie=CODE) : on rejoint directement
  const invited = new URLSearchParams(location.search).get('partie');
  if (invited) {
    history.replaceState(null, '', location.pathname);
    mode = 'online';
    code = normalizeCode(invited);
    join();
  }

  const MODES: { id: Mode; label: string }[] = [
    { id: 'bot', label: "Contre l'ordinateur" },
    { id: 'local', label: 'À deux, sur cet appareil' },
    { id: 'online', label: 'En ligne' },
  ];

  const COLORS: { id: Prefs['color']; label: string }[] = [
    { id: 'w', label: 'Blancs' },
    { id: 'random', label: 'Au hasard' },
    { id: 'b', label: 'Noirs' },
  ];
</script>

<main class="home">
  <img class="logo" src="{import.meta.env.BASE_URL}logo.jpg" alt="Tempête sur l'échiquier" />

  {#if canResume}
    <button type="button" class="btn primary wide big" onclick={resume} disabled={busy}>Reprendre la partie</button>
  {/if}

  <section class="panel">
    <div class="seg" role="radiogroup" aria-label="Adversaire">
      {#each MODES as opt (opt.id)}
        <button type="button" role="radio" aria-checked={mode === opt.id} class:on={mode === opt.id} onclick={() => (mode = opt.id)}>{opt.label}</button>
      {/each}
    </div>

    {#if mode === 'local'}
      <p class="local-note">Les Blancs commencent. Entre deux tours, un écran cache la main du joueur précédent : passez-vous l'appareil.</p>
    {:else if mode === 'online'}
      <p class="local-note">Créez une partie et envoyez son code à votre adversaire, ou rejoignez la sienne.</p>
      <h2>Vous jouez</h2>
      <div class="seg" role="radiogroup" aria-label="Couleur">
        {#each COLORS as opt (opt.id)}
          <button type="button" role="radio" aria-checked={color === opt.id} class:on={color === opt.id} onclick={() => (color = opt.id)}>
            {#if opt.id !== 'random'}
              <img src="{import.meta.env.BASE_URL}pieces/{opt.id}K.svg" alt="" />
            {:else}
              <span class="dice">?</span>
            {/if}
            {opt.label}
          </button>
        {/each}
      </div>
      <h2>Rejoindre une partie</h2>
      <form
        class="join"
        onsubmit={(e) => {
          e.preventDefault();
          join();
        }}
      >
        <input
          type="text"
          inputmode="text"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          maxlength={CODE_LENGTH + 2}
          placeholder="Code"
          aria-label="Code de la partie"
          bind:value={code}
          disabled={busy}
        />
        <button type="submit" class="btn" disabled={!codeOk || busy}>Rejoindre</button>
      </form>
    {:else}
      <h2>Vous jouez</h2>
      <div class="seg" role="radiogroup" aria-label="Couleur">
        {#each COLORS as opt (opt.id)}
          <button type="button" role="radio" aria-checked={color === opt.id} class:on={color === opt.id} onclick={() => (color = opt.id)}>
            {#if opt.id !== 'random'}
              <img src="{import.meta.env.BASE_URL}pieces/{opt.id}K.svg" alt="" />
            {:else}
              <span class="dice">?</span>
            {/if}
            {opt.label}
          </button>
        {/each}
      </div>

      <h2>Contre l'ordinateur</h2>
      <div class="levels" role="radiogroup" aria-label="Niveau">
        {#each BOT_LEVELS as l (l.id)}
          <button type="button" role="radio" aria-checked={level === l.id} class="level" class:on={level === l.id} onclick={() => (level = l.id)}>
            <strong>{l.label}</strong>
            <span>{l.description}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button type="button" class="btn {canResume ? 'ghost' : 'primary'} wide big" onclick={play} disabled={busy}>
    {mode === 'online' ? (busy ? 'Connexion…' : 'Créer une partie') : 'Nouvelle partie'}
  </button>

  {#if install.offered}
    <button type="button" class="btn ghost wide install" onclick={installApp}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
      Installer l'appli
    </button>
  {/if}

  <div class="links">
    <button type="button" class="link" onclick={() => (rules = true)}>Comment jouer ?</button>
    <button type="button" class="link" onclick={() => (gallery = true)}>Les {DECK_CARDS.length} cartes</button>
    <button type="button" class="link" onclick={() => c.cycleTheme()}>Thème : {THEME_LABEL[c.prefs.theme ?? 'auto']}</button>
  </div>
  <p class="version">Version {__APP_VERSION__}</p>
</main>

{#if rules}
  <Sheet onclose={() => (rules = false)} label="Règles">
    <h2 class="sheet-title">Comment jouer ?</h2>
    <div class="rules">
      <p>Une partie d'échecs normale… jusqu'à ce que les cartes s'en mêlent.</p>
      <ul>
        <li>Chaque joueur a <strong>5 cartes</strong> en main.</li>
        <li>À votre tour, vous pouvez jouer <strong>une seule carte</strong>, puis vous en piochez une nouvelle.</li>
        <li>Chaque carte indique son moment : <em>avant</em> votre coup, <em>à la place</em> de votre coup ou <em>après</em> votre coup.</li>
        <li>Certaines cartes se jouent <em>après le coup adverse</em>, pour y réagir. Quand l'une d'elles s'applique, la partie vous laisse le choix : jouer la carte ou « Laisser passer ». Vous pouvez jouer une carte pendant le tour adverse, et une autre pendant le vôtre.</li>
        <li>Certaines cartes posent une règle temporaire (plus de prise, une pièce endormie…) : elle s'affiche sous l'échiquier tant qu'elle dure. Touchez-la pour relire la carte.</li>
        <li><em>Non</em> et <em>Niet</em> annulent la carte que l'adversaire vient de jouer : elle est perdue, sans effet. Elles comptent dans la même limite.</li>
        <li>Les cartes jouables brillent. Touchez une carte pour la lire, puis « Jouer » et suivez les consignes sur l'échiquier.</li>
        <li>Une carte ne peut jamais laisser votre Roi en échec — mais elle peut vous sortir d'un mat !</li>
        <li>Une carte devenue définitivement inutile (par exemple Pégase quand vous n'avez plus de Cavalier) porte le tampon « Inutile » : après avoir joué votre coup, vous pouvez la défausser et en piocher une autre, à la place de jouer une carte ce tour-là.</li>
        <li>On gagne par échec et mat, comme d'habitude.</li>
      </ul>
    </div>
    <button type="button" class="btn primary wide" onclick={() => (rules = false)}>Compris</button>
  </Sheet>
{/if}

{#if iosHelp}
  <Sheet onclose={() => (iosHelp = false)} label="Installer l'appli">
    <h2 class="sheet-title">Installer l'appli</h2>
    <p class="install-intro">Installé sur l'écran d'accueil, le jeu s'ouvre en plein écran, sans barre d'adresse.</p>
    <ol class="install-steps">
      <li>
        <span class="step-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 3v12M12 3 8 7m4-4 4 4M7 11H5v10h14V11h-2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        <span>Dans Safari, touchez le bouton <strong>Partager</strong> (en bas de l'écran, ou en haut sur iPad).</span>
      </li>
      <li>
        <span class="step-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2.2" /><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
        </span>
        <span>Faites défiler, choisissez <strong>Sur l'écran d'accueil</strong>, puis <strong>Ajouter</strong>.</span>
      </li>
    </ol>
    <p class="install-note">L'appli installée garde ses propres données : il faudra y saisir le mot de passe une fois. Pour rejoindre une partie depuis l'appli, saisissez son code dans « En ligne ».</p>
    <button type="button" class="btn primary wide" onclick={() => (iosHelp = false)}>Compris</button>
  </Sheet>
{/if}

{#if gallery}
  <Sheet onclose={() => (gallery = false)} label="Les cartes">
    <h2 class="sheet-title">Les cartes</h2>
    <div class="gallery">
      {#each DECK_CARDS as card (card.id)}
        <Card id={card.id} onclick={() => (zoom = card.id)} />
      {/each}
    </div>
  </Sheet>
{/if}

{#if zoom}
  <Sheet center onclose={() => (zoom = null)} label="Carte">
    <Card id={zoom} big />
    <button type="button" class="btn ghost wide close" onclick={() => (zoom = null)}>Fermer</button>
  </Sheet>
{/if}

<style>
  .home {
    width: min(100%, 520px);
    margin: 0 auto;
    min-height: 100dvh;
    padding: calc(16px + env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .logo {
    width: min(72%, 280px);
    margin: 0 auto;
    mix-blend-mode: var(--logo-blend);
    /* thème sombre : le logo (fond blanc) devient une vignette encadrée */
    border: var(--logo-frame);
    border-radius: 16px;
    box-shadow: var(--logo-shadow);
  }
  .panel {
    border: 3px solid var(--ink);
    border-radius: 16px;
    background: var(--card);
    padding: 14px;
    box-shadow: 4px 4px 0 var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h2 {
    margin: 4px 0 0;
    font-family: var(--font-comic);
    font-weight: 400;
    font-size: 20px;
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .seg button,
  .level {
    border: 2px solid var(--ink);
    border-radius: 10px;
    background: var(--paper);
    font: inherit;
    color: var(--ink);
    cursor: pointer;
  }
  .seg button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 8px 4px;
    font-weight: 700;
    font-size: 14px;
  }
  .seg img {
    width: 34px;
    height: 34px;
  }
  .dice {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    font-family: var(--font-comic);
    font-size: 26px;
  }
  .levels {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .level {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 8px 12px;
    text-align: left;
  }
  .level span {
    font-size: 13px;
    color: var(--muted);
  }
  .on {
    background: var(--mustard) !important;
    color: var(--on-bright) !important;
    box-shadow: 2px 2px 0 var(--shadow);
  }
  .on span {
    color: var(--on-bright);
  }
  .big {
    font-size: 19px;
    padding: 14px;
  }
  .local-note {
    margin: 0;
    color: var(--muted);
    text-align: center;
  }
  .join {
    display: flex;
    gap: 8px;
  }
  .join input {
    flex: 1;
    min-width: 0;
    border: 2.5px solid var(--ink);
    border-radius: 12px;
    padding: 10px 14px;
    font: inherit;
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ink);
    background: var(--paper);
  }
  .join input::placeholder {
    letter-spacing: normal;
    font-weight: 400;
  }
  .error {
    margin: 0;
    color: var(--accent);
    font-weight: 700;
    text-align: center;
  }
  .install {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .install-intro,
  .install-note {
    margin: 0 0 12px;
    line-height: 1.45;
  }
  .install-note {
    color: var(--muted);
    font-size: 14px;
  }
  .install-steps {
    margin: 0 0 14px;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .install-steps li {
    display: flex;
    align-items: center;
    gap: 12px;
    line-height: 1.4;
  }
  .step-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 2.5px solid var(--ink);
    border-radius: 10px;
    background: var(--paper);
    color: #1a73e8;
  }
  .version {
    margin: 0;
    font-size: 0.75rem;
    color: var(--muted);
    text-align: center;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px 20px;
  }
  .link {
    border: 0;
    background: none;
    font: inherit;
    font-weight: 700;
    color: var(--ink);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
    cursor: pointer;
    padding: 6px;
  }
  .sheet-title {
    margin: 0 0 12px;
    font-family: var(--font-comic);
    font-size: 24px;
    font-weight: 400;
  }
  .rules {
    font-size: 16px;
    line-height: 1.45;
  }
  .rules ul {
    padding-left: 20px;
  }
  .rules li {
    margin-bottom: 6px;
  }
  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
    gap: 10px;
  }
  .close {
    margin-top: 14px;
  }
</style>
