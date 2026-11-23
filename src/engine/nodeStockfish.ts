// Stockfish en sous-processus Node, pour les tests et les scripts (jamais chargé par l'appli).
import { spawn } from 'node:child_process';
import { type Analysis, type Engine, type SearchLimits } from './engine';
import { parseInfo } from './stockfish';

export class NodeStockfish implements Engine {
  private proc = spawn(process.execPath, ['node_modules/stockfish/src/stockfish-18-lite-single.js']);
  private buf = '';
  private waiters: ((l: string) => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor() {
    this.proc.stdout.on('data', (d: Buffer) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        this.waiters.forEach((w) => w(line));
      }
    });
    this.proc.stdin.write('uci\n');
  }
  analyse(fen: string, l: SearchLimits): Promise<Analysis> {
    const run = () =>
      new Promise<Analysis>((resolve) => {
        const lines: { move: string; score: number }[] = [];
        const multipv = l.multipv ?? 1;
        const w = (line: string) => {
          const info = parseInfo(line);
          if (info) lines[info.index] = { move: info.move, score: info.score };
          if (line.startsWith('bestmove')) {
            this.waiters = this.waiters.filter((x) => x !== w);
            const b = line.split(' ')[1];
            const found = lines.filter(Boolean);
            resolve({ bestmove: b === '(none)' ? null : b, score: found[0]?.score ?? 0, lines: multipv > 1 ? found : undefined });
          }
        };
        this.waiters.push(w);
        this.proc.stdin.write(`setoption name Skill Level value ${l.skill ?? 20}\nsetoption name MultiPV value ${multipv}\nposition fen ${fen}\ngo depth ${l.depth ?? 8}${l.movetime ? ' movetime ' + l.movetime : ''}${l.searchmoves?.length ? ' searchmoves ' + l.searchmoves.join(' ') : ''}\n`);
      });
    const p = this.queue.then(run);
    this.queue = p;
    return p;
  }
  dispose() {
    this.proc.kill();
  }
}
