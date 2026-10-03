// 無畫面測試線上同步：兩台「手機」各跑一場比賽，各自的 AI 控制自己的球員，
// 中間用有延遲的假網路接起來，檢查兩邊比分一致、不會卡住。
// 執行：npx tsx scripts/online-test.ts [單程延遲毫秒=60] [場數=3] [doubles|drift] [drop] [spec]
//   drop：第一場中途 B 關掉分頁（A 暫停 → 按「AI 接手繼續」對 AI 打幾分），B 重新整理網頁回來，
//         A 這一分打完就把對手換回 B（送 start 讓 B 照這場設定重建＋resume 從目前比分繼續），之後兩邊比分要一致
//   spec：打到 5 分時一位觀眾 S 進房（伺服器把 A、B 的訊息都轉給他、標上 fr；S 送 spec-hello 要快照，房主 A 回 snap），
//         S 照快照建比賽、跟著看到結束，最後 S 的比分、局數要跟 A（房主、標準視角）一樣
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, GAME, PHYS } from '../src/config';
import { idleInput, Match } from '../src/sim/match';
import { buildKit } from '../src/sim/kits';
import type { PeerMsg, SpecMsg, SpecPlayer, SpecStart } from '../src/net/protocol';
import { OnlineSync } from '../src/net/sync';
import { snapDuo, Spectator } from '../src/net/spectate';

const latMs = Number(process.argv[2] ?? 60);
// 例：ONLINE='{"dilate":false,"holdScale":1}' 試不同的延遲處理
if (process.env.ONLINE) Object.assign(GAME.online, JSON.parse(process.env.ONLINE));
const games = Number(process.argv[3] ?? 3);
const tickMs = (PHYS.dt / GAME.simSpeed) * 1000; // 一個 tick 的真實時間
const delayTicks = Math.max(1, Math.round(latMs / tickMs));

// 第四個參數 doubles：線上雙打（雙方各帶一個 AI 隊友：本機 0 號＋2 號，對方 1、3 號）
const doubles = process.argv[4] === 'doubles';
const drop = process.argv.includes('drop');
const spec = process.argv.includes('spec');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
let ok = 0;
let specOk = 0;
let dropOk = false;
for (let g = 0; g < games; g++) {
  const mk = (seed: number) => {
    const m = new Match({ ...DEFAULT_SETTINGS, points: 21, doubles }, seed);
    m.remote = 1;
    return m;
  };
  const A = mk(10 + g);
  let B = mk(900 + g);
  A.server = 0; // A 是房主先發
  B.server = 1;
  A.setupServe();
  B.setupServe();
  const queue: { at: number; to: 'A' | 'B' | 'S'; msg: PeerMsg | SpecMsg }[] = [];
  let tick = 0;
  const clock = () => tick * tickMs;
  // ---- 觀眾 S（spec 模式）：伺服器把 A（房主 fr=h）、B（加入的人 fr=g）送的都轉一份給他 ----
  let S: Spectator | null = null;
  let sMatch: Match | null = null;
  let sHits = 0;
  const sJumps: number[] = [];
  const toS = (fr: 'h' | 'g', msg: PeerMsg) => {
    if (S && msg.t !== 'ping' && msg.t !== 'pong') queue.push({ at: tick + delayTicks, to: 'S', msg: { fr, ...clone(msg) } as SpecMsg });
  };
  const sA = new OnlineSync(
    A,
    (msg) => {
      queue.push({ at: tick + delayTicks, to: 'B', msg: clone(msg) });
      toS('h', msg);
    },
    clock,
  );
  const mkSyncB = (m: Match) =>
    new OnlineSync(
      m,
      (msg) => {
        queue.push({ at: tick + delayTicks, to: 'A', msg: clone(msg) });
        toS('g', msg);
      },
      clock,
    );
  let sB = mkSyncB(B);
  // 兩邊的 hello／這場的規則（房主 A 回快照用；跟上面 mk() 的 Match 設定一致）
  const helloA: SpecPlayer = { name: 'A（房主）', character: DEFAULT_SETTINGS.character, racket: DEFAULT_SETTINGS.racket, partner: 'allround', partnerRacket: 'balance' };
  const helloB: SpecPlayer = { name: 'B', character: DEFAULT_SETTINGS.character, racket: DEFAULT_SETTINGS.racket, partner: 'allround', partnerRacket: 'balance' };
  const startInfo: SpecStart = { points: 21, games: 1, venue: 'indoor', matchType: doubles ? 'doubles' : 'singles', difficulty: 'normal' };
  // 每台手機控制自己這隊：0 號（玩家，這裡用 AI 代打）＋雙打時 2 號 AI 隊友
  const own = (m: Match) => (doubles ? [0, 2] : [0]).map((id) => new AIController(m, id as 0 | 2, 'hard'));
  const aiA = own(A);
  let aiB = own(B);
  const inputs = (m: Match, ais: AIController[]) => m.players.map((p) => (m.isRemote(p.id) ? { moveX: 0, moveY: 0, charging: false, jump: false, flick: null, dive: null } : ais[p.id === 0 ? 0 : 1].input()));
  // ---- drop 模式（只有第一場）：B 斷線 → A 暫停 → AI 接手 → B 回來 → 下一分換回來 ----
  const dropping = drop && g === 0;
  let stage: 'live' | 'paused' | 'ai' | 'back' | 'waitResume' | 'done' = 'live';
  let stageT = 0;
  let takeover: (AIController | null)[] = [];
  let aiPoints = 0;
  const inputsA = () => (stage === 'ai' || stage === 'back' ? A.players.map((p) => (p.id % 2 === 0 ? aiA[p.id === 0 ? 0 : 1].input() : takeover[p.id]!.input())) : inputs(A, aiA));
  let maxAwait = 0;
  const jumps: number[] = [];
  const lowest: number[] = [];
  let awaitT = [0, 0];
  let hits = 0;
  let netHitsLate = 0;
  for (; tick < 120 * 60 * 30 && !(A.phase === 'matchOver' && B.phase === 'matchOver'); tick++) {
    while (queue.length && queue[0].at <= tick) {
      const q = queue.shift()!;
      if (q.to === 'S') {
        if (!S) continue;
        const m = q.msg as SpecMsg;
        if (m.t === 'hit' && !m.s && sMatch) {
          // 觀眾收到擊球時，他的球離擊球點（標準視角）多遠
          const neg = m.fr === 'g' ? -1 : 1;
          sJumps.push(Math.hypot(sMatch.shuttle.pos.x - neg * m.c[0], sMatch.shuttle.pos.y - m.c[1], sMatch.shuttle.pos.z - neg * m.c[2]));
        }
        S.receive(m);
        continue;
      }
      if (q.msg.t === 'spec-hello') {
        // 觀眾要快照：房主 A 回（跟 main.ts 的 sendSnap 一樣）
        if (q.to === 'A' && stage !== 'paused') queue.push({ at: tick + delayTicks, to: 'S', msg: { fr: 'h', ...snapDuo('host', helloA, helloB, startInfo, stage === 'ai' || stage === 'back' ? null : A) } as SpecMsg });
        continue;
      }
      if (q.to === 'B' && (stage === 'paused' || stage === 'ai' || stage === 'back')) continue; // B 不在：訊息丟掉
      if (q.to === 'B' && stage === 'waitResume') {
        // B（重新整理後的新網頁）等 A 的 start＋resume
        if (q.msg.t === 'resume') {
          const sc: [number, number] = [q.msg.sc[1], q.msg.sc[0]];
          const gm: [number, number] = [q.msg.gm[1], q.msg.gm[0]];
          B.resumePoint(sc, gm, (q.msg.srv ^ 1) as 0 | 1 | 2 | 3);
          B.drainEvents();
          stage = 'done';
        }
        continue;
      }
      if (q.msg.t === 'hit' && !q.msg.s) {
        // 收到對方擊球前，本機的球在哪：跟對方擊球點差多遠（瞬移距離）、離地多高
        const M = q.to === 'A' ? A : B;
        const c = q.msg.c;
        jumps.push(Math.hypot(M.shuttle.pos.x + c[0], M.shuttle.pos.y - c[1], M.shuttle.pos.z + c[2]));
        lowest.push(M.shuttle.pos.y);
      }
      (q.to === 'A' ? sA : sB).receive(q.msg as PeerMsg);
    }
    // spec：打到 5 分時觀眾進房（伺服器送 welcome，他接著要快照）
    if (spec && !S && A.score[0] + A.score[1] >= 5 && A.phase === 'rally') {
      S = new Spectator(
        { ...DEFAULT_SETTINGS },
        (msg) => {
          if (msg.t === 'spec-hello') queue.push({ at: tick + delayTicks, to: 'A', msg });
          else if (msg.t === 'ping') queue.push({ at: tick + 2 * delayTicks, to: 'S', msg: { t: 'pong', a: msg.a } }); // 伺服器直接回
        },
        clock,
        4242 + g,
      );
      S.onMatch = (m) => (sMatch = m);
      S.receive({ t: 'welcome', role: 'spectator', peers: 2, cap: 2, spec: 1 });
    }
    if (dropping) {
      stageT += PHYS.dt / GAME.simSpeed;
      if (stage === 'live' && A.score[0] + A.score[1] >= 5 && A.phase === 'rally') {
        stage = 'paused'; // B 關掉分頁：A 收到「對手斷線了」→ 暫停
        stageT = 0;
      } else if (stage === 'paused' && stageT > 3) {
        // A 按「AI 接手繼續」：對手那隊改由本機 AI 控制，這一分重新發球
        stage = 'ai';
        A.remote = null;
        takeover = [null, new AIController(A, 1, 'hard'), null, doubles ? new AIController(A, 3, 'hard') : null];
        A.resumePoint(A.score.slice() as [number, number], A.games.slice() as [number, number], A.server);
      } else if (stage === 'ai' && aiPoints >= 6) {
        // B 重新整理網頁回來（新的一場 Match，還沒有比分）：A 等這一分打完
        stage = 'back';
        B = mk(5000);
        sB = mkSyncB(B);
        aiB = own(B);
        if (S) queue.push({ at: tick + delayTicks, to: 'S', msg: { t: 'peer-join' } }); // 伺服器也告訴觀眾有人進來
      } else if (stage === 'back' && (A.phase === 'point' || A.phase === 'serve')) {
        // A 把對手換回 B：送 start（B 照這場設定重建，這裡已經建好了）＋ resume（從目前比分繼續）
        A.remote = 1;
        takeover = [];
        const s = A.settings;
        A.players[1].kit = buildKit(s.aiCharacter ?? 'allround', s.aiRacket ?? 'balance');
        if (doubles) A.players[3].kit = buildKit(s.ai2Character ?? 'allround', s.ai2Racket ?? 'balance');
        const resume: PeerMsg = { t: 'resume', sc: [A.score[0], A.score[1]], gm: [A.games[0], A.games[1]], srv: A.server };
        queue.push({ at: tick + delayTicks, to: 'B', msg: resume });
        toS('h', resume); // 觀眾也會收到（AI 代打期間他看不到比分變化，resume 把比分對回來）
        A.resumePoint(A.score.slice() as [number, number], A.games.slice() as [number, number], A.server);
        stage = 'waitResume';
      }
    }
    if (stage !== 'paused') A.step(inputsA());
    // 第四個參數 drift：B 每 700 tick 卡住 40 tick（模擬手機掉幀、時間落後）
    const frozen = process.argv[4] === 'drift' && tick % 700 < 40;
    const bLive = stage === 'live' || stage === 'done';
    if (!frozen && bLive) B.step(inputs(B, aiB));
    for (const [m, s, i] of [[A, sA, 0], [B, sB, 1]] as const) {
      if (i === 1 && !bLive) continue;
      const offline = i === 0 && (stage === 'ai' || stage === 'back' || stage === 'paused');
      for (const e of m.drainEvents()) {
        if (!offline) s.onEvent(e);
        if (e.type === 'hit' && e.player === 0) hits++;
        if (e.type === 'point' && i === 0 && stage === 'ai') aiPoints++;
        if (e.type === 'land' && m.phase === 'await') void 0;
      }
      if (!offline) s.afterStep();
      awaitT[i] = m.phase === 'await' ? awaitT[i] + PHYS.dt : 0;
      maxAwait = Math.max(maxAwait, awaitT[i]);
    }
    // 觀眾：照收到的訊息模擬（沒有輸入）
    if (S && sMatch) {
      sMatch.step(sMatch.players.map(() => idleInput()));
      for (const e of sMatch.drainEvents()) if (e.type === 'hit') sHits++;
      S.afterStep();
    }
    void netHitsLate;
  }
  const same = A.games[0] === B.games[1] && A.games[1] === B.games[0];
  if (same && A.phase === 'matchOver') ok++;
  if (dropping) dropOk = stage === 'done' && same && A.phase === 'matchOver' && B.phase === 'matchOver';
  console.log(`第 ${g + 1} 場：A 局數 ${A.games} 比分 ${A.score}｜B 局數 ${B.games} 比分 ${B.score}｜${same ? '一致' : '不一致！'}｜擊球 ${hits}｜等判定最久 ${maxAwait.toFixed(2)}s｜RTT ${sA.rttMs.toFixed(0)}ms｜${A.phase}/${B.phase}`);
  if (dropping) console.log(`  斷線回來：B 斷線 → A 讓 AI 接手打了 ${aiPoints} 分 → B 重新整理回來、下一分換回 B：${dropOk ? '成功，之後兩邊比分一致' : '失敗！'}（${stage}）`);
  jumps.sort((a, b) => a - b);
  const pct = (a: number[], f: number) => (a.length ? a[Math.floor(a.length * f)].toFixed(2) : '-');
  console.log(`  收到對方擊球時，本機的球跳回擊球點的距離：中位 ${pct(jumps, 0.5)} m、90% ${pct(jumps, 0.9)} m、最大 ${pct(jumps, 0.999)} m；當下球離地 中位 ${pct(lowest.sort((a, b) => a - b), 0.5)} m、最低 10% ${pct(lowest, 0.1)} m`);
  if (spec) {
    // 觀眾（標準視角 = 房主 A 的視角）最後的比分、局數要跟 A 一樣
    const sSame = !!sMatch && sMatch.score[0] === A.score[0] && sMatch.score[1] === A.score[1] && sMatch.games[0] === A.games[0] && sMatch.games[1] === A.games[1] && sMatch.phase === 'matchOver';
    if (sSame) specOk++;
    sJumps.sort((a, b) => a - b);
    console.log(`  觀眾 S（5 分時進房）：局數 ${sMatch?.games} 比分 ${sMatch?.score}｜${sSame ? '跟 A 一致' : '不一致！'}｜看到 ${sHits} 拍｜${sMatch?.phase}｜RTT ${S?.rttMs.toFixed(0)}ms｜收到擊球時球離擊球點 中位 ${pct(sJumps, 0.5)} m、90% ${pct(sJumps, 0.9)} m`);
  }
}
console.log(`延遲 ${latMs}ms（${delayTicks} tick）：${ok}/${games} 場兩邊結果一致${spec ? `｜觀眾 ${specOk}/${games} 場跟房主一致` : ''}`);
if ((drop && !dropOk) || (spec && specOk < games)) process.exit(1);
