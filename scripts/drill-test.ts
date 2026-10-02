// 無畫面測試訓練關卡：用「自動跑位 + 算好時機出拍」的機器人打每一關，檢查餵球與判定是否合理。
// 執行：npx tsx scripts/drill-test.ts
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, GAME, timeForCharge } from '../src/config';
import { DRILLS, DrillRunner } from '../src/modes/drills';
import { idleInput, Match, type PlayerInput } from '../src/sim/match';
import { chargeForDepth, type Flick } from '../src/sim/shots';

const FLICK: Record<string, { flick: Flick; depth: number; jump?: boolean }> = {
  clear: { flick: { x: 0, y: 1 }, depth: 6.0 },
  smash: { flick: { x: 0, y: -1 }, depth: 4.2 },
  net: { flick: { x: 0, y: -1 }, depth: 1.1 },
  defend: { flick: { x: 0, y: 1 }, depth: 5.0 },
  drive: { flick: { x: 1, y: 0.05 }, depth: 5.0 },
  jump: { flick: { x: 0, y: -1 }, depth: 4.2, jump: true },
};

for (const d of DRILLS) {
  const match = new Match({ ...DEFAULT_SETTINGS, practice: true }, 7);
  const mover = new AIController(match, 0, 'hard', true);
  const msgs: Record<string, number> = {};
  let finished: [number, number] | null = null;
  const runner = new DrillRunner(
    match,
    d,
    (r) => (msgs[r.msg] = (msgs[r.msg] ?? 0) + 1),
    (ok, stars) => (finished = [ok, stars]),
  );
  const plan = FLICK[d.id];
  let flickAt = -1;
  let chargeFrom = -1;
  let seen = -1;
  for (let tick = 0; tick < 120 * 120 && !finished; tick++) {
    runner.tick(PHYS_DT_REAL);
    const inp: PlayerInput = idleInput();
    const mv = mover.input();
    inp.moveX = mv.moveX;
    inp.moveY = mv.moveY;
    const sh = match.shuttle;
    if (sh.lastHitter === 1 && match.hitSerial !== seen && sh.prediction) {
      seen = match.hitSerial;
      // 找羽球進到自己半場、適合擊球高度的那一刻
      const me = match.players[0];
      const pts = sh.prediction.points;
      const wantHigh = d.id !== 'net' && d.id !== 'defend' && d.id !== 'drive';
      // 高球：取擊球高度那一點；低球：取離自己最近的那一點
      const near = [...pts].filter((q) => q.p.z > 0.4 && q.p.y > 0.3 && q.p.y < 2.6).sort((a, b) => Math.hypot(a.p.x - me.pos.x, a.p.z - me.pos.z) - Math.hypot(b.p.x - me.pos.x, b.p.z - me.pos.z))[0];
      const pt = (wantHigh ? pts.find((q) => q.p.z > 0.4 && q.p.y < 2.5 && q.p.y > 1.9) : near) ?? pts[Math.floor(pts.length * 0.8)];
      flickAt = sh.launchTime + pt.t - GAME.idealContactT - (plan.jump ? 0.25 : 0);
      chargeFrom = flickAt - timeForCharge(chargeForDepth(plan.depth));
      void me;
    }
    if (flickAt > 0 && match.time >= chargeFrom) {
      inp.charging = true;
      inp.jump = !!plan.jump;
    }
    if (flickAt > 0 && match.time >= flickAt && !(plan.jump && !match.players[0].airborne && match.time < flickAt + 0.4)) {
      inp.flick = plan.flick;
      inp.charging = false;
      flickAt = -1;
    }
    match.step([inp, idleInput()]);
    for (const e of match.drainEvents()) {
      runner.onEvent(e);
      if (e.type === 'whiff' && e.player === 0) msgs['揮空:' + e.reason] = (msgs['揮空:' + e.reason] ?? 0) + 1;
    }
  }
  console.log(`${d.name.padEnd(6)} 成功 ${finished ? finished[0] : '?'} / ${d.reps}  星 ${finished ? finished[1] : '?'}  `, msgs);
}

// 一個 sim tick 對應的真實時間（runner.tick 用真實秒）
var PHYS_DT_REAL: number;
PHYS_DT_REAL = 1 / 120 / GAME.simSpeed;
