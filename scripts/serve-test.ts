// 無畫面測試發球：
// 1. 單球：每種發球（發小球／發高遠球／彈發／平抽發）× 左右瞄準（T 點／中間／開角）× 時機（完美～最差），
//    單打與雙打、兩種操作的手勢形式：落在對角發球區內、瞄準方向對、擊球高度合法（≤ 1.15 m）、
//    小球完美擦網帶／時機差飄高、高遠球時機差變短（attack 變大）、彈發比高遠球低又快、太晚出界、太早翹高變短、
//    平抽發球經過接發球員身體高度；蓄力划動的種類判斷（蓄到最上面一段往上划 = 彈發）；接發球員搶攻飄高的小球
// 2. AI 對打（每個難度，單打＋雙打）：發球種類比例、發球失誤、搶攻次數、「發球直接得分」（發球得分＋接發球失誤）佔比（困難要 < 12%）
// 執行：npx tsx scripts/serve-test.ts [每個難度幾場=3]
import { AIController } from '../src/ai/ai';
import { COURT, DEFAULT_SETTINGS, GAME, PHYS, type Difficulty } from '../src/config';
import { idleInput, Match, type MatchEvent, type PlayerInput } from '../src/sim/match';
import { netTopAt, predict, v3 } from '../src/sim/physics';
import { chargeForDepth, SERVE_NAMES, serveQuality, type Flick, type ServeKind } from '../src/sim/shots';

type Hit = Extract<MatchEvent, { type: 'hit' }>;
let fails = 0;
const fail = (msg: string) => {
  fails++;
  if (fails <= 40) console.log('✘ ' + msg);
};
const S = GAME.serve;

/** 發一球：server = 0 號（近側），timing = 離最低點多久（正 = 早），gesture = 划動；回傳擊球事件與預測軌跡 */
function serveOnce(doubles: boolean, timing: number, gesture: Flick, charge?: number, seed = 11) {
  const m = new Match({ ...DEFAULT_SETTINGS, doubles, points: 21 }, seed);
  m.drainEvents();
  // 最低點在 P/2：phaseT = P/2 - timing 時出拍（先把球放到那個時間點的位置）
  const want = S.beat / 2 - timing;
  const n = Math.round(want / PHYS.dt);
  const idle = () => m.players.map(() => idleInput());
  for (let i = 0; i < n - 1; i++) m.step(idle());
  const inputs = idle();
  if (charge !== undefined) m.players[0].charge = charge;
  inputs[0].flick = gesture;
  m.step(inputs);
  const hit = m.drainEvents().find((e): e is Hit => e.type === 'hit');
  if (!hit) throw new Error('沒發出去');
  const pred = predict(hit.pos, hit.vel, hit.stepDt);
  return { m, hit, pred };
}

const heightAtZ = (pred: ReturnType<typeof predict>, z: number) => pred.points.find((p) => p.p.z <= z);
const apexOf = (pred: ReturnType<typeof predict>) => Math.max(...pred.points.map((p) => p.p.y));

// ---------- 1. 單球 ----------
console.log('--- 單球：種類 × 瞄準 × 時機（近側 0 號發球，對角發球區在 x<0） ---');
const TAP: Record<ServeKind, (aim: number) => Flick> = {
  short: (aim) => ({ x: aim * 0.6, y: -1, cmd: { family: 'down', depth: 'auto' } }),
  high: (aim) => ({ x: aim * 0.6, y: 1, cmd: { family: 'up', depth: 'auto' } }),
  flick: (aim) => ({ x: aim * 0.6, y: 1, cmd: { family: 'up', depth: 'auto', long: true } }),
  drive: (aim) => ({ x: aim || 0.01, y: -0.3, cmd: { family: 'down', depth: 'smash', stick: 'smash' } }),
};
for (const doubles of [false, true]) {
  const hw = doubles ? COURT.doublesHalfWidth : COURT.singlesHalfWidth;
  const back = doubles ? COURT.doublesLongService : COURT.halfLength;
  const rz = -(COURT.shortService + (doubles ? S.receiverZ.doubles : S.receiverZ.singles));
  console.log(`\n[${doubles ? '雙打' : '單打'}] 發球區 x∈[-${hw}, 0]、z∈[-${back}, -${COURT.shortService}]、接發球員 z=${rz.toFixed(2)}`);
  let perfectHighLand = 0;
  let perfectHighApex = 0;
  let perfectHighAttack = 0;
  let perfectFlickLand = 0;
  let perfectFlickAttack = 0;
  for (const kind of ['high', 'short', 'flick', 'drive'] as ServeKind[]) {
    for (const aim of [0, 1, -1]) {
      for (const timing of [0, 0.15, -0.15, 0.3, -0.3, 0.55]) {
        if (aim !== 0 && timing !== 0) continue; // 瞄準只看完美時機
        const { m, hit, pred } = serveOnce(doubles, timing, TAP[kind](aim));
        const q = serveQuality(timing);
        const L = pred.landing;
        const landZ = L ? Math.abs(L.z) : NaN;
        const inBox = !!L && L.x * m.shuttle.serveBoxSign >= 0 && Math.abs(L.x) <= hw && landZ >= COURT.shortService && landZ <= back;
        const netPt = heightAtZ(pred, 0);
        const over = netPt ? netPt.p.y - netTopAt(netPt.p.x) : NaN;
        const recv = heightAtZ(pred, rz);
        const label = `${SERVE_NAMES[kind]} aim=${aim > 0 ? 'T ' : aim < 0 ? '開角' : '中間'} t=${timing.toFixed(2).padStart(5)} q=${q.toFixed(2)}`;
        const where = L ? `落 (${L.x.toFixed(2)}, ${L.z.toFixed(2)})` : pred.hitsNet ? '掛網' : '?';
        console.log(`${label} ${hit.name.padEnd(4)} ${hit.grade} ${String(hit.speedKmh).padStart(3)}km/h 接觸y=${hit.pos.y.toFixed(2)} 過網+${over.toFixed(2)} 最高${apexOf(pred).toFixed(2)} 接球員${recv ? `${recv.p.y.toFixed(2)}m@${recv.t.toFixed(2)}s` : '-'} ${where} ${inBox ? '✔' : '✘'} attack=${hit.attack.toFixed(2)}`);
        // 共同檢查
        if (!hit.serve) fail(`${label}：不是發球事件`);
        if (hit.name !== SERVE_NAMES[kind]) fail(`${label}：名稱 ${hit.name}`);
        if (hit.pos.y > 1.15 || hit.pos.y < 0.8) fail(`${label}：擊球高度 ${hit.pos.y.toFixed(2)} 不合法`);
        if (hit.timing === undefined || Math.abs(hit.timing - timing) > 0.02) fail(`${label}：時機 ${hit.timing}`);
        const wantGrade = q >= 0.9 ? '完美' : q >= 0.74 ? '不錯' : '勉強';
        if (hit.grade !== wantGrade) fail(`${label}：評價 ${hit.grade}，應為 ${wantGrade}`);
        if (timing === 0 && !inBox) fail(`${label}：完美時機沒落在發球區 ${where}`);
        // 瞄準：aim>0（往右 = 往中線）= T 點、aim<0 = 開角
        if (aim > 0 && kind !== 'drive' && L && Math.abs(L.x) > hw / 2 - 0.25) fail(`${label}：瞄 T 點卻落在 x=${L.x.toFixed(2)}`);
        if (aim < 0 && kind !== 'drive' && L && Math.abs(L.x) < hw / 2 + 0.25) fail(`${label}：瞄開角卻落在 x=${L.x.toFixed(2)}`);
        if (aim === 0 && kind !== 'drive' && L && Math.abs(Math.abs(L.x) - hw / 2) > 0.4) fail(`${label}：瞄中間卻落在 x=${L.x.toFixed(2)}`);
        if (kind === 'short') {
          if (timing === 0 && (over < 0.0 || over > 0.14)) fail(`${label}：完美小球過網 +${over.toFixed(2)}（應擦網帶）`);
          if (timing === 0.55 && over < 0.3) fail(`${label}：最差小球過網 +${over.toFixed(2)}（應飄高）`);
          if (timing === 0.55 && !inBox) fail(`${label}：最差小球出發球區 ${where}`);
          if (landZ > 3.4) fail(`${label}：小球落太深 ${landZ.toFixed(2)}`);
        }
        if (kind === 'high') {
          if (timing === 0 && aim === 0) {
            perfectHighLand = landZ;
            perfectHighApex = apexOf(pred);
            perfectHighAttack = hit.attack;
            if (landZ < back - 1.0) fail(`${label}：完美高遠球太短 ${landZ.toFixed(2)}`);
          }
          if (timing === 0.55 && landZ > perfectHighLand - 0.5) fail(`${label}：最差高遠球沒變短 ${landZ.toFixed(2)} vs ${perfectHighLand.toFixed(2)}`);
          if (timing === 0.55 && hit.attack < perfectHighAttack + 0.25) fail(`${label}：最差高遠球 attack=${hit.attack.toFixed(2)} 應該比完美（${perfectHighAttack.toFixed(2)}）好殺`);
          if (timing === 0 && hit.attack > 0.3) fail(`${label}：完美高遠球 attack=${hit.attack.toFixed(2)} 太好殺`);
        }
        if (kind === 'flick') {
          if (timing === 0 && aim === 0) {
            perfectFlickLand = landZ;
            perfectFlickAttack = hit.attack;
            if (apexOf(pred) > perfectHighApex - 1.5) fail(`${label}：彈發最高 ${apexOf(pred).toFixed(2)} 沒比高遠球（${perfectHighApex.toFixed(2)}）低`);
            if (!recv || recv.p.y < 2.9 || recv.p.y > 3.45) fail(`${label}：經過接發球員頭頂 ${recv?.p.y.toFixed(2)} m（應剛好超過 2.85 的擊球範圍）`);
            if (!recv || recv.t > (doubles ? 0.45 : 0.55)) fail(`${label}：到接發球員 ${recv?.t.toFixed(2)} s 太慢`);
            if (landZ < back - 0.7) fail(`${label}：完美彈發太短 ${landZ.toFixed(2)}`);
          }
          if (timing === -0.15 && !inBox) fail(`${label}：稍晚的彈發不該出界 ${landZ.toFixed(2)}`);
          if (timing === -0.3 && inBox) fail(`${label}：過晚的彈發應該出界，卻落 ${landZ.toFixed(2)}`);
          if (timing === 0.55 && landZ > perfectFlickLand - 0.6) fail(`${label}：放太早的彈發沒翹高變短 ${landZ.toFixed(2)}`);
          if (timing === 0.55 && hit.attack < perfectFlickAttack + 0.15) fail(`${label}：翹高的彈發 attack=${hit.attack.toFixed(2)} 應該比完美（${perfectFlickAttack.toFixed(2)}）好殺`);
        }
        if (kind === 'drive') {
          if (!recv || recv.p.y < 1.0 || recv.p.y > (timing === 0 ? 1.9 : 2.2)) fail(`${label}：經過接發球員 ${recv?.p.y.toFixed(2)} m（應在身體高度）`);
          if (timing === 0 && hit.speedKmh < 45) fail(`${label}：平抽發球太慢 ${hit.speedKmh} km/h`);
          if (!inBox) fail(`${label}：平抽發球出發球區 ${where}`);
          if (timing === 0 && (over < 0.15 || over > 0.45)) fail(`${label}：平抽發球過網 +${over.toFixed(2)}`);
        }
      }
    }
  }
  // 「殺」搖桿往上 = 彈發；鍵盤空白鍵（沒方向鍵）= 發小球；主搖桿左右滑 = 發小球開角
  const stickUp = serveOnce(doubles, 0, { x: 0, y: 1, cmd: { family: 'down', depth: 1.2, stick: 'smash' } });
  if (stickUp.hit.name !== '彈發') fail(`「殺」搖桿往上 → ${stickUp.hit.name}，應為彈發`);
  const space = serveOnce(doubles, 0, { x: 0, y: -1, cmd: { family: 'down', depth: 'smash' } });
  if (space.hit.name !== '發小球') fail(`空白鍵 → ${space.hit.name}，應為發小球`);
  const sideSlide = serveOnce(doubles, 0, { x: -1, y: 0.1, cmd: { family: 'side', depth: 5.0 } });
  if (sideSlide.hit.name !== '發小球' || !sideSlide.pred.landing || Math.abs(sideSlide.pred.landing.x) < hw / 2 + 0.25) fail(`主搖桿往左滑 → ${sideSlide.hit.name} x=${sideSlide.pred.landing?.x.toFixed(2)}，應為發小球開角`);
  // 蓄力划動（沒有 cmd）：種類看划的方向與蓄力；彈發段 = 後界前 flickBand
  const raw = (dir: [number, number], depth: number) => serveOnce(doubles, 0, { x: dir[0], y: dir[1] }, chargeForDepth(depth));
  const cases: [string, [number, number], number, string, boolean][] = [
    ['上划・綠色', [0, 1], back - S.flickBand - 0.6, '發高遠球', true],
    ['上划・橘色段', [0, 1], back - S.flickBand / 2, '彈發', true],
    ['下划・小球', [0, -1], COURT.shortService + 0.4, '發小球', true],
    ['下划・蓄太少', [0, -1], COURT.shortService - 0.5, '發小球', false],
    ['橫划・綠色', [1, 0.05], 4.0, '平抽發', true],
    ['橫划・紅色（出界）', [1, 0.05], back + 0.6, '平抽發', false],
  ];
  for (const [name, dir, depth, want, wantIn] of cases) {
    const { m, hit, pred } = raw(dir, depth);
    const L = pred.landing;
    const inBox = !!L && L.x * m.shuttle.serveBoxSign >= 0 && Math.abs(L.x) <= hw && Math.abs(L.z) >= COURT.shortService && Math.abs(L.z) <= back;
    console.log(`蓄力划動 ${name.padEnd(10)} → ${hit.name.padEnd(4)} 落 z=${L ? Math.abs(L.z).toFixed(2) : '掛網'} ${inBox ? '進' : '出'}`);
    if (hit.name !== want) fail(`蓄力划動 ${name}：${hit.name}，應為 ${want}`);
    if (inBox !== wantIn) fail(`蓄力划動 ${name}：${inBox ? '進' : '出'}發球區，應為${wantIn ? '進' : '出'}`);
  }
}

// ---------- 搶攻：接發球員往前衝＋只點一下，飄高的小球撲下去、擦網帶的小球搶不到 ----------
console.log(`\n--- 搶攻（雙打，接發球員站前發球線後 ${S.receiverZ.doubles} m，發球一出手就往前衝、球到身邊「只點一下」） ---`);
function rushTest(timing: number): string {
  const m = new Match({ ...DEFAULT_SETTINGS, doubles: true, points: 21 }, 5);
  m.drainEvents();
  const want = S.beat / 2 - timing;
  const n = Math.round(want / PHYS.dt);
  const idle = () => m.players.map(() => idleInput());
  for (let i = 0; i < n - 1; i++) m.step(idle());
  const inputs = idle();
  inputs[0].flick = TAP.short(0);
  m.step(inputs);
  const r = m.receiver;
  let name = '沒碰到';
  for (let i = 0; i < 400 && m.phase === 'rally'; i++) {
    const inp: PlayerInput[] = idle();
    inp[r].moveY = i > 12 ? 1 : 0; // 反應一下之後往網子衝
    inp[r].flick = { x: 0, y: 0, cmd: { family: 'side', depth: 5.0, soft: true } };
    m.step(inp);
    for (const e of m.drainEvents()) if (e.type === 'hit' && e.player === r) name = `${e.name}（擊球點 y=${e.pos.y.toFixed(2)} z=${Math.abs(e.pos.z).toFixed(2)}）`;
  }
  return name;
}
const rushBad = rushTest(0.55);
const rushMid = rushTest(0.3);
const rushGood = rushTest(0);
console.log(`最差小球 → ${rushBad}｜過早（q=0.80）→ ${rushMid}｜完美小球 → ${rushGood}`);
if (!rushBad.startsWith('搶攻')) fail(`飄高的小球沒被搶攻：${rushBad}`);
if (rushGood.startsWith('搶攻')) fail(`擦網帶的小球不該被搶攻：${rushGood}`);

// ---------- 2. AI 對打統計 ----------
const N = Number(process.argv[2] ?? 3);
console.log(`\n--- AI 對打（每個難度 ${N} 場 21 分，單打＋雙打）：發球種類、搶攻、發球直接得分 ---`);
interface Stat {
  serves: Record<string, number>;
  faults: number;
  aces: number;
  direct: number; // 發球方在 ≤ 2 拍內得分（發球得分＋接發球失誤）
  points: number;
  rush: number;
  grades: Record<string, number>;
  maxServeWait: number;
  returnFault: number;
}
const rows: string[] = [];
for (const doubles of [false, true]) {
  for (const diff of ['easy', 'normal', 'hard', 'extreme', 'hell'] as Difficulty[]) {
    const st: Stat = { serves: {}, faults: 0, aces: 0, direct: 0, points: 0, rush: 0, grades: {}, maxServeWait: 0, returnFault: 0 };
    for (let g = 0; g < N; g++) {
      const m = new Match({ ...DEFAULT_SETTINGS, difficulty: diff, points: 21, games: 1, doubles }, 700 + g * 13);
      const ais = m.players.map((p) => new AIController(m, p.id, diff));
      let hits = 0;
      let serverTeam = -1;
      let ticks = 0;
      while (m.phase !== 'matchOver' && ticks < 120 * 60 * 40) {
        m.step(ais.map((a) => a.input()));
        ticks++;
        if (m.phase === 'serve') st.maxServeWait = Math.max(st.maxServeWait, m.phaseT);
        for (const e of m.drainEvents()) {
          if (e.type === 'hit') {
            hits++;
            if (e.serve) {
              st.serves[e.name] = (st.serves[e.name] ?? 0) + 1;
              st.grades[e.grade] = (st.grades[e.grade] ?? 0) + 1;
              serverTeam = m.teamOf(e.player);
            }
            if (e.name === '搶攻') st.rush++;
          } else if (e.type === 'point') {
            st.points++;
            if (e.reason === '發球失誤') st.faults++;
            if (e.reason === '發球得分') st.aces++;
            if (hits <= 2 && e.winner === serverTeam) st.direct++;
            if (hits === 2 && e.winner === serverTeam) st.returnFault++;
            hits = 0;
          }
        }
      }
      if (m.phase !== 'matchOver') fail(`${diff} ${doubles ? '雙打' : '單打'} 第 ${g + 1} 場沒打完`);
    }
    const total = Object.values(st.serves).reduce((a, b) => a + b, 0);
    const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
    const mix = (['short', 'high', 'flick', 'drive'] as ServeKind[]).map((k) => `${SERVE_NAMES[k]} ${pct(st.serves[SERVE_NAMES[k]] ?? 0, total)}`).join('、');
    const directPct = (100 * st.direct) / st.points;
    rows.push(
      `${(doubles ? '雙打' : '單打') + ' ' + diff}`.padEnd(14) +
        `發球 ${total}：${mix}｜評價 ${JSON.stringify(st.grades)}｜失誤 ${pct(st.faults, total)}｜發球得分 ${pct(st.aces, st.points)}｜接發球失誤 ${pct(st.returnFault, st.points)}｜直接得分 ${pct(st.direct, st.points)}｜搶攻 ${st.rush}（${pct(st.rush, st.serves['發小球'] ?? 0)} 的小球）｜最長等發球 ${st.maxServeWait.toFixed(1)}s`,
    );
    if (diff === 'hard' && directPct >= 12) fail(`${doubles ? '雙打' : '單打'} 困難：發球直接得分 ${directPct.toFixed(1)}% ≥ 12%`);
    if (st.faults / total > 0.12) fail(`${doubles ? '雙打' : '單打'} ${diff}：發球失誤 ${pct(st.faults, total)} 太多`);
    if (st.maxServeWait > 4) fail(`${doubles ? '雙打' : '單打'} ${diff}：等發球 ${st.maxServeWait.toFixed(1)}s 太久`);
    if ((diff === 'easy' || diff === 'normal') && ((st.serves['彈發'] ?? 0) + (st.serves['平抽發'] ?? 0)) / total > 0.12) fail(`${diff} 彈發／平抽發太多`);
    if (diff === 'hell' && !doubles && (st.serves['彈發'] ?? 0) === 0) fail('地獄單打完全沒有彈發');
    if (diff === 'hell' && doubles && (st.serves['平抽發'] ?? 0) === 0) fail('地獄雙打完全沒有平抽發');
  }
}
for (const r of rows) console.log(r);

console.log(fails ? `\n✘ ${fails} 個問題` : '\n✔ 全部通過');
process.exitCode = fails ? 1 : 0;
void v3;
