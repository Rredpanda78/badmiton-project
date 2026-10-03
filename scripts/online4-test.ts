// 無畫面測試 4 人房（線上雙打 2 對 2）：四台「手機」各跑一場比賽，各自的 AI 控制自己的球員（房主另外模擬 AI 補位），
// 中間是有延遲的假網路（每台到伺服器單程 30–150 ms、每則訊息再加抖動，同一條連線不亂序）和真正的裁決器（server/src/arbiter.ts）。
// 偶爾故意讓兩個隊友都去搶同一球；檢查四台比分一致、不會卡住、搶球都有解決，印出統計（衝突、還原、瞬移距離）。
// 執行：npx tsx scripts/online4-test.ts [場數=3] [名單=4h|2h|2hs] [drop] [spec]
//   4h = 四個真人；2h = A、B 隊各一個真人（其餘 AI 由房主模擬）；2hs = 兩個真人同一隊（對面兩個 AI）
//   drop = 第一場中途 3 號座位斷線（房主讓 AI 代打），幾分後他重新整理網頁回來，下一分拿回座位
//   spec = 打到 5 分時一位觀眾進房：伺服器把玩家的訊息、裁決結果都轉給他；他送 spec-hello 要快照，房主回 snap（名單＋比分＋裁決序號），
//          他照快照建比賽、從下一個裁決開始套用；最後比分要跟四台一樣
import { AIController } from '../src/ai/ai';
import { DEFAULT_SETTINGS, GAME, PHYS } from '../src/config';
import { Arbiter, type ArbEv } from '../server/src/arbiter';
import type { PeerMsg, QuadHuman, QuadRoster, SpecMsg } from '../src/net/protocol';
import { isHuman, QuadLobby } from '../src/net/quad';
import { QuadSession } from '../src/net/session4';
import { snapQuad, Spectator } from '../src/net/spectate';
import { idleInput, type Match } from '../src/sim/match';
import { Rng } from '../src/sim/rng';

const N = Number(process.argv[2] ?? 3);
const layout = (process.argv[3] ?? '4h') as '4h' | '2h' | '2hs';
const drop = process.argv.includes('drop');
const spec = process.argv.includes('spec');
// 例：QUADHOLD='{"max":0}' 關掉 4 人房的「隊友附近放慢」
if (process.env.QUADHOLD) Object.assign(GAME.quadHold, JSON.parse(process.env.QUADHOLD));
const tickMs = (PHYS.dt / GAME.simSpeed) * 1000;
const rng = new Rng(4242);

let fails = 0;
const fail = (msg: string) => {
  fails++;
  if (fails <= 20) console.log('✘ ' + msg);
};
const pct = (a: number[], f: number) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(2) : '-');

type Msg = PeerMsg | { t: 'welcome' | 'peer-join' | 'peer-left'; cid?: string };

interface Phone {
  idx: number;
  cid: string;
  lat: number; // 單程延遲（毫秒）
  up: boolean;
  paused: boolean;
  sess: QuadSession | null;
  own: AIController | null; // 代替真人操作的 AI
  awaitT: number;
  rallyT: number;
  lastUp: number; // 上行（手機 → 伺服器）最後一則的到達時間（保持順序）
  lastDown: number;
}

function human(cid: string, name: string, character: string): QuadHuman {
  return { cid, name, character, racket: 'balance', mv: 'auto', ready: true, on: true };
}

const totals = { conflicts: 0, undo: 0, rejected: 0, landBeatHit: 0, decided: 0, points: 0, jumps: [] as number[], mateJumps: [] as number[], maxAwait: 0, maxRally: 0, ok: 0, whiffs: 0, hits: 0, specOk: 0 };

for (let g = 0; g < N; g++) {
  // ---- 名單 ----
  const cfg = { points: 21 as const, games: 1 as const, venue: 'indoor' as const, difficulty: 'hard' as const, allManual: false };
  const lobby = QuadLobby.create(human('P0', '房主', 'allround'), cfg);
  const humanSeats = layout === '4h' ? [0, 1, 2, 3] : layout === '2h' ? [0, 1] : [0, 2];
  const chars = ['allround', 'power', 'touch', 'driver'];
  for (const s of humanSeats) if (s !== 0) lobby.seats[s] = human(`P${s}`, `玩家${s}`, chars[s]);
  lobby.fillAi();
  const roster: QuadRoster = JSON.parse(JSON.stringify(lobby.r));

  // ---- 假網路＋伺服器 ----
  const arb = new Arbiter();
  let now = 0;
  const up: { at: number; from: number; msg: Msg }[] = [];
  const down: { at: number; to: number; msg: Msg }[] = [];
  const phones: Phone[] = humanSeats.map((s, i) => ({ idx: i, cid: `P${s}`, lat: 30 + rng.next() * 120, up: true, paused: false, sess: null, own: null, awaitT: 0, rallyT: 0, lastUp: 0, lastDown: 0 }));
  const jit = () => rng.next() * 25;
  const toServer = (p: Phone, msg: Msg) => {
    if (!p.up) return;
    p.lastUp = Math.max(p.lastUp, now + p.lat + jit());
    up.push({ at: p.lastUp, from: p.idx, msg: JSON.parse(JSON.stringify(msg)) });
    up.sort((a, b) => a.at - b.at);
  };
  const toClient = (p: Phone, msg: Msg, t: number) => {
    if (!p.up) return;
    p.lastDown = Math.max(p.lastDown, t + p.lat + jit());
    down.push({ at: p.lastDown, to: p.idx, msg: JSON.parse(JSON.stringify(msg)) });
    down.sort((a, b) => a.at - b.at);
  };
  // ---- 觀眾 S（spec 模式；不在 phones 裡，不算人數）：單程 80 ms＋抖動；伺服器轉給他玩家的訊息和裁決結果 ----
  let S: Spectator | null = null;
  let sMatch: Match | null = null;
  let sHits = 0;
  const sLat = 80;
  let sLastDown = 0;
  const sDown: { at: number; msg: Msg }[] = [];
  const toSpec = (msg: Msg, t: number) => {
    if (!S) return;
    sLastDown = Math.max(sLastDown, t + sLat + jit());
    sDown.push({ at: sLastDown, msg: JSON.parse(JSON.stringify(msg)) });
    sDown.sort((a, b) => a.at - b.at);
  };
  const SPEC = -1; // up 裡 from = -1 代表觀眾送的
  const broadcast = (ds: { q: number; ev: ArbEv }[], t: number) => {
    for (const d of ds) {
      const acc: Msg = { t: 'acc', q: d.q, e: d.ev as never };
      for (const p of phones) toClient(p, acc, t);
      toSpec(acc, t);
    }
  };
  // 伺服器：依時間順序處理上行訊息和裁決窗口
  const serverRun = () => {
    for (;;) {
      const due = arb.due;
      const m = up[0];
      if (due !== null && due <= now && (!m || due <= m.at)) {
        broadcast(arb.poll(due), due);
        continue;
      }
      if (!m || m.at > now) break;
      up.shift();
      const msg = m.msg;
      if (m.from === SPEC) {
        // 觀眾送的：只接受 ping（直接回）、spec-hello（轉給玩家）
        if (msg.t === 'ping') toSpec({ t: 'pong', a: msg.a }, m.at);
        else if (msg.t === 'spec-hello') for (const p of phones) toClient(p, msg, m.at);
        continue;
      }
      const from = phones[m.from];
      if (msg.t === 'ping') toClient(from, { t: 'pong', a: msg.a }, m.at);
      else if (msg.t === 'ev') broadcast(arb.submit(msg as unknown as ArbEv, m.at), m.at);
      else if (msg.t === 'arb') arb.reset(msg.ep, msg.q);
      else if (msg.t === 'snap') toSpec(msg, m.at); // 快照只給觀眾
      else {
        for (const p of phones) if (p !== from) toClient(p, msg, m.at);
        toSpec(msg, m.at);
      }
    }
  };

  // ---- 斷線／回來（drop 模式，只有第一場）----
  let dropAt = -1;
  let dropped = false;
  let rejoined = false;
  let returnedAt = -1;
  const victim = phones[phones.length - 1];

  // ---- 每台手機 ----
  const host = phones[0];
  let ep = 1;
  let pendingReturn: QuadHuman | null = null;
  const own = (p: Phone) => {
    const s = p.sess!;
    p.own = new AIController(s.match, 0, 'hard');
    // 偶爾故意搶隊友的球（分工沒分到也去打）
    p.own.takeHook = (assigned) => assigned || rng.chance(0.15);
  };
  const begin = (p: Phone, s: QuadSession | null) => {
    p.sess = s;
    if (s) own(p);
  };
  const clientRecv = (p: Phone, msg: Msg) => {
    if (msg.t === 'go') begin(p, QuadSession.start(DEFAULT_SETTINGS, msg, p.cid, (x) => toServer(p, x), () => now, 1000 * g + p.idx));
    else if (msg.t === 'resume4') {
      if (p.sess && QuadSession.seatIn(msg.r, p.cid) === p.sess.mySeat) {
        p.sess.resume(msg);
        own(p); // 新的一分：AI 重新看狀態
      } else begin(p, QuadSession.fromResume(DEFAULT_SETTINGS, msg, p.cid, (x) => toServer(p, x), () => now, 7000 + p.idx));
      p.paused = false;
    } else if (msg.t === 'peer-left') {
      p.paused = true; // 有人斷線：大家先暫停
      if (p === host) dropAt = now;
    } else if (msg.t === 'hello' && p === host && msg.cid) {
      const h = human(msg.cid, msg.name, msg.character);
      if (lobby.join(h, true) === 'return') pendingReturn = h;
    } else if (msg.t === 'spec-hello') {
      // 觀眾要快照：帶大家繼續的人（房主）回（跟 main.ts 的 sendSnap 一樣）
      if (p === host) toServer(host, snapQuad(host.sess, lobby.r));
    } else p.sess?.sync.receive(msg as PeerMsg);
  };
  // 房主開打
  const sendBoth = (p: Phone, a: PeerMsg, b: PeerMsg) => {
    toServer(p, a);
    toServer(p, b);
  };
  const go: PeerMsg = { t: 'go', r: roster, ep, srv: 0 };
  sendBoth(host, { t: 'arb', ep, q: 0 }, go);
  clientRecv(host, go as Msg);

  const resumeAll = (r: QuadRoster) => {
    ep++;
    const msg = host.sess!.resumeMsg(r, ep);
    sendBoth(host, { t: 'arb', ep, q: 0 }, msg);
    clientRecv(host, msg as Msg);
  };

  let tick = 0;
  const maxTicks = 120 * 60 * 40;
  for (; tick < maxTicks; tick++) {
    now = tick * tickMs;
    serverRun();
    while (down.length && down[0].at <= now) {
      const d = down.shift()!;
      if (phones[d.to].up) clientRecv(phones[d.to], d.msg);
    }
    const hs = host.sess;
    // spec：打到 5 分、回合中 → 觀眾進房（伺服器送 welcome，他接著要快照）
    if (spec && !S && hs && hs.match.score[0] + hs.match.score[1] >= 5 && hs.match.phase === 'rally') {
      S = new Spectator(
        { ...DEFAULT_SETTINGS },
        (x) => {
          up.push({ at: now + sLat + jit(), from: SPEC, msg: JSON.parse(JSON.stringify(x)) });
          up.sort((a, b) => a.at - b.at);
        },
        () => now,
        9000 + g,
      );
      S.onMatch = (m) => (sMatch = m);
      sLastDown = now;
      S.receive({ t: 'welcome', role: 'spectator', peers: phones.length, cap: 4, spec: 1 });
    }
    while (S && sDown.length && sDown[0].at <= now) S.receive(sDown.shift()!.msg as SpecMsg);
    if (S && sMatch) {
      sMatch.step(sMatch.players.map(() => idleInput()));
      for (const e of sMatch.drainEvents()) if (e.type === 'hit') sHits++;
      S.afterStep();
    }
    // drop：第一場打到 5 分以上、回合中 → 最後一台手機斷線
    if (drop && g === 0 && !dropped && hs && hs.match.score[0] + hs.match.score[1] >= 5 && hs.match.phase === 'rally') {
      dropped = true;
      victim.up = false;
      victim.sess = null; // 重新整理網頁：比賽狀態沒了
      for (const p of phones) if (p !== victim) toClient(p, { t: 'peer-left', cid: victim.cid }, now);
    }
    // 房主等 3 秒（真實時間）對方沒回來 → AI 接手
    if (dropAt >= 0 && now - dropAt > 3000) {
      dropAt = -1;
      const seat = lobby.seatOf(victim.cid);
      lobby.takeover(seat);
      resumeAll(lobby.r);
    }
    // AI 代打 6 分後，斷線的人重新整理網頁回來（送 hello）
    if (drop && dropped && !rejoined && dropAt < 0 && hs && hs.match.phase === 'point' && hs.match.score[0] + hs.match.score[1] >= 11) {
      rejoined = true;
      victim.up = true;
      victim.lastUp = victim.lastDown = now;
      victim.paused = false;
      toServer(victim, { t: 'hello', v: 5, name: '回來的人', character: chars[3], racket: 'balance', points: 21, games: 1, venue: 'indoor', cid: victim.cid, mv: 'auto' });
    }
    // 房主：回來的人下一分拿回座位（等這一分結束）
    if (pendingReturn && hs && (hs.match.phase === 'point' || hs.match.phase === 'serve')) {
      lobby.giveBack(pendingReturn);
      pendingReturn = null;
      returnedAt = now;
      resumeAll(lobby.r);
    }

    let allOver = true;
    for (const p of phones) {
      const s = p.sess;
      if (!s || !p.up || p.paused) {
        if (p.up) allOver = false;
        continue;
      }
      const m = s.match;
      m.step(s.inputs(p.own ? p.own.input() : idleInput()));
      for (const e of m.drainEvents()) {
        s.sync.onEvent(e);
        if (e.type === 'point') totals.points += p === host ? 1 : 0;
        if (e.type === 'whiff' && e.player === 0) totals.whiffs++;
        if (e.type === 'hit' && e.player === 0) totals.hits++;
      }
      s.sync.afterStep();
      p.awaitT = m.phase === 'await' ? p.awaitT + PHYS.dt : 0;
      p.rallyT = m.phase === 'rally' || m.phase === 'await' ? p.rallyT + PHYS.dt : 0;
      totals.maxAwait = Math.max(totals.maxAwait, p.awaitT);
      totals.maxRally = Math.max(totals.maxRally, p.rallyT);
      if (p.awaitT > 5) fail(`第 ${g + 1} 場：手機 ${p.idx} 等判定超過 5 秒（卡住）`);
      if (m.phase !== 'matchOver') allOver = false;
    }
    if (allOver) break;
  }

  // ---- 檢查：四台的比分（換成標準視角：A 隊、B 隊）一樣 ----
  const canon = (p: Phone) => {
    const s = p.sess!;
    const f = s.mySeat & 1;
    return { sc: [s.match.score[f], s.match.score[f ^ 1]], gm: [s.match.games[f], s.match.games[f ^ 1]], phase: s.match.phase };
  };
  const res = phones.filter((p) => p.sess).map(canon);
  const same = res.every((r) => r.sc[0] === res[0].sc[0] && r.sc[1] === res[0].sc[1] && r.gm[0] === res[0].gm[0] && r.gm[1] === res[0].gm[1]);
  const over = res.every((r) => r.phase === 'matchOver');
  if (!same) fail(`第 ${g + 1} 場：比分不一致 ${JSON.stringify(res)}`);
  if (!over) fail(`第 ${g + 1} 場：沒打完（${res.map((r) => r.phase).join('/')}，tick ${tick}）`);
  if (drop && g === 0) {
    if (!dropped || !rejoined || returnedAt < 0) fail('drop：斷線／回來沒有發生');
    if (!phones.every((p) => p.sess)) fail('drop：回來的人沒有重新加入比賽');
    if (victim.sess && !isHuman(victim.sess.roster.seats[victim.sess.mySeat])) fail('drop：座位沒有還給回來的人');
  }
  if (same && over) totals.ok++;
  if (spec) {
    // 觀眾（標準視角：A 隊、B 隊）最後的比分要跟四台一樣
    const sSame = !!sMatch && sMatch.score[0] === res[0].sc[0] && sMatch.score[1] === res[0].sc[1] && sMatch.games[0] === res[0].gm[0] && sMatch.games[1] === res[0].gm[1] && sMatch.phase === 'matchOver';
    if (sSame) totals.specOk++;
    else fail(`第 ${g + 1} 場：觀眾的比分不一致 ${JSON.stringify({ sc: sMatch?.score, gm: sMatch?.games, phase: sMatch?.phase })} vs ${JSON.stringify(res[0])}`);
    console.log(`  觀眾 S（5 分時進房）：A:B 局數 ${sMatch?.games.join(':')} 比分 ${sMatch?.score.join(':')}｜${sSame ? '跟四台一致' : '不一致！'}｜看到 ${sHits} 拍｜RTT ${S?.rttMs.toFixed(0)}ms`);
  }
  const undo = phones.reduce((a, p) => a + (p.sess?.sync.stats.undo ?? 0), 0);
  const jumps = phones.flatMap((p) => p.sess?.sync.stats.jumps ?? []);
  const mateJumps = phones.flatMap((p) => p.sess?.sync.stats.mateJumps ?? []);
  totals.conflicts += arb.stats.conflicts;
  totals.undo += undo;
  totals.rejected += arb.stats.rejected;
  totals.landBeatHit += arb.stats.landBeatHit;
  totals.decided += arb.stats.decided;
  totals.jumps.push(...jumps);
  totals.mateJumps.push(...mateJumps);
  console.log(
    `第 ${g + 1} 場（${layout}${drop && g === 0 ? '＋斷線回來' : ''}）：A:B 局數 ${res[0].gm.join(':')} 比分 ${res[0].sc.join(':')}｜${same ? '四台一致' : '不一致！'}｜延遲 ${phones.map((p) => Math.round(p.lat)).join('/')} ms｜裁決 ${arb.stats.decided}｜搶球衝突 ${arb.stats.conflicts}｜本機還原 ${undo}｜落地贏過擊球 ${arb.stats.landBeatHit}｜丟掉 ${arb.stats.rejected}`,
  );
  console.log(`  收到擊球時本機的球離擊球點的距離（瞬移）：對手打的 中位 ${pct(jumps, 0.5)} m、90% ${pct(jumps, 0.9)} m、最大 ${pct(jumps, 0.999)} m｜隊友打的 中位 ${pct(mateJumps, 0.5)} m、90% ${pct(mateJumps, 0.9)} m、最大 ${pct(mateJumps, 0.999)} m`);
}
console.log(
  `${totals.ok}/${N} 場四台結果一致｜共 ${totals.points} 分、裁決 ${totals.decided}｜搶球衝突 ${totals.conflicts}（都已裁決）｜本機還原 ${totals.undo}｜真人擊球 ${totals.hits}、揮空 ${totals.whiffs}｜等判定最久 ${totals.maxAwait.toFixed(2)}s｜最長回合 ${totals.maxRally.toFixed(1)}s｜瞬移 對手 中位 ${pct(totals.jumps, 0.5)} m／隊友 中位 ${pct(totals.mateJumps, 0.5)} m、90% ${pct(totals.mateJumps, 0.9)} m`,
);
if (totals.conflicts === 0 && layout !== '2h') fail('沒有發生任何搶球衝突（測試沒測到）');
console.log(fails ? `✘ ${fails} 項失敗` : '✔ 全部通過');
process.exit(fails ? 1 : 0);
