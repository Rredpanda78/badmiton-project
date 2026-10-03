// 殺球打到身體不同距離：硬伸手（時機完美）vs 魚躍，看回球品質與結果
// 執行：npx tsx scripts/stretch-test.ts
import { DEFAULT_SETTINGS, GAME } from '../src/config';
import { idleInput, Match, timeUntilInReach } from '../src/sim/match';

for (const reachMul of [1, GAME.manualReachMul]) {
  console.log(reachMul === 1 ? '— 自動跑位（範圍 1.15 m）' : '— 手動跑位（範圍 1.38 m）');
  for (const off of [0.4, 0.7, 0.9, 1.1, 1.3, 1.6, 2.2]) {
    const row: string[] = [];
    for (const mode of ['伸手', '魚躍'] as const) {
      let n = 0, hit = 0, over = 0, weak = 0, netF = 0, q = 0;
      for (let k = 0; k < 40; k++) {
        const m = new Match({ ...DEFAULT_SETTINGS, practice: true }, 300 + k);
        m.players[0].reachMul = reachMul;
        // 殺到玩家右邊 off 公尺（以落點估計），人站在 x=0
        const tx = off;
        m.feed({ from: { x: -1.0, y: 2.6, z: -4.4 }, family: 'down', depth: 4.0 + (k % 3) * 0.3, aimX: -tx / 2.3, playerAt: { x: 0, z: 4.0 } });
        n++;
        let acted = false;
        let got = false;
        for (let t = 0; t < 600 && m.phase === 'rally'; t++) {
          const inp = idleInput();
          if (!acted) {
            if (mode === '伸手') {
              const tIn = timeUntilInReach(m, 0);
              if (tIn !== null && tIn <= GAME.idealContactT) {
                inp.flick = { x: 0, y: 1, cmd: { family: 'up', depth: 6.1 } };
                acted = true;
              }
            } else {
              const sh = m.shuttle;
              const el = m.time - sh.launchTime;
              const pt = sh.prediction!.points.find((p) => p.t >= el && p.p.z >= 3.5 && p.p.y < GAME.dive.maxY);
              if (pt && pt.t - el <= GAME.dive.dur * 0.7) {
                inp.dive = { x: pt.p.x - m.players[0].pos.x, y: -(pt.p.z - m.players[0].pos.z) };
                acted = true;
              }
            }
          }
          m.step([inp, idleInput()]);
          for (const e of m.drainEvents()) {
            if (e.type === 'hit' && e.player === 0 && !got) {
              got = true;
              hit++;
              q += e.quality;
              if (e.netFault) netF++;
              else over++;
              if (e.wobble) weak++;
            }
          }
        }
      }
      row.push(`${mode}: 接到 ${hit}/${n} 過網 ${over} 掛網 ${netF} 機會球 ${weak} 品質 ${hit ? (q / hit).toFixed(2) : '-'}`);
    }
    console.log(`離身體約 ${off.toFixed(1)} m｜${row.join('｜')}`);
  }
}
