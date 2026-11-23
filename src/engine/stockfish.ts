// Stockfish 18 « lite single-thread » dans un Web Worker (pas besoin d'en-têtes COOP/COEP).
// Les recherches sont sérialisées : une seule à la fois sur le worker.

import { MATE_SCORE, type Analysis, type Engine, type SearchLimits } from './engine';

export class StockfishEngine implements Engine {
  private worker: Worker;
  private queue: Promise<unknown> = Promise.resolve();
  private listener: ((line: string) => void) | null = null;
  private ready: Promise<void>;
  private currentSkill = -1;
  private currentMultiPV = 1;

  constructor(url = `${import.meta.env.BASE_URL}stockfish/stockfish-18-lite-single.js`) {
    this.worker = new Worker(url);
    this.worker.onmessage = (e: MessageEvent) => this.listener?.(String(e.data));
    this.ready = this.waitFor('uci', (l) => l === 'uciok')
      .then(() => this.waitFor('isready', (l) => l === 'readyok'))
      .then(() => undefined);
  }

  private waitFor(cmd: string, done: (line: string) => boolean, onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve) => {
      this.listener = (line) => {
        onLine?.(line);
        if (done(line)) {
          this.listener = null;
          resolve(line);
        }
      };
      this.worker.postMessage(cmd);
    });
  }

  analyse(fen: string, limits: SearchLimits): Promise<Analysis> {
    const run = async (): Promise<Analysis> => {
      await this.ready;
      const skill = limits.skill ?? 20;
      if (skill !== this.currentSkill) {
        this.worker.postMessage(`setoption name Skill Level value ${skill}`);
        this.currentSkill = skill;
      }
      const multipv = Math.max(1, limits.multipv ?? 1);
      if (multipv !== this.currentMultiPV) {
        this.worker.postMessage(`setoption name MultiPV value ${multipv}`);
        this.currentMultiPV = multipv;
      }
      this.worker.postMessage(`position fen ${fen}`);
      const lines: { move: string; score: number }[] = [];
      const go = ['go'];
      if (limits.depth) go.push('depth', String(limits.depth));
      if (limits.movetime) go.push('movetime', String(limits.movetime));
      if (limits.searchmoves?.length) go.push('searchmoves', ...limits.searchmoves); // toujours en dernier
      const last = await this.waitFor(
        go.join(' '),
        (l) => l.startsWith('bestmove'),
        (l) => {
          const info = parseInfo(l);
          if (info) lines[info.index] = { move: info.move, score: info.score };
        },
      );
      const best = last.split(/\s+/)[1];
      const found = lines.filter(Boolean);
      return {
        bestmove: best && best !== '(none)' ? best : null,
        score: found[0]?.score ?? 0,
        lines: multipv > 1 ? found : undefined,
      };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  dispose() {
    this.worker.terminate();
  }
}

/** Lit une ligne `info … multipv N score … pv <coup> …` (ignore les bornes partielles). */
export function parseInfo(line: string): { index: number; score: number; move: string } | null {
  const m = / score (cp|mate) (-?\d+)/.exec(line);
  if (!m || line.includes(' upperbound') || line.includes(' lowerbound')) return null;
  const v = Number(m[2]);
  const score = m[1] === 'cp' ? v : Math.sign(v || -1) * (MATE_SCORE - Math.abs(v) * 100);
  const index = Number(/ multipv (\d+)/.exec(line)?.[1] ?? 1) - 1;
  const move = / pv (\S+)/.exec(line)?.[1] ?? '';
  return { index, score, move };
}
