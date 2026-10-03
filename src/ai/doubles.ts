import { GAME } from '../config';
import type { Match, PlayerId, PlayerState, TeamId } from '../sim/match';
import type { Prediction } from '../sim/physics';

/**
 * 雙打的共用判斷（純函式，只讀比賽狀態）：
 * - ballTaker：對方打過來的這一球由隊上哪一位接（兩位 AI、玩家的自動跑位都用同一個結果，
 *   所以不會兩個人搶同一球、也不會兩個人都放掉）
 * - formationSpot：沒有要接球的人該站哪裡（進攻前後站、防守左右並排）
 */

/** 這一球分給誰接：球員、預估擊球點、還有多久 */
export interface Assignment {
  id: PlayerId;
  x: number;
  z: number;
  t: number;
}

const REACT = 0.2; // 估算用的反應時間（跟難度無關，大家算出來才會一樣）
const TIE = 0.12; // 兩人差不多時，照陣型分工的加權（秒）
const SLACK = 0.05; // 至少提早這麼多到位才算「來得及」
const FRONT_Z = 3.3; // 擊球點離網比這近算前場球
const LIFT_APEX = 3.3; // 最高點超過這個高度 = 挑高球（打的那一隊轉防守）

interface Memo {
  serial: number;
  team: TeamId;
  a: Assignment | null;
}
const memo = new WeakMap<Match, Memo>();
const apexMemo = new WeakMap<Prediction, number>();

/** 這顆球的最高點（判斷是挑高球還是往下壓的球） */
function apexOf(pred: Prediction): number {
  let a = apexMemo.get(pred);
  if (a === undefined) {
    a = 0;
    for (const q of pred.points) a = Math.max(a, q.p.y);
    apexMemo.set(pred, a);
  }
  return a;
}

/** 現在飛行中的這一球是不是挑高球（高遠／挑球／發高遠） */
export function isLift(m: Match): boolean {
  const pred = m.shuttle.prediction;
  return !!pred && apexOf(pred) >= LIFT_APEX;
}

/** 這一隊現在是進攻（前後站）還是防守（左右並排）：自己這隊壓下去 = 進攻；對方挑高給我們 = 進攻 */
export function teamAttacking(m: Match, team: TeamId): boolean {
  const h = m.shuttle.lastHitter;
  if (h === null) return false;
  const lift = isLift(m);
  return m.teamOf(h) === team ? !lift : lift;
}

/** 擋不住、還趴在地上、在空中……還要多久才能開始跑 */
function busyTime(p: PlayerState): number {
  let t = p.downT + p.landRecover;
  if (p.dive) t += Math.max(0, GAME.dive.dur - p.dive.t) + GAME.dive.down;
  if (p.airborne) t += 0.25;
  return t;
}

/**
 * 對方打過來的球分給隊上哪一位：沿著預測軌跡，找每個人「最早來得及」的擊球點
 * （跑過去的時間 + 反應 + 還趴著／在空中的時間 ≤ 球飛到那裡的時間），最早能接到的那位接（網前的人可以攔截）；
 * 兩人差不多（相差 < TIE 秒）時照陣型分工：前後站 → 前場球給前面的人、後場球給後面的人；並排 → 球在誰那一半誰接。
 * 都來不及就給最接近來得及的那位。雙打發球只有接發球的人能接。
 * 結果依擊球序號記住，整個來球期間不變（AI 夥伴、AI 對手、玩家的自動跑位看到的都一樣）。
 * 手動跑位的玩家也照這個分：比較靠近玩家的球，AI 夥伴就會讓給玩家。
 */
export function ballTaker(m: Match, team: TeamId): Assignment | null {
  const sh = m.shuttle;
  if (sh.lastHitter === null || m.teamOf(sh.lastHitter) === team || !sh.prediction || sh.mode !== 'flight') return null;
  const c = memo.get(m);
  if (c && c.serial === m.hitSerial && c.team === team) return c.a;
  const a = computeTaker(m, team);
  memo.set(m, { serial: m.hitSerial, team, a });
  return a;
}

function computeTaker(m: Match, team: TeamId): Assignment | null {
  const sh = m.shuttle;
  const pred = sh.prediction!;
  if (pred.hitsNet) return null;
  let mates = m.teamPlayers(team);
  // 雙打發球只有接發球的人能接
  if (sh.isServe && m.doubles) mates = mates.filter((p) => p.id === m.receiver);
  const elapsed = m.time - sh.launchTime;
  const attack = isLift(m); // 對方挑高 → 我們進攻（前後站）
  const front = mates.length === 2 ? (Math.abs(mates[0].pos.z) <= Math.abs(mates[1].pos.z) ? mates[0].id : mates[1].id) : -1;
  let best: Assignment | null = null;
  let bestScore = Infinity;
  for (const p of mates) {
    const speed = GAME.moveSpeed * p.kit.move;
    const reach = GAME.reach * p.reachMul;
    const busy = busyTime(p);
    // 最早來得及的點（越早接 = 越主動，網前的人可以攔截）；都來不及就取最接近來得及的點
    let first = Infinity;
    let need = Infinity;
    let bx = 0;
    let bz = 0;
    let bt = 0;
    for (let i = 0; i < pred.points.length; i += 2) {
      const q = pred.points[i];
      const tt = q.t - elapsed;
      if (tt < 0) continue;
      const pt = q.p;
      if (pt.z * p.side < 0.15 || pt.y < 0.25 || pt.y > GAME.reachMaxY - 0.1) continue;
      const dist = Math.max(0, Math.hypot(pt.x - p.pos.x, pt.z - p.pos.z) - reach * 0.8);
      const n = dist / speed + REACT + busy - tt;
      if (first === Infinity && (n < need || n <= -SLACK)) {
        need = n;
        bx = pt.x;
        bz = pt.z;
        bt = tt;
      }
      if (n <= -SLACK) {
        first = tt;
        break;
      }
    }
    if (need === Infinity) continue;
    let pen = 0;
    const mate = mates.find((o) => o.id !== p.id);
    if (mate) {
      if (attack) {
        if (Math.abs(bz) < FRONT_Z !== (p.id === front)) pen = TIE;
      } else {
        // 並排：球在兩人中線的哪一邊
        const mid = (p.pos.x + mate.pos.x) / 2;
        if (Math.sign(bx - mid) !== Math.sign(p.pos.x - mate.pos.x)) pen = TIE;
      }
    }
    const score = (first < Infinity ? first : 10 + need) + pen;
    if (score < bestScore) {
      bestScore = score;
      best = { id: p.id, x: bx, z: bz, t: bt };
    }
  }
  return best;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/**
 * 不接這一球的人（或剛打完的人）該站哪裡（世界座標）：
 * - 進攻（前後站）：一人在前發球線附近（約 2.35 m）封網，一人在中後場（約 4.6 m）；
 *   誰前誰後看「參考的人」（剛擊球的人／負責接這球的人）的擊球點在前場還是後場，另一人補另一個位置
 * - 防守（左右並排，約 3.9 m）：參考的人顧他那一半，另一人顧另一半；整體往球打去的方向偏一點
 */
export function formationSpot(m: Match, id: PlayerId): { x: number; z: number } {
  const me = m.players[id];
  const mate = m.partnerOf(id);
  const side = me.side;
  const sh = m.shuttle;
  if (!mate || sh.lastHitter === null) return { x: 0, z: side * 3.6 };
  const hitter = m.players[sh.lastHitter];
  const ours = hitter.team === me.team;
  const attack = teamAttacking(m, me.team);
  // 參考的人：我們打出去 → 擊球的人；對方打過來 → 分到這球的人
  let ref: { id: PlayerId; x: number; z: number } | null = null;
  let shift = 0;
  if (ours) {
    const cp = hitter.swing?.contactPoint ?? hitter.pos;
    ref = { id: hitter.id, x: cp.x, z: cp.z };
    // 往對方可能回球的方向（我們這球的落點）偏一點，封直線
    const L = sh.prediction?.landing;
    if (L) shift = clamp(L.x * 0.25, -0.5, 0.5);
  } else {
    const a = ballTaker(m, me.team);
    if (a) ref = { id: a.id, x: a.x, z: a.z };
  }
  if (!ref) {
    // 沒有參考（掛網球等）：照目前站位，前面的人在前、左右照現在的位置
    ref = { id: mate.id, x: mate.pos.x, z: mate.pos.z };
  }
  const iAmRef = ref.id === id;
  if (attack) {
    const refFront = Math.abs(ref.z) < FRONT_Z;
    const front = iAmRef ? refFront : !refFront;
    return front ? { x: clamp(shift * 1.4 + (ours ? 0 : ref.x * 0.25), -1, 1), z: side * 2.35 } : { x: clamp(shift, -0.8, 0.8), z: side * 4.6 };
  }
  // 防守並排：參考的人那一半（世界座標的正負）
  let refLane = Math.sign(ref.x);
  if (Math.abs(ref.x) < 0.15) refLane = Math.sign((iAmRef ? me.pos.x - mate.pos.x : mate.pos.x - me.pos.x) || 1);
  const lane = iAmRef ? refLane : -refLane;
  return { x: clamp(shift + lane * 1.35, -2.2, 2.2), z: side * 3.9 };
}
