// 無畫面測試雙打：四個 AI 對打，檢查規則（每邊只能打一拍、發球輪轉、對角接發、雙打邊線）、
// 分工（不會兩個人搶同一球）、陣型、勝率、不會卡住。
// 執行：npx tsx scripts/doubles-test.ts [difficulty=normal] [場數=8] [每局分數=21] [局數=1|3]
import { AIController } from '../src/ai/ai';
import { ballTaker, teamAttacking } from '../src/ai/doubles';
import { COURT, DEFAULT_SETTINGS, GAME, PHYS, type Difficulty } from '../src/config';
import { idleInput, Match, type PlayerId, type TeamId } from '../src/sim/match';
import { v3 } from '../src/sim/physics';
import { CHARACTERS, RACKETS } from '../src/sim/kits';

const diff = (process.argv[2] as Difficulty) ?? 'normal';
const N = Number(process.argv[3] ?? 8);
const points = Number(process.argv[4] ?? 21) as 11 | 15 | 21;
const gamesSetting = (Number(process.argv[5] ?? 1) === 3 ? 3 : 1) as 1 | 3;
let gameChecks = 0;

let fails = 0;
const fail = (msg: string) => {
  fails++;
  if (fails <= 20) console.log('✘ ' + msg);
};

// --- 單元檢查：落點判定（雙打邊線、雙打後發球線、對角發球區） ---
// 0 號（近側）的球從 (x, z) 正上方掉下來，看判好球還是出界
function landAt(doubles: boolean, x: number, z: number, serve: boolean): boolean {
  const m = new Match({ ...DEFAULT_SETTINGS, doubles }, 1);
  const sh = m.shuttle;
  m.drainEvents();
  m.phase = 'rally';
  sh.mode = 'flight';
  sh.lastHitter = 0;
  sh.isServe = serve; // 0:0 由 0 號從右區發 → 對角在遠側 x<0（serveBoxSign = -1）
  sh.pos = v3(x, 0.03, z);
  sh.vel = v3(0, -1, 0);
  sh.stepDt = PHYS.dt;
  for (let i = 0; i < 20; i++) {
    m.step(m.players.map(() => idleInput()));
    for (const e of m.drainEvents()) if (e.type === 'land') return e.inBounds;
  }
  throw new Error('沒落地');
}
const lineCases: [string, boolean, number, number, boolean, boolean][] = [
  // 說明, 雙打?, x, z, 發球?, 應該是好球?
  ['雙打 單打線外雙打線內', true, 2.8, -3, false, true],
  ['單打 同一點', false, 2.8, -3, false, false],
  ['雙打 雙打邊線外', true, 3.2, -3, false, false],
  ['雙打 底線內', true, 0, -6.6, false, true],
  ['雙打發球 超過雙打後發球線', true, -1.5, -6.2, true, false],
  ['單打發球 同一點', false, -1.5, -6.2, true, true],
  ['雙打發球 雙打邊線內', true, -2.9, -4, true, true],
  ['單打發球 同一點', false, -2.9, -4, true, false],
  ['雙打發球 打錯區（非對角）', true, 1.5, -4, true, false],
  ['雙打發球 沒過前發球線', true, -1.5, -1.8, true, false],
];
for (const [name, d, x, z, serve, want] of lineCases) {
  const got = landAt(d, x, z, serve);
  if (got !== want) fail(`落點判定：${name} (${x}, ${z}) 判 ${got ? '好球' : '出界'}，應為 ${want ? '好球' : '出界'}`);
}
console.log(`落點判定單元檢查 ${lineCases.length} 項${fails ? '有錯' : '通過'}`);

const teamWins: [number, number] = [0, 0];
const teamPoints: [number, number] = [0, 0];
const reasons: Record<string, number> = {};
const shots: Record<string, number> = {};
const hitsBy: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
let rallies = 0;
let hits = 0;
let maxRally = 0;
let serveChecks = 0;
let serveLandChecks = 0;
let doublesLineIn = 0; // 落在單打邊線外、雙打邊線內，判好球
let doublesLineOut = 0; // 落在雙打邊線外，判出界
let lands = 0;
let bothSwung = 0; // 同一球兩位隊友都揮拍（搶球）
let incomingBalls = 0;
let takerMissed = 0; // 分到球的人沒揮到、球落在自己場內
let partnerHit = 0; // 不是分到球的人打到
let maxServeT = 0;
let maxRallyT = 0;
let maxFlightT = 0; // 球在空中最久多久沒被打到也沒落地（卡住的話會一直變大）
let attackT = 0;
let attackFrontBack = 0;
let defenceT = 0;
let defenceSideBySide = 0;
let closeT = 0;
let totalT = 0;
let simSecs = 0;

for (let g = 0; g < N; g++) {
  const pick = <T,>(xs: T[], k: number) => xs[(g * 7 + k * 3) % xs.length];
  const s = {
    ...DEFAULT_SETTINGS,
    difficulty: diff,
    points,
    games: gamesSetting,
    doubles: true,
    character: pick(CHARACTERS, 0).id,
    racket: pick(RACKETS, 0).id,
    aiCharacter: pick(CHARACTERS, 1).id,
    aiRacket: pick(RACKETS, 1).id,
    partnerCharacter: pick(CHARACTERS, 2).id,
    partnerRacket: pick(RACKETS, 2).id,
    ai2Character: pick(CHARACTERS, 3).id,
    ai2Racket: pick(RACKETS, 3).id,
  };
  const m = new Match(s, 500 + g);
  // 一半的場次遠側那隊先發（測試兩邊都會輪轉）
  if (g % 2 === 1) {
    m.server = 1;
    m.setupServe();
    m.drainEvents();
  }
  const ais = [0, 1, 2, 3].map((id) => new AIController(m, id as PlayerId, diff));

  // 參考模型：自己照 BWF 規則推一遍發球員與站位，跟比賽比對
  const refCourt: (1 | -1)[] = m.players.map((p) => p.court);
  let refServer: PlayerId = m.server;
  const refScore: [number, number] = [0, 0];

  let rallyHits: { player: PlayerId; serve: boolean }[] = [];
  let swungThisBall = new Set<PlayerId>();
  let curSerial = -1;
  let curTaker: PlayerId | null = null;
  let curTeam: TeamId | null = null;
  let ticks = 0;
  const limit = 120 * 60 * 40 * gamesSetting;
  while (m.phase !== 'matchOver' && ticks < limit) {
    // 新的來球：記下分給誰
    const sh = m.shuttle;
    if (m.phase === 'rally' && sh.lastHitter !== null && m.hitSerial !== curSerial) {
      // 上一球結束：檢查是不是兩個人都揮了
      if (curTeam !== null && swungThisBall.size > 1) bothSwung++;
      curSerial = m.hitSerial;
      curTeam = m.teamOf(sh.lastHitter) === 0 ? 1 : 0;
      curTaker = ballTaker(m, curTeam)?.id ?? null;
      swungThisBall = new Set();
      incomingBalls++;
    }
    const prevSwings = m.players.map((p) => p.swing);
    m.step(ais.map((a) => a.input()));
    ticks++;
    m.players.forEach((p, i) => {
      if (p.swing && p.swing !== prevSwings[i] && curTeam === p.team && m.phase === 'rally') swungThisBall.add(p.id);
    });

    // 陣型統計（回合進行中）
    if (m.phase === 'rally') {
      totalT += PHYS.dt;
      for (const team of [0, 1] as TeamId[]) {
        const [a, b] = m.teamPlayers(team);
        const dz = Math.abs(Math.abs(a.pos.z) - Math.abs(b.pos.z));
        const dx = Math.abs(a.pos.x - b.pos.x);
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < 0.5) closeT += PHYS.dt;
        // 球在飛向對方時看站位（自己這隊不用接球、應該在陣型上）
        if (m.hitByTeam(team) && m.time - sh.launchTime > 0.5) {
          if (teamAttacking(m, team)) {
            attackT += PHYS.dt;
            if (dz > 1.2) attackFrontBack += PHYS.dt;
          } else {
            defenceT += PHYS.dt;
            if (dx > 1.5 && dz < 1.5) defenceSideBySide += PHYS.dt;
          }
        }
      }
    }
    if (m.phase === 'serve') maxServeT = Math.max(maxServeT, m.phaseT);
    if (m.phase === 'rally') {
      maxRallyT = Math.max(maxRallyT, m.phaseT);
      maxFlightT = Math.max(maxFlightT, m.time - m.shuttle.launchTime);
    }

    for (const e of m.drainEvents()) {
      if (e.type === 'serveStart') {
        serveChecks++;
        const srv = m.players[e.server];
        const team = srv.team;
        const parity: 1 | -1 = m.score[team] % 2 === 0 ? 1 : -1;
        if (e.server !== refServer) fail(`第${g + 1}場 ${m.score}：發球員 ${e.server}，規則應為 ${refServer}`);
        m.players.forEach((p, i) => {
          if (p.court !== refCourt[i]) fail(`第${g + 1}場 ${m.score}：${i} 號站 ${p.court > 0 ? '右' : '左'}區，規則應為 ${refCourt[i] > 0 ? '右' : '左'}區`);
        });
        if (srv.court !== parity) fail(`第${g + 1}場 ${m.score}：發球員站 ${srv.court > 0 ? '右' : '左'}區但分數 ${m.score[team]}`);
        const r = m.players[m.receiver];
        if (r.team === team || r.court !== srv.court) fail(`第${g + 1}場：接發球員 ${r.id} 不在對角`);
        // 位置：發球員在自己的那一區、接發球員在對角（世界座標 x 異號）
        if (srv.pos.x * srv.side * parity <= 0) fail(`第${g + 1}場：發球員 x=${srv.pos.x.toFixed(2)} 不在${parity > 0 ? '右' : '左'}區`);
        if (r.pos.x * srv.pos.x >= 0) fail(`第${g + 1}場：接發球員 x=${r.pos.x.toFixed(2)} 不在對角`);
        if (Math.abs(r.pos.z) > COURT.doublesLongService || Math.abs(r.pos.z) < COURT.shortService) fail(`第${g + 1}場：接發球員不在發球區 z=${r.pos.z.toFixed(2)}`);
        rallyHits = [];
      }
      if (e.type === 'hit') {
        hits++;
        hitsBy[e.player]++;
        shots[e.name] = (shots[e.name] ?? 0) + 1;
        const prev = rallyHits[rallyHits.length - 1];
        if (prev && m.teamOf(prev.player) === m.teamOf(e.player)) fail(`第${g + 1}場：同一隊連打兩拍（${prev.player} → ${e.player}）`);
        if (prev?.serve && e.player !== m.receiver) fail(`第${g + 1}場：發球被 ${e.player} 接走，應該是 ${m.receiver}`);
        if (!e.serve && curTaker !== null && e.player !== curTaker) partnerHit++;
        rallyHits.push({ player: e.player, serve: e.serve });
      }
      if (e.type === 'land' && m.shuttle.mode === 'down') {
        lands++;
        const ax = Math.abs(e.pos.x);
        const az = Math.abs(e.pos.z);
        const hitter = m.shuttle.lastHitter!;
        const crossed = Math.sign(e.pos.z) !== m.players[hitter].side;
        if (crossed && rallyHits.length > 0) {
          const serve = rallyHits.length === 1 && rallyHits[0].serve;
          const tol = 0.03;
          let want = ax <= COURT.doublesHalfWidth + tol && az <= COURT.halfLength + tol;
          if (serve) {
            serveLandChecks++;
            want = want && az >= COURT.shortService - tol && az <= COURT.doublesLongService + tol && e.pos.x * m.shuttle.serveBoxSign >= -tol;
          }
          if (want !== e.inBounds) fail(`第${g + 1}場：落點 (${e.pos.x.toFixed(2)}, ${e.pos.z.toFixed(2)}) ${serve ? '發球' : ''}判 ${e.inBounds ? '好球' : '出界'}，應為 ${want ? '好球' : '出界'}`);
          if (!serve && e.inBounds && ax > COURT.singlesHalfWidth) doublesLineIn++;
          if (!serve && !e.inBounds && ax > COURT.doublesHalfWidth + tol) doublesLineOut++;
          // 好球落在接球那隊場內：分到球的人有沒有揮拍
          if (e.inBounds && curTaker !== null && !swungThisBall.has(curTaker)) takerMissed++;
        }
      }
      if (e.type === 'point') {
        rallies++;
        teamPoints[e.winner]++;
        reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
        maxRally = Math.max(maxRally, m.rallyHits);
        if (swungThisBall.size > 1) bothSwung++;
        swungThisBall = new Set();
        curTeam = null;
        // 參考模型：BWF 雙打輪轉
        refScore[e.winner]++;
        const st = m.players[refServer].team;
        if (st === e.winner) {
          const mate = (refServer ^ 2) as PlayerId;
          [refCourt[refServer], refCourt[mate]] = [refCourt[mate], refCourt[refServer]];
        } else {
          const want = refScore[e.winner] % 2 === 0 ? 1 : -1;
          refServer = ([0, 1, 2, 3] as PlayerId[]).find((i) => i % 2 === e.winner && refCourt[i] === want)!;
        }
        if (JSON.stringify(refScore) !== JSON.stringify(m.score)) fail(`第${g + 1}場：比分 ${m.score} ≠ 參考 ${refScore}`);
      }
      if (e.type === 'game') {
        // 參考模型：新的一局比分歸零，贏的那隊由站右區的人先發（站位不動）
        gameChecks++;
        refScore[0] = refScore[1] = 0;
        refServer = ([0, 1, 2, 3] as PlayerId[]).find((i) => i % 2 === e.winner && refCourt[i] === 1)!;
      }
      if (e.type === 'match') teamWins[e.winner]++;
    }
  }
  simSecs += ticks * PHYS.dt;
  if (m.phase !== 'matchOver') fail(`第${g + 1}場沒打完（卡住？）phase=${m.phase} 比分 ${m.score}`);
  const gm = gamesSetting > 1 ? `局數 ${m.games.join(' : ')}，最後一局 ` : '';
  console.log(`第 ${g + 1} 場（${g % 2 ? '遠側' : '近側'}先發）：${gm}比分 ${m.score.join(' : ')}｜${(ticks * PHYS.dt / GAME.simSpeed / 60).toFixed(1)} 分鐘`);
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : '-');
console.log(`\n--- 雙打 AI 對打（${diff}），${N} 場 ---`);
console.log(`隊伍勝場 近側 ${teamWins[0]} : 遠側 ${teamWins[1]}｜得分 ${teamPoints[0]} : ${teamPoints[1]}（近側 ${pct(teamPoints[0], teamPoints[0] + teamPoints[1])}）`);
console.log(`每分擊球數 ${(hits / rallies).toFixed(1)}，最長 ${maxRally}；各人擊球 ${JSON.stringify(hitsBy)}`);
console.log('得分原因', reasons);
console.log('球種', shots);
console.log(`發球檢查 ${serveChecks} 次（打完 ${gameChecks} 局，換局發球也檢查）、發球落點檢查 ${serveLandChecks} 次、落地 ${lands} 次（單打線外雙打線內判好球 ${doublesLineIn}、雙打線外判出界 ${doublesLineOut}）`);
console.log(`分工：來球 ${incomingBalls}｜兩人都揮拍 ${bothSwung}（${pct(bothSwung, incomingBalls)}）｜不是分到的人打到 ${partnerHit}｜分到的人沒揮、球落地 ${takerMissed}`);
console.log(`陣型：進攻時前後站 ${pct(attackFrontBack, attackT)}、防守時左右並排 ${pct(defenceSideBySide, defenceT)}、隊友貼太近（<0.5 m）${pct(closeT, totalT)}`);
console.log(`最長發球等待 ${maxServeT.toFixed(1)}s、最長回合 ${maxRallyT.toFixed(1)}s、一拍最久飛 ${maxFlightT.toFixed(1)}s（模擬秒）、共模擬 ${(simSecs / GAME.simSpeed / 60).toFixed(1)} 分鐘`);

if (rallies === 0 || hits / rallies < 2) fail('幾乎沒有來回');
if (maxServeT > 5) fail('發球等太久');
if (maxFlightT > 8) fail('球飛太久沒被打到也沒落地（卡住？）');
if (maxRallyT > 300) fail('回合太久（卡住？）');
console.log(fails ? `\n✘ ${fails} 個問題` : '\n✔ 全部通過');
process.exitCode = fails ? 1 : 0;
