// 無畫面跑完整個新手教學（兩種操作 × 自動／手動跑位），模擬玩家照提示操作，確認每一步都過得了。
// 執行：npx tsx scripts/tutorial-test.ts
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, GAME, PHYS, type ControlScheme } from '../src/config';
import { idleInput, Match, type PlayerInput } from '../src/sim/match';
import { buildTutorial, TutorialRunner, type TutStep } from '../src/modes/tutorial';
import { chargeForDepth, type Flick } from '../src/sim/shots';

const TAP: Record<string, Flick> = {
  '挑球（下手）': { x: 0, y: 1, cmd: { family: 'up', depth: 5.7 } },
  '放小球（下手）': { x: 0, y: -1, cmd: { family: 'down', depth: 1.0 } },
  '高遠球（上手）': { x: 0, y: 1, cmd: { family: 'up', depth: 6.0 } },
  '切球（上手）': { x: 0, y: -1, cmd: { family: 'down', depth: 1.5 } },
  平抽: { x: 1, y: 0, cmd: { family: 'side', depth: 5.0 } },
  '殺球（殺球搖桿）': { x: 0, y: -1, cmd: { family: 'down', depth: 'smash' } },
  假殺真切: { x: 0, y: 1, cmd: { family: 'down', depth: 1.4 } },
  跳殺: { x: 0, y: -1, cmd: { family: 'down', depth: 'smash' } },
};
const CHARGE_DIR: Record<string, [number, number]> = { '高遠球 ↑': [0, 1], '殺球 ↓': [0, -1], '切球 ↓': [0, -1], '放小球 ↓': [0, -1], '挑球 ↑': [0, 1], '平抽 ← →': [1, 0.05], 跳殺: [0, -1] };

function run(scheme: ControlScheme, autoMove: boolean): void {
  const m = new Match({ ...DEFAULT_SETTINGS, practice: true, scheme, autoMove }, 7);
  const assist = new AIController(m, 0, 'hard', true);
  assist.allowDive = false;
  const log: string[] = [];
  const ui = { card() {}, prompt() {}, highlight() {}, target() {}, toast(ok: boolean, msg: string) { log.push(`${ok ? '✔' : '✘'}${msg}`); }, finish() { log.push('完成'); } };
  const T = new TutorialRunner(m, buildTutorial(scheme, autoMove), ui, scheme);
  let pending: PlayerInput | null = null;
  let charging = false;
  let fails = 0;
  for (let f = 0; f < 60 * 240 && !T.done; f++) {
    const dt = 1 / 60;
    const st: TutStep = T.step;
    // 卡片按鈕
    if (st.kind === 'info' || (st.kind === 'shot' && (T as unknown as { state: string }).state === 'card')) T.button();
    T.tick(dt);
    const me = m.players[0];
    const inp = idleInput();
    if (st.kind === 'charge') {
      inp.charging = charging = me.charge < 0.5 && !(charging && me.charge === 0 && f % 2 === 0);
    }
    if (st.kind === 'move' && st.targets![(T as unknown as { targetIdx: number }).targetIdx]) {
      const tg = st.targets!.find((_, i) => i === (T as unknown as { targetIdx: number }).targetIdx)!;
      inp.moveX = Math.sign(tg.x - me.pos.x) * Math.min(1, Math.abs(tg.x - me.pos.x));
      inp.moveY = -Math.sign(tg.z - me.pos.z) * Math.min(1, Math.abs(tg.z - me.pos.z));
    }
    if (st.title === '跳殺' && !me.airborne && !T.frozen) {
      inp.charging = scheme === 'charge';
      inp.jump = true;
    }
    if (T.frozen) {
      if (st.freeze === 'dive') inp.dive = { x: 1, y: 0.1 };
      else if (scheme === 'tap') inp.flick = TAP[st.title];
      else {
        const lo = chargeForDepth(st.range![0]);
        const hi = chargeForDepth(st.range![1]);
        if (me.charge < Math.min((lo + hi) / 2, lo + 0.08) || me.charge > hi) m.holdCharge(0, me.charge <= hi, dt * GAME.simSpeed);
        else {
          const d = CHARGE_DIR[st.title];
          inp.flick = { x: d[0], y: d[1] };
        }
      }
      pending = T.frozenInput(inp) ?? pending;
    }
    const n = Math.round((dt * GAME.simSpeed * T.timeScale) / PHYS.dt);
    for (let i = 0; i < Math.max(n, T.timeScale > 0 ? 1 : 0); i++) {
      const use = pending ?? inp;
      pending = null;
      if (T.wantAssist) {
        const a = assist.input();
        use.moveX = a.moveX;
        use.moveY = a.moveY;
      }
      m.step([use, idleInput()]);
      for (const e of m.drainEvents()) T.onEvent(e);
      if (T.checkFreeze()) break;
    }
    fails = log.filter((s) => s.startsWith('✘')).length;
    if (fails > 6) break;
  }
  console.log(`${scheme}${autoMove ? '・自動' : '・手動'}：${T.done ? '全部完成' : `卡在「${T.step.title}」`}｜${log.join(' ')}`);
}

for (const scheme of ['charge', 'tap'] as const) for (const auto of [true, false]) run(scheme, auto);
