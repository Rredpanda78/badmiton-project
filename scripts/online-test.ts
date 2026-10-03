// 無畫面測試線上同步：兩台「手機」各跑一場比賽，各自的 AI 控制自己的球員，
// 中間用有延遲的假網路接起來，檢查兩邊比分一致、不會卡住。
// 執行：npx tsx scripts/online-test.ts [單程延遲毫秒=60] [場數=3]
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, GAME, PHYS } from '../src/config';
import { Match } from '../src/sim/match';
import type { PeerMsg } from '../src/net/protocol';
import { OnlineSync } from '../src/net/sync';

const latMs = Number(process.argv[2] ?? 60);
// 例：ONLINE='{"dilate":false,"holdScale":1}' 試不同的延遲處理
if (process.env.ONLINE) Object.assign(GAME.online, JSON.parse(process.env.ONLINE));
const games = Number(process.argv[3] ?? 3);
const tickMs = (PHYS.dt / GAME.simSpeed) * 1000; // 一個 tick 的真實時間
const delayTicks = Math.max(1, Math.round(latMs / tickMs));

// 第四個參數 doubles：線上雙打（雙方各帶一個 AI 隊友：本機 0 號＋2 號，對方 1、3 號）
const doubles = process.argv[4] === 'doubles';
let ok = 0;
for (let g = 0; g < games; g++) {
  const mk = (seed: number) => {
    const m = new Match({ ...DEFAULT_SETTINGS, points: 21, doubles }, seed);
    m.remote = 1;
    return m;
  };
  const A = mk(10 + g);
  const B = mk(900 + g);
  A.server = 0; // A 是房主先發
  B.server = 1;
  A.setupServe();
  B.setupServe();
  const queue: { at: number; to: 'A' | 'B'; msg: PeerMsg }[] = [];
  let tick = 0;
  const clock = () => tick * tickMs;
  const sA = new OnlineSync(A, (msg) => queue.push({ at: tick + delayTicks, to: 'B', msg: JSON.parse(JSON.stringify(msg)) }), clock);
  const sB = new OnlineSync(B, (msg) => queue.push({ at: tick + delayTicks, to: 'A', msg: JSON.parse(JSON.stringify(msg)) }), clock);
  // 每台手機控制自己這隊：0 號（玩家，這裡用 AI 代打）＋雙打時 2 號 AI 隊友
  const own = (m: Match) => (doubles ? [0, 2] : [0]).map((id) => new AIController(m, id as 0 | 2, 'hard'));
  const aiA = own(A);
  const aiB = own(B);
  const inputs = (m: Match, ais: AIController[]) => m.players.map((p) => (m.isRemote(p.id) ? { moveX: 0, moveY: 0, charging: false, jump: false, flick: null, dive: null } : ais[p.id === 0 ? 0 : 1].input()));
  let maxAwait = 0;
  const jumps: number[] = [];
  const lowest: number[] = [];
  let awaitT = [0, 0];
  let hits = 0;
  let netHitsLate = 0;
  for (; tick < 120 * 60 * 30 && !(A.phase === 'matchOver' && B.phase === 'matchOver'); tick++) {
    while (queue.length && queue[0].at <= tick) {
      const q = queue.shift()!;
      if (q.msg.t === 'hit' && !q.msg.s) {
        // 收到對方擊球前，本機的球在哪：跟對方擊球點差多遠（瞬移距離）、離地多高
        const M = q.to === 'A' ? A : B;
        const c = q.msg.c;
        jumps.push(Math.hypot(M.shuttle.pos.x + c[0], M.shuttle.pos.y - c[1], M.shuttle.pos.z + c[2]));
        lowest.push(M.shuttle.pos.y);
      }
      (q.to === 'A' ? sA : sB).receive(q.msg);
    }
    A.step(inputs(A, aiA));
    // 第四個參數 drift：B 每 700 tick 卡住 40 tick（模擬手機掉幀、時間落後）
    const frozen = process.argv[4] === 'drift' && tick % 700 < 40;
    if (!frozen) B.step(inputs(B, aiB));
    for (const [m, s, i] of [[A, sA, 0], [B, sB, 1]] as const) {
      for (const e of m.drainEvents()) {
        s.onEvent(e);
        if (e.type === 'hit' && e.player === 0) hits++;
        if (e.type === 'land' && m.phase === 'await') void 0;
      }
      s.afterStep();
      awaitT[i] = m.phase === 'await' ? awaitT[i] + PHYS.dt : 0;
      maxAwait = Math.max(maxAwait, awaitT[i]);
    }
    void netHitsLate;
  }
  const same = A.games[0] === B.games[1] && A.games[1] === B.games[0];
  if (same && A.phase === 'matchOver') ok++;
  console.log(`第 ${g + 1} 場：A 局數 ${A.games} 比分 ${A.score}｜B 局數 ${B.games} 比分 ${B.score}｜${same ? '一致' : '不一致！'}｜擊球 ${hits}｜等判定最久 ${maxAwait.toFixed(2)}s｜RTT ${sA.rttMs.toFixed(0)}ms｜${A.phase}/${B.phase}`);
  jumps.sort((a, b) => a - b);
  const pct = (a: number[], f: number) => (a.length ? a[Math.floor(a.length * f)].toFixed(2) : '-');
  console.log(`  收到對方擊球時，本機的球跳回擊球點的距離：中位 ${pct(jumps, 0.5)} m、90% ${pct(jumps, 0.9)} m、最大 ${pct(jumps, 0.999)} m；當下球離地 中位 ${pct(lowest.sort((a, b) => a - b), 0.5)} m、最低 10% ${pct(lowest, 0.1)} m`);
}
console.log(`延遲 ${latMs}ms（${delayTicks} tick）：${ok}/${games} 場兩邊結果一致`);
