// 魚躍統計：AI 對打時撲了幾次、救回幾次、救回後贏下這分的比例
// 執行：npx tsx scripts/dive-test.ts [easy|normal|hard]
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, type Difficulty } from '../src/config';
import { Match } from '../src/sim/match';

const diff = (process.argv[2] ?? 'hard') as Difficulty;
let dives = 0, saves = 0, rallies = 0, hits = 0, saveWins = 0;
for (let g = 0; g < 6; g++) {
  const m = new Match({ ...DEFAULT_SETTINGS, points: 21 }, 100 + g);
  const a = new AIController(m, 0, diff);
  const b = new AIController(m, 1, diff);
  let saved: (0 | 1)[] = [];
  for (let t = 0; t < 120 * 600 && m.phase !== 'matchOver'; t++) {
    m.step([a.input(), b.input()]);
    for (const e of m.drainEvents()) {
      if (e.type === 'dive') dives++;
      if (e.type === 'hit') {
        hits++;
        if (e.dive) { saves++; saved.push(e.player); }
      }
      if (e.type === 'point') {
        rallies++;
        saveWins += saved.filter((p) => p === e.winner).length;
        saved = [];
      }
    }
  }
}
console.log({ diff, rallies, hitsPerRally: (hits / rallies).toFixed(1), dives, saves, divesPerRally: (dives / rallies).toFixed(2), saverWonPoint: saves ? (saveWins / saves).toFixed(2) : '-' });
