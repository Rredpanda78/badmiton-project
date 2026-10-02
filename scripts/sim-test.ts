// 無畫面測試：檢查擊球求解器，並讓兩個 AI 對打，統計得分原因與球種。
// 執行：npx tsx scripts/sim-test.ts [difficulty] [points]
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, GAME, type Difficulty } from '../src/config';
import { Match } from '../src/sim/match';
import { predict, v3 } from '../src/sim/physics';
import { Rng } from '../src/sim/rng';
import { chargeForDepth, resolveShot, type Family } from '../src/sim/shots';

const rng = new Rng(1);
console.log('--- 單球測試（近側球員 side=1，往 z<0 打） ---');
const cases: [string, number, number, Family, number][] = [
  // 名稱, 擊球點 z, 高度, 球種, 目標深度（m，越過網）
  ['後場高遠 深6.0', 6.0, 2.5, 'up', 6.0],
  ['後場高遠 深7.4(出界)', 6.0, 2.5, 'up', 7.4],
  ['後場殺球 深4.3', 5.5, 2.6, 'down', 4.3],
  ['後場切球 深1.3', 5.5, 2.6, 'down', 1.3],
  ['中場平抽 深5.2', 3.5, 1.4, 'side', 5.2],
  ['網前放網 深0.9', 1.2, 0.8, 'down', 0.9],
  ['網前挑球 深5.6', 1.2, 0.6, 'up', 5.6],
  ['網前撲球 深3.2', 1.3, 2.1, 'down', 3.2],
  ['網前高點撲 深3.2', 1.5, 2.6, 'down', 3.2],
  ['蓄力不足 深0.0', 5.0, 2.4, 'up', 0.0],
];
for (const [name, z, y, family, depth] of cases) {
  const t0 = performance.now();
  const charge = chargeForDepth(depth);
  const r = resolveShot({ side: 1, contact: v3(0, y, z), family, aimX: 0, charge, quality: 1, serve: null }, rng);
  const ms = (performance.now() - t0).toFixed(1);
  const pr = predict(v3(0, y, z), r.vel, r.stepDt);
  const land = pr.landing ? `落點 z=${pr.landing.z.toFixed(2)}` : pr.hitsNet ? '掛網' : '未落地';
  const apex = Math.max(...pr.points.map((p) => p.p.y)).toFixed(2);
  const real = (pr.landTime / GAME.simSpeed).toFixed(2);
  console.log(`${name.padEnd(16)} c=${charge.toFixed(2)} ${r.name.padEnd(4)} ${String(r.speedKmh).padStart(3)}km/h 實際飛行${real}s 最高${apex}m ${land} (${ms}ms)`);
}

const diff = (process.argv[2] as Difficulty) ?? 'normal';
const points = Number(process.argv[3] ?? 40);
console.log(`\n--- AI vs AI（${diff}），${points} 分 ---`);
const match = new Match({ ...DEFAULT_SETTINGS, difficulty: diff, points: 21, games: 3 }, 42);
const ais = [new AIController(match, 0, diff), new AIController(match, 1, diff)];
const reasons: Record<string, number> = {};
const shots: Record<string, number> = {};
let rallyLens: number[] = [];
let totalPoints = 0;
let ticks = 0;
let lastShot = '';
const byShot: Record<string, number> = {};
const topSpeed: Record<string, number> = {};
while (totalPoints < points && ticks < 120 * 60 * 30 && match.phase !== 'matchOver') {
  match.step([ais[0].input(), ais[1].input()]);
  ticks++;
  for (const e of match.drainEvents()) {
    if (e.type === 'hit') {
      shots[e.name] = (shots[e.name] ?? 0) + 1;
      topSpeed[e.name] = Math.max(topSpeed[e.name] ?? 0, e.speedKmh);
      lastShot = `${e.name}${e.netFault ? '(力道不足)' : ''} c=${e.charge.toFixed(2)} y=${e.pos.y.toFixed(2)} dn=${Math.abs(e.pos.z).toFixed(1)}`;
    }
    if (e.type === 'point') {
      totalPoints++;
      reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
      const key = `${e.reason} ← ${lastShot.split(' ')[0]}`;
      byShot[key] = (byShot[key] ?? 0) + 1;
      if (process.env.VERBOSE) console.log(e.reason.padEnd(4), lastShot);
      rallyLens.push(match.rallyHits);
    }
  }
}
const avg = rallyLens.reduce((a, b) => a + b, 0) / rallyLens.length;
console.log('得分原因', reasons);
console.log('失分球種', byShot);
console.log('各球種最高初速 km/h', topSpeed);
console.log('球種', shots);
console.log(`平均每分擊球數 ${avg.toFixed(1)}，最長 ${Math.max(...rallyLens)}，模擬 ${(ticks / 120 / GAME.simSpeed / 60).toFixed(1)} 分鐘（真實時間）`);
console.log('比分', match.score, '局數', match.games);
