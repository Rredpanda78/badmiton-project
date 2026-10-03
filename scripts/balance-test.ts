// 平衡測試：讓兩個 AI 用不同的「球員特質 × 球拍」對打，統計勝率與各特質實際影響多少分。
//
// 執行（專案根目錄）：
//   npx tsx scripts/balance-test.ts                         # 預設：全部組合 vs 基準、角色循環賽、球拍循環賽；hard + normal
//   npx tsx scripts/balance-test.ts --suite=combos --diff=hard --points=800
//   npx tsx scripts/balance-test.ts --exploit               # AI 偏好自己變快的球種（模擬人類「打自己的長處」）
//   npx tsx scripts/balance-test.ts --jitter=0.06           # 出拍時機雜訊改成較像人類（模擬秒），看揮拍判定時間的影響
//   npx tsx scripts/balance-test.ts --kits='{"power":{"speed":{"smash":1.1},"move":0.95}}'   # 試算新數值（整個 kit 取代，不改檔案）
//
// 參數：
//   --suite=combos,chars,rackets  combos = 20 個組合各自 vs 基準（allround + balance）
//                                 chars  = 角色循環賽（都拿 balance）；rackets = 球拍循環賽（都用 allround）
//   --diff=hard,normal            AI 難度（兩邊同難度）
//   --points=1600                 每個對戰、每個難度至少要打的分數（±1.96·√(p(1-p)/n)：1067 分 ≈ ±3%，1600 分 ≈ ±2.5%）
//   --games=11                    每局幾分（短局、每局不同種子；A 在近側/遠側各打一半＝鏡像）
//   --workers=N                   平行子行程數（預設 CPU 數 - 2）
//   --exploit[=5]                 球種權重 × kit.speed[組]^k（k 預設 5：+15% 球速 → 約 2 倍頻率）
//   --jitter=秒                   覆寫兩邊 AI 的出拍時機雜訊 timingJitter
//   --aimA=倍率                   只讓 A 的左右瞄準 × 倍率（不改準度），用來分離「瞄更邊」本身的效果
//   --kits=JSON                   以 id 覆寫角色/球拍的 kit（取代整個 kit 物件）
//   --only=touch+balance,...      combos 只跑這些組合（基準自己一定會跑，特質表要用）
//   --json=檔名                   輸出原始統計
//   --no-traits                   不印特質影響表
import { fork } from 'node:child_process';
import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AIController } from '../src/ai/ai';
import { COURT, DEFAULT_SETTINGS, GAME, type Difficulty } from '../src/config';
import { CHARACTERS, RACKETS, shotGroup, type Kit, type ShotGroup } from '../src/sim/kits';
import { Match } from '../src/sim/match';

// ---------------- 共用型別 ----------------
type Combo = { c: string; r: string };
const key = (x: Combo) => `${x.c}+${x.r}`;
const BASE: Combo = { c: 'allround', r: 'balance' };
const GROUPS: ShotGroup[] = ['smash', 'drop', 'push', 'clear'];
const ERR_REASONS = new Set(['出界', '掛網', '未過網', '發球失誤']);

interface Opts {
  exploit: number; // 0 = 關
  aimA: number | null; // 只給 A：左右瞄準倍率（覆寫 exploit 依 accuracy 算的倍率；用來分離「瞄更邊」與「更準」）
  jitter: number | null;
  kits: Record<string, unknown> | null;
  gamePoints: 11 | 21;
}

interface Job {
  id: number;
  a: Combo;
  b: Combo;
  diff: Difficulty;
  games: number; // 鏡像成對：偶數 index A 在 id0（近側），奇數 index A 在 id1
  seed: number;
  opts: Opts;
}

/** 某一方（A 或 B）的統計 */
interface Side {
  hits: Record<ShotGroup, number>;
  wins: Record<ShotGroup, number>; // 這一拍之後直接得分（對手沒接到/揮空/放掉）
  errs: Record<ShotGroup, number>; // 這一拍直接失分（出界/掛網/未過網）
  ptsTouched: Record<ShotGroup, number>; // 這一分中至少打過一拍此組的分數
  whiffs: number;
  chance: number; // 打出機會球（勉強接回）
  points: number;
  games: number;
}
interface Result {
  points: number;
  games: number;
  rallyHits: number;
  ticks: number;
  A: Side;
  B: Side;
}

const zg = (): Record<ShotGroup, number> => ({ smash: 0, drop: 0, push: 0, clear: 0 });
const newSide = (): Side => ({ hits: zg(), wins: zg(), errs: zg(), ptsTouched: zg(), whiffs: 0, chance: 0, points: 0, games: 0 });
const newResult = (): Result => ({ points: 0, games: 0, rallyHits: 0, ticks: 0, A: newSide(), B: newSide() });

function addSide(t: Side, s: Side): void {
  for (const g of GROUPS) {
    t.hits[g] += s.hits[g];
    t.wins[g] += s.wins[g];
    t.errs[g] += s.errs[g];
    t.ptsTouched[g] += s.ptsTouched[g];
  }
  t.whiffs += s.whiffs;
  t.chance += s.chance;
  t.points += s.points;
  t.games += s.games;
}
function addResult(t: Result, r: Result): void {
  t.points += r.points;
  t.games += r.games;
  t.rallyHits += r.rallyHits;
  t.ticks += r.ticks;
  addSide(t.A, r.A);
  addSide(t.B, r.B);
}

// ---------------- 子行程：實際模擬 ----------------
let applied = '';
function applyOpts(o: Opts): void {
  const sig = JSON.stringify(o);
  if (sig === applied) return;
  applied = sig;
  if (o.kits) {
    for (const [id, kit] of Object.entries(o.kits)) {
      const t = CHARACTERS.find((c) => c.id === id) ?? RACKETS.find((r) => r.id === id);
      if (!t) throw new Error(`--kits: 找不到 id ${id}`);
      t.kit = kit as typeof t.kit;
    }
  }
  if (o.exploit > 0 || o.aimA !== null) installExploit(o.exploit);
}

/**
 * 「打自己長處」的 AI：複製 AIController.chooseShot，但每個選項的權重 × kit.speed[該球的組]^k，
 * 基準 kit（全部 1）時與原本 AI 完全相同。--aimA 另外可以只讓 A 瞄更邊。
 */
function installExploit(k: number): void {
  const proto = AIController.prototype as unknown as { chooseShot: (y: number, dn: number) => unknown };
  proto.chooseShot = function (this: any, y: number, dn: number) {
    const m: Match = this.match;
    const rng = m.rng;
    const me = m.players[this.id as 0 | 1];
    const opp = m.players[this.id === 0 ? 1 : 0];
    const kit: Kit = me.kit;
    const oppDeep = Math.abs(opp.pos.z) > 4.6;
    const oppFront = Math.abs(opp.pos.z) < 3.0;
    const oppAim = (opp.pos.x * me.side) / 2.3;
    let aimX = rng.chance(this.p.smartAim) ? -Math.sign(oppAim || rng.next() - 0.5) * rng.range(0.45, 0.85) : rng.range(-0.8, 0.8);
    const aimMul = this.aimScale ?? 1; // 瞄更邊對誰都有利（實測 ×1.2 ≈ +7% 每分勝率），不算特質，預設不改
    aimX = Math.max(-0.95, Math.min(0.95, aimX * aimMul));
    const groupOf = (family: string, depth: number): ShotGroup => {
      if (family === 'up') return 'clear';
      if (family === 'side') return y >= GAME.highZoneY && depth > 4.5 ? 'clear' : 'push';
      if (depth < 2.6) return 'drop';
      return y >= COURT.netTop ? 'smash' : 'push';
    };
    const pick = (opts: [number, string, number][]) => {
      const w = opts.map(([wt, fam, d]) => wt * Math.pow(kit.speed[groupOf(fam, d)], k));
      const total = w.reduce((s, x) => s + x, 0);
      let r = rng.next() * total;
      for (let i = 0; i < opts.length; i++) {
        r -= w[i];
        if (r <= 0) return { family: opts[i][1], depth: opts[i][2], aimX };
      }
      return { family: opts[0][1], depth: opts[0][2], aimX };
    };
    const sb = this.p.smashBias * (m.shuttle.wobble ? 2.2 : 1);
    if (dn < 2.3 && y >= COURT.netTop + 0.3) {
      const kill = this.p.killRate;
      return pick([[kill, 'down', 3.2], [1 - kill, 'down', 1.1], [oppFront ? 0.3 : 0.1, 'up', 5.6]]);
    }
    if (y >= GAME.highZoneY) {
      if (dn < 4.5) return pick([[0.6 * sb, 'down', 4.3], [oppDeep ? 0.35 : 0.2, 'down', 1.3], [oppFront ? 0.3 : 0.12, 'up', 5.8]]);
      return pick([[oppFront ? 0.55 : 0.4, 'up', 5.8], [0.3 * sb, 'down', 4.6], [oppDeep ? 0.45 : 0.25, 'down', 1.4]]);
    }
    if (y >= 1.3) {
      if (dn < 2.3) return pick([[0.7, 'down', 1.1], [0.3, 'up', 5.6]]);
      return pick([[0.4, 'side', 5.2], [oppFront ? 0.5 : 0.3, 'up', 5.6], [oppDeep ? 0.35 : 0.2, 'down', 1.5]]);
    }
    if (dn < 2.5) return pick([[oppDeep ? 0.65 : 0.45, 'down', 1.1], [oppFront ? 0.65 : 0.45, 'up', 5.6]]);
    return pick([[0.65, 'up', 5.6], [0.35, 'side', 5.0]]);
  };
}

function runJob(job: Job): Result {
  applyOpts(job.opts);
  const res = newResult();
  for (let g = 0; g < job.games; g++) {
    const aIs = (g % 2) as 0 | 1; // A 的 player id（鏡像：一半近側、一半遠側；id0 先發球）
    const p0 = aIs === 0 ? job.a : job.b;
    const p1 = aIs === 0 ? job.b : job.a;
    const seed = (job.seed + Math.floor(g / 2) * 7919) >>> 0; // 鏡像的兩局用同一個種子
    const m = new Match(
      { ...DEFAULT_SETTINGS, difficulty: job.diff, points: job.opts.gamePoints, games: 1, character: p0.c, racket: p0.r, aiCharacter: p1.c, aiRacket: p1.r },
      seed,
    );
    const ais = [new AIController(m, 0, job.diff), new AIController(m, 1, job.diff)];
    if (job.opts.jitter !== null) for (const ai of ais) (ai as any).p = { ...(ai as any).p, timingJitter: job.opts.jitter };
    if (job.opts.aimA !== null) (ais[aIs] as any).aimScale = job.opts.aimA;
    const role = (pid: 0 | 1): Side => (pid === aIs ? res.A : res.B);
    let last: { player: 0 | 1; group: ShotGroup } | null = null;
    let touched: [Set<ShotGroup>, Set<ShotGroup>] = [new Set(), new Set()];
    let ticks = 0;
    while (m.phase !== 'matchOver' && ticks < 120 * 60 * 30) {
      m.step([ais[0].input(), ais[1].input()]);
      ticks++;
      for (const e of m.drainEvents()) {
        if (e.type === 'hit') {
          const grp = shotGroup(e.name === '機會殺球' ? '殺球' : e.name);
          role(e.player).hits[grp]++;
          touched[e.player].add(grp);
          last = { player: e.player, group: grp };
          res.rallyHits++;
        } else if (e.type === 'whiff') role(e.player).whiffs++;
        else if (e.type === 'chance') role(e.player === 0 ? 1 : 0).chance++; // 事件的 player = 拿到機會球的一方
        else if (e.type === 'point') {
          res.points++;
          role(e.winner).points++;
          if (last) {
            if (ERR_REASONS.has(e.reason)) role(last.player).errs[last.group]++;
            else if (last.player === e.winner) role(last.player).wins[last.group]++;
          }
          for (const pid of [0, 1] as const) for (const grp of touched[pid]) role(pid).ptsTouched[grp]++;
          touched = [new Set(), new Set()];
          last = null;
        } else if (e.type === 'match') {
          res.games++;
          role(e.winner).games++;
        }
      }
    }
    res.ticks += ticks;
  }
  return res;
}

if (process.argv.includes('--worker')) {
  process.on('message', (job: Job) => {
    process.send!({ id: job.id, res: runJob(job) });
  });
} else {
  await main();
}

// ---------------- 主行程：排程、彙整、輸出 ----------------
function parseArgs() {
  const a: Record<string, string> = {};
  for (const s of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/s.exec(s);
    if (m) a[m[1]] = m[2] ?? '';
  }
  return a;
}

/** 21 分制（落後 2 分 deuce、30 分封頂）單局勝率，給每分勝率 p */
function gameWin(p: number, target = 21, cap = 30): number {
  const memo = new Map<string, number>();
  const f = (a: number, b: number): number => {
    if ((a >= target && a - b >= 2) || a >= cap) return 1;
    if ((b >= target && b - a >= 2) || b >= cap) return 0;
    const k = `${a},${b}`;
    const v = memo.get(k);
    if (v !== undefined) return v;
    const r = p * f(a + 1, b) + (1 - p) * f(a, b + 1);
    memo.set(k, r);
    return r;
  };
  return f(0, 0);
}

async function main() {
  const args = parseArgs();
  const diffs = (args.diff ?? 'hard,normal').split(',') as Difficulty[];
  const suites = (args.suite ?? 'combos,chars,rackets').split(',');
  const targetPts = Number(args.points ?? 1600);
  const gamePoints = (Number(args.games ?? 11) === 21 ? 21 : 11) as 11 | 21;
  const workers = Math.max(1, Number(args.workers ?? Math.max(1, cpus().length - 2)));
  const opts: Opts = {
    exploit: 'exploit' in args ? Number(args.exploit || 5) : 0,
    aimA: args.aimA ? Number(args.aimA) : null,
    jitter: args.jitter ? Number(args.jitter) : null,
    kits: args.kits ? JSON.parse(args.kits) : null,
    gamePoints,
  };
  // 主行程也套用覆寫（印表時要用到新數值）
  applyOpts({ ...opts, exploit: 0 });

  // 對戰清單（同一對戰只跑一次，循環賽裡跟基準的對戰直接重用）
  const pairs = new Map<string, { a: Combo; b: Combo }>();
  const addPair = (a: Combo, b: Combo) => pairs.set(`${key(a)}|${key(b)}`, { a, b });
  const only = args.only ? new Set(args.only.split(',')) : null; // 只跑部分組合 vs 基準（例：--only=touch+balance,power+attack）
  if (suites.includes('combos'))
    for (const c of CHARACTERS) for (const r of RACKETS) if (!only || only.has(`${c.id}+${r.id}`) || (c.id === BASE.c && r.id === BASE.r)) addPair({ c: c.id, r: r.id }, BASE);
  if (suites.includes('chars'))
    for (let i = 0; i < CHARACTERS.length; i++)
      for (let j = i + 1; j < CHARACTERS.length; j++) {
        addPair({ c: CHARACTERS[j].id, r: 'balance' }, { c: CHARACTERS[i].id, r: 'balance' });
      }
  if (suites.includes('rackets'))
    for (let i = 0; i < RACKETS.length; i++)
      for (let j = i + 1; j < RACKETS.length; j++) addPair({ c: 'allround', r: RACKETS[j].id }, { c: 'allround', r: RACKETS[i].id });

  // 每個 job = 一組鏡像局；估每局分數來決定局數
  const estPtsPerGame = gamePoints === 11 ? 17 : 37;
  const gamesPerJob = 8;
  const jobsPerPair = Math.max(1, Math.ceil(targetPts / estPtsPerGame / gamesPerJob));
  const jobs: Job[] = [];
  const jobMeta: { pairKey: string; diff: Difficulty }[] = [];
  let seedBase = Number(args.seed ?? 20261003);
  for (const diff of diffs)
    for (const [pk, { a, b }] of pairs)
      for (let j = 0; j < jobsPerPair; j++) {
        jobs.push({ id: jobs.length, a, b, diff, games: gamesPerJob, seed: (seedBase += 104729) >>> 0, opts });
        jobMeta.push({ pairKey: pk, diff });
      }

  const t0 = Date.now();
  console.log(
    `對戰 ${pairs.size} × 難度 ${diffs.join('/')}，每對戰約 ${jobsPerPair * gamesPerJob} 局（${gamePoints} 分制，鏡像）≈ ${jobsPerPair * gamesPerJob * estPtsPerGame} 分；` +
      `${jobs.length} 個工作 / ${workers} 個子行程` +
      (opts.exploit ? `；exploit k=${opts.exploit}` : '') +
      (opts.jitter !== null ? `；timingJitter=${opts.jitter}` : '') +
      (opts.aimA !== null ? `；A 瞄準倍率 ${opts.aimA}` : '') +
      (opts.kits ? `；kits 覆寫 ${JSON.stringify(opts.kits)}` : ''),
  );

  const results = new Map<string, Result>(); // `${diff}|${pairKey}`
  let next = 0;
  let done = 0;
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
        const meta = jobMeta[msg.id];
        const k = `${meta.diff}|${meta.pairKey}`;
        if (!results.has(k)) results.set(k, newResult());
        addResult(results.get(k)!, msg.res);
        done++;
        if (done % Math.max(1, Math.floor(jobs.length / 20)) === 0) process.stderr.write(`  ${done}/${jobs.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
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
  const secs = (Date.now() - t0) / 1000;
  let totalPts = 0;
  for (const r of results.values()) totalPts += r.points;
  console.log(`完成：${totalPts} 分，${secs.toFixed(0)} 秒（${(totalPts / secs).toFixed(0)} 分/秒）\n`);

  // ---------- 取結果（a 對 b 的 A 方觀點；反向則對調） ----------
  const get = (diff: Difficulty, a: Combo, b: Combo): { pw: number; n: number; gw: number; gn: number; r: Result; flip: boolean } | null => {
    let r = results.get(`${diff}|${key(a)}|${key(b)}`);
    let flip = false;
    if (!r) {
      r = results.get(`${diff}|${key(b)}|${key(a)}`);
      flip = true;
    }
    if (!r) return null;
    const A = flip ? r.B : r.A;
    return { pw: A.points / r.points, n: r.points, gw: A.games / r.games, gn: r.games, r, flip };
  };
  const ci = (p: number, n: number) => 1.96 * Math.sqrt((p * (1 - p)) / n);
  const fmt = (p: number, n: number) => `${(100 * p).toFixed(1)}±${(100 * ci(p, n)).toFixed(1)}`;
  const flag = (p: number, n: number) => (p - ci(p, n) > 0.5 ? ' ▲' : p + ci(p, n) < 0.5 ? ' ▼' : '  ');

  if (suites.includes('combos')) {
    console.log('== 1. 每個組合 vs 基準（allround + balance）：每分勝率 %（95% CI）；▲/▼ = 顯著高/低於 50；「21分局」= 依每分勝率推算的 21 分制單局勝率；「局」= 實測 ' + gamePoints + ' 分局勝率 ==');
    for (const diff of diffs) {
      console.log(`\n[${diff}]`);
      console.log('角色＼球拍'.padEnd(10) + RACKETS.map((r) => r.id.padStart(24)).join(''));
      for (const c of CHARACTERS) {
        let line = c.id.padEnd(12);
        for (const r of RACKETS) {
          const x = get(diff, { c: c.id, r: r.id }, BASE);
          line += x ? `${fmt(x.pw, x.n)}${flag(x.pw, x.n)} (${(100 * gameWin(x.pw)).toFixed(0)})`.padStart(24) : '-'.padStart(24);
        }
        console.log(line);
      }
      console.log('（括號 = 推算 21 分局勝率 %）');
      let line = '實測' + gamePoints + '分局勝率 '.padEnd(6);
      const rows: string[] = [];
      for (const c of CHARACTERS)
        for (const r of RACKETS) {
          const x = get(diff, { c: c.id, r: r.id }, BASE);
          if (x) rows.push(`${c.id}+${r.id} ${fmt(x.gw, x.gn)}`);
        }
      line += rows.join(' | ');
      console.log(line);
    }
  }

  const matrix = (title: string, ids: string[], mk: (id: string) => Combo) => {
    console.log(`\n== ${title}：列 vs 欄 的每分勝率 %（±95% CI） ==`);
    for (const diff of diffs) {
      console.log(`[${diff}]`);
      console.log(''.padEnd(10) + ids.map((i) => i.padStart(14)).join('') + '   平均'.padStart(10));
      for (const a of ids) {
        let line = a.padEnd(10);
        let sum = 0;
        let cnt = 0;
        for (const b of ids) {
          if (a === b) {
            line += '—'.padStart(14);
            continue;
          }
          const x = get(diff, mk(a), mk(b));
          if (!x) {
            line += '-'.padStart(14);
            continue;
          }
          line += fmt(x.pw, x.n).padStart(14);
          sum += x.pw;
          cnt++;
        }
        console.log(line + (cnt ? (100 * (sum / cnt)).toFixed(1).padStart(10) : ''));
      }
    }
  };
  if (suites.includes('chars')) matrix('2a. 角色循環賽（都拿 balance）', CHARACTERS.map((c) => c.id), (id) => ({ c: id, r: 'balance' }));
  if (suites.includes('rackets')) matrix('2b. 球拍循環賽（都用 allround）', RACKETS.map((r) => r.id), (id) => ({ c: 'allround', r: id }));

  // ---------- 3. 特質實際影響多少分 ----------
  if (!('no-traits' in args) && suites.includes('combos')) {
    console.log('\n== 3. 特質影響（A = 測試組合，對手 = 基準）==');
    console.log('每組：拍/100分 = A 每 100 分打幾拍；有打% = A 至少打過一拍此組的分數比例；win% = 這拍後直接得分；err% = 這拍直接失誤；');
    console.log('      Δ分 = (A 的 win% − 基準 win%) × A 該組拍數 ÷ 總分 ≈ 該組（球速等）讓 A 多/少直接拿下幾 % 的分數');
    for (const diff of diffs) {
      const base = get(diff, BASE, BASE);
      if (!base) continue;
      // 基準 vs 基準：兩邊合併
      const bS = newSide();
      addSide(bS, base.r.A);
      addSide(bS, base.r.B);
      const rate = (s: Side, g: ShotGroup) => (s.hits[g] ? s.wins[g] / s.hits[g] : 0);
      const erate = (s: Side, g: ShotGroup) => (s.hits[g] ? s.errs[g] / s.hits[g] : 0);
      console.log(`\n[${diff}]  基準：` + GROUPS.map((g) => `${g} ${((100 * bS.hits[g]) / (2 * base.n)).toFixed(0)}拍/100分 win ${(100 * rate(bS, g)).toFixed(1)}% err ${(100 * erate(bS, g)).toFixed(1)}%`).join(' | ') + `；揮空 ${((100 * bS.whiffs) / (2 * base.n)).toFixed(1)}/100分`);
      const rows: [string, Combo][] = [
        ...CHARACTERS.filter((c) => c.id !== 'allround').map((c) => [c.id, { c: c.id, r: 'balance' }] as [string, Combo]),
        ...RACKETS.filter((r) => r.id !== 'balance').map((r) => [r.id + '拍', { c: 'allround', r: r.id }] as [string, Combo]),
        ['power+attack', { c: 'power', r: 'attack' }],
        ['touch+control', { c: 'touch', r: 'control' }],
        ['driver+speed', { c: 'driver', r: 'speed' }],
        ['runner+speed', { c: 'runner', r: 'speed' }],
      ];
      console.log('組合'.padEnd(15) + GROUPS.map((g) => `${g}:拍/有打%/win%/err%/Δ分`.padStart(32)).join('') + '  揮空/100分 對手win%(全部)');
      for (const [label, cmb] of rows) {
        const x = get(diff, cmb, BASE);
        if (!x) continue;
        const A = x.flip ? x.r.B : x.r.A;
        const B = x.flip ? x.r.A : x.r.B;
        let line = label.padEnd(15);
        for (const g of GROUPS) {
          const per100 = (100 * A.hits[g]) / x.n;
          const dPts = ((rate(A, g) - rate(bS, g)) * A.hits[g]) / x.n;
          line += `${per100.toFixed(0)}/${((100 * A.ptsTouched[g]) / x.n).toFixed(0)}/${(100 * rate(A, g)).toFixed(1)}/${(100 * erate(A, g)).toFixed(1)}/${dPts >= 0 ? '+' : ''}${(100 * dPts).toFixed(1)}%`.padStart(32);
        }
        const oppHits = GROUPS.reduce((s, g) => s + B.hits[g], 0);
        const oppWins = GROUPS.reduce((s, g) => s + B.wins[g], 0);
        const bHits = GROUPS.reduce((s, g) => s + bS.hits[g], 0);
        const bWins = GROUPS.reduce((s, g) => s + bS.wins[g], 0);
        line += `  ${((100 * A.whiffs) / x.n).toFixed(1).padStart(6)}  ${(100 * (oppWins / oppHits)).toFixed(1)}% (基準 ${(100 * (bWins / bHits)).toFixed(1)}%)`;
        console.log(line);
      }
      console.log(`平均每分擊球數 ${(base.r.rallyHits / base.n).toFixed(1)}`);
    }
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ opts, diffs, results: Object.fromEntries(results) }, null, 1));
    console.log(`\n原始統計已寫入 ${args.json}`);
  }
}
