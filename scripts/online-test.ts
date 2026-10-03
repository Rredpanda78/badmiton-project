// 無畫面測試線上同步：兩台「手機」各跑一場比賽，各自的 AI 控制自己的球員，
// 中間用有延遲的假網路接起來，檢查兩邊比分一致、不會卡住。
// 執行：npx tsx scripts/online-test.ts [單程延遲毫秒=60] [場數=3]
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, GAME, PHYS } from '../src/config';
import { Match } from '../src/sim/match';
import type { PeerMsg } from '../src/net/protocol';
import { OnlineSync } from '../src/net/sync';

const latMs = Number(process.argv[2] ?? 60);
const games = Number(process.argv[3] ?? 3);
const tickMs = (PHYS.dt / GAME.simSpeed) * 1000; // 一個 tick 的真實時間
const delayTicks = Math.max(1, Math.round(latMs / tickMs));

let ok = 0;
for (let g = 0; g < games; g++) {
  const mk = (seed: number) => {
    const m = new Match({ ...DEFAULT_SETTINGS, points: 21 }, seed);
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
  const aiA = new AIController(A, 0, 'hard');
  const aiB = new AIController(B, 0, 'hard');
  let maxAwait = 0;
  let awaitT = [0, 0];
  let hits = 0;
  let netHitsLate = 0;
  for (; tick < 120 * 60 * 30 && !(A.phase === 'matchOver' && B.phase === 'matchOver'); tick++) {
    while (queue.length && queue[0].at <= tick) {
      const q = queue.shift()!;
      (q.to === 'A' ? sA : sB).receive(q.msg);
    }
    A.step([aiA.input(), { moveX: 0, moveY: 0, charging: false, jump: false, flick: null, dive: null }]);
    // 第四個參數 drift：B 每 700 tick 卡住 40 tick（模擬手機掉幀、時間落後）
    const frozen = process.argv[4] === 'drift' && tick % 700 < 40;
    if (!frozen) B.step([aiB.input(), { moveX: 0, moveY: 0, charging: false, jump: false, flick: null, dive: null }]);
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
}
console.log(`延遲 ${latMs}ms（${delayTicks} tick）：${ok}/${games} 場兩邊結果一致`);
