// Orchestration d'une partie : état, tours de l'ordinateur, sélection des cartes
// et sauvegarde locale. Deux modes :
// - « bot »   : un humain contre l'ordinateur ;
// - « local » : deux humains sur le même appareil, à tour de rôle. L'écran montre toujours le
//   point de vue du joueur qui doit agir, et un écran de passage cache sa main au changement.
// - « online » : deux appareils, via le serveur de parties (online.ts). L'adversaire prend la
//   place de l'ordinateur : ses actions arrivent du réseau au lieu d'être calculées.

import { BOT_LEVELS, decide, duelThrow, type BotLevel } from '../core/bot';
import { CARD_BY_ID, isDead, type CardOption } from '../core/cards';
import type { NormalMove } from '../core/chess';
import { actor, apply, canDiscard, canSkip, cardOptions, choiceStep, clashingRules, mustAct, newGame, normalMoves, playableCards, resign, type Action, type GameState, type Throw } from '../core/game';
import { CARD_PIECE_DELAY, play as playSound } from './sound';
import { inCheck, kingSq, toFen, type Color, type PieceType, type Sq } from '../core/position';
import { createRoom, joinRoom, openRoom, type ChatMessage, type NetAction, type NetEntry, type Room, type RoomMeta } from './online';
import type { Engine } from '../engine/engine';
import { StockfishEngine } from '../engine/stockfish';

const SAVE_KEY = 'tempete2.partie';
/** Rechargement pour une nouvelle version en pleine partie : la reprendre aussitôt (cf. main.ts). */
export const RESUME_KEY = 'tempete2.reprendre';
const PREFS_KEY = 'tempete2.prefs';
/** En ligne : heure du dernier message lu, par partie (`tempete2.chat.<CODE>`). */
const CHAT_READ_KEY = 'tempete2.chat.';

export interface Reveal {
  card: string;
  summary: string;
  color: Color;
  /** Cartes dont l'effet en cours prend fin (règles contraires). */
  ends: string[];
}

export interface CardSelection {
  card: string;
  options: CardOption[];
  path: Sq[];
  chosen: CardOption | null;
  /** Choix imposé par une carte en cours (pas d'annulation possible). */
  forced?: boolean;
  prompt?: string;
}

export type Mode = 'bot' | 'local' | 'online';

/** Partie en ligne en cours : son code, et où en est l'adversaire. */
export interface OnlineState {
  code: string;
  /** L'adversaire n'a pas encore rejoint la partie. */
  waiting: boolean;
  /** L'adversaire a l'appli ouverte sur la partie. */
  here: boolean;
  /** Une action envoyée attend la confirmation du serveur. */
  sending: boolean;
  /** Les deux appareils ne voient plus la même partie (versions différentes ?). */
  broken: string | null;
}

/** Une ligne du chat, telle qu'affichée. */
export interface ChatLine {
  id: string;
  mine: boolean;
  t: number;
  text: string;
}

/** Applique une action du journal en ligne (l'abandon n'est pas une action du réducteur). */
function step(g: GameState, a: NetAction): GameState {
  return a.type === 'resign' ? resign(g, a.color) : apply(g, a);
}

export interface Prefs {
  color: Color | 'random';
  level: string;
  sound?: boolean;
  /** Contre l'ordinateur (par défaut) ou à deux sur le même appareil. */
  mode?: Mode;
  /** Thème de l'affichage : celui du système (par défaut), clair ou sombre. */
  theme?: Theme;
}

export type Theme = 'auto' | 'light' | 'dark';
export const THEME_LABEL: Record<Theme, string> = { auto: 'automatique', light: 'clair', dark: 'sombre' };

/** Applique le thème à la page (attribut data-theme sur <html>, couleur de la barre du navigateur). */
export function applyTheme(theme: Theme = 'auto') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1714' : '#f2b632');
}

/** Écran de passage entre deux joueurs, avec ce que l'adversaire a fait entre-temps. */
export interface Handoff {
  color: Color;
  news: string[];
}

const COLOR_NAME: Record<Color, string> = { w: 'Blancs', b: 'Noirs' };
const BUILD = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.split(' ')[0] : 'dev';

interface Save {
  game?: GameState;
  human: Color;
  level: string;
  mode?: Mode;
  seen?: Record<Color, number>;
  /** En ligne : la partie se recharge depuis le serveur, on ne garde que son code. */
  code?: string;
}

function storage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function store(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : tant pis */
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GameController {
  game = $state.raw<GameState | null>(null);
  mode = $state<Mode>('bot');
  /** Contre l'ordinateur : la place de l'humain. À deux : sans objet (cf. `color`). */
  human = $state<Color>('w');
  /** Revoir la partie : index dans l'historique de l'entrée affichée (null = position actuelle). */
  review = $state<number | null>(null);
  /** À deux : passage de l'appareil en cours (la main du joueur précédent est cachée). */
  handoff = $state<Handoff | null>(null);
  level = $state<BotLevel>(BOT_LEVELS[1]);
  thinking = $state(false);
  reveal = $state<Reveal | null>(null);
  /** Issue d'un duel qui vient de se terminer (affichée jusqu'à ce que le joueur la touche). */
  duelResult = $state<GameState['lastDuel']>(null);
  toast = $state<string | null>(null);
  online = $state<OnlineState | null>(null);
  /** En ligne : messages du chat, combien de l'adversaire ne sont pas lus, et le dernier reçu (affiché un instant). */
  chat = $state<ChatLine[]>([]);
  chatOpen = $state(false);
  /** Grand écran : le chat est affiché en permanence à côté de l'échiquier. */
  chatDocked = $state(false);
  unread = $state(0);
  bubble = $state<ChatLine | null>(null);

  /** Case sélectionnée pour un coup normal. */
  selected = $state<Sq | null>(null);
  promotion = $state<{ from: Sq; to: Sq } | null>(null);
  selection = $state<CardSelection | null>(null);

  prefs = $state<Prefs>(storage<Prefs>(PREFS_KEY) ?? { color: 'w', level: 'moyen' });

  private engine: Engine | null = null;
  private token = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Heure du dernier message lu (les messages plus anciens ne sont plus « nouveaux »). */
  private readUpTo = 0;
  private revealDone: (() => void) | null = null;
  private duelDone: (() => void) | null = null;
  /** À deux : joueur qui avait l'appareil, et nombre d'entrées d'historique déjà vues par chacun. */
  private viewer: Color = 'w';
  private seen: Record<Color, number> = { w: 0, b: 0 };
  /** En ligne : la partie ouverte, les entrées du journal déjà appliquées et celles en attente. */
  private room: Room | null = null;
  private applied = 0;
  private inbox: NetEntry[] = [];
  private pumping = false;
  /** Action refusée parce qu'une autre a pris sa place dans le journal (duel) : à renvoyer. */
  private retry: NetAction | null = null;
  /** Attentes de la fin d'un affichage (carte adverse, issue de duel). */
  private clearWaiters: (() => void)[] = [];

  /**
   * Couleur dont l'écran montre le point de vue. Contre l'ordinateur : celle de l'humain (l'inverse
   * de sa place pendant Double jeu). À deux : celle du joueur qui doit agir maintenant.
   */
  get color(): Color {
    const g = this.game;
    if (this.mode === 'local') {
      if (!g || g.phase === 'over') return this.viewer;
      if (g.phase === 'duel') return mustAct(g, 'w') ? 'w' : mustAct(g, 'b') ? 'b' : this.viewer;
      return actor(g);
    }
    return g?.swap ? (this.human === 'w' ? 'b' : 'w') : this.human;
  }

  /** La couleur d'en face (l'ordinateur, ou l'autre joueur). */
  get bot(): Color {
    return this.color === 'w' ? 'b' : 'w';
  }

  /** Comment désigner l'adversaire dans les messages (« l'ordinateur », « les Noirs »…). */
  get opponent(): string {
    return this.mode === 'local' ? `les ${COLOR_NAME[this.bot]}` : this.mode === 'online' ? "l'adversaire" : "l'ordinateur";
  }

  colorName(c: Color): string {
    return COLOR_NAME[c];
  }

  /** Est-ce au joueur humain d'agir (son tour, ou une réaction au coup adverse) ? Hors duel. */
  get myTurn(): boolean {
    const g = this.game;
    return !!g && !this.reveal && !this.duelResult && !this.handoff && this.onlineReady && g.phase !== 'over' && g.phase !== 'duel' && actor(g) === this.color;
  }

  /** En ligne : l'adversaire est là et rien n'est en cours d'envoi (toujours vrai hors ligne). */
  get onlineReady(): boolean {
    const o = this.online;
    return !o || (!o.waiting && !o.sending && !o.broken);
  }

  // ---------- cycle de vie ----------

  hasSave(): boolean {
    return !!storage(SAVE_KEY);
  }

  start(prefs: Prefs) {
    this.leaveRoom();
    this.prefs = prefs;
    store(PREFS_KEY, prefs);
    this.mode = prefs.mode ?? 'bot';
    this.human = prefs.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : prefs.color;
    this.level = BOT_LEVELS.find((l) => l.id === prefs.level) ?? BOT_LEVELS[1];
    this.reset(newGame(Math.floor(Math.random() * 2 ** 31)));
  }

  /** Reprend la partie sauvegardée (en ligne : la recharge depuis le serveur, ce qui peut échouer). */
  async resume(): Promise<boolean> {
    const save = storage<Save>(SAVE_KEY);
    if (!save) return false;
    if (save.mode === 'online') {
      if (!save.code) return false;
      await this.enterRoom(save.code);
      return true;
    }
    if (!save.game) return false;
    this.leaveRoom();
    this.mode = save.mode ?? 'bot';
    this.human = save.human;
    this.level = BOT_LEVELS.find((l) => l.id === save.level) ?? BOT_LEVELS[1];
    this.reset(save.game, save.seen);
    return true;
  }

  quit() {
    this.leaveRoom();
    this.token++;
    this.game = null;
    this.thinking = false;
    this.reveal = null;
    this.handoff = null;
  }

  private reset(g: GameState, seen?: Record<Color, number>) {
    this.review = null;
    this.token++;
    this.thinking = false;
    this.reveal = null;
    this.duelResult = null;
    this.selected = null;
    this.selection = null;
    this.promotion = null;
    this.handoff = null;
    this.game = g;
    this.seen = seen ?? { w: g.log.length, b: g.log.length };
    // à deux : on (re)commence toujours par l'écran de passage, pour ne montrer aucune main par surprise
    if (this.mode === 'local') {
      this.viewer = this.color;
      this.askHandoff();
    }
    this.syncChoice();
    if (this.mode === 'bot') this.engine ??= new StockfishEngine();
    this.save();
    void this.botLoop();
  }

  private save() {
    const g = this.game;
    if (!g) return;
    if (g.phase === 'over') store(SAVE_KEY, null);
    else if (this.mode === 'online') store(SAVE_KEY, { human: this.human, level: this.level.id, mode: 'online', code: this.online?.code } satisfies Save);
    else store(SAVE_KEY, { game: g, human: this.human, level: this.level.id, mode: this.mode, seen: this.seen } satisfies Save);
  }

  /** À deux : le joueur qui doit agir change, on cache l'écran jusqu'à ce qu'il prenne l'appareil. */
  private askHandoff() {
    this.review = null;
    const g = this.game!;
    const c = this.color;
    // (à deux, tout se raisonne par couleur jouée : ce qu'a fait l'autre couleur depuis mon dernier passage)
    const news = g.log.slice(this.seen[c]).filter((e) => e.color !== c).map((e) => e.text);
    this.handoff = { color: c, news };
  }

  /** À deux : le joueur a pris l'appareil. */
  takeOver() {
    const h = this.handoff;
    if (!h || !this.game) return;
    this.seen = { ...this.seen, [h.color]: this.game.log.length };
    this.handoff = null;
    this.save();
  }

  private commit(next: GameState) {
    const prev = this.game;
    this.game = next;
    if (prev?.phase === 'duel' && next.phase !== 'duel' && next.lastDuel) this.duelResult = next.lastDuel;
    if (prev && next.log.length > prev.log.length && this.prefs.sound !== false) {
      const entry = next.log[next.log.length - 1];
      const count = (g: GameState) => g.pos.board.filter(Boolean).length;
      const piece = count(next) < count(prev) ? 'capture' : 'move';
      if (entry.card) {
        playSound('card');
        // la carte a bougé ou pris des pièces : on l'entend aussi
        const moved = next.pos.board.some((p, i) => p?.c !== prev.pos.board[i]?.c || p?.t !== prev.pos.board[i]?.t);
        if (moved) playSound(piece, CARD_PIECE_DELAY);
      } else playSound(piece);
    }
    // en ligne : un carillon quand la main revient au joueur (son tour, ou une réaction possible)
    if (this.mode === 'online' && prev && this.prefs.sound !== false && next.phase !== 'over' && next.phase !== 'duel') {
      const mine = (g: GameState) => g.phase !== 'over' && g.phase !== 'duel' && actor(g) === (g.swap ? (this.human === 'w' ? 'b' : 'w') : this.human); // (Double jeu : couleurs échangées)
      if (!mine(prev) && mine(next)) playSound('turn', 0.25);
    }
    // événements à signaler (fin d'une règle, Voyance qui se réalise…)
    if (prev) for (const e of next.log.slice(prev.log.length)) if (e.notice) this.notify(e.text);
    this.selected = null;
    if (this.mode === 'local') {
      // ce que le joueur actuel vient de faire, il l'a vu
      this.seen = { ...this.seen, [this.viewer]: next.log.length };
      if (next.phase !== 'over' && this.color !== this.viewer) {
        this.viewer = this.color;
        this.askHandoff();
      }
    }
    this.syncChoice();
    this.save();
  }

  /** Un choix imposé par une carte m'attend : on ouvre directement la sélection. */
  private syncChoice() {
    const g = this.game;
    const step = g ? choiceStep(g) : null;
    if (!g || !step || step.chooser !== this.color) {
      if (this.selection?.forced) this.selection = null;
      return;
    }
    if (this.selection?.forced) return;
    this.selection = { card: g.choice!.card, options: step.options, path: [], chosen: null, forced: true, prompt: step.prompt };
    this.autoChoose();
  }

  notify(msg: string) {
    this.toast = msg;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 2600);
  }

  // ---------- ordinateur ----------

  private async botLoop() {
    if (this.mode !== 'bot') return;
    const token = this.token;
    while (this.game && mustAct(this.game, this.bot)) {
      if (this.duelResult) {
        // on laisse le joueur voir l'issue du duel avant de continuer
        await new Promise<void>((r) => (this.duelDone = r));
        if (token !== this.token) return;
        continue;
      }
      this.thinking = true;
      const started = performance.now();
      let action: Action;
      try {
        action = this.game.phase === 'duel' ? duelThrow(this.bot) : await decide(this.game, this.engine!, this.level);
      } catch (e) {
        console.error(e);
        this.thinking = false;
        this.notify("L'ordinateur a eu un souci… réessayez.");
        return;
      }
      if (token !== this.token) return;
      // un minimum de suspense, pour qu'on voie l'ordinateur « réfléchir »
      const elapsed = performance.now() - started;
      // (pas de pause pour la fin de tour, l'absence de réaction ou une manche de duel)
      const quick = action.type === 'endTurn' || action.type === 'pass' || action.type === 'duel';
      if (!quick && elapsed < 650) await wait(650 - elapsed);
      if (token !== this.token) return;

      const prev = this.game;
      const next = apply(prev, action);
      this.thinking = false;
      this.commit(next);
      const reveal = this.presentOpponent(action, prev, next);
      if (reveal) {
        await this.showReveal(reveal);
        if (token !== this.token) return;
      }
    }
    this.thinking = false;
  }

  /** Montre au joueur ce que l'adversaire vient de faire ; renvoie la carte à dévoiler, s'il y en a une. */
  private presentOpponent(action: NetAction, prev: GameState, next: GameState): Reveal | null {
    const who = this.mode === 'online' ? "L'adversaire" : "L'ordinateur";
    if (action.type === 'discard') this.notify(`${who} défausse « ${CARD_BY_ID[action.card].title} »`);
    if (action.type === 'choose') this.notify(`${who} : ${next.log[next.log.length - 1].text.replace(/^[^:]+:\s*/, '')}`);
    if (action.type === 'resign') this.notify(`${who} abandonne`);
    if (action.type !== 'card') return null;
    const ends = clashingRules(prev, action.card);
    // carte en suspens (le joueur peut l'annuler) : pas encore dans l'historique
    const pending = next.pending?.card === action.card && !next.pending.counters.length ? next.pending : null;
    // (l'entrée de la carte elle-même : une règle qui prend fin s'inscrit après elle)
    const entry = next.log.findLast((e) => e.card === action.card) ?? next.log[next.log.length - 1];
    const summary = pending ? pending.option.summary : entry.text.replace(/^[^:]+:\s*/, '');
    return { card: action.card, summary, color: this.bot, ends };
  }

  private showReveal(r: Reveal): Promise<void> {
    this.reveal = r;
    // la carte reste affichée jusqu'à ce que le joueur la touche
    return new Promise((resolve) => (this.revealDone = resolve));
  }

  /** Attend qu'aucune carte adverse ni issue de duel ne soit plus affichée. */
  private async untilClear() {
    while (this.reveal || this.duelResult) await new Promise<void>((r) => this.clearWaiters.push(r));
  }

  private cleared() {
    const waiters = this.clearWaiters;
    this.clearWaiters = [];
    for (const w of waiters) w();
  }

  dismissDuel() {
    this.duelResult = null;
    const done = this.duelDone;
    this.duelDone = null;
    done?.();
    this.cleared();
  }

  dismissReveal() {
    this.reveal = null;
    const done = this.revealDone;
    this.revealDone = null;
    done?.();
    this.cleared();
  }

  // ---------- actions humaines ----------

  private act(action: Action) {
    if (!this.game) return;
    if (this.mode === 'online') return void this.send(action);
    let next: GameState;
    try {
      next = apply(this.game, action);
    } catch (e) {
      this.notify(e instanceof Error ? e.message : 'Action impossible');
      return;
    }
    this.selection = null;
    this.commit(next);
    void this.botLoop();
  }

  /** Coups légaux du joueur humain, par case de départ. */
  get moveMap(): Map<Sq, NormalMove[]> {
    const map = new Map<Sq, NormalMove[]>();
    if (!this.game || !this.myTurn || this.game.phase !== 'main') return map;
    for (const m of normalMoves(this.game)) {
      if (!map.has(m.from)) map.set(m.from, []);
      map.get(m.from)!.push(m);
    }
    return map;
  }

  tapSquare(s: Sq, moveMap: Map<Sq, NormalMove[]>) {
    if (!this.game || !this.myTurn || this.review !== null) return;
    if (this.selection) return this.tapCardSquare(s);
    if (this.game.phase !== 'main') return;

    if (this.selected !== null) {
      const move = moveMap.get(this.selected)?.find((m) => m.to === s);
      if (move) {
        if (move.promotion) this.promotion = { from: move.from, to: move.to };
        else this.act({ type: 'move', from: move.from, to: move.to });
        return;
      }
    }
    if (moveMap.has(s)) this.selected = this.selected === s ? null : s;
    else this.selected = null;
  }

  promote(t: PieceType | null) {
    const p = this.promotion;
    this.promotion = null;
    if (p && t) this.act({ type: 'move', from: p.from, to: p.to, promotion: t });
  }

  endTurn() {
    this.act({ type: 'endTurn' });
  }

  /** Je passe (en réserve) : rejouer un coup. */
  replay() {
    this.act({ type: 'replay' });
  }

  /** Provocation : passer son tour plutôt que de prendre. */
  skip() {
    this.act({ type: 'skip' });
  }

  /** Ne pas réagir au coup de l'ordinateur, ou ne pas annuler sa carte. */
  passReaction() {
    this.selection = null;
    this.act({ type: 'pass' });
  }

  throwDuel(t: Throw) {
    if (this.game?.phase === 'duel' && mustAct(this.game, this.color)) this.act({ type: 'duel', color: this.color, throw: t });
  }

  resign() {
    if (!this.game) return;
    if (this.mode === 'online') return void this.send({ type: 'resign', color: this.human });
    this.token++;
    // à deux, c'est le joueur qui tient l'appareil qui abandonne (sa place : sans Double jeu)
    const seat = this.mode === 'local' ? (this.game.swap ? (this.color === 'w' ? 'b' : 'w') : this.color) : this.human;
    this.commit(resign(this.game, seat));
  }

  // ---------- en ligne ----------

  /** Mémorise les choix de l'accueil sans lancer de partie. */
  setPrefs(prefs: Prefs) {
    this.prefs = prefs;
    store(PREFS_KEY, prefs);
  }

  /** Crée une partie en ligne et l'ouvre : l'adversaire la rejoindra avec son code. */
  async createOnline(color: Color | 'random') {
    const seat = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    const code = await createRoom(seat, Math.floor(Math.random() * 2 ** 31), BUILD);
    await this.enterRoom(code);
  }

  /** Rejoint une partie en ligne (ou y revient), d'après son code. */
  async joinOnline(code: string) {
    await this.enterRoom(code);
  }

  private async enterRoom(code: string) {
    const { meta, seat } = await joinRoom(code);
    this.leaveRoom();
    // ce qui arrive avant que la partie soit prête est mis de côté, puis traité dans l'ordre
    let ready = false;
    let opened: Room | null = null;
    const early: NetEntry[] = [];
    const earlyChat: ChatMessage[] = [];
    let latest: { meta: RoomMeta; here: boolean } = { meta, here: false };
    const live = () => ready && this.room === opened && !!this.online;
    const { room, history } = await openRoom(code, {
      entry: (_, e) => {
        if (!ready) early.push(e);
        else if (live()) {
          this.inbox.push(e);
          void this.pump();
        }
      },
      meta: (m) => {
        latest = { ...latest, meta: m };
        if (live()) this.online = { ...this.online!, waiting: !m.guest };
      },
      presence: (here) => {
        latest = { ...latest, here };
        if (live()) this.online = { ...this.online!, here };
      },
      chat: (m) => {
        if (!ready) earlyChat.push(m);
        else if (live()) this.hear(m);
      },
      unchat: (id) => {
        const i = earlyChat.findIndex((m) => m.id === id);
        if (i >= 0) earlyChat.splice(i, 1);
        if (live()) this.chat = this.chat.filter((l) => l.id !== id);
      },
    });
    opened = room;
    // la partie est recalculée en rejouant le journal depuis la graine
    let g = newGame(meta.seed);
    for (const e of history) g = step(g, e.action);
    this.room = room;
    this.applied = history.length;
    this.retry = null;
    this.mode = 'online';
    this.human = seat;
    this.reset(g);
    this.online = { code, waiting: !latest.meta.guest, here: latest.here, sending: false, broken: null };
    this.inbox = early;
    // le chat déjà échangé : n'est « non lu » que ce qui est arrivé depuis la dernière lecture
    this.readUpTo = storage<number>(CHAT_READ_KEY + code) ?? 0;
    this.chat = earlyChat.map((m) => this.line(m));
    this.unread = this.chat.filter((l) => !l.mine && l.t > this.readUpTo).length;
    ready = true;
    if (meta.build !== BUILD) this.notify('Attention : l’adversaire n’a peut-être pas la même version de l’appli.');
    this.save();
    void this.pump();
  }

  private leaveRoom() {
    this.room?.close();
    this.room = null;
    this.online = null;
    this.inbox = [];
    this.retry = null;
    this.clearWaiters = [];
    this.chat = [];
    this.chatOpen = false;
    this.unread = 0;
    this.bubble = null;
  }

  // ---------- chat (en ligne) ----------

  private line(m: ChatMessage): ChatLine {
    return { id: m.id, mine: m.by === this.room?.uid, t: m.t, text: m.text };
  }

  /** Un message vient d'arriver. */
  private hear(m: ChatMessage) {
    if (this.chat.some((l) => l.id === m.id)) return;
    const l = this.line(m);
    this.chat = [...this.chat, l];
    // (les messages déjà échangés peuvent arriver après l'ouverture de la partie)
    if (l.mine || l.t <= this.readUpTo) return;
    if (this.chatOpen || this.chatDocked) return this.markRead();
    this.unread++;
    this.bubble = l;
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => (this.bubble = null), 5000);
  }

  private markRead() {
    this.unread = 0;
    const last = this.chat.at(-1);
    if (!last || !this.online || last.t <= this.readUpTo) return;
    this.readUpTo = last.t;
    store(CHAT_READ_KEY + this.online.code, last.t);
  }

  openChat() {
    this.chatOpen = true;
    this.bubble = null;
    this.markRead();
  }

  closeChat() {
    this.chatOpen = false;
  }

  /** Le chat s'affiche (ou plus) à côté de l'échiquier, selon la taille de l'écran. */
  dockChat(docked: boolean) {
    this.chatDocked = docked;
    if (!docked) return;
    this.chatOpen = false;
    this.bubble = null;
    this.markRead();
  }

  /** Envoie un message à l'adversaire ; vrai s'il est parti. */
  async say(text: string): Promise<boolean> {
    const msg = text.trim();
    const room = this.room;
    if (!msg || !room) return false;
    try {
      await room.say(msg);
      return true;
    } catch (e) {
      console.error(e);
      this.notify('Message non envoyé : vérifiez la connexion.');
      return false;
    }
  }

  /** Envoie une action au journal ; elle ne s'applique qu'une fois revenue du serveur, chez les deux joueurs. */
  private async send(action: NetAction) {
    const g = this.game;
    const room = this.room;
    if (!g || !room || !this.online) return;
    let next: GameState;
    try {
      next = step(g, action);
    } catch (e) {
      this.notify(e instanceof Error ? e.message : 'Action impossible');
      return;
    }
    this.selection = null;
    this.selected = null;
    this.online = { ...this.online, sending: true };
    const index = this.applied;
    let ok: boolean;
    try {
      ok = await room.send(index, { by: room.uid, action, fen: toFen(next.pos) });
    } catch (e) {
      console.error(e);
      if (this.room === room && this.online) this.online = { ...this.online, sending: false };
      this.notify('Envoi impossible : vérifiez la connexion et réessayez.');
      return;
    }
    // place déjà prise (l'adversaire a écrit au même moment) : on renverra après son action
    if (!ok && this.room === room) {
      this.retry = action;
      // (son action a peut-être déjà été appliquée)
      if (this.applied > index && !this.pumping) this.flushRetry();
    }
  }

  /** Renvoie l'action refusée faute de place, si elle tient toujours. */
  private flushRetry() {
    const a = this.retry;
    if (!a || !this.game || !this.online) return;
    this.retry = null;
    try {
      step(this.game, a);
    } catch {
      this.online = { ...this.online, sending: false };
      return;
    }
    void this.send(a);
  }

  /** Applique, dans l'ordre, les entrées du journal reçues (en laissant au joueur le temps de voir). */
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const room = this.room;
    try {
      while (this.room === room && this.inbox.length) {
        await this.untilClear();
        if (this.room !== room || !this.game || !this.online) return;
        const e = this.inbox.shift()!;
        const prev = this.game;
        let next: GameState;
        try {
          next = step(prev, e.action);
        } catch (err) {
          console.error(err, e);
          next = prev;
        }
        if (next === prev || toFen(next.pos) !== e.fen) {
          this.online = { ...this.online, broken: 'Les deux appareils ne voient plus la même partie. Mettez l’appli à jour des deux côtés (rechargez la page), puis reprenez la partie.' };
          return;
        }
        this.applied++;
        const mine = e.by === room!.uid;
        if (mine) this.online = { ...this.online, sending: false };
        this.commit(next);
        const reveal = mine ? null : this.presentOpponent(e.action, prev, next);
        if (reveal) this.reveal = reveal;
        if (!this.inbox.length) this.flushRetry();
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---------- cartes ----------

  /** Titres des effets en cours auxquels cette carte mettrait fin si on la jouait. */
  ends(id: string): string[] {
    return this.game ? clashingRules(this.game, id).map((r) => CARD_BY_ID[r].title) : [];
  }

  /** Pourquoi une carte de la main n'est pas jouable maintenant (ou null si elle l'est). */
  whyNot(card: string): string | null {
    const g = this.game;
    if (!g) return '…';
    if (g.phase === 'over') return 'La partie est terminée';
    const t = CARD_BY_ID[card].timing;
    if (g.phase === 'duel') return 'Un duel est en cours';
    if (g.phase === 'choice') return 'Un choix est en cours';
    if ((g.rules ?? []).some((r) => r.card === 'origines')) return 'Origines : aucune carte tant qu’aucun Roi n’a été mis en échec';
    if (actor(g) !== this.color) return t === 'reaction' ? 'Se joue juste après un coup adverse' : 'Attendez votre tour';
    if (g.phase === 'counter') {
      if (t !== 'counter') return 'Seuls Non et Niet peuvent répondre à une carte';
      return cardOptions(g, card).length ? null : 'Une seule carte par tour';
    }
    if (t === 'counter') return 'Se joue juste après une carte adverse';
    if (g.phase === 'reaction') {
      if (t !== 'reaction') return 'Se joue pendant votre tour';
      if (g.reacted) return 'Une seule carte pendant le tour adverse';
      return cardOptions(g, card).length ? null : 'Ne s’applique pas à ce coup';
    }
    if (t === 'reaction') return 'Se joue juste après un coup adverse';
    if (CARD_BY_ID[card].turnEffect === 'rebelote') {
      if (!g.cardPlayed) return 'Se joue après une première carte, à ce tour';
      if (g.rebelote || g.extra) return 'Une seule fois par tour';
    } else if (g.cardPlayed && !g.extra) return 'Une seule carte par tour';
    if (isDead(card, g.pos, g.active)) {
      return g.phase === 'main'
        ? 'Cette carte ne peut plus servir dans cette partie. Vous pourrez la défausser après votre coup.'
        : 'Cette carte ne peut plus servir dans cette partie';
    }
    if (t === 'replace' && canSkip(g)) return 'Provocation : prenez une pièce ou passez votre tour';
    if (g.phase === 'main' && t === 'after') return 'Se joue après votre coup';
    if (g.phase === 'after' && (t === 'replace' || t === 'before')) return 'Se joue avant votre coup';
    if (!cardOptions(g, card).length) return 'Aucune cible possible pour le moment';
    return null;
  }

  /** Carte morte encore défaussable ce tour-ci (maintenant ou après le coup). */
  isDead(card: string): boolean {
    const g = this.game;
    return !!g && this.myTurn && (g.phase === 'main' || g.phase === 'after') && !g.cardPlayed && isDead(card, g.pos, g.active);
  }

  canDiscard(card: string): boolean {
    return !!this.game && this.myTurn && canDiscard(this.game, card);
  }

  discard(card: string) {
    this.selection = null;
    this.act({ type: 'discard', card });
  }

  /** Thème suivant : automatique → clair → sombre → automatique. */
  cycleTheme() {
    const order: Theme[] = ['auto', 'light', 'dark'];
    const theme = order[(order.indexOf(this.prefs.theme ?? 'auto') + 1) % order.length];
    this.prefs = { ...this.prefs, theme };
    store(PREFS_KEY, this.prefs);
    applyTheme(theme);
  }

  toggleSound() {
    this.prefs = { ...this.prefs, sound: this.prefs.sound === false };
    store(PREFS_KEY, this.prefs);
  }

  playable(): string[] {
    return this.game && this.myTurn ? playableCards(this.game) : [];
  }

  // ---------- revoir la partie (lecture seule) ----------

  /** Entrées de l'historique qu'on peut revoir (celles qui ont enregistré leur position). */
  reviewable(): number[] {
    return (this.game?.log ?? []).flatMap((e, i) => (e.fen ? [i] : []));
  }

  /** Revoir la position après l'entrée `i` de l'historique (par défaut : la dernière). */
  startReview(i?: number) {
    const list = this.reviewable();
    if (!list.length) return;
    this.review = i !== undefined && list.includes(i) ? i : list[list.length - 1];
    this.selected = null;
  }

  /** Entrée précédente (-1) ou suivante (+1) ; au-delà de la dernière, on revient à la partie. */
  stepReview(d: -1 | 1) {
    const list = this.reviewable();
    if (this.review === null) return;
    const k = list.indexOf(this.review) + d;
    if (k < 0) return;
    this.review = k < list.length ? list[k] : null;
  }

  endReview() {
    this.review = null;
  }

  startCard(card: string) {
    this.review = null;
    if (!this.game || this.whyNot(card)) return;
    const options = cardOptions(this.game, card);
    this.selected = null;
    this.selection = { card, options, path: [], chosen: null };
    this.autoChoose();
  }

  cancelCard() {
    if (!this.selection?.forced) this.selection = null;
  }

  /** Options compatibles avec le chemin déjà touché. */
  matching(sel: CardSelection): CardOption[] {
    return sel.options.filter((o) => sel.path.every((s, i) => o.path[i] === s));
  }

  nextSquares(sel: CardSelection): Set<Sq> {
    const out = new Set<Sq>();
    for (const o of this.matching(sel)) if (o.path.length > sel.path.length) out.add(o.path[sel.path.length]);
    return out;
  }

  /** Options complètes (chemin entièrement touché) — plusieurs si un libellé départage. */
  complete(sel: CardSelection): CardOption[] {
    return this.matching(sel).filter((o) => o.path.length === sel.path.length);
  }

  private tapCardSquare(s: Sq) {
    const sel = this.selection!;
    if (sel.path.length && sel.path[sel.path.length - 1] === s) {
      // retoucher la dernière case annule cette étape
      this.selection = { ...sel, path: sel.path.slice(0, -1), chosen: null };
      return;
    }
    if (!this.nextSquares(sel).has(s)) return;
    this.selection = { ...sel, path: [...sel.path, s], chosen: null };
    this.autoChoose();
  }

  private autoChoose() {
    const sel = this.selection!;
    const done = this.complete(sel);
    if (done.length === 1 && this.nextSquares(sel).size === 0) {
      this.selection = { ...sel, chosen: done[0] };
      // étape réversible d'un choix imposé : appliquée sans validation
      if (sel.forced && done[0].instant) this.confirmCard();
    }
  }

  choose(o: CardOption) {
    if (this.selection) this.selection = { ...this.selection, chosen: o };
  }

  confirmCard() {
    const sel = this.selection;
    if (!sel?.chosen) return;
    if (sel.forced) this.act({ type: 'choose', path: sel.chosen.path, label: sel.chosen.label });
    else this.act({ type: 'card', card: sel.card, path: sel.chosen.path, label: sel.chosen.label });
  }

  // ---------- divers ----------

  checkSquare(): Sq | null {
    const g = this.game;
    if (!g) return null;
    const side = g.pos.turn;
    return inCheck(g.pos.board, side) ? kingSq(g.pos.board, side) : null;
  }
}

export const controller = new GameController();
