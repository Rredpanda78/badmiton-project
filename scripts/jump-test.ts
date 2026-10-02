// 跳殺（連按兩下 → 自動起跳）手感調校：無畫面模擬。
//
// 對面球員（id 1）當發球機：直接設定 match.shuttle，用 resolveShot 打出各種高遠球／挑球，
// 落在近側半場 z 2~6.5、x ±2.3（只留近側最高點 ≥ 3.0 m、值得跳的高球）。
// 近側球員（id 0）是腳本化的「人類」：
//   1. 反應 0.2 模擬秒後跑到「羽球降到 hc（2.7~3.1 m）的位置」旁邊 0.3~0.8 m（右手邊）
//   2. 羽球進入跳躍擊球範圍前 0.45~0.65 模擬秒連按兩下並按住（charging + jump）→ jumpArmed
//   3. 在自動起跳時刻 T0 + δ 往下划（殺球）。δ ≤ 0 = 還沒起跳就划（立刻起跳，整段滯空可擊球）
// 掃 GAME.jump.lead × δ ×（height, gravity），統計空中擊中／地面擊中／揮空，以及容錯區間。
// 人類時機雜訊（σ = 0.05 模擬秒 ≈ 81 ms）用確定性 δ 掃描結果做高斯捲積估計。
// 「看到起跳再划」= 瞄準起跳後 250 ms（真實）± 81 ms。
//
// 執行：npx tsx scripts/jump-test.ts [feeds=100]
// 環境變數：PAIRS=default 只跑目前的高度/重力；DETAIL=1 每組 lead 都印完整 δ 表
import { COURT, DEFAULT_SETTINGS, GAME, PHYS } from '../src/config';
import { idleInput, jumpApexTime, Match, type HitGrade, type PlayerInput, type WhiffReason } from '../src/sim/match';
import { copy3, predict, stepShuttle, v3, type Prediction, type Vec3 } from '../src/sim/physics';
import { Rng } from '../src/sim/rng';
import { chargeForDepth, resolveShot, type Family } from '../src/sim/shots';

const DT = PHYS.dt;
const realMs = (simS: number) => Math.round((simS / GAME.simSpeed) * 1000);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const pct = (a: number, n: number) => (n && Number.isFinite(a) ? ((100 * a) / n).toFixed(0) : '-') + '%';
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pad = (s: string | number, n: number) => String(s).padStart(n);

const NOISE = 0.05; // 人類出拍時機雜訊（模擬秒）
const REACT_AIM = 0.25 * GAME.simSpeed; // 看到起跳後 250 ms（真實）才划
const REACTION = 0.2; // 看到對手出拍到開始移動（模擬秒）
const FLICK_DOWN = { x: 0, y: -1 };

// ---------------- 發球機 ----------------
interface Feed {
  pos: Vec3;
  vel: Vec3;
  stepDt: number;
  pred: Prediction;
  name: string;
  maxYNear: number; // 在近側半場的最高點
}

function nearMaxY(pred: Prediction): number {
  let y = 0;
  for (const pt of pred.points) if (pt.p.z > 0.3) y = Math.max(y, pt.p.y);
  return y;
}

/** 對面（side -1）從 contact 打一顆 family 球，落在近側 (tx, D) */
function shoot(rng: Rng, contact: Vec3, family: Family, D: number, tx: number): Feed | null {
  const charge = clamp(chargeForDepth(D), 0, 1);
  const shot = resolveShot({ side: -1, contact, family, aimX: clamp(-tx / 2.3, -1, 1), charge, quality: 1, serve: null, jump: false }, rng);
  if (shot.netFault) return null;
  const pred = predict(contact, shot.vel, shot.stepDt);
  if (pred.hitsNet || !pred.landing || pred.landing.z <= 0) return null;
  return { pos: copy3(contact), vel: shot.vel, stepDt: shot.stepDt, pred, name: shot.name, maxYNear: nearMaxY(pred) };
}

/** 高遠球（後場高點擊出）＋挑球（前中場低點擊出），只留在近側半場最高點 ≥ 3.0 m 的高球 */
function makeHighFeeds(n: number, seed: number): { feeds: Feed[]; rejectedLow: number } {
  const rng = new Rng(seed);
  const feeds: Feed[] = [];
  let rejectedLow = 0;
  while (feeds.length < n) {
    const clear = rng.chance(0.55);
    const contact = clear ? v3(rng.range(-2.2, 2.2), rng.range(2.0, 2.7), -rng.range(4.0, 6.2)) : v3(rng.range(-2.2, 2.2), rng.range(0.4, 1.6), -rng.range(1.0, 4.0));
    const f = shoot(rng, contact, 'up', rng.range(2.0, 6.5), rng.range(-2.3, 2.3));
    if (!f) continue;
    if (f.maxYNear < 3.0) {
      rejectedLow++;
      continue;
    }
    feeds.push(f);
  }
  return { feeds, rejectedLow };
}

// ---------------- 腳本化的人類 ----------------
interface Human {
  lateral: number; // 站在羽球路徑旁多遠（m）
  zOff: number; // 前後誤差（+ = 站後面一點）
  hc: number; // 想在羽球降到多高的地方打（決定站位）
  startX: number;
  startZ: number;
  armAhead: number; // 羽球進入跳躍擊球範圍前多久開始連按兩下按住（模擬秒）
}

function makeHumans(n: number, seed: number, lateral: [number, number] = [0.3, 0.8]): Human[] {
  const rng = new Rng(seed);
  const out: Human[] = [];
  for (let i = 0; i < n; i++)
    out.push({
      lateral: rng.range(lateral[0], lateral[1]),
      zOff: rng.range(-0.15, 0.35),
      hc: rng.range(2.7, 3.1),
      startX: rng.range(-0.6, 0.6),
      startZ: rng.range(3.2, 4.2),
      armAhead: rng.range(0.45, 0.65),
    });
  return out;
}

interface Plan {
  standX: number;
  standZ: number;
  startX: number;
  startZ: number;
  tZone: number; // 預計羽球進入「跳起來擊球範圍」的時間（相對擊出）
  armAt: number;
}

/** 依目前 GAME.jump 算站位與按住時間（站位只看 hc 或 zMark，跟 lead 無關） */
function makePlan(feed: Feed, h: Human, zMark?: number): Plan {
  const pts = feed.pred.points;
  let P = pts[pts.length - 1];
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i].p;
    if (q.z < 0.3) continue;
    const hit = zMark !== undefined ? q.z >= zMark : q.y <= h.hc && q.y < pts[i - 1].p.y;
    if (hit) {
      P = pts[i];
      break;
    }
  }
  const standX = clamp(P.p.x - h.lateral, -3.4, 3.4);
  const standZ = clamp(P.p.z + h.zOff, 0.4, 8.0);
  const top = GAME.reachMaxY + GAME.jump.height;
  let tZone = P.t;
  for (const pt of pts) {
    const q = pt.p;
    if (q.z < 0.05 || q.y < GAME.jump.minShuttleY || q.y > top) continue;
    if (Math.hypot(q.x - standX, q.z - standZ) <= GAME.reach) {
      tZone = pt.t;
      break;
    }
  }
  return { standX, standZ, startX: h.startX, startZ: h.startZ, tZone, armAt: Math.max(REACTION + 0.1, tZone - h.armAhead) };
}

// ---------------- 單次模擬 ----------------
type Outcome = 'air' | 'ground' | 'whiff' | 'none';
interface RunResult {
  outcome: Outcome;
  whiff?: WhiffReason;
  whiffAboveReach?: number; // 揮空當下羽球比「腳 + reachMaxY」高多少
  whiffD?: number; // 揮空當下水平距離
  name?: string;
  quality?: number;
  grade?: HitGrade;
  above?: number; // 擊球點離腳的高度
  contactY?: number;
  fromApex?: number; // 擊球時間 - 最高點時間（模擬秒，負 = 上升中）
  inBounds?: boolean;
  dn?: number;
  drift?: number; // 起跳到擊球的水平位移
  T0: number | null; // 第一次起跳時間
  airtime?: number;
  jumps: number;
  landings: number;
  rejump: boolean; // 落地後又自動起跳
  takeoffZ?: number; // 起跳瞬間羽球 z（近側為正；負 = 還在對面半場）
  takeoffDist?: number; // 起跳瞬間與站位的距離（還沒跑到位）
  earlyPath: boolean; // 還沒自動起跳就划 → 立刻起跳
}

function moveTo(inp: PlayerInput, m: Match, x: number, z: number): void {
  const me = m.players[0];
  const dx = x - me.pos.x;
  const dz = z - me.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) return;
  const s = Math.min(1, d / 0.35);
  inp.moveX = (dx / d) * me.side * s;
  inp.moveY = (-dz / d) * me.side * s;
}

function inBoundsFar(m: Match): boolean {
  const pr = m.shuttle.prediction;
  if (!pr || pr.hitsNet || !pr.landing) return false;
  const L = pr.landing;
  return L.z < 0 && Math.abs(L.x) <= COURT.singlesHalfWidth + 0.03 && Math.abs(L.z) <= COURT.halfLength + 0.03;
}

/** flickAt = null → 一直按住不划（探測自動起跳時間 T0，也測「按住不放」的邊界情況） */
function run(feed: Feed, plan: Plan, flickAt: number | null, seed: number, armAt = plan.armAt): RunResult {
  const m = new Match(DEFAULT_SETTINGS, seed);
  m.drainEvents();
  m.phase = 'rally';
  m.phaseT = 0;
  const me = m.players[0];
  me.pos = v3(plan.startX, 0, plan.startZ);
  me.vel = v3();
  m.players[1].pos = v3(feed.pos.x, 0, feed.pos.z - 0.3);
  const sh = m.shuttle;
  sh.pos = copy3(feed.pos);
  sh.vel = copy3(feed.vel);
  sh.mode = 'flight';
  sh.lastHitter = 1;
  sh.isServe = false;
  sh.stepDt = feed.stepDt;
  sh.launchTime = m.time;
  sh.prediction = feed.pred;
  // 遊戲裡 hit() 之後同一個 tick 會再推進一步，這裡照做，prediction 的時間才對得上
  stepShuttle(sh.pos, sh.vel, sh.stepDt);

  const res: RunResult = { outcome: 'none', T0: null, jumps: 0, landings: 0, rejump: false, earlyPath: false };
  let flicked = false;
  let takeoffPos: Vec3 | null = null;
  const tEnd = feed.pred.landTime + 1.5;
  while (m.time < tEnd) {
    const tNext = m.time + DT;
    const inp = idleInput();
    if (tNext >= REACTION) moveTo(inp, m, plan.standX, plan.standZ);
    let flickTick = false;
    if (!flicked && flickAt !== null && tNext >= flickAt) {
      inp.flick = FLICK_DOWN;
      flicked = flickTick = true;
    } else if (!flicked && tNext >= armAt) {
      inp.charging = true;
      inp.jump = true;
    }
    m.step([inp, idleInput()]);
    for (const e of m.drainEvents()) {
      if (e.type === 'jump' && e.player === 0) {
        if (res.landings > 0) res.rejump = true;
        res.jumps++;
        if (res.T0 === null) {
          res.T0 = m.time;
          takeoffPos = copy3(me.pos);
          res.takeoffZ = sh.pos.z;
          res.takeoffDist = Math.hypot(me.pos.x - plan.standX, me.pos.z - plan.standZ);
          if (flickTick) res.earlyPath = true;
        }
      }
      if (e.type === 'jumpLand' && e.player === 0) {
        if (res.landings === 0 && res.T0 !== null) res.airtime = m.time - res.T0;
        res.landings++;
      }
      if (e.type === 'hit' && e.player === 0) {
        // e.jump = 打出「跳殺」；空中與否看擊球當下的 airborne（擊球判定在 updatePlayer 之後）
        res.outcome = me.airborne ? 'air' : 'ground';
        res.name = e.name;
        res.quality = e.quality;
        res.grade = e.grade;
        res.contactY = e.pos.y;
        res.above = e.pos.y - me.pos.y;
        res.dn = Math.abs(e.pos.z);
        if (res.T0 !== null) res.fromApex = m.time - (res.T0 + jumpApexTime());
        if (takeoffPos) res.drift = Math.hypot(me.pos.x - takeoffPos.x, me.pos.z - takeoffPos.z);
        res.inBounds = inBoundsFar(m);
        return res;
      }
      if (e.type === 'whiff' && e.player === 0) {
        res.outcome = 'whiff';
        res.whiff = e.reason;
        res.whiffAboveReach = sh.pos.y - (me.pos.y + GAME.reachMaxY);
        res.whiffD = Math.hypot(sh.pos.x - me.pos.x, sh.pos.z - me.pos.z);
        if (flickAt !== null) return res;
      }
    }
    if (m.phase !== 'rally' && !me.airborne) break;
  }
  return res;
}

// ---------------- 掃描 ----------------
const DELTAS: number[] = [];
for (let k = -48; k <= 60; k++) DELTAS.push(k * DT); // -0.40 … +0.50 模擬秒，每 tick
const LEADS = [-0.1, -0.075, -0.05, -0.025, 0, 0.025, 0.05, 0.075, 0.1, 0.125, 0.15];

interface Sweep {
  lead: number;
  probes: RunResult[];
  valid: number[]; // 有自動起跳的 feed index
  grid: RunResult[][]; // [δ][feed]
}

function sweep(feeds: Feed[], humans: Human[], lead: number): Sweep {
  GAME.jump.lead = lead;
  const plans = feeds.map((f, i) => makePlan(f, humans[i]));
  const probes = feeds.map((f, i) => run(f, plans[i], null, 1000 + i));
  const valid = probes.map((p, i) => (p.T0 !== null ? i : -1)).filter((i) => i >= 0);
  const grid = DELTAS.map((d, di) =>
    feeds.map((f, i) => {
      const T0 = probes[i].T0;
      if (T0 === null) return probes[i];
      const flickAt = T0 + d;
      // 很早划的話，至少要先按住 0.1 秒才算「已連按兩下」
      return run(f, plans[i], flickAt, 7919 * i + di, Math.min(plans[i].armAt, flickAt - 0.1));
    }),
  );
  return { lead, probes, valid, grid };
}

interface Row {
  n: number;
  air: number;
  jumpSmash: number;
  kill: number; // 空中但打成撲球（離網 < 2.5 m）
  ground: number;
  whiff: Record<string, number>;
  q: number[];
  perfect: number;
  good: number;
  poor: number;
  above: number[];
  contactY: number[];
  fromApex: number[];
  inB: number;
  names: Record<string, number>;
}

function rowStats(rs: RunResult[], valid: number[]): Row {
  const r: Row = { n: 0, air: 0, jumpSmash: 0, kill: 0, ground: 0, whiff: {}, q: [], perfect: 0, good: 0, poor: 0, above: [], contactY: [], fromApex: [], inB: 0, names: {} };
  for (const i of valid) {
    const x = rs[i];
    r.n++;
    if (x.outcome === 'air') {
      r.air++;
      r.names[x.name!] = (r.names[x.name!] ?? 0) + 1;
      if (x.name === '跳殺') r.jumpSmash++;
      if (x.name === '撲球') r.kill++;
      r.q.push(x.quality!);
      if (x.grade === '完美') r.perfect++;
      else if (x.grade === '不錯') r.good++;
      else r.poor++;
      r.above.push(x.above!);
      r.contactY.push(x.contactY!);
      r.fromApex.push(x.fromApex!);
      if (x.inBounds) r.inB++;
    } else if (x.outcome === 'ground') r.ground++;
    else if (x.outcome === 'whiff') r.whiff[x.whiff!] = (r.whiff[x.whiff!] ?? 0) + 1;
    else r.whiff['none'] = (r.whiff['none'] ?? 0) + 1;
  }
  return r;
}

const nearestIdx = (d: number) => DELTAS.reduce((b, x, j) => (Math.abs(x - d) < Math.abs(DELTAS[b] - d) ? j : b), 0);

/** 高斯雜訊：瞄準 δ 時的期望值（用確定性網格捲積；value 回傳 null = 不計入分母） */
function noisy(sw: Sweep, aimIdx: number, value: (x: RunResult) => number | null): number {
  let ws = 0;
  let acc = 0;
  for (let j = 0; j < DELTAS.length; j++) {
    const w = Math.exp(-0.5 * ((DELTAS[j] - DELTAS[aimIdx]) / NOISE) ** 2);
    if (w < 1e-4) continue;
    for (const i of sw.valid) {
      const v = value(sw.grid[j][i]);
      if (v === null) continue;
      acc += w * v;
      ws += w;
    }
  }
  return ws ? acc / ws : NaN;
}

/** δ 在 [lo, hi] 內、ok(row) 成立的最長連續區間 */
function longestRun(rows: Row[], ok: (r: Row) => boolean, lo = -Infinity, hi = Infinity): [number, number] | null {
  let best: [number, number] | null = null;
  let start = -1;
  for (let j = 0; j <= rows.length; j++) {
    const good = j < rows.length && DELTAS[j] >= lo - 1e-9 && DELTAS[j] <= hi + 1e-9 && rows[j].n > 0 && ok(rows[j]);
    if (good && start < 0) start = j;
    if (!good && start >= 0) {
      if (!best || j - 1 - start > best[1] - best[0]) best = [start, j - 1];
      start = -1;
    }
  }
  return best ? [DELTAS[best[0]], DELTAS[best[1]]] : null;
}

/** 起跳後馬上划卻揮空的「死區」：δ > 0 起連續 air < 50% 的區段 */
function deadZone(rows: Row[]): [number, number] | null {
  const j0 = DELTAS.findIndex((d) => d > 1e-9);
  let j = j0;
  while (j < rows.length && rows[j].air / rows[j].n < 0.5) j++;
  return j > j0 ? [DELTAS[j0], DELTAS[j - 1]] : null;
}

interface Summary {
  lead: number;
  takeoff: number;
  early90: [number, number] | null;
  dead: [number, number] | null;
  late90: [number, number] | null;
  perfect50: [number, number] | null;
  medWidth: number;
  aim: number;
  best: Record<string, number>;
  react: Record<string, number>;
  offSpot: number;
  drift: number;
  rejump: number;
  zTakeoffMin: number;
}

function noisyPack(sw: Sweep, j: number): Record<string, number> {
  return {
    air: noisy(sw, j, (x) => (x.outcome === 'air' ? 1 : 0)),
    js: noisy(sw, j, (x) => (x.outcome === 'air' && x.name === '跳殺' ? 1 : 0)),
    kill: noisy(sw, j, (x) => (x.outcome === 'air' && x.name === '撲球' ? 1 : 0)),
    q: noisy(sw, j, (x) => (x.outcome === 'air' ? x.quality! : null)),
    perfect: noisy(sw, j, (x) => (x.outcome === 'air' ? (x.grade === '完美' ? 1 : 0) : null)),
    above: noisy(sw, j, (x) => (x.outcome === 'air' ? x.above! : null)),
    fromApex: noisy(sw, j, (x) => (x.outcome === 'air' ? x.fromApex! : null)),
    inB: noisy(sw, j, (x) => (x.outcome === 'air' ? (x.inBounds ? 1 : 0) : null)),
  };
}

function summarize(sw: Sweep): Summary {
  const rows = DELTAS.map((_, j) => rowStats(sw.grid[j], sw.valid));
  // 瞄準點：限制在網格內側 3σ，避免邊界截斷
  let bestJ = -1;
  let bestScore = -1;
  for (let j = 0; j < DELTAS.length; j += 2) {
    if (DELTAS[j] < DELTAS[0] + 3 * NOISE || DELTAS[j] > DELTAS[DELTAS.length - 1] - 3 * NOISE) continue;
    const pAir = noisy(sw, j, (x) => (x.outcome === 'air' ? 1 : 0));
    const q = noisy(sw, j, (x) => (x.outcome === 'air' ? x.quality! : null));
    const score = pAir * q;
    if (score > bestScore) {
      bestScore = score;
      bestJ = j;
    }
  }
  const takeoffs = sw.probes.filter((p) => p.T0 !== null);
  const widths = sw.valid.map((i) => DELTAS.filter((_, j) => sw.grid[j][i].outcome === 'air').length * DT).sort((a, b) => a - b);
  const drifts = sw.valid.flatMap((i) => sw.grid.map((row) => row[i]).filter((x) => x.outcome === 'air' && x.drift !== undefined).map((x) => x.drift!));
  return {
    lead: sw.lead,
    takeoff: takeoffs.length / sw.probes.length,
    early90: longestRun(rows, (r) => r.air / r.n >= 0.9, -Infinity, 0),
    dead: deadZone(rows),
    late90: longestRun(rows, (r) => r.air / r.n >= 0.9, 1e-6),
    perfect50: longestRun(rows, (r) => r.perfect / r.n >= 0.5),
    medWidth: widths[Math.floor(widths.length / 2)] ?? 0,
    aim: DELTAS[bestJ],
    best: noisyPack(sw, bestJ),
    react: noisyPack(sw, nearestIdx(REACT_AIM)),
    offSpot: takeoffs.filter((p) => p.takeoffDist! > 0.3).length / Math.max(1, takeoffs.length),
    drift: mean(drifts),
    rejump: takeoffs.filter((p) => p.rejump).length / Math.max(1, takeoffs.length),
    zTakeoffMin: Math.min(...takeoffs.map((p) => p.takeoffZ!)),
  };
}

const win = (w: [number, number] | null) => (w ? `${realMs(w[0])}~${realMs(w[1])}` : '—');

function printSummary(list: Summary[]): void {
  console.log('  [A] 無雜訊 δ 區間（真實 ms，相對自動起跳）');
  console.log('  lead    起跳%  早划(δ≤0)空中≥90%  起跳後死區(空中<50%)  晚划空中≥90%  完美≥50%   每球空中寬(中位)  起跳時離站位>0.3m  空中漂移m  落地再跳  起跳時羽球z最小');
  for (const s of list)
    console.log(
      `  ${pad((s.lead >= 0 ? '+' : '') + s.lead.toFixed(3), 6)} ${pad(pct(s.takeoff, 1), 5)}  ${pad(win(s.early90), 17)}  ${pad(win(s.dead), 19)}  ${pad(win(s.late90), 12)}  ${pad(win(s.perfect50), 9)}  ${pad(realMs(s.medWidth), 14)}ms  ${pad(pct(s.offSpot, 1), 17)}  ${pad(f2(s.drift), 9)}  ${pad(pct(s.rejump, 1), 8)}  ${pad(f2(s.zTakeoffMin), 8)}`,
    );
  console.log(`  [B] 有雜訊 σ=${realMs(NOISE)}ms：最佳瞄準點 ｜ 看到起跳再划（瞄準 +${realMs(REACT_AIM)}ms）`);
  console.log('  lead    瞄準ms  空中%  跳殺%  撲球%  品質  完美%  離腳高m  距apex ms  界內% ｜ 空中%  跳殺%  品質  完美%  距apex ms');
  for (const s of list) {
    const b = s.best;
    const r = s.react;
    console.log(
      `  ${pad((s.lead >= 0 ? '+' : '') + s.lead.toFixed(3), 6)} ${pad(realMs(s.aim), 6)}  ${pad(pct(b.air, 1), 5)}  ${pad(pct(b.js, 1), 5)}  ${pad(pct(b.kill, 1), 5)}  ${f2(b.q)}  ${pad(pct(b.perfect, 1), 5)}  ${pad(f2(b.above), 7)}  ${pad(realMs(b.fromApex), 9)}  ${pad(pct(b.inB, 1), 5)} ｜ ${pad(pct(r.air, 1), 5)}  ${pad(pct(r.js, 1), 5)}  ${f2(r.q)}  ${pad(pct(r.perfect, 1), 5)}  ${pad(realMs(r.fromApex), 9)}`,
    );
  }
}

function printDetail(sw: Sweep, title: string): void {
  console.log(`\n  δ 掃描（${title}；無雜訊；n=${sw.valid.length} 球有自動起跳；δ≤0 走「先划→立刻起跳」路徑）`);
  console.log('  δ sim   δ real |  空中  跳殺  地面  揮空 早/晚/遠/高/低 | 品質  完美/不錯/勉強 | 離腳高 擊球高 距apex ms 界內 | 空中球種');
  for (let j = 0; j < DELTAS.length; j++) {
    const k = Math.round(DELTAS[j] / DT);
    if (k % 3 !== 0 && !(k > 0 && k <= 9)) continue;
    const r = rowStats(sw.grid[j], sw.valid);
    const w = r.whiff;
    const wh = ['太早', '太晚', '太遠', '太高', '太低'].map((key) => pad(w[key] ?? 0, 2)).join('/');
    const names = Object.entries(r.names)
      .sort((a, b) => b[1] - a[1])
      .map(([key, v]) => `${key}${v}`)
      .join(' ');
    console.log(
      `  ${pad((DELTAS[j] >= 0 ? '+' : '') + DELTAS[j].toFixed(3), 6)} ${pad(realMs(DELTAS[j]), 6)}ms | ${pad(pct(r.air, r.n), 4)} ${pad(pct(r.jumpSmash, r.n), 4)} ${pad(pct(r.ground, r.n), 4)}  ${wh} | ${f2(mean(r.q))}  ${pad(pct(r.perfect, r.air), 4)}/${pad(pct(r.good, r.air), 4)}/${pad(pct(r.poor, r.air), 4)} | ${pad(f2(mean(r.above)), 5)}  ${pad(f2(mean(r.contactY)), 5)}  ${pad(realMs(mean(r.fromApex)), 7)}  ${pad(pct(r.inB, r.air), 4)} | ${names}${w.none ? ` (none ${w.none})` : ''}`,
    );
  }
}

// ---------------- 主程式 ----------------
const N = Number(process.argv[2] ?? 100);
const base = { height: GAME.jump.height, gravity: GAME.jump.gravity, lead: GAME.jump.lead, minShuttleY: GAME.jump.minShuttleY };
const PAIRS: [number, number][] =
  process.env.PAIRS === 'default'
    ? [[base.height, base.gravity]]
    : [
        [base.height, base.gravity],
        [0.42, 12],
        [0.55, 16],
        [0.35, 20],
      ];

const { feeds, rejectedLow } = makeHighFeeds(N, 2024);
const humans = makeHumans(N, 77);
const names: Record<string, number> = {};
for (const f of feeds) names[f.name] = (names[f.name] ?? 0) + 1;
console.log(`發球機：${feeds.length} 顆高球 ${JSON.stringify(names)}（另有 ${rejectedLow} 顆近側最高點 < 3.0 m 的低球被丟掉）`);
console.log(`落點 z ${f2(Math.min(...feeds.map((f) => f.pred.landing!.z)))}~${f2(Math.max(...feeds.map((f) => f.pred.landing!.z)))}，x ${f2(Math.min(...feeds.map((f) => f.pred.landing!.x)))}~${f2(Math.max(...feeds.map((f) => f.pred.landing!.x)))}`);
console.log(`δ = 划動時間 − 自動起跳時間（δ ≤ 0：還沒起跳就划 → 立刻起跳）。所有 ms 都是真實時間（模擬秒 / ${GAME.simSpeed}）。`);
const t0 = performance.now();

const allSummaries: { pair: [number, number]; list: Summary[]; sweeps: Sweep[] }[] = [];
for (const [h, g] of PAIRS) {
  GAME.jump.height = h;
  GAME.jump.gravity = g;
  const apex = jumpApexTime();
  console.log(`\n===== 跳躍高度 ${h} m、重力 ${g}：到最高點 ${realMs(apex)} ms，滯空 ${realMs(2 * apex)} ms（真實） =====`);
  const sweeps = LEADS.map((lead) => sweep(feeds, humans, lead));
  const list = sweeps.map(summarize);
  printSummary(list);
  allSummaries.push({ pair: [h, g], list, sweeps });
  if (process.env.DETAIL) for (const sw of sweeps) printDetail(sw, `h=${h} g=${g} lead=${sw.lead}`);
}

// 目前高度/重力：印 lead=目前值、-0.05、+0.05 的完整 δ 表
if (!process.env.DETAIL) {
  const def = allSummaries[0];
  GAME.jump.height = def.pair[0];
  GAME.jump.gravity = def.pair[1];
  for (const lead of [base.lead, -0.05, 0.05]) {
    const sw = def.sweeps.find((s) => Math.abs(s.lead - lead) < 1e-9);
    if (sw) printDetail(sw, `h=${def.pair[0]} g=${def.pair[1]} lead=${lead}${lead === base.lead ? '（目前設定）' : ''}`);
  }
}
console.log(`\n主掃描耗時 ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// ---------------- 邊界情況 ----------------
GAME.jump.height = base.height;
GAME.jump.gravity = base.gravity;
GAME.jump.lead = base.lead;
const reactFlick = (T0: number) => T0 + REACT_AIM;
console.log(`\n===== 邊界情況（h=${base.height} g=${base.gravity} lead=${base.lead}；划動 = 起跳後 ${realMs(REACT_AIM)} ms） =====`);

// E1：一直按住不划 → 會不會落地後又自動起跳、會不會沒落地
{
  console.log('\n[E1] 按住跳殺不划');
  for (const lead of [-0.1, 0, 0.15]) {
    GAME.jump.lead = lead;
    let n = 0;
    let jumps = 0;
    let rej = 0;
    let noLand = 0;
    const air: number[] = [];
    feeds.forEach((f, i) => {
      const r = run(f, makePlan(f, humans[i]), null, 1000 + i);
      if (r.T0 === null) return;
      n++;
      jumps += r.jumps;
      if (r.rejump) rej++;
      if (r.landings < r.jumps) noLand++;
      if (r.airtime !== undefined) air.push(r.airtime);
    });
    console.log(`  lead ${lead >= 0 ? '+' : ''}${lead.toFixed(2)}：${n} 球起跳，平均 ${(jumps / n).toFixed(2)} 跳，落地再跳 ${rej}，沒落地 ${noLand}，滯空 ${realMs(Math.min(...air))}~${realMs(Math.max(...air))} ms`);
  }
  GAME.jump.lead = base.lead;
}

// E2：平球／殺球／低挑球來球時按住跳殺 → 會不會亂跳、跳了打出什麼；並測 minShuttleY
{
  console.log('\n[E2] 非高球來球時「誤按」跳殺（擊出 0.3 s 後就按住，站在羽球經過 z≈3.5 處旁 0.5 m），依 minShuttleY');
  const rng = new Rng(99);
  const gen = (label: string, mk: () => Feed | null): [string, Feed[]] => {
    const fs: Feed[] = [];
    let guard = 0;
    while (fs.length < 60 && guard++ < 5000) {
      const f = mk();
      if (f) fs.push(f);
    }
    return [label, fs];
  };
  const sets: [string, Feed[]][] = [
    gen('平抽/平高', () => shoot(rng, v3(rng.range(-2, 2), rng.range(1.0, 2.2), -rng.range(2.5, 5.5)), 'side', rng.range(3.5, 6.3), rng.range(-2, 2))),
    gen('對手殺球', () => shoot(rng, v3(rng.range(-2, 2), rng.range(2.3, 2.8), -rng.range(3.5, 6.0)), 'down', rng.range(3.5, 6.0), rng.range(-2, 2))),
    gen('低挑球', () => {
      const f = shoot(rng, v3(rng.range(-2, 2), rng.range(0.4, 1.4), -rng.range(1.0, 3.5)), 'up', rng.range(2.0, 6.0), rng.range(-2, 2));
      return f && f.maxYNear < 3.0 ? f : null;
    }),
  ];
  for (const minY of [base.minShuttleY, 2.0, 2.3, 2.6]) {
    GAME.jump.minShuttleY = minY;
    const parts: string[] = [];
    for (const [label, fs] of sets) {
      const hs = makeHumans(fs.length, 5, [0.5, 0.5]);
      let take = 0;
      let oppSide = 0;
      let smash = 0;
      let air = 0;
      const nm: Record<string, number> = {};
      fs.forEach((f, i) => {
        const plan = makePlan(f, { ...hs[i], hc: 0 }, 3.5);
        plan.armAt = 0.3;
        const probe = run(f, plan, null, 500 + i);
        if (probe.T0 === null) return;
        take++;
        if (probe.takeoffZ! < 0) oppSide++;
        const r = run(f, plan, reactFlick(probe.T0), 600 + i);
        if (r.outcome !== 'air') return;
        air++;
        nm[r.name!] = (nm[r.name!] ?? 0) + 1;
        if (r.name === '跳殺') smash++;
      });
      const top = Object.entries(nm)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}${v}`)
        .join(' ');
      parts.push(`${label} 起跳${take}/${fs.length}（對面${oppSide}）空中${air} 跳殺${smash} [${top}]`);
    }
    // 高球主樣本：minShuttleY 會不會讓該跳的球不跳
    let take = 0;
    let air = 0;
    let perfect = 0;
    feeds.forEach((f, i) => {
      const plan = makePlan(f, humans[i]);
      const probe = run(f, plan, null, 1000 + i);
      if (probe.T0 === null) return;
      take++;
      const r = run(f, plan, reactFlick(probe.T0), 2000 + i);
      if (r.outcome === 'air') air++;
      if (r.outcome === 'air' && r.grade === '完美') perfect++;
    });
    console.log(`  minShuttleY ${minY.toFixed(1)}：${parts.join('；')}；高球主樣本 起跳 ${take}/${feeds.length} 空中 ${air} 完美 ${perfect}`);
  }
  GAME.jump.minShuttleY = base.minShuttleY;
}

// E3：站太遠（羽球從 1.0~1.3 m 外經過）
{
  console.log('\n[E3] 站太遠（羽球從身旁 1.0~1.3 m 經過）');
  const hs = makeHumans(feeds.length, 31, [1.0, 1.3]);
  let take = 0;
  let air = 0;
  const wr: Record<string, number> = {};
  const off: number[] = [];
  feeds.forEach((f, i) => {
    const plan = makePlan(f, hs[i]);
    const probe = run(f, plan, null, 300 + i);
    if (probe.T0 === null) return;
    take++;
    const r = run(f, plan, reactFlick(probe.T0), 400 + i);
    if (r.outcome === 'air') air++;
    if (r.outcome === 'whiff') {
      wr[r.whiff!] = (wr[r.whiff!] ?? 0) + 1;
      off.push(probe.takeoffDist!);
    }
  });
  console.log(`  ${feeds.length} 球：自動起跳 ${take}；空中擊中 ${air}；起跳了卻揮空 ${take - air} ${JSON.stringify(wr)}（這些球起跳時離站位平均 ${f2(mean(off))} m = 還在跑）`);
}

// E4：按住時間（連按兩下到划動）vs 跳殺落點界內
{
  console.log('\n[E4] 連按兩下按住到划動的時間 → 跳殺是否出界（armAhead 相對羽球進入跳躍範圍）');
  for (const ah of [0.3, 0.4, 0.5, 0.6, 0.8, 1.0]) {
    let air = 0;
    let inB = 0;
    let js = 0;
    let cut = 0;
    const holds: number[] = [];
    feeds.forEach((f, i) => {
      const plan = makePlan(f, { ...humans[i], armAhead: ah });
      const probe = run(f, plan, null, 1000 + i);
      if (probe.T0 === null) return;
      const flickAt = reactFlick(probe.T0);
      holds.push(flickAt - plan.armAt);
      const r = run(f, plan, flickAt, 2000 + i);
      if (r.outcome !== 'air') return;
      air++;
      if (r.name === '跳殺') {
        js++;
        if (r.inBounds) inB++;
      }
      if (r.name === '切球') cut++;
    });
    console.log(`  armAhead ${realMs(ah)} ms → 按住到划 平均 ${realMs(mean(holds))} ms：空中 ${air}，跳殺 ${js}（界內 ${pct(inB, js)}），切球 ${cut}`);
  }
}

// E5：主掃描中空中擊中的球種（為什麼不是跳殺）
{
  const sw = allSummaries[0].sweeps.find((s) => Math.abs(s.lead - base.lead) < 1e-9);
  if (sw) {
    const near: Record<string, number> = {};
    const far: Record<string, number> = {};
    for (const row of sw.grid)
      for (const i of sw.valid) {
        const x = row[i];
        if (x.outcome !== 'air') continue;
        const t = x.dn! < 2.5 ? near : far;
        t[x.name!] = (t[x.name!] ?? 0) + 1;
      }
    console.log('\n[E5] 主掃描（目前 lead，所有 δ）空中擊中的球種：離網 < 2.5 m', near, '；≥ 2.5 m', far);
  }
}

// E6：先划→立刻起跳，但跳太早：揮空原因標示
{
  console.log('\n[E6] 太早划（δ = -300 ~ -200 ms）揮空：顯示的原因 vs 揮空當下羽球是否還在擊球範圍上方');
  const sw = allSummaries[0].sweeps.find((s) => Math.abs(s.lead - base.lead) < 1e-9);
  if (sw) {
    const lab: Record<string, number> = {};
    let stillAbove = 0;
    let n = 0;
    DELTAS.forEach((d, j) => {
      if (realMs(d) < -300 || realMs(d) > -200) return;
      for (const i of sw.valid) {
        const x = sw.grid[j][i];
        if (x.outcome !== 'whiff') continue;
        n++;
        lab[x.whiff!] = (lab[x.whiff!] ?? 0) + 1;
        if (x.whiffAboveReach! > 0 && x.whiffD! <= GAME.reach) stillAbove++;
      }
    });
    console.log(`  ${n} 次揮空，標示 ${JSON.stringify(lab)}；其中羽球在水平範圍內但還高於「腳 + ${GAME.reachMaxY}」(= 其實是跳太早) ${stillAbove}`);
  }
}

GAME.jump.height = base.height;
GAME.jump.gravity = base.gravity;
GAME.jump.lead = base.lead;
GAME.jump.minShuttleY = base.minShuttleY;
console.log(`\n總耗時 ${((performance.now() - t0) / 1000).toFixed(1)} s`);
