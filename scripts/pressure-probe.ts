// 無畫面量測：AI 對打時每一拍「被調動多少」—— 對手擊球後跑了多遠、有多少時間、擊球當下的跑速、來球速度。
// 用來校準 GAME.pressure（被調動、接殺球的球質懲罰）。執行：npx tsx scripts/pressure-probe.ts [difficulty] [points]
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, GAME, type Difficulty } from '../src/config';
import { Match, type PlayerId } from '../src/sim/match';

// 例：G='{"moveAccel":42,"pressure":{"penalty":0}}' 試不同參數
const patch = (a: Record<string, unknown>, b: Record<string, unknown>) => { for (const k in b) typeof b[k] === "object" ? patch(a[k] as Record<string, unknown>, b[k] as Record<string, unknown>) : (a[k] = b[k]); };
if (process.env.G) patch(GAME as unknown as Record<string, unknown>, JSON.parse(process.env.G));
const diff = (process.argv[2] as Difficulty) ?? 'hard';
const points = Number(process.argv[3] ?? 60);
const m = new Match({ ...DEFAULT_SETTINGS, difficulty: diff, points: 21, games: 3 }, 7);
const ais = m.players.map((p) => new AIController(m, p.id as PlayerId, diff));
const from = new Map<PlayerId, { x: number; z: number; t: number }>();
let lastHitName = '';
let lastDn = 0;
let prevSpeed = 0;
const rows: { name: string; inName: string; run: number; T: number; sp: number; inSpeed: number; q: number; pr?: number; heat?: number; dive: boolean }[] = [];
let pts = 0;
const reasons = new Map<string, number>();
for (let tick = 0; tick < 120 * 60 * 60 && pts < points && m.phase !== 'matchOver'; tick++) {
  const v = m.shuttle.vel;
  prevSpeed = Math.hypot(v.x, v.y, v.z);
  m.step(ais.map((a) => a.input()));
  for (const e of m.drainEvents()) {
    if (e.type === 'hit') {
      const p = m.players[e.player];
      const f = from.get(p.id);
      if (f && !e.serve) {
        rows.push({
          name: e.name,
          inName: lastHitName + (lastHitName === '殺球' ? (lastDn > 4 ? '後' : '中') : ''),
          run: Math.hypot(p.pos.x - f.x, p.pos.z - f.z),
          T: m.time - f.t,
          sp: Math.hypot(p.vel.x, p.vel.z) / (GAME.moveSpeed * p.kit.move),
          inSpeed: prevSpeed,
          q: e.quality,
          pr: (e as { pressure?: number }).pressure,
          heat: (e as { heat?: number }).heat,
          dive: e.dive,
        });
      }
      lastHitName = e.name;
      lastDn = Math.abs(e.pos.z);
      from.clear();
      for (const o of m.players) if (o.team !== p.team) from.set(o.id, { x: o.pos.x, z: o.pos.z, t: m.time });
    }
    if (e.type === 'point') {
      pts++;
      reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
    }
  }
}
const pct = (a: number[], f: number) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * f)] : NaN);
const show = (label: string, rs: typeof rows) => {
  const dives = rs.filter((r) => r.dive).length;
  rs = rs.filter((r) => !r.dive);
  if (!rs.length) return;
  const f = (k: keyof (typeof rows)[0]) => {
    const a = rs.map((r) => r[k] as number).filter((x) => x !== undefined && !Number.isNaN(x));
    return a.length ? `${pct(a, 0.1).toFixed(2)}/${pct(a, 0.5).toFixed(2)}/${pct(a, 0.9).toFixed(2)}` : '-';
  };
  console.log(`${label.padEnd(10)} n=${String(rs.length).padStart(4)} 跑距 ${f('run')} m｜時間 ${f('T')} s｜跑速比 ${f('sp')}｜來球 ${f('inSpeed')} m/s｜品質 ${f('q')}｜壓力 ${f('pr')}｜接殺 ${f('heat')}｜魚躍 ${dives}`);
};
console.log(`${diff}，${pts} 分，${rows.length} 拍（數字 = 10%/50%/90%）`);
show('全部', rows);
for (const n of ['殺球後', '殺球中', '跳殺', '撲球', '平抽', '高遠球', '切球', '放網']) show(`接${n}`, rows.filter((r) => r.inName === n));
const { score, games } = m;
console.log(`比分 ${score} 局 ${games}｜每分 ${(rows.length / pts).toFixed(1)} 拍｜${[...reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join('、')}`);
