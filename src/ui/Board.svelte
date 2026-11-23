<script lang="ts">
  import { fade, scale } from 'svelte/transition';
  import { fileOf, rankOf, type Board, type Sq } from '../core/position';
  import { track, type TrackedPiece } from '../lib/pieces';

  interface Props {
    board: Board;
    flipped: boolean;
    lastFrom?: Sq | null;
    lastTo?: Sq | null;
    selected?: Sq | null;
    dests?: Set<Sq>;
    targets?: Set<Sq>;
    /** Choix d'une direction depuis cette case : les cibles deviennent des flèches. */
    aimFrom?: Sq | null;
    path?: Sq[];
    marks?: Sq[];
    check?: Sq | null;
    preview?: boolean;
    /** Position passée (revoir la partie) : lecture seule, légèrement passée. */
    past?: boolean;
    /** Position avant l'aperçu d'une carte : sert à montrer ce qui bouge (flèches) et ce qui disparaît. */
    base?: Board | null;
    /** Pièce endormie (Planque). */
    sleeping?: Sq | null;
    onsquare?: (s: Sq) => void;
  }

  let {
    board,
    flipped,
    lastFrom = null,
    lastTo = null,
    selected = null,
    dests = new Set(),
    targets = new Set(),
    aimFrom = null,
    path = [],
    marks = [],
    check = null,
    preview = false,
    past = false,
    base = null,
    sleeping = null,
    onsquare,
  }: Props = $props();

  // l'identité des pièces est conservée d'une position à l'autre pour animer les mouvements
  let previous: TrackedPiece[] = [];
  const pieces = $derived.by(() => (previous = track(previous, board)));

  const col = (s: Sq) => (flipped ? 7 - fileOf(s) : fileOf(s));
  const row = (s: Sq) => (flipped ? rankOf(s) : 7 - rankOf(s));
  // cases dans l'ordre d'affichage (de haut en bas, de gauche à droite) ; retourné = rotation d'un demi-tour
  const squares = $derived(
    Array.from({ length: 64 }, (_, i) => {
      const normal = (7 - (i >> 3)) * 8 + (i & 7);
      return flipped ? 63 - normal : normal;
    }),
  );
  const markSet = $derived(new Set(marks));

  // choix d'une carte en cours : on met en avant les cases à toucher et celles déjà choisies
  const focus = $derived(targets.size > 0);
  const lit = (s: Sq) => targets.has(s) || path.includes(s);
  // que des pièces à toucher : on les encadre ; sinon ce sont des destinations (point, ou anneau si occupée)
  const picking = $derived(focus && [...targets].every((s) => !!board[s]));
  const targetClass = (s: Sq) => (picking ? 'pick' : board[s] ? 'aim' : 'spot');

  // aperçu : ce que la carte change (pièces déplacées, retirées, transformées)
  const same = (a: Board[number], b: Board[number]) => (!a && !b) || (!!a && !!b && a.c === b.c && a.t === b.t);
  const diff = $derived.by(() => {
    if (!preview || !base) return null;
    const removed: Sq[] = [];
    const added: Sq[] = [];
    for (let s = 0; s < 64; s++) {
      if (same(base[s], board[s])) continue;
      if (base[s]) removed.push(s);
      if (board[s]) added.push(s);
    }
    const dist = (a: Sq, b: Sq) => Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
    const arrows: { from: Sq; to: Sq }[] = [];
    const changed: Sq[] = [];
    const left = new Set(removed);
    for (const to of added) {
      // la même pièce, partie de la case la plus proche
      const from = [...left].filter((r) => same(base[r], board[to])).sort((a, b) => dist(a, to) - dist(b, to))[0];
      if (from === undefined) changed.push(to);
      else {
        arrows.push({ from, to });
        left.delete(from);
      }
    }
    // pièces disparues : fantôme barré si la case est vide, sinon la case est marquée « prise »
    const ghosts = [...left].filter((s) => !board[s]).map((s) => ({ sq: s, piece: base[s]! }));
    const taken = [...left].filter((s) => !!board[s]);
    return { arrows, changed: new Set(changed), ghosts, taken: new Set(taken) };
  });
  const center = (s: Sq) => ({ x: col(s) * 100 + 50, y: row(s) * 100 + 50 });

  // directions : flèche de la pièce vers la case voisine, puis la ligne visée jusqu'au bord
  let hovered = $state<Sq | null>(null);
  const aims = $derived.by(() => {
    if (aimFrom === null) return [];
    const o = center(aimFrom);
    return [...targets].map((t) => {
      const p = center(t);
      const dx = Math.sign(p.x - o.x);
      const dy = Math.sign(p.y - o.y);
      // dernière case de la ligne avant le bord
      let k = 0;
      while (p.x + (k + 1) * dx * 100 > 0 && p.x + (k + 1) * dx * 100 < 800 && p.y + (k + 1) * dy * 100 > 0 && p.y + (k + 1) * dy * 100 < 800) k++;
      return {
        sq: t,
        x1: o.x + dx * 26,
        y1: o.y + dy * 26,
        x2: p.x - dx * 14,
        y2: p.y - dy * 14,
        ray: k > 0 ? { x1: p.x + dx * 30, y1: p.y + dy * 30, x2: p.x + k * dx * 100 + dx * 40, y2: p.y + k * dy * 100 + dy * 40 } : null,
      };
    });
  });
  function arrowLine(from: Sq, to: Sq) {
    const a = center(from);
    const b = center(to);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // du centre de départ jusqu'avant la pièce d'arrivée (la pointe dépasse le bout du trait)
    const k0 = 0;
    const k1 = Math.max(0.3, (len - 50) / len);
    return { x1: a.x + (b.x - a.x) * k0, y1: a.y + (b.y - a.y) * k0, x2: a.x + (b.x - a.x) * k1, y2: a.y + (b.y - a.y) * k1 };
  }
</script>

<div class="board" class:preview class:focus class:past>
  {#each squares as s (s)}
    {@const light = (fileOf(s) + rankOf(s)) % 2 === 1}
    <button
      type="button"
      class="sq"
      class:light
      class:last={s === lastFrom || s === lastTo}
      class:selected={s === selected}
      class:path={path.includes(s)}
      class:mark={markSet.has(s)}
      class:check={s === check}
      class:lit={focus && lit(s)}
      class:taken={!!diff?.taken.has(s)}
      aria-label={'abcdefgh'[fileOf(s)] + (rankOf(s) + 1)}
      onclick={() => onsquare?.(s)}
      onpointerenter={() => (hovered = s)}
      onpointerleave={() => (hovered = hovered === s ? null : hovered)}
    >
      {#if row(s) === 7}<span class="coord file">{'abcdefgh'[fileOf(s)]}</span>{/if}
      {#if col(s) === 0}<span class="coord rank">{rankOf(s) + 1}</span>{/if}
      {#if dests.has(s)}<span class={board[s] ? 'ring' : 'dot'}></span>{/if}
      {#if targets.has(s) && aimFrom === null}<span class={targetClass(s)}></span>{/if}
      {#if !preview && path.includes(s)}<span class="step">{path.indexOf(s) + 1}</span>{/if}
    </button>
  {/each}

  <div class="pieces" aria-hidden="true">
    {#each pieces as p (p.id)}
      <div
        class="piece"
        class:faded={focus && !lit(p.sq)}
        class:changed={!!diff && (diff.changed.has(p.sq) || diff.arrows.some((a) => a.to === p.sq))}
        style:transform="translate({col(p.sq) * 100}%, {row(p.sq) * 100}%)"
        in:scale={{ duration: 250, start: 0.4 }}
        out:fade={{ duration: 220 }}
      >
        <img src="{import.meta.env.BASE_URL}pieces/{p.c}{p.t.toUpperCase()}.svg" alt="" draggable="false" />
        {#if p.sq === sleeping}<span class="zzz">z<small>z</small></span>{/if}
      </div>
    {/each}
    {#each diff?.ghosts ?? [] as g (g.sq)}
      <div class="piece ghost" style:transform="translate({col(g.sq) * 100}%, {row(g.sq) * 100}%)" in:fade={{ duration: 200 }}>
        <img src="{import.meta.env.BASE_URL}pieces/{g.piece.c}{g.piece.t.toUpperCase()}.svg" alt="" draggable="false" />
      </div>
    {/each}
  </div>

  {#if aims.length}
    <svg class="arrows aims" viewBox="0 0 800 800" aria-hidden="true">
      <defs>
        <marker id="aim-head" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="3" markerHeight="3" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)" />
        </marker>
      </defs>
      {#each aims as a (a.sq)}
        <g class="aim-dir" class:hot={hovered === a.sq}>
          {#if a.ray}<line class="ray" x1={a.ray.x1} y1={a.ray.y1} x2={a.ray.x2} y2={a.ray.y2} />{/if}
          <line class="shaft" x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} marker-end="url(#aim-head)" />
        </g>
      {/each}
    </svg>
  {/if}

  {#if diff?.arrows.length}
    <svg class="arrows" viewBox="0 0 800 800" aria-hidden="true">
      <defs>
        <marker id="arrow-head" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)" />
        </marker>
      </defs>
      {#each diff.arrows as a (a.from + '-' + a.to)}
        {@const l = arrowLine(a.from, a.to)}
        <line {...l} stroke="var(--accent)" stroke-width="14" stroke-linecap="round" marker-end="url(#arrow-head)" in:fade={{ duration: 200 }} />
      {/each}
    </svg>
  {/if}
</div>

<style>
  .board {
    position: relative;
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    width: 100%;
    aspect-ratio: 1;
    border: 3px solid var(--ink);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 4px 4px 0 var(--shadow);
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
  }
  .sq {
    position: relative;
    border: 0;
    padding: 0;
    margin: 0;
    background: var(--sq-dark);
    aspect-ratio: 1;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .sq.light {
    background: var(--sq-light);
  }
  .sq.last::before,
  .sq.selected::before,
  .sq.path::before,
  .sq.check::before,
  .sq.mark::before {
    content: '';
    position: absolute;
    inset: 0;
  }
  .sq.last::before {
    background: var(--hl-last);
  }
  .sq.selected::before {
    background: var(--hl-select);
  }
  .sq.path::before {
    background: var(--hl-card);
  }
  .sq.mark::before {
    background: var(--hl-mark);
    animation: flash 1.2s ease-out 1;
  }
  .sq.check::before {
    background: radial-gradient(circle, rgba(230, 40, 20, 0.85) 0%, rgba(230, 40, 20, 0.35) 45%, transparent 72%);
  }
  @keyframes flash {
    0% {
      background: rgba(214, 69, 47, 0.85);
    }
  }
  .coord {
    position: absolute;
    font-size: clamp(8px, 2.2vw, 11px);
    font-weight: 700;
    opacity: 0.7;
    color: var(--board-ink);
    pointer-events: none;
    z-index: 1;
  }
  .file {
    right: 3px;
    bottom: 1px;
  }
  .rank {
    left: 3px;
    top: 1px;
  }
  .dot {
    position: absolute;
    inset: 36%;
    border-radius: 50%;
    background: var(--hint);
    z-index: 3;
    pointer-events: none;
  }
  .ring {
    position: absolute;
    inset: 4%;
    border-radius: 50%;
    border: 5px solid var(--hint);
    z-index: 3;
    pointer-events: none;
  }
  /* choix d'une carte : pièce à toucher (cadre) ou case d'arrivée (point) */
  .pick {
    position: absolute;
    inset: 4%;
    border-radius: 18%;
    border: 3px solid var(--accent);
    box-shadow:
      0 0 0 2px rgba(255, 250, 240, 0.7),
      inset 0 0 12px rgba(214, 69, 47, 0.45);
    z-index: 3;
    pointer-events: none;
    animation: glow 1.1s ease-in-out infinite alternate;
  }
  .aim {
    position: absolute;
    inset: 5%;
    border-radius: 50%;
    border: 5px solid var(--accent);
    box-shadow: 0 0 0 2px rgba(255, 250, 240, 0.6);
    z-index: 3;
    pointer-events: none;
    animation: glow 1.1s ease-in-out infinite alternate;
  }
  .spot {
    position: absolute;
    inset: 33%;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px rgba(255, 250, 240, 0.65);
    z-index: 3;
    pointer-events: none;
    animation: breathe 1.1s ease-in-out infinite alternate;
  }
  @keyframes glow {
    to {
      opacity: 0.55;
    }
  }
  @keyframes breathe {
    to {
      transform: scale(0.75);
    }
  }
  /* le reste de l'échiquier s'efface pendant le choix */
  .focus .sq:not(.lit)::after {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(24, 18, 12, 0.3);
  }
  .step {
    position: absolute;
    top: 3%;
    left: 3%;
    z-index: 4;
    min-width: 34%;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: clamp(9px, 2.4vw, 13px);
    font-weight: 800;
    line-height: 1.5;
    text-align: center;
    pointer-events: none;
  }
  .sq.taken::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, transparent 52%, rgba(214, 69, 47, 0.6) 54%, rgba(214, 69, 47, 0.6) 64%, transparent 66%);
  }
  .pieces {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
  }
  .piece {
    position: absolute;
    width: 12.5%;
    height: 12.5%;
    top: 0;
    left: 0;
    transition: transform 260ms cubic-bezier(0.3, 0.9, 0.4, 1);
  }
  .zzz {
    position: absolute;
    top: 2%;
    right: 6%;
    font-family: var(--font-comic);
    font-size: clamp(10px, 2.6vw, 18px);
    line-height: 1;
    color: var(--board-ink);
    text-shadow: 0 0 3px #fffaf0;
  }
  .zzz small {
    font-size: 0.7em;
  }
  .piece img {
    width: 100%;
    height: 100%;
    display: block;
  }
  .past {
    filter: sepia(0.35) saturate(0.85);
  }
  .past .sq {
    cursor: default;
  }
  .piece.faded {
    opacity: 0.5;
  }
  .piece.changed {
    filter: drop-shadow(0 0 4px rgba(242, 182, 50, 1)) drop-shadow(0 0 2px rgba(242, 182, 50, 1));
  }
  .piece.ghost {
    opacity: 0.4;
    filter: grayscale(1);
  }
  .piece.ghost::after {
    content: '';
    position: absolute;
    inset: 22%;
    background:
      linear-gradient(45deg, transparent 45%, var(--accent) 45%, var(--accent) 55%, transparent 55%),
      linear-gradient(-45deg, transparent 45%, var(--accent) 45%, var(--accent) 55%, transparent 55%);
  }
  .arrows {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 3;
    pointer-events: none;
    opacity: 0.85;
  }
  .aims {
    opacity: 1;
  }
  .aim-dir {
    opacity: 0.75;
    transition: opacity 120ms;
  }
  .aim-dir.hot {
    opacity: 1;
  }
  .aim-dir .shaft {
    stroke: var(--accent);
    stroke-width: 13;
    stroke-linecap: round;
  }
  .aim-dir .ray {
    stroke: var(--accent);
    stroke-width: 6;
    stroke-linecap: round;
    stroke-dasharray: 4 18;
    opacity: 0.35;
    transition: opacity 120ms;
  }
  .aim-dir.hot .ray {
    opacity: 0.9;
  }
  @media (prefers-reduced-motion: reduce) {
    .piece {
      transition: none;
    }
    .pick,
    .aim,
    .spot {
      animation: none;
    }
  }
</style>
