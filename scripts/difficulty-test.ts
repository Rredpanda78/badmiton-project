// 難度階梯測試：每個難度對「下一級」打（例如 困難 vs 普通），兩邊同一組球員＋球拍（全能型＋均衡拍），
// 近側／遠側輪流（鏡像，同一個種子打兩場），統計 A 方的每分勝率與單局勝率。
//
// 執行（專案根目錄）：
//   npx tsx scripts/difficulty-test.ts                       # 預設：普通/簡單、困難/普通、超難/困難、地獄/超難，21 分一局，各 120 局
//   npx tsx scripts/difficulty-test.ts --games=200 --points=11
//   npx tsx scripts/difficulty-test.ts --pairs=hell:hard,hell:normal
//   npx tsx scripts/difficulty-test.ts --doubles              # 雙打：A 隊兩位 AI 都是 A 難度
//   npx tsx scripts/difficulty-test.ts --params='{"hell":{"reaction":0.05}}'   # 試算新參數（不改檔案）
//
// 參數：--pairs=A:B,...  --games=局數（偶數，鏡像）  --points=11|15|21  --doubles  --workers=N  --seed=N  --params=JSON
//       --sweep=檔案.json（[[標籤, 參數覆寫], ...]：一次比較多種調法，每組用同一批種子）
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AIController, DIFFICULTY_PARAMS } from '../src/ai/ai';
import { DEFAULT_SETTINGS, type Difficulty } from '../src/config';
import { Match, type PlayerId } from '../src/sim/match';

interface Job {
  id: number;
  a: Difficulty;
  b: Difficulty;
  games: number; // 偶數：一半 A 在近側（0 號隊）、一半在遠側
  seed: number;
  points: 11 | 15 | 21;
  doubles: boolean;
  params: Record<string, Record<string, number>> | null;
}
interface Result {
  aPts: number;
  bPts: number;
  aGames: number;
  bGames: number;
  hits: number;
  ticks: number;
  smashes: [number, number]; // [A, B] 殺球＋跳殺
  dives: [number, number];
}

// 子行程會重複使用：每個工作先還原原本的參數再套用覆寫
const ORIGINAL = JSON.parse(JSON.stringify(DIFFICULTY_PARAMS)) as typeof DIFFICULTY_PARAMS;
function applyParams(p: Job['params']): void {
  for (const d of Object.keys(ORIGINAL) as Difficulty[]) Object.assign(DIFFICULTY_PARAMS[d], ORIGINAL[d]);
  if (!p) return;
  for (const [d, over] of Object.entries(p)) Object.assign(DIFFICULTY_PARAMS[d as Difficulty], over);
}

function runJob(job: Job): Result {
  applyParams(job.params);
  const r: Result = { aPts: 0, bPts: 0, aGames: 0, bGames: 0, hits: 0, ticks: 0, smashes: [0, 0], dives: [0, 0] };
  for (let g = 0; g < job.games; g++) {
    const aTeam = g % 2; // A 是哪一隊（0 = 近側）
    const seed = (job.seed + Math.floor(g / 2) * 7919) >>> 0;
    const m = new Match(
      {
        ...DEFAULT_SETTINGS,
        points: job.points,
        games: 1,
        character: 'allround',
        racket: 'balance',
        aiCharacter: 'allround',
        aiRacket: 'balance',
        doubles: job.doubles,
        partnerCharacter: 'allround',
        partnerRacket: 'balance',
        ai2Character: 'allround',
        ai2Racket: 'balance',
      },
      seed,
    );
    const lvl = (id: number) => (id % 2 === aTeam ? job.a : job.b);
    const ais = m.players.map((p) => new AIController(m, p.id as PlayerId, lvl(p.id)));
    let ticks = 0;
    while (m.phase !== 'matchOver' && ticks < 120 * 60 * 40) {
      m.step(ais.map((ai) => ai.input()));
      ticks++;
      for (const e of m.drainEvents()) {
        const isA = (id: number) => id % 2 === aTeam;
        if (e.type === 'hit') {
          r.hits++;
          if (e.name.includes('殺')) r.smashes[isA(e.player) ? 0 : 1]++;
        } else if (e.type === 'dive') r.dives[isA(e.player) ? 0 : 1]++;
        else if (e.type === 'point') {
          if (e.winner === aTeam) r.aPts++;
          else r.bPts++;
        } else if (e.type === 'match') {
          if (e.winner === aTeam) r.aGames++;
          else r.bGames++;
        }
      }
    }
    r.ticks += ticks;
  }
  return r;
}

if (process.argv.includes('--worker')) {
  process.on('message', (job: Job) => process.send!({ id: job.id, res: runJob(job) }));
} else {
  await main();
}

function parseArgs(): Record<string, string> {
  const a: Record<string, string> = {};
  for (const s of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/s.exec(s);
    if (m) a[m[1]] = m[2] ?? '';
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const pairs = (args.pairs ?? 'normal:easy,hard:normal,extreme:hard,hell:extreme').split(',').map((s) => s.split(':') as [Difficulty, Difficulty]);
  const games = Math.max(2, Math.round(Number(args.games ?? 120) / 2) * 2);
  const points = (Number(args.points ?? 21) as 11 | 15 | 21) || 21;
  const doubles = 'doubles' in args;
  const workers = Math.max(1, Number(args.workers ?? Math.max(1, cpus().length - 2)));
  // 參數組：--params=JSON 一組；--sweep=檔案.json 多組 [[標籤, 覆寫], ...]（一次比較多種調法）
  const variants: [string, Job['params']][] = args.sweep
    ? JSON.parse(readFileSync(args.sweep, 'utf8'))
    : [['', args.params ? JSON.parse(args.params) : null]];
  const perJob = 4;
  const jobs: Job[] = [];
  const meta: number[] = [];
  const runs: { label: string; a: Difficulty; b: Difficulty }[] = [];
  for (const [label, params] of variants) {
    let seed = Number(args.seed ?? 20261003); // 每組參數用同一批種子，比較起來比較準
    for (const [a, b] of pairs) {
      for (let j = 0; j < games / perJob; j++) {
        jobs.push({ id: jobs.length, a, b, games: perJob, seed: (seed += 104729) >>> 0, points, doubles, params });
        meta.push(runs.length);
      }
      runs.push({ label, a, b });
    }
  }
  const t0 = Date.now();
  console.log(`${doubles ? '雙打' : '單打'}，${points} 分一局，每組 ${games} 局（鏡像），${jobs.length} 個工作 / ${Math.min(workers, jobs.length)} 個子行程${args.params ? `；參數覆寫 ${args.params}` : ''}`);
  const results: Result[] = runs.map(() => ({ aPts: 0, bPts: 0, aGames: 0, bGames: 0, hits: 0, ticks: 0, smashes: [0, 0], dives: [0, 0] }));
  let next = 0;
  await new Promise<void>((resolve, reject) => {
    const self = fileURLToPath(import.meta.url);
    const n = Math.min(workers, jobs.length);
    let alive = n;
    for (let w = 0; w < n; w++) {
      const child = fork(self, ['--worker'], { execArgv: process.execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const feed = () => {
        if (next < jobs.length) child.send(jobs[next++]);
        else child.disconnect();
      };
      child.on('message', (msg: { id: number; res: Result }) => {
        const t = results[meta[msg.id]];
        const s = msg.res;
        t.aPts += s.aPts;
        t.bPts += s.bPts;
        t.aGames += s.aGames;
        t.bGames += s.bGames;
        t.hits += s.hits;
        t.ticks += s.ticks;
        for (const i of [0, 1]) {
          t.smashes[i] += s.smashes[i];
          t.dives[i] += s.dives[i];
        }
        feed();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code) reject(new Error(`worker exit ${code}`));
        if (--alive === 0) resolve();
      });
      feed();
    }
  });
  const ci = (p: number, n: number) => 1.96 * Math.sqrt((p * (1 - p)) / n);
  const pct = (p: number, n: number) => `${(100 * p).toFixed(1)}%±${(100 * ci(p, n)).toFixed(1)}`;
  console.log(`完成，${((Date.now() - t0) / 1000).toFixed(0)} 秒\n`);
  console.log('A 難度 vs B 難度'.padEnd(20) + '每分勝率'.padStart(16) + '單局勝率'.padStart(16) + '每分擊球'.padStart(10) + '  殺球/100分 A:B'.padStart(18) + '  魚躍/100分 A:B');
  runs.forEach(({ label, a, b }, i) => {
    const r = results[i];
    const n = r.aPts + r.bPts;
    const gn = r.aGames + r.bGames;
    const per = (x: number) => ((100 * x) / n).toFixed(0);
    console.log(
      `${label ? `[${label}] ` : ''}${a} vs ${b}`.padEnd(20) +
        pct(r.aPts / n, n).padStart(16) +
        pct(r.aGames / gn, gn).padStart(16) +
        (r.hits / n).toFixed(1).padStart(10) +
        `${per(r.smashes[0])}:${per(r.smashes[1])}`.padStart(18) +
        `  ${per(r.dives[0])}:${per(r.dives[1])}`,
    );
  });
}
