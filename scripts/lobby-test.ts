// 遊戲大廳名單（server/src/lobby.ts）的單元測試：整筆取代、過期清除、排序、節流合併
// 執行：npx tsx scripts/lobby-test.ts
import { Coalescer, LOBBY_MAX_AGE_MS, LOBBY_MIN_GAP_MS, LobbyRegistry, type LobbyEntry } from '../server/src/lobby';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) fails++;
  console.log(`${ok ? '✔' : '✘'} ${msg}`);
};
const entry = (code: string, t: number, extra: Partial<LobbyEntry> = {}): LobbyEntry => ({
  code,
  host: '房主',
  mode: 'singles',
  venue: 'indoor',
  points: 21,
  games: 1,
  cap: 2,
  players: 1,
  spectators: 0,
  status: 'wait',
  t,
  ...extra,
});

// ---- 名單 ----
{
  const reg = new LobbyRegistry();
  reg.upsert(entry('AAAA', 1000));
  reg.upsert(entry('BBBB', 2000, { status: 'play', sc: [5, 3] }));
  reg.upsert(entry('CCCC', 3000, { status: 'over' }));
  reg.upsert(entry('DDDD', 4000));
  check(reg.size === 4, '四筆都在');
  const l = reg.list(5000);
  check(l.map((e) => e.code).join(',') === 'DDDD,AAAA,BBBB,CCCC', `等待中（最近有動靜的在前）→ 比賽中 → 已結束：${l.map((e) => e.code).join(',')}`);
  // 整筆取代
  reg.upsert(entry('AAAA', 6000, { players: 2, status: 'play', sc: [0, 0] }));
  check(reg.get('AAAA')?.players === 2 && reg.get('AAAA')?.status === 'play', 'upsert 整筆取代（人數、狀態都換新）');
  check(reg.list(6000)[0].code === 'DDDD' && reg.list(6000)[1].code === 'AAAA', '變成比賽中就排到等待中的後面');
  // 過期：超過 LOBBY_MAX_AGE_MS 沒更新的不列、prune 清掉
  const now = 4000 + LOBBY_MAX_AGE_MS + 1; // BBBB/CCCC/DDDD（2000～4000）都過期，AAAA（6000）還在
  const visible = reg.list(now).map((e) => e.code);
  check(!visible.includes('BBBB') && visible.includes('AAAA'), `過期的不列出來（BBBB 2000 → 不見；AAAA 剛更新 → 還在）：${visible.join(',')}`);
  const gone = reg.prune(now);
  check(gone.sort().join(',') === 'BBBB,CCCC,DDDD' && reg.size === 1, `prune 回傳清掉的房號：${gone.join(',')}，剩 ${reg.size} 筆`);
  check(reg.remove('AAAA') && !reg.remove('AAAA') && reg.size === 0, 'remove：第一次 true、第二次 false');
}

// ---- 節流 ----
{
  const c = new Coalescer();
  check(c.request(10_000) === null, '第一次要送：馬上送');
  c.sent(10_000);
  const at1 = c.request(10_500);
  const at2 = c.request(11_000);
  const at3 = c.request(11_900);
  check(at1 === 12_000 && at2 === 12_000 && at3 === 12_000 && c.pending, `2 秒內的三次變動合併成同一個時間點（${at1}）`);
  c.sent(12_000);
  check(!c.pending && c.request(12_000 + LOBBY_MIN_GAP_MS) === null, '時間到送出後，下一次要送又可以馬上送');
  // 模擬房間：10 次連續變動（0.1 秒一次）只會送 2 次（第一次＋合併的那一次）
  const c2 = new Coalescer();
  let sends = 0;
  let timer: number | null = null;
  for (let i = 0; i < 10; i++) {
    const now = 20_000 + i * 100;
    const at = c2.request(now);
    if (at === null) {
      sends++;
      c2.sent(now);
    } else timer = at;
  }
  if (timer !== null) {
    sends++;
    c2.sent(timer);
  }
  check(sends === 2 && timer === 22_000, `10 次密集變動 → 送 ${sends} 次（第二次在 ${timer}）`);
}

console.log(fails ? `✘ ${fails} 項失敗` : '✔ 全部通過');
process.exit(fails ? 1 : 0);
