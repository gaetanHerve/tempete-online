// Sons synthétisés à la volée (Web Audio) : pas de fichier à charger, pas de droits à gérer.
// Le « tok » d'une pièce posée d'un geste vif : un clic de contact, un sinus dont la hauteur
// plonge très vite, la résonance aiguë du bois et un petit choc, avec une minuscule réflexion
// du plateau. Tout s'éteint en quelques centièmes de seconde. Légères variations aléatoires
// pour éviter l'effet mitraillette.

let ctx: AudioContext | null = null;
let out: AudioNode | null = null;
let board: AudioNode | null = null;

/** Amplification avant l'écrêtage doux : c'est le réglage du volume général. */
const LOUDNESS = 3;

/**
 * Sortie commune : on amplifie fortement, puis un écrêtage doux (tanh) arrondit les pics au lieu
 * de saturer. Un son aussi bref paraît ainsi fort sans jamais dépasser le plein niveau.
 */
function output(ac: AudioContext): AudioNode {
  if (out) return out;
  // la courbe couvre ±RANGE en amplitude réelle : le signal y entre divisé par RANGE
  const RANGE = 4;
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * RANGE);
  const shaper = ac.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = '4x';
  const gain = ac.createGain();
  gain.gain.value = LOUDNESS / RANGE;
  const master = ac.createGain();
  master.gain.value = 0.95;
  gain.connect(shaper);
  shaper.connect(master);
  master.connect(ac.destination);
  return (out = gain);
}

/** Minuscule réflexion du plateau (4 ms) : de l'épaisseur sans traîne, avant la sortie commune. */
function plateau(ac: AudioContext): AudioNode {
  if (board) return board;
  const input = ac.createGain();
  const delay = ac.createDelay(0.05);
  delay.delayTime.value = 0.004;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3500;
  const fb = ac.createGain();
  fb.gain.value = 0.35;
  input.connect(output(ac));
  input.connect(delay);
  delay.connect(lp);
  lp.connect(fb);
  fb.connect(output(ac));
  return (board = input);
}

/** Les navigateurs mobiles n'autorisent le son qu'après un geste de l'utilisateur. */
export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function noiseBuffer(ac: AudioContext, seconds: number): AudioBuffer {
  const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * seconds), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envelope(ac: AudioContext, dest: AudioNode, t: number, peak: number, decay: number, attack = 0.0015): GainNode {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
}

/** Mode de vibration : sinus amorti, avec une chute de hauteur. */
function tone(ac: AudioContext, dest: AudioNode, t: number, freq: number, peak: number, decay: number, drop = 0.98) {
  const o = ac.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(freq * drop, t + decay);
  o.connect(envelope(ac, dest, t, peak, decay, 0.0004));
  o.start(t);
  o.stop(t + decay + 0.03);
}

/** « Tok » : sinus dont la hauteur plonge très vite, le cœur du claquement. */
function tok(ac: AudioContext, dest: AudioNode, t: number, from: number, to: number, peak: number, decay: number) {
  const o = ac.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + decay * 0.5);
  o.connect(envelope(ac, dest, t, peak, decay, 0.0003));
  o.start(t);
  o.stop(t + decay + 0.03);
}

/** Bouffée de bruit filtré : le contact. */
function click(ac: AudioContext, dest: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, peak: number) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur + 0.02);
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  src.connect(f);
  f.connect(envelope(ac, dest, t, peak, dur, 0.0002));
  src.start(t);
  src.stop(t + dur + 0.03);
}

/** Impulsion envoyée dans un résonateur étroit : le bois dur qui sonne. */
function ring(ac: AudioContext, dest: AudioNode, t: number, freq: number, q: number, peak: number) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, 0.02);
  const exc = ac.createGain();
  exc.gain.setValueAtTime(0.0001, t);
  exc.gain.exponentialRampToValueAtTime(peak, t + 0.0003);
  exc.gain.exponentialRampToValueAtTime(0.0001, t + 0.003);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  src.connect(exc);
  exc.connect(bp);
  bp.connect(dest);
  src.start(t);
  src.stop(t + 0.03);
}

function knock(ac: AudioContext, t: number, strength = 1) {
  const v = 0.96 + Math.random() * 0.08;
  const dest = plateau(ac);
  click(ac, dest, t, 0.003, 'highpass', 3000 * v, 0.7, 0.4 * strength);
  tok(ac, dest, t, 1500 * v, 720 * v, 0.55 * strength, 0.04);
  ring(ac, dest, t, 2400 * v, 20, 2.9 * strength); // (gain du résonateur × excitation)
  tone(ac, dest, t, 200 * v, 0.3 * strength, 0.035, 0.7);
}

/** Prise : un tok plus fort, doublé d'un claquement aigu, puis un petit rebond. */
function capture(ac: AudioContext, t: number) {
  const dest = plateau(ac);
  knock(ac, t, 1.15);
  tok(ac, dest, t + 0.004, 2200, 1100, 0.3, 0.03);
  click(ac, dest, t + 0.004, 0.012, 'bandpass', 4500, 1, 0.3);
  knock(ac, t + 0.06, 0.45);
}

/** Note de clochette : un sinus et deux harmoniques qui s'éteignent doucement. */
function bell(ac: AudioContext, t: number, freq: number, peak: number) {
  const dest = output(ac);
  for (const [mult, gain, decay] of [
    [1, 1, 0.9],
    [2.76, 0.18, 0.35],
    [5.4, 0.06, 0.15],
  ]) {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq * mult;
    o.connect(envelope(ac, dest, t, peak * gain, decay, 0.004));
    o.start(t);
    o.stop(t + decay + 0.05);
  }
}

export type SoundKind = 'move' | 'capture' | 'card' | 'turn';

/** Délai entre le froissement d'une carte et le son de la pièce qu'elle déplace. */
export const CARD_PIECE_DELAY = 0.14;

/** Joue un son. Ne lève jamais d'exception : un souci audio ne doit pas bloquer la partie. */
export function play(kind: SoundKind, delay = 0) {
  if (!ctx || ctx.state !== 'running') return;
  try {
    render(ctx, kind, delay);
  } catch (e) {
    console.warn('Son indisponible :', e);
  }
}

function render(ctx: AudioContext, kind: SoundKind, delay: number) {
  const t = ctx.currentTime + 0.01 + delay;
  if (kind === 'move') knock(ctx, t);
  else if (kind === 'turn') {
    // « à vous » : deux notes de clochette, montantes
    bell(ctx, t, 784, 0.16);
    bell(ctx, t + 0.13, 1047, 0.14);
  }
  else if (kind === 'capture') capture(ctx, t);
  else {
    // carte : froissement de carton qu'on abat sur la table
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.18);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(5000, t);
    bp.frequency.exponentialRampToValueAtTime(1400, t + 0.15);
    src.connect(bp);
    bp.connect(envelope(ctx, output(ctx), t, 0.22, 0.16, 0.002));
    src.start(t);
    src.stop(t + 0.2);
  }
}
