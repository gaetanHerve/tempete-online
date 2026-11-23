<script lang="ts">
  import { untrack } from 'svelte';
  import { fade, fly, scale } from 'svelte/transition';
  import { CARD_BY_ID, DIRECTION_STEP, STEP_HINTS } from '../core/cards';
  import { PIECE_NAME, fromFen, sqName, type PieceType, type Sq } from '../core/position';
  import { BEATS, DUEL_WINS, THROWS, actor, canReplay, canSkip, canUndo, mustAct, type LogEntry, type Rule, type Throw } from '../core/game';
  import { THEME_LABEL, controller as c } from '../lib/controller.svelte';
  import { cardImage } from '../lib/vault';
  import Board from './Board.svelte';
  import Card from './Card.svelte';
  import Chat from './Chat.svelte';
  import Sheet from './Sheet.svelte';

  interface Props {
    onquit: () => void;
  }
  let { onquit }: Props = $props();

  const g = $derived(c.game!);
  // revoir la partie : l'entrée d'historique affichée, sa position, son rang parmi les entrées revoyables
  const rv = $derived(c.review !== null ? (g.log[c.review] ?? null) : null);
  const rvBoard = $derived(rv?.fen ? fromFen(rv.fen).board : null);
  const rvList = $derived(rv ? c.reviewable() : []);
  const rvRank = $derived(rv ? rvList.indexOf(c.review!) + 1 : 0);
  const sel = $derived(c.selection);
  const moveMap = $derived(c.game && c.myTurn ? c.moveMap : new Map());
  const playable = $derived(new Set(g && c.myTurn ? c.playable() : []));

  let detail = $state<string | null>(null);
  let showLog = $state(false);
  let showMenu = $state(false);
  let zoom = $state<string | null>(null);
  /** Fin de partie : la fenêtre du résultat a été refermée (on la rouvre depuis la barre). */
  let overHidden = $state(false);
  $effect(() => {
    if (g.phase !== 'over') overHidden = false;
  });

  // grand écran en paysage (même requête que la mise en page « table de jeu » plus bas)
  const WIDE = '(min-width: 1000px) and (min-height: 600px) and (min-aspect-ratio: 5/4)';
  let wide = $state(matchMedia(WIDE).matches);
  $effect(() => {
    const mq = matchMedia(WIDE);
    const on = () => (wide = mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  $effect(() => {
    const docked = online && wide;
    untrack(() => c.dockChat(docked));
  });

  // ----- plateau affiché : position réelle, ou aperçu d'une carte en cours -----
  // carte en suspens (on peut encore l'annuler) : on montre ce qu'elle ferait, aux deux joueurs
  const pendingShown = $derived(g.phase === 'counter' && g.pending && !sel ? g.pending : null);
  // Ruade : le coup adverse est annulé, on choisit sur la position d'avant
  const before = $derived(sel && CARD_BY_ID[sel.card].showsBefore && g.phase === 'reaction' ? (g.reactTo?.before.board ?? null) : null);
  const shown = $derived(sel?.chosen ? sel.chosen.result.board : (before ?? pendingShown?.option.result.board ?? g.pos.board));
  const dests = $derived(
    c.selected !== null && !sel ? new Set<Sq>((moveMap.get(c.selected) ?? []).map((m: { to: Sq }) => m.to)) : new Set<Sq>(),
  );
  const targets = $derived(sel && !sel.chosen ? c.nextSquares(sel) : new Set<Sq>());
  // choix d'une direction (Laser, Chasse-neige) : des flèches partent de la pièce choisie
  const aimFrom = $derived(sel && !sel.chosen && !sel.forced && DIRECTION_STEP[sel.card] === sel.path.length ? sel.path[sel.path.length - 1] : null);
  const ev = $derived(g.lastEvent);
  const marks = $derived(sel?.chosen ? sel.chosen.marks : (pendingShown?.option.marks ?? ev?.marks ?? []));
  const labelChoices = $derived(sel ? c.complete(sel).filter((o) => o.label) : []);
  // nombre d'étapes de sélection (cases à toucher) de la carte en cours
  const steps = $derived(sel && !sel.forced ? (STEP_HINTS[sel.card]?.length ?? 0) : 0);

  const hint = $derived.by(() => {
    if (!sel) return '';
    if (sel.chosen) return sel.chosen.summary;
    if (c.nextSquares(sel).size === 0) return 'Choisissez :';
    if (sel.forced) return sel.prompt ?? 'Touchez une case en surbrillance';
    return STEP_HINTS[sel.card]?.[sel.path.length] ?? 'Touchez une case en surbrillance';
  });

  const status = $derived.by(() => {
    if (g.phase === 'over') return g.result?.reason ?? 'Partie terminée';
    if (c.online?.waiting) return "En attente de l'adversaire…";
    if (c.online?.sending) return 'Envoi…';
    if (g.phase === 'duel') return 'Duel !';
    if (g.phase === 'choice' && !c.thinking && actor(g) !== c.color) return `${CARD_BY_ID[g.choice!.card].title} : au choix de ${c.opponent}…`;
    if (c.thinking) return "L'ordinateur réfléchit…";
    const target = g.phase === 'counter' && g.pending ? (g.pending.counters.at(-1)?.card ?? g.pending.card) : null;
    if (actor(g) !== c.color) {
      // c'est à l'adversaire de décider, même pendant mon tour (réaction à mon coup, annulation de ma carte)
      const who = c.opponent.charAt(0).toUpperCase() + c.opponent.slice(1);
      if (g.phase === 'reaction') return `${who} peut réagir à votre coup…`;
      if (target) return `${who} peut annuler « ${CARD_BY_ID[target].title} »…`;
      return `Au tour de ${c.opponent}`;
    }
    if (g.phase === 'reaction') return 'Réagir au coup adverse ?';
    if (target) return `Annuler « ${CARD_BY_ID[target].title} » ?`;
    if (g.active !== c.color) return `Au tour de ${c.opponent}`;
    if (g.phase === 'main' && g.forbidden) return 'Coup annulé : jouez-en un autre';
    if (canSkip(g)) return 'Provocation : prenez une pièce, ou passez';
    if (g.extra) return `Rebelote : encore ${g.extra} carte${g.extra > 1 ? 's' : ''} ce tour-ci`;
    if (g.phase === 'after') {
      if (g.cardPlayed) return 'Terminez votre tour';
      const options = g.hands[c.color].some((id) => playable.has(id) || c.canDiscard(id));
      return options ? 'Une carte à jouer ou défausser ?' : 'Aucune carte à jouer : terminez votre tour';
    }
    if (c.checkSquare() !== null) return 'Échec ! À vous de jouer';
    return 'À vous de jouer';
  });

  const lastLog = $derived(g.log.length ? g.log[g.log.length - 1] : null);
  // défausse : comme sur une vraie table, la dernière carte défaussée est visible de tous
  const topDiscard = $derived(g.discard.at(-1) ?? null);

  // ----- règles temporaires en cours -----
  const rules = $derived(g.rules ?? []);
  // cartes gardées devant soi (Je passe) : visibles des deux joueurs
  const reserves = $derived((['w', 'b'] as const).flatMap((color) => (g.reserve?.[color] ?? []).map((card) => ({ color, card }))));
  const sleeping = $derived(rules.find((r) => r.card === 'planque')?.sq ?? null);
  function ruleDetail(r: Rule): string {
    if (r.card === 'planque' && r.sq !== undefined) return sqName(r.sq);
    // la pièce désignée par Voyance reste secrète pour l'adversaire
    if (r.card === 'voyance') return r.owner === c.color && r.sq !== undefined ? sqName(r.sq) : '?';
    if (r.turn !== undefined) return r.owner === c.color ? 'tour adverse' : 'votre tour';
    return '';
  }
  const level = $derived(c.level);
  const online = $derived(c.mode === 'online');
  /** En ligne : l'adversaire doit agir (son tour, ou une décision pendant le mien). */
  const theirMove = $derived(online && !c.online?.waiting && g.phase !== 'over' && g.phase !== 'duel' && actor(g) !== c.color);

  // en ligne : inviter l'adversaire (lien direct vers la partie, ou code à saisir)
  let copied = $state(false);
  async function invite(code: string) {
    const url = `${location.origin}${location.pathname}?partie=${code}`;
    const text = `Une partie de Tempête sur l'échiquier ? Code : ${code}`;
    try {
      if (navigator.share) return await navigator.share({ title: "Tempête sur l'échiquier", text, url });
      await navigator.clipboard.writeText(`${text}\n${url}`);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      /* partage annulé */
    }
  }

  /** Qui a fait cette entrée de l'historique (« Vous », « Ordi », ou la couleur à deux). */
  function whoOf(e: LogEntry): string {
    if (c.mode === 'local') return c.colorName(e.color);
    return (e.swapped ? e.color !== c.human : e.color === c.human) ? 'Vous' : online ? 'Adv.' : 'Ordi';
  }
  function reviewFrom(i: number) {
    showLog = false;
    c.startReview(i);
  }
  // ordinateur : flèches gauche/droite pour revoir la partie, Échap pour revenir
  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowLeft') {
      if (c.review === null) c.startReview();
      else c.stepReview(-1);
    } else if (e.key === 'ArrowRight' && c.review !== null) c.stepReview(1);
    else if (e.key === 'Escape' && c.review !== null) c.endReview();
    else return;
    e.preventDefault();
  }

  function openCard(id: string) {
    detail = id;
  }
  function discardDetail() {
    const id = detail!;
    detail = null;
    c.discard(id);
  }
  function playDetail() {
    const id = detail!;
    detail = null;
    c.startCard(id);
  }
  const PROMO: PieceType[] = ['q', 'r', 'b', 'n'];
  const ICON: Record<Throw, string> = { pierre: '✊', feuille: '✋', ciseaux: '✌️' };
  function roundText(mine: Throw, theirs: Throw) {
    return mine === theirs ? 'égalité, on rejoue' : BEATS[mine] === theirs ? 'manche gagnée' : 'manche perdue';
  }
</script>

<!-- historique, du plus récent au plus ancien (les `count` dernières entrées) -->
{#snippet logList(count: number)}
  <ol class="log">
    {#each g.log.slice(-count).toReversed() as e, i (g.log.length - i)}
      {@const idx = g.log.length - 1 - i}
      <li class:card={!!e.card} class:current={idx === c.review}>
        <!-- toucher une entrée : revoir la position à ce moment-là -->
        <button type="button" class="log-row" disabled={!e.fen} onclick={() => reviewFrom(idx)} title={e.fen ? 'Revoir cette position' : undefined}>
          <span class="who-dot {e.color}"></span>
          <span class="log-who">{whoOf(e)}</span>
          <span class="log-text">{e.text}</span>
        </button>
      </li>
    {/each}
  </ol>
{/snippet}

<svelte:window onkeydown={onKey} />

<div class="game">
  <header>
    <button type="button" class="icon" onclick={() => (showMenu = true)} aria-label="Menu">
      <svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" /></svg>
    </button>
    <div class="opponent">
      <div class="avatar" class:thinking={c.thinking || theirMove}>
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
          <rect x="6" y="9" width="20" height="16" rx="4" fill="var(--mustard)" stroke="var(--ink)" stroke-width="2.4" />
          <circle cx="12.5" cy="17" r="2.4" fill="var(--ink)" /><circle cx="19.5" cy="17" r="2.4" fill="var(--ink)" />
          <path d="M16 9V4" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" /><circle cx="16" cy="4" r="2" fill="var(--accent)" />
        </svg>
      </div>
      <div class="who">
        {#if c.mode === 'local'}
          <strong>{c.colorName(c.bot)}</strong>
          <span>Adversaire · à deux sur cet appareil</span>
        {:else if c.online}
          <strong>Adversaire</strong>
          <span><i class="presence" class:here={c.online.here}></i>{c.online.waiting ? 'pas encore arrivé' : c.online.here ? 'en ligne' : 'hors ligne'}{theirMove ? ' · réfléchit…' : ` · partie ${c.online.code}`}</span>
        {:else}
          <strong>Ordinateur</strong>
          <span>{level.label}{c.thinking ? ' · réfléchit…' : ''}</span>
        {/if}
      </div>
      {#if c.bubble}
        <!-- dernier message de l'adversaire, un instant : le toucher ouvre le chat -->
        {#key c.bubble.id}
          <button type="button" class="bubble" onclick={() => c.openChat()} transition:fly={{ y: -8, duration: 200 }}>{c.bubble.text}</button>
        {/key}
      {/if}
      <div class="backs" aria-label="{g.hands[c.bot].length} cartes en main">
        {#each g.hands[c.bot] as _, i (i)}
          <div class="mini-back" style:--i={i} style:background-image="url({cardImage('card-back')})"></div>
        {/each}
      </div>
    </div>
    {#if topDiscard}
      <button type="button" class="discard-mini" onclick={() => (zoom = topDiscard)} aria-label="Défausse : {CARD_BY_ID[topDiscard].title}" title="Défausse : {CARD_BY_ID[topDiscard].title}">
        {#key g.discard.length}
          <img src={cardImage(topDiscard)} alt="" draggable="false" in:fly={{ y: -16, duration: 250 }} />
        {/key}
      </button>
    {/if}
    {#if online}
      <button type="button" class="icon chat-btn" onclick={() => c.openChat()} aria-label={c.unread ? `Chat, ${c.unread} message${c.unread > 1 ? 's' : ''} non lu${c.unread > 1 ? 's' : ''}` : 'Chat'}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M4 5h16v11H10l-4 4v-4H4z" /></svg>
        {#if c.unread}<span class="badge">{c.unread > 9 ? '9+' : c.unread}</span>{/if}
      </button>
    {/if}
    <button type="button" class="icon log-btn" onclick={() => (showLog = true)} aria-label="Historique">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 4h11l3 3v13H5z" /><path d="M8 10h8M8 14h8M8 18h5" /></svg>
    </button>
  </header>

  <!-- grand écran : la main adverse, en éventail en haut de la table -->
  <div class="opp-fan" aria-hidden="true">
    {#each g.hands[c.bot] as _, i (i)}
      <div class="opp-card" style:--i={i} style:--n={g.hands[c.bot].length} in:fly={{ y: -80, duration: 300 }}>
        <Card back />
      </div>
    {/each}
  </div>

  <div class="middle">
  <div class="board-wrap">
    {#if rv && rvBoard}
      <!-- revoir la partie : position passée, en lecture seule -->
      <Board
        board={rvBoard}
        flipped={(c.mode === 'local' ? c.color : c.human) === 'b'}
        lastFrom={rv.event?.from ?? null}
        lastTo={rv.event?.to ?? null}
        marks={rv.event?.marks ?? []}
        past
      />
    {:else}
      <Board
        board={shown}
        flipped={(c.mode === 'local' ? c.color : c.human) === 'b'}
        lastFrom={sel ? null : (ev?.from ?? null)}
        lastTo={sel ? null : (ev?.to ?? null)}
        selected={c.selected}
        {dests}
        {targets}
        {aimFrom}
        path={sel?.path ?? []}
        {marks}
        check={sel ? null : c.checkSquare()}
        preview={!!sel?.chosen || !!pendingShown}
        base={sel?.chosen ? (before ?? g.pos.board) : pendingShown ? g.pos.board : null}
        {sleeping}
        onsquare={(s) => c.tapSquare(s, moveMap)}
      />
    {/if}
  </div>

  <div class="left">
    <!-- grand écran : la défausse, face visible -->
    {#if topDiscard}
      <div class="pile">
        <span class="wide-label">Défausse · {g.discard.length} carte{g.discard.length > 1 ? 's' : ''}</span>
        <div class="pile-stack" class:deep={g.discard.length > 1}>
          {#key g.discard.length}
            <div class="pile-top" in:fly={{ x: 120, y: 40, duration: 320 }}>
              <Card id={topDiscard} onclick={() => (zoom = topDiscard)} />
            </div>
          {/key}
        </div>
      </div>
    {/if}
  {#if rules.length || g.swap || reserves.length}
    <div class="rules" aria-label="Règles en cours">
      <span class="wide-label">Règles en cours</span>
      {#if g.swap}
        <button type="button" class="rule mine" onclick={() => (zoom = 'doubleJeu')}>
          Double jeu<span>vous jouez les {c.color === 'w' ? 'Blancs' : 'Noirs'}, encore {Math.ceil((g.swap.until - (g.turn ?? 0)) / 2)} tour(s)</span>
        </button>
      {/if}
      {#each reserves as r (r.color + r.card)}
        <button type="button" class="rule" class:mine={r.color === c.color} onclick={() => (zoom = r.card)}>
          {CARD_BY_ID[r.card].title}<span>en réserve · {r.color === c.color ? 'vous' : online ? 'adversaire' : 'ordi'}</span>
        </button>
      {/each}
      {#each rules as r (r.card)}
        {@const detail = ruleDetail(r)}
        <button type="button" class="rule" class:mine={r.owner === c.color} onclick={() => (zoom = r.card)}>
          {CARD_BY_ID[r.card].title}{#if detail}<span>{detail}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
    <!-- grand écran : les derniers coups restent visibles à gauche -->
    {#if g.log.length}
      <div class="side-log" aria-label="Derniers coups">
        <span class="wide-label">Derniers coups</span>
        {@render logList(8)}
      </div>
    {/if}
  </div>

  <div class="right">
  <div class="bar" class:card-mode={!!sel || !!rv}>
    {#if rv}
      <div class="sel-head">
        <span class="sel-title">Revoir la partie <span class="sel-step">{rvRank}/{rvList.length}</span></span>
        <span class="sel-hint review-entry">
          <span class="who-dot {rv.color}"></span>{whoOf(rv)} : {rv.text}
          {#if rv.card}<button type="button" class="link-btn" onclick={() => (zoom = rv.card!)}>voir la carte</button>{/if}
        </span>
      </div>
      <div class="actions">
        <button type="button" class="btn ghost step-btn" disabled={rvRank <= 1} onclick={() => c.stepReview(-1)} aria-label="Coup précédent">◀</button>
        <button type="button" class="btn ghost step-btn" onclick={() => c.stepReview(1)} aria-label={rvRank >= rvList.length ? 'Revenir à la partie' : 'Coup suivant'}>▶</button>
        <button type="button" class="btn primary" onclick={() => c.endReview()}>Revenir à la partie</button>
      </div>
    {:else if sel}
      <div class="sel-head">
        <span class="sel-title">
          {CARD_BY_ID[sel.card].title}
          {#if steps > 1 && !sel.chosen}<span class="sel-step">étape {Math.min(sel.path.length + 1, steps)}/{steps}</span>{/if}
        </span>
        <span class="sel-hint">{hint}</span>
      </div>
      {#if labelChoices.length > 1 || (labelChoices.length === 1 && targets.size > 0)}
        <div class="choices">
          {#each labelChoices as o (o.label)}
            <button type="button" class="chip" class:on={sel.chosen === o} onclick={() => c.choose(o)}>{o.label}</button>
          {/each}
        </div>
      {/if}
      <div class="actions">
        {#if !sel.forced}<button type="button" class="btn ghost" onclick={() => c.cancelCard()}>Annuler</button>{/if}
        <button type="button" class="btn primary" disabled={!sel.chosen} onclick={() => c.confirmCard()}>{sel.forced ? 'Valider' : 'Jouer la carte'}</button>
      </div>
    {:else}
      <div class="status">
        <span class="turn-dot" class:mine={actor(g) === c.color && g.phase !== 'over'}></span>
        <span>{status}</span>
      </div>
      {#if g.phase === 'over'}
        <button type="button" class="btn primary small" onclick={() => (overHidden = false)}>Résultat</button>
      {:else if g.phase === 'after' && g.active === c.color}
        <div class="turn-btns">
          {#if canUndo(g) && c.myTurn}
            <button type="button" class="btn ghost small" onclick={() => c.undo()} title="Reprendre le coup que vous venez de jouer">Annuler mon coup</button>
          {/if}
          {#if canReplay(g) && c.myTurn}
            <button type="button" class="btn ghost small" onclick={() => c.replay()}>Je passe : rejouer</button>
          {/if}
          <button type="button" class="btn primary small" onclick={() => c.endTurn()}>Terminer mon tour</button>
        </div>
      {:else if canSkip(g) && c.myTurn}
        <button type="button" class="btn primary small" onclick={() => c.skip()}>Passer mon tour</button>
      {:else if (g.phase === 'reaction' || g.phase === 'counter') && actor(g) === c.color && !c.reveal}
        <button type="button" class="btn primary small" onclick={() => c.passReaction()}>Laisser passer</button>
      {:else if lastLog}
        <button type="button" class="last" title="Revoir la partie" onclick={() => c.startReview()}>
          <span class="who-dot {lastLog.color}"></span>{lastLog.text}
        </button>
      {/if}
    {/if}
  </div>
    <!-- grand écran, en ligne : le chat reste affiché sous la barre d'état -->
    {#if online && wide}
      <div class="side-chat" aria-label="Chat">
        <Chat docked />
      </div>
    {/if}
  </div>
  </div>

  <div class="hand" aria-label="Votre main">
    {#each g.hands[c.color] as id, i (id)}
      <div class="slot" style:--i={i} style:--n={g.hands[c.color].length} in:fly={{ y: 60, duration: 300 }}>
        <Card {id} playable={playable.has(id) && !sel} dim={!!sel && sel.card !== id} onclick={() => openCard(id)} />
        {#if !sel && playable.has(id) && c.ends(id).length}
          <span class="ends-badge" title="Met fin à {c.ends(id).join(', ')}">⇄</span>
        {:else if !sel && c.isDead(id)}<span class="dead-stamp" title={g.phase === 'after' ? 'Défaussable' : 'Défaussable après votre coup'}>Inutile</span>{/if}
      </div>
    {/each}
  </div>
</div>

<!-- fiche détaillée d'une carte de la main -->
{#if detail}
  {@const why = c.whyNot(detail)}
  {@const ends = c.ends(detail)}
  <Sheet onclose={() => (detail = null)} label="Carte">
    <div class="detail">
      <Card id={detail} big />
      {#if why}
        <p class="why">{why}</p>
        {#if c.canDiscard(detail)}
          <p class="dead-note">Vous pouvez la défausser et en piocher une autre. Cela compte comme votre carte du tour.</p>
          <button type="button" class="btn primary wide" onclick={discardDetail}>Défausser et piocher</button>
        {/if}
        <button type="button" class="btn ghost wide" onclick={() => (detail = null)}>Fermer</button>
      {:else}
        {#if ends.length}
          <p class="ends-note">
            {ends.map((t) => `« ${t} »`).join(' et ')} {ends.length > 1 ? 'sont' : 'est'} en cours : jouer cette carte y met fin, car la dernière carte jouée l'emporte.
          </p>
        {/if}
        <button type="button" class="btn primary wide" onclick={playDetail}>Jouer cette carte</button>
      {/if}
    </div>
  </Sheet>
{/if}

<!-- à deux : passage de l'appareil (cache la main du joueur précédent) -->
{#if c.handoff}
  <div class="handoff" transition:fade={{ duration: 150 }}>
    <div class="handoff-card">
      <img class="handoff-king" src="{import.meta.env.BASE_URL}pieces/{c.handoff.color}K.svg" alt="" />
      <h2>Au tour des {c.colorName(c.handoff.color)}</h2>
      {#if c.handoff.news.length}
        <p class="muted">Depuis votre dernier passage :</p>
        <ul class="handoff-news">
          {#each c.handoff.news as n, i (i)}<li>{n}</li>{/each}
        </ul>
      {:else}
        <p class="muted">Passez l'appareil, sans regarder la main de l'autre.</p>
      {/if}
      <button type="button" class="btn primary wide" onclick={() => c.takeOver()}>Je suis prêt</button>
    </div>
  </div>
{/if}

<!-- l'ordinateur joue une carte -->
{#if c.reveal}
  <div class="reveal" transition:fade={{ duration: 180 }} onclick={() => c.dismissReveal()} role="presentation">
    <div class="reveal-card" in:scale={{ start: 0.6, duration: 320 }}>
      <p class="reveal-kicker">{online ? "L'adversaire joue" : "L'ordinateur joue"}</p>
      <Card id={c.reveal.card} big />
      <p class="reveal-summary">{c.reveal.summary}</p>
      {#if c.reveal.ends.length}
        <p class="reveal-ends">Met fin à {c.reveal.ends.map((id) => `« ${CARD_BY_ID[id].title} »`).join(' et ')}</p>
      {/if}
      <p class="tap">Touchez pour continuer</p>
    </div>
  </div>
{/if}

<!-- duel : pierre-feuille-ciseaux -->
{#if g.phase === 'duel' && g.duel && !c.reveal}
  {@const d = g.duel}
  <Sheet center label="Duel">
    <div class="duel">
      <h2 class="sheet-title">Duel</h2>
      <p class="muted">{d.defender === c.color ? 'Défendez votre pièce !' : 'Prenez la pièce de force !'} Premier à {DUEL_WINS} manches.</p>
      <div class="duel-score"><span>{c.mode === 'local' ? c.colorName(c.color) : 'Vous'} <b>{d.score[c.color]}</b></span><span><b>{d.score[c.bot]}</b> {c.mode === 'local' ? c.colorName(c.bot) : online ? 'Adv.' : 'Ordi'}</span></div>
      {#if d.last}
        <p class="duel-last">{ICON[d.last[c.color]]} contre {ICON[d.last[c.bot]]} : {roundText(d.last[c.color], d.last[c.bot])}</p>
      {/if}
      {#if mustAct(g, c.color)}
        <div class="throws">
          {#each THROWS as t (t)}
            <button type="button" class="throw" onclick={() => c.throwDuel(t)}><span>{ICON[t]}</span>{t}</button>
          {/each}
        </div>
      {:else}
        <p class="muted">Au tour de {c.opponent} de choisir…</p>
      {/if}
    </div>
  </Sheet>
{/if}

<!-- issue du duel -->
{#if c.duelResult}
  {@const r = c.duelResult}
  <Sheet center onclose={() => c.dismissDuel()} label="Issue du duel">
    <div class="duel">
      <div class="over-badge" class:won={r.winner === c.color}>{r.winner === c.color ? 'Duel gagné !' : 'Duel perdu'}</div>
      <p class="duel-last">{ICON[r.last[c.color]]} contre {ICON[r.last[c.bot]]} · {r.score[c.color]}–{r.score[c.bot]}</p>
      <p>{r.winner === r.defender ? 'La pièce attaquante est éliminée.' : 'La prise a lieu.'}</p>
      <button type="button" class="btn primary wide" onclick={() => c.dismissDuel()}>Continuer</button>
    </div>
  </Sheet>
{/if}

<!-- promotion -->
{#if c.promotion}
  <Sheet center onclose={() => c.promote(null)} label="Promotion">
    <h2 class="sheet-title">Promotion</h2>
    <div class="promo">
      {#each PROMO as t (t)}
        <button type="button" class="promo-btn" onclick={() => c.promote(t)} aria-label={PIECE_NAME[t]}>
          <img src="{import.meta.env.BASE_URL}pieces/{c.color}{t.toUpperCase()}.svg" alt="" />
        </button>
      {/each}
    </div>
  </Sheet>
{/if}

<!-- en ligne : en attendant l'adversaire -->
{#if c.online?.waiting && g.phase !== 'over'}
  {@const code = c.online.code}
  <Sheet center label="En attente de l'adversaire">
    <div class="over">
      <h2 class="sheet-title">Partie {code}</h2>
      <p>Envoyez ce code à votre adversaire. La partie commence dès son arrivée.</p>
      <p class="room-code" aria-label="Code {code.split('').join(' ')}">{code}</p>
      <button type="button" class="btn primary wide" onclick={() => invite(code)}>{copied ? 'Lien copié !' : 'Inviter'}</button>
      <button type="button" class="btn ghost wide" onclick={onquit}>Menu principal</button>
    </div>
  </Sheet>
{/if}

<!-- en ligne : les deux appareils ne voient plus la même partie -->
{#if c.online?.broken}
  <Sheet center label="Partie désynchronisée">
    <div class="over">
      <h2 class="sheet-title">Partie interrompue</h2>
      <p>{c.online.broken}</p>
      <button type="button" class="btn primary wide" onclick={() => location.reload()}>Recharger</button>
      <button type="button" class="btn ghost wide" onclick={onquit}>Menu principal</button>
    </div>
  </Sheet>
{/if}

<!-- fin de partie -->
{#if g.phase === 'over' && g.result && !overHidden}
  {@const local = c.mode === 'local'}
  {@const won = local || g.result.winner === c.human}
  {@const draw = g.result.winner === null}
  <!-- refermable : pour revoir l'échiquier, ou continuer à discuter en ligne -->
  <Sheet center onclose={() => (overHidden = true)} label="Fin de partie">
    <div class="over">
      <div class="over-badge" class:won class:draw>
        {draw ? 'Nulle' : local ? `Les ${c.colorName(g.result.winner!)} gagnent !` : won ? 'Victoire !' : 'Défaite'}
      </div>
      <p>{g.result.reason}{draw || local ? '' : won ? ' — bien joué.' : online ? " — l'adversaire l'emporte." : " — l'ordinateur l'emporte."}</p>
      {#if !online}
        <button type="button" class="btn primary wide" onclick={() => c.start(c.prefs)}>Rejouer</button>
      {:else}
        <button
          type="button"
          class="btn primary wide"
          onclick={() => {
            overHidden = true;
            if (!c.chatDocked) c.openChat();
          }}>Discuter{c.unread ? ` (${c.unread} non lu${c.unread > 1 ? 's' : ''})` : ''}</button
        >
      {/if}
      <button type="button" class="btn ghost wide" onclick={() => (overHidden = true)}>Voir l'échiquier</button>
      <button type="button" class="btn ghost wide" onclick={onquit}>Menu principal</button>
    </div>
  </Sheet>
{/if}

<!-- historique -->
{#if showLog}
  <Sheet onclose={() => (showLog = false)} label="Historique">
    <h2 class="sheet-title">Historique</h2>
    {#if !g.log.length}
      <p class="muted">Rien pour l'instant.</p>
    {:else}
      <p class="muted log-hint">Touchez une entrée pour revoir la position à ce moment-là.</p>
      {@render logList(g.log.length)}
    {/if}
  </Sheet>
{/if}

{#if c.chatOpen && !c.chatDocked}
  <Sheet onclose={() => c.closeChat()} label="Chat">
    <Chat />
  </Sheet>
{/if}

{#if zoom}
  <Sheet center onclose={() => (zoom = null)} label="Carte">
    <Card id={zoom} big />
    <button type="button" class="btn ghost wide zoom-close" onclick={() => (zoom = null)}>Fermer</button>
  </Sheet>
{/if}

<!-- menu -->
{#if showMenu}
  <Sheet onclose={() => (showMenu = false)} label="Menu">
    <h2 class="sheet-title">Partie en cours</h2>
    <div class="menu">
      <button type="button" class="btn ghost wide" onclick={() => (showMenu = false)}>Continuer</button>
      <button type="button" class="btn ghost wide" onclick={() => c.toggleSound()}>Son : {c.prefs.sound === false ? 'désactivé' : 'activé'}</button>
      <button type="button" class="btn ghost wide" onclick={() => c.cycleTheme()}>Thème : {THEME_LABEL[c.prefs.theme ?? 'auto']}</button>
      <button
        type="button"
        class="btn ghost wide"
        onclick={() => {
          showMenu = false;
          onquit();
        }}>Menu principal (partie sauvegardée)</button
      >
      {#if g.phase !== 'over'}
        <button
          type="button"
          class="btn danger wide"
          onclick={() => {
            showMenu = false;
            c.resign();
          }}>Abandonner</button
        >
      {/if}
      <p class="version">Version {__APP_VERSION__}</p>
    </div>
  </Sheet>
{/if}

{#if c.toast}
  <div class="toast-layer"><div class="toast" transition:fly={{ y: 20, duration: 200 }}>{c.toast}</div></div>
{/if}

<style>
  .game {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(100%, 520px);
    margin: 0 auto;
    min-height: 100dvh;
    padding: calc(8px + env(safe-area-inset-top)) 16px calc(12px + env(safe-area-inset-bottom));
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border: 2px solid var(--ink);
    border-radius: 10px;
    background: var(--card);
    color: var(--ink);
    box-shadow: 2px 2px 0 var(--shadow);
  }
  .icon:active {
    transform: translate(2px, 2px);
    box-shadow: none;
  }
  .opponent {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border: 2px solid var(--ink);
    border-radius: 12px;
    background: var(--card);
    height: 42px;
  }
  .avatar {
    flex: none;
    display: grid;
    place-items: center;
  }
  .opponent {
    position: relative;
  }
  .bubble {
    position: absolute;
    z-index: 6;
    top: calc(100% + 8px);
    left: 10px;
    max-width: min(260px, 80vw);
    padding: 7px 11px;
    border: 2px solid var(--ink);
    border-radius: 4px 14px 14px 14px;
    background: var(--card);
    color: var(--ink);
    box-shadow: 2px 2px 0 var(--shadow);
    font: inherit;
    font-size: 14px;
    text-align: left;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .chat-btn {
    position: relative;
  }
  .badge {
    position: absolute;
    top: -7px;
    right: -7px;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border: 2px solid var(--ink);
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
  }
  .presence {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 5px;
    border-radius: 50%;
    background: var(--muted);
    vertical-align: 1px;
  }
  .presence.here {
    background: #3fa34d;
  }
  .room-code {
    margin: 4px 0;
    font-family: var(--font-comic);
    font-size: 44px;
    letter-spacing: 0.25em;
    text-align: center;
    user-select: all;
  }
  .avatar.thinking {
    animation: bob 0.7s ease-in-out infinite alternate;
  }
  @keyframes bob {
    to {
      transform: translateY(-3px) rotate(-6deg);
    }
  }
  .who {
    display: flex;
    flex-direction: column;
    line-height: 1.1;
    min-width: 0;
  }
  .who strong {
    font-size: 14px;
  }
  .who span {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .backs {
    margin-left: auto;
    display: flex;
    flex: none;
  }
  .mini-back {
    width: 14px;
    height: 22px;
    margin-left: -5px;
    border: 1.5px solid var(--ink);
    border-radius: 3px;
    background-color: var(--mustard);
    background-position: center;
    background-size: cover;
    transform: rotate(calc((var(--i) - 2) * 6deg));
  }

  .middle {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 10px;
  }
  .board-wrap {
    width: 100%;
    max-width: min(100%, calc(100dvh - 340px));
    min-width: 260px;
    margin: 0 auto;
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 48px;
    padding: 6px 10px;
    border: 2px solid var(--ink);
    border-radius: 12px;
    background: var(--card);
  }
  .bar.card-mode {
    flex-direction: column;
    align-items: stretch;
    background: var(--mustard-soft);
  }
  .turn-btns {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: 15px;
  }
  .turn-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--muted);
    flex: none;
  }
  .turn-dot.mine {
    background: var(--accent);
    box-shadow: 0 0 0 3px rgba(214, 69, 47, 0.25);
  }
  .last {
    border: 0;
    padding: 0;
    background: none;
    font: inherit;
    cursor: pointer;
    font-size: 13px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .who-dot {
    flex: none;
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--ink);
  }
  .who-dot.w {
    background: #fff;
  }
  .who-dot.b {
    background: #1d1a16;
  }
  .sel-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sel-title {
    font-family: var(--font-comic);
    font-size: 18px;
  }
  .sel-step {
    margin-left: 6px;
    padding: 1px 8px;
    border: 1.5px solid var(--ink);
    border-radius: 999px;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    vertical-align: middle;
  }
  .sel-hint {
    font-size: 14px;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    border: 2px solid var(--ink);
    border-radius: 999px;
    padding: 6px 12px;
    background: var(--card);
    font: inherit;
    font-size: 14px;
    font-weight: 700;
    color: var(--ink);
  }
  .chip.on {
    background: var(--ink);
    color: var(--paper);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions .btn {
    flex: 1;
  }

  .hand {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px;
    padding-top: 8px;
  }
  .slot {
    position: relative;
    min-width: 0;
    container-type: inline-size;
  }
  /* carte devenue inutile (défaussable) : un coup de tampon sur l'illustration, pas un bouton */
  .dead-stamp {
    position: absolute;
    top: 30%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-14deg);
    padding: 1cqw 5cqw;
    border: 2px solid var(--accent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--card) 78%, transparent);
    color: var(--accent);
    font-family: var(--font-comic);
    font-size: clamp(10px, 15cqw, 20px);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    pointer-events: none;
  }
  .ends-badge {
    position: absolute;
    top: -7px;
    right: -5px;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: 2px solid var(--ink);
    border-radius: 50%;
    background: var(--mustard);
    color: var(--on-bright);
    font-size: 13px;
    font-weight: 900;
    pointer-events: none;
  }
  .ends-note {
    margin: 0;
    text-align: center;
    font-size: 14px;
    font-weight: 700;
  }
  .dead-note {
    margin: 0;
    text-align: center;
    font-size: 14px;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 380px;
    margin: 0 auto;
  }
  .why {
    margin: 0;
    text-align: center;
    font-weight: 700;
    color: var(--muted);
  }

  .reveal {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--scrim);
  }
  .reveal-card {
    width: min(100%, 270px);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .reveal-kicker {
    margin: 0;
    text-align: center;
    font-family: var(--font-comic);
    font-size: 24px;
    color: var(--mustard);
    text-shadow: 2px 2px 0 var(--shadow);
  }
  .reveal-ends {
    margin: 0;
    padding: 8px 12px;
    border: 2px solid var(--ink);
    border-radius: 10px;
    background: var(--mustard-soft);
    font-weight: 700;
    text-align: center;
  }
  .reveal-summary {
    margin: 0;
    padding: 10px 12px;
    border: 2px solid var(--ink);
    border-radius: 10px;
    background: var(--paper);
    font-weight: 700;
    text-align: center;
  }
  .tap {
    margin: 0;
    text-align: center;
    font-size: 13px;
    color: var(--paper);
    opacity: 0.85;
  }

  .sheet-title {
    margin: 0 0 12px;
    font-family: var(--font-comic);
    font-size: 24px;
    font-weight: 400;
  }
  .promo {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }
  .promo-btn {
    border: 2px solid var(--ink);
    border-radius: 10px;
    background: var(--sq-light);
    padding: 4px;
    aspect-ratio: 1;
  }
  .promo-btn img {
    width: 100%;
    height: 100%;
  }
  .over {
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: center;
  }
  .over p {
    margin: 0 0 6px;
  }
  .over-badge {
    font-family: var(--font-comic);
    font-size: 40px;
    color: var(--accent);
    text-shadow: 2px 2px 0 var(--shadow);
  }
  .over-badge.won {
    color: var(--mustard);
  }
  .over-badge.draw {
    color: var(--muted);
  }
  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .log li {
    border-bottom: 1px dashed color-mix(in srgb, var(--ink) 25%, transparent);
    font-size: 15px;
  }
  .log li.card {
    font-weight: 700;
  }
  .log li.current {
    background: var(--mustard-soft);
  }
  .log-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 8px 2px;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .log-row:disabled {
    cursor: default;
  }
  .log-row:not(:disabled):hover .log-text {
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
  .log-hint {
    margin: 0 0 6px;
    font-size: 14px;
  }
  .review-entry {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .link-btn {
    border: 0;
    padding: 0;
    background: none;
    font: inherit;
    font-weight: 700;
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .step-btn {
    flex: 0 0 auto !important;
    min-width: 48px;
  }
  .log-who {
    flex: none;
    width: 38px;
    color: var(--muted);
    font-size: 13px;
  }
  .zoom-close {
    margin-top: 14px;
  }
  .menu {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .rules {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
  }
  .rule {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 3px 10px;
    border: 2px solid var(--ink);
    border-radius: 999px;
    background: var(--mustard-soft);
    font: inherit;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
  }
  .rule.mine {
    background: var(--mustard);
    color: var(--on-bright);
  }
  .rule span {
    font-weight: 400;
    color: var(--muted);
  }
  .wide-label,
  .opp-fan,
  .side-log,
  .pile {
    display: none;
  }
  /* défausse sur téléphone : une vignette de la dernière carte, dans la barre du haut */
  .discard-mini {
    flex: none;
    width: 30px;
    height: 42px;
    padding: 0;
    border: 2px solid var(--ink);
    border-radius: 5px;
    background: var(--card);
    box-shadow: 2px 2px 0 var(--shadow);
    overflow: hidden;
    cursor: pointer;
    transform: rotate(-4deg);
  }
  .discard-mini img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .left,
  .right {
    display: contents;
  }

  /* ===== Grand écran en paysage : une table de jeu vue de dessus =====
     main adverse en éventail en haut, échiquier au centre (règles à gauche, actions à droite),
     sa propre main en éventail en bas, qui déborde de l'écran comme des cartes tenues en main. */
  @media (min-width: 1000px) and (min-height: 600px) and (min-aspect-ratio: 5/4) {
    .game {
      --top: 76px;
      --bottom: 180px;
      --card-w: clamp(96px, 8vw, 124px);
      position: relative;
      display: block;
      width: 100%;
      max-width: none;
      height: 100dvh;
      min-height: 0;
      padding: 0;
      overflow: hidden;
    }
    header {
      position: absolute;
      z-index: 5;
      top: 14px;
      left: 24px;
      right: 24px;
    }
    .opponent {
      order: -1;
      flex: none;
      width: min(320px, 26vw);
    }
    header > .icon:not(.log-btn):not(.chat-btn) {
      margin-left: auto;
    }
    /* le chat est déjà affiché à droite de l'échiquier */
    .chat-btn,
    .bubble {
      display: none;
    }
    .opponent .backs,
    .discard-mini {
      display: none;
    }
    .pile {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      flex: none;
    }
    .pile-stack {
      position: relative;
      width: clamp(84px, 7vw, 108px);
      transform: rotate(-3deg);
    }
    /* les cartes déjà défaussées dessous : deux bords qui dépassent */
    .pile-stack.deep::before,
    .pile-stack.deep::after {
      content: '';
      position: absolute;
      inset: 0;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: var(--card);
    }
    .pile-stack.deep::before {
      transform: rotate(7deg) translate(6px, 2px);
    }
    .pile-stack.deep::after {
      transform: rotate(-5deg) translate(-4px, 3px);
    }
    .pile-top {
      position: relative;
      z-index: 1;
    }

    .opp-fan {
      position: absolute;
      top: 0;
      left: 50%;
      display: flex;
      transform: translateX(-50%);
      pointer-events: none;
    }
    .opp-card {
      --d: calc(var(--i) - (var(--n) - 1) / 2);
      width: calc(var(--card-w) * 0.62);
      margin: 0 -10px;
      transform: translateY(calc(-52% - var(--d) * var(--d) * 3px)) rotate(calc(var(--d) * -7deg));
    }

    .middle {
      position: absolute;
      inset: var(--top) 24px var(--bottom);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 28px;
    }
    .board-wrap {
      grid-column: 2;
      grid-row: 1;
      width: min(calc(100dvh - var(--top) - var(--bottom) - 16px), 50vw);
      max-width: none;
    }
    .left {
      grid-column: 1;
      grid-row: 1;
      justify-self: end;
      align-self: center;
      display: flex;
      flex-direction: column;
      gap: 14px;
      width: min(100%, 300px);
      max-height: 100%;
      min-height: 0;
    }
    .rules,
    .side-log {
      flex-direction: column;
      align-items: flex-start;
      padding: 12px;
      border: 2px solid var(--ink);
      border-radius: 14px;
      background: var(--card);
      box-shadow: 3px 3px 0 var(--shadow);
    }
    .side-log {
      display: flex;
      gap: 4px;
      min-height: 0;
      overflow: hidden;
    }
    .side-log .log {
      width: 100%;
    }
    .side-log .log li {
      font-size: 13.5px;
    }
    .side-log .log-row {
      padding: 5px 2px;
    }
    .wide-label {
      display: block;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .right {
      grid-column: 3;
      grid-row: 1;
      justify-self: start;
      align-self: stretch;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 14px;
      width: min(100%, 320px);
      min-height: 0;
    }
    .side-chat {
      display: flex;
      flex-direction: column;
      flex: 0 1 460px;
      min-height: 0;
      padding: 12px;
      border: 2px solid var(--ink);
      border-radius: 14px;
      background: var(--card);
      box-shadow: 3px 3px 0 var(--shadow);
    }
    .bar {
      flex: none;
      flex-direction: column;
      align-items: stretch;
      padding: 14px;
      border-radius: 14px;
      box-shadow: 3px 3px 0 var(--shadow);
    }
    .turn-btns {
      justify-content: stretch;
    }
    .turn-btns .btn {
      flex: 1 1 auto;
    }
    .bar .last {
      white-space: normal;
    }

    /* sa main : un éventail qui dépasse du bas de l'écran */
    .hand {
      position: absolute;
      bottom: 0;
      left: 50%;
      z-index: 6;
      display: flex;
      padding: 0;
      transform: translateX(-50%);
    }
    .slot {
      --d: calc(var(--i) - (var(--n) - 1) / 2);
      width: var(--card-w);
      margin: 0 -12px;
      transform-origin: 50% 100%;
      transform: translateY(calc(8% + var(--d) * var(--d) * 5px)) rotate(calc(var(--d) * 6deg));
      transition: transform 180ms ease;
    }
    .slot:focus-within,
    .slot:hover {
      z-index: 2;
      transform: translateY(-2%) rotate(0deg) scale(1.3);
    }
    .toast-layer {
      bottom: calc(var(--bottom) + 24px);
    }
    @media (prefers-reduced-motion: reduce) {
      .slot {
        transition: none;
      }
    }
  }

  .handoff {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px))
      max(16px, env(safe-area-inset-left, 0px));
    background: var(--paper);
  }
  .handoff-card {
    display: grid;
    gap: 12px;
    justify-items: center;
    width: min(100%, 420px);
    text-align: center;
  }
  .handoff-card h2 {
    margin: 0;
    font-family: var(--font-comic);
    font-weight: 400;
    font-size: 1.8rem;
  }
  .handoff-king {
    width: 72px;
    height: 72px;
  }
  .handoff-news {
    margin: 0;
    padding: 10px 14px 10px 30px;
    max-height: 40vh;
    overflow: auto;
    text-align: left;
    background: var(--card);
    border: 2px solid var(--ink);
    border-radius: 12px;
  }
  .duel {
    display: grid;
    gap: 12px;
    justify-items: center;
    text-align: center;
  }
  .duel-score {
    display: flex;
    gap: 24px;
    font-family: var(--font-comic);
    font-size: 1.3rem;
  }
  .duel-score b {
    font-size: 1.8rem;
  }
  .duel-last {
    margin: 0;
    font-size: 1.05rem;
  }
  .throws {
    display: flex;
    gap: 10px;
  }
  .throw {
    display: grid;
    justify-items: center;
    gap: 4px;
    min-width: 84px;
    padding: 10px 8px;
    border: 2.5px solid var(--ink);
    border-radius: 14px;
    background: var(--card);
    font: inherit;
    text-transform: capitalize;
    cursor: pointer;
    box-shadow: 0 3px 0 var(--shadow);
  }
  .throw span {
    font-size: 2rem;
  }
  .throw:active {
    transform: translateY(2px);
    box-shadow: 0 1px 0 var(--shadow);
  }
  .version {
    margin: 4px 0 0;
    font-size: 0.75rem;
    color: var(--muted);
    text-align: center;
  }
  .muted {
    color: var(--muted);
  }
  .toast-layer {
    position: fixed;
    left: 16px;
    right: 16px;
    bottom: calc(24px + env(safe-area-inset-bottom));
    z-index: 60;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  .toast {
    padding: 10px 16px;
    border: 2px solid var(--ink);
    border-radius: 12px;
    background: var(--toast-bg);
    color: var(--toast-fg);
    font-weight: 700;
  }
</style>
