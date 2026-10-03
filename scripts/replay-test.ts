// 無畫面測試得分回放：
// 1. 同一個種子的比賽跑兩次（一次每個 tick 錄影、得分時整段回放都播完；一次完全不碰回放），
//    比對每個事件、最後的比分／時間／位置／亂數狀態要一模一樣（回放不能改到比賽）
// 2. 只有主動得分（落地得分、發球得分）會回放；掛網、出界、未過網、發球失誤不會
// 3. 回放長度約 3 秒、致勝擊球那一格有慢動作、檢視用比賽跟真正的比賽是不同物件
// 4. 錄影每個 tick 的成本
// 執行：npx tsx scripts/replay-test.ts [difficulty=normal] [分數=21]
import { AIController } from '../src/ai/ai';
import { ballTaker } from '../src/ai/doubles';
import { DEFAULT_SETTINGS, GAME, PHYS, type Difficulty } from '../src/config';
import { predictContact, type ContactHint } from '../src/render/anim/contact';
import { isWinner, ReplayPlayer, ReplayRecorder } from '../src/render/replay';
import { idleInput, Match, type MatchEvent, type PlayerId, type TeamId } from '../src/sim/match';

const diff = (process.argv[2] as Difficulty) ?? 'normal';
const points = Number(process.argv[3] ?? 21) as 11 | 15 | 21;

let fails = 0;
const fail = (msg: string) => {
  fails++;
  if (fails <= 20) console.log('✘ ' + msg);
};

interface Stats {
  replays: number;
  winners: number;
  others: Record<string, number>;
  durations: number[];
  shots: Record<string, number>;
  recordUs: number;
  recordN: number;
  playMs: number;
}

/** 比賽的完整狀態（比對用） */
function stateKey(m: Match): string {
  return JSON.stringify({
    score: m.score,
    games: m.games,
    server: m.server,
    phase: m.phase,
    phaseT: m.phaseT,
    time: m.time,
    hitSerial: m.hitSerial,
    rallyHits: m.rallyHits,
    rng: (m.rng as unknown as { s: number }).s,
    players: m.players.map((p) => ({ ...p, kit: undefined })),
    shuttle: { ...m.shuttle, prediction: m.shuttle.prediction ? m.shuttle.prediction.landTime : null },
  });
}

/**
 * 跑一場：withReplay = 照 main.ts 的流程錄影＋回放（回放期間比賽不推進，播的是檢視用比賽）。
 * 回傳整場事件的序列化字串、最後狀態
 */
function run(doubles: boolean, seed: number, withReplay: boolean, st: Stats): { events: string; final: string; ticks: number } {
  const m = new Match({ ...DEFAULT_SETTINGS, difficulty: diff, points, games: 1, doubles }, seed);
  const bots = m.players.map((p) => new AIController(m, p.id, diff));
  const rec = new ReplayRecorder();
  let pending: { hit: NonNullable<ReplayRecorder['lastHit']>; land: NonNullable<ReplayRecorder['lastLand']> } | null = null;
  const hints: ContactHint[] = [0, 1, 2, 3].map(() => ({ t: 0, x: 0, y: 0, z: 0, d: 0 }));
  const log: string[] = [];
  let ticks = 0;
  let over = 0; // 比賽結束後再跑 1 模擬秒（最後一分的回放在結束後 delay 秒才播；兩種跑法都一樣多 tick）
  while (over < 120 && ticks < 120 * 60 * 40) {
    m.step(m.players.map((p) => bots[p.id]?.input() ?? idleInput()));
    ticks++;
    if (m.phase === 'matchOver') over++;
    const events = m.drainEvents();
    if (withReplay) {
      const t0 = performance.now();
      rec.record(m, events);
      st.recordUs += (performance.now() - t0) * 1000;
      st.recordN++;
    }
    for (const e of events) {
      log.push(JSON.stringify(e));
      if (e.type !== 'point') continue;
      const win = isWinner(e);
      if (win) st.winners += withReplay ? 1 : 0;
      else if (withReplay) st.others[e.reason] = (st.others[e.reason] ?? 0) + 1;
      if (!withReplay) continue;
      const hit = rec.lastHit;
      const land = rec.lastLand;
      if (win) {
        if (!hit || !land || land.tick !== rec.lastTick || !land.e.inBounds) fail(`主動得分卻找不到致勝球／落地（${e.reason}）`);
        else if (m.teamOf(hit.e.player) !== e.winner) fail(`致勝球不是得分那一隊打的（${e.reason}）`);
        else pending = { hit, land };
      } else if (land && land.tick === rec.lastTick && land.e.inBounds && hit && m.teamOf(hit.e.player) === e.winner) {
        fail(`${e.reason} 看起來像主動得分卻沒回放`);
      }
    }
    // 得分暫停 delay 秒後開始回放（main.ts 的 replayDue）
    if (pending && (m.phase === 'point' || m.phase === 'matchOver') && m.phaseT >= GAME.replay.delay) {
      const before = stateKey(m);
      const t0 = performance.now();
      const p = ReplayPlayer.create(rec, m, pending.hit, pending.land);
      pending = null;
      if (!p) {
        fail('ReplayPlayer.create 失敗（緩衝區不夠？）');
        continue;
      }
      if (p.view === m || p.view.players === m.players || p.view.shuttle === m.shuttle) fail('檢視用比賽跟真正的比賽共用物件');
      st.replays++;
      st.shots[p.shot.name] = (st.shots[p.shot.name] ?? 0) + 1;
      let real = 0;
      let minSpeed = Infinity; // 擊球前後的播放速度（模擬秒／真實秒）
      let hitFired = false;
      let landFired = false;
      let lastSince = p.sinceHit;
      for (let i = 0; i < 60 * 10 && !p.done; i++) {
        p.aspect = i % 2 ? 0.46 : 1.78; // 直向、橫向的鏡頭都算到
        const { events: evs } = p.update(1 / 60);
        real += 1 / 60;
        const since = p.sinceHit;
        if (Math.abs(since) < 0.04) minSpeed = Math.min(minSpeed, ((since - lastSince) * 60) / GAME.simSpeed);
        lastSince = since;
        for (const e of evs) {
          if (e === p.shot) hitFired = true;
          if (e.type === 'land') landFired = true;
          if (e.type === 'point' || e.type === 'game' || e.type === 'match' || e.type === 'serveStart') fail(`回放重播了不該重播的事件 ${e.type}`);
        }
        // 畫面每幀會做的唯讀計算
        const v = p.view;
        v.players.forEach((pl, k) => predictContact(v, pl.id, hints[k]));
        if (v.doubles) for (const t of [0, 1] as TeamId[]) ballTaker(v, t);
        const c = p.cam;
        if (![c.pos.x, c.pos.y, c.pos.z, c.look.x, c.look.y, c.look.z, c.fov].every(Number.isFinite)) fail('鏡頭算出 NaN');
        if (c.pos.y < 0.2) fail(`鏡頭鑽到地板下 y=${c.pos.y.toFixed(2)}`);
        if (Math.abs(c.pos.x) > 4.35 || c.pos.z > 8.85 || c.pos.z < -7.25 || (c.pos.z < -5.8 && c.pos.y > 1.85)) fail(`鏡頭跑太遠 (${c.pos.x.toFixed(1)}, ${c.pos.z.toFixed(1)})`);
      }
      st.playMs += performance.now() - t0;
      st.durations.push(real);
      if (!p.done) fail('回放播不完');
      if (!hitFired) fail(`回放沒有重播致勝擊球 ${p.shot.name}`);
      if (!landFired) fail('回放沒有重播落地');
      if (minSpeed > GAME.replay.slow * 1.6) fail(`擊球瞬間沒有慢動作（${minSpeed.toFixed(2)}×）`);
      if (stateKey(m) !== before) fail('回放改到了比賽狀態！');
    }
  }
  return { events: log.join('\n'), final: stateKey(m), ticks };
}

const newStats = (): Stats => ({ replays: 0, winners: 0, others: {}, durations: [], shots: {}, recordUs: 0, recordN: 0, playMs: 0 });
for (const doubles of [false, true]) {
  for (const seed of [11, 2024]) {
    const st = newStats();
    const a = run(doubles, seed, true, st);
    const b = run(doubles, seed, false, newStats());
    const label = `${doubles ? '雙打' : '單打'} seed=${seed}`;
    if (a.events !== b.events) fail(`${label}：有回放／沒回放的事件不一樣`);
    if (a.final !== b.final) fail(`${label}：有回放／沒回放的最後狀態不一樣`);
    if (a.ticks !== b.ticks) fail(`${label}：tick 數不一樣 ${a.ticks} vs ${b.ticks}`);
    if (st.replays !== st.winners) fail(`${label}：主動得分 ${st.winners} 分，回放 ${st.replays} 次`);
    const d = st.durations;
    const avg = d.reduce((x, y) => x + y, 0) / Math.max(1, d.length);
    if (d.some((x) => x < 1.8 || x > 4.2)) fail(`${label}：回放長度超出範圍 ${Math.min(...d).toFixed(2)}～${Math.max(...d).toFixed(2)} 秒`);
    console.log(
      `${label}：${a.ticks} ticks，事件與最後狀態一致=${a.events === b.events && a.final === b.final}；` +
        `回放 ${st.replays} 次（非主動得分 ${JSON.stringify(st.others)}），長度 ${Math.min(...d).toFixed(2)}～${Math.max(...d).toFixed(2)} 秒（平均 ${avg.toFixed(2)}）；` +
        `錄影 ${(st.recordUs / st.recordN).toFixed(2)} µs/tick；建立＋播完一段回放平均 ${(st.playMs / Math.max(1, st.replays)).toFixed(1)} ms`,
    );
    console.log('  回放球種', st.shots);
  }
}

// 主動得分判定的單元檢查
const pt = (reason: string, byRemote = false): MatchEvent => ({ type: 'point', winner: 0, reason, byRemote });
for (const r of ['落地得分', '發球得分']) if (!isWinner(pt(r))) fail(`${r} 應該回放`);
for (const r of ['掛網', '未過網', '出界', '發球失誤']) if (isWinner(pt(r))) fail(`${r} 不應該回放`);
if (isWinner(pt('落地得分', true))) fail('線上對方判定的分數不應該回放');
void (0 as PlayerId);
void PHYS;

console.log(fails ? `\n✘ ${fails} 項失敗` : '\n✔ 全部通過');
process.exit(fails ? 1 : 0);
