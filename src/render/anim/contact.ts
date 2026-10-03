import { GAME, PHYS } from '../../config';
import type { Match } from '../../sim/match';

/**
 * 預估「這位球員接下來在哪裡、多久後擊球」，只給步法動畫用（唯讀，不影響模擬）。
 * 依羽球的預測軌跡：羽球進入身體附近（≈ 擊球品質滿分的距離）的第一個點；
 * 沒有進到那麼近就取最接近的點，並附上距離讓動畫自己判斷要不要跨出去。
 */
export interface ContactHint {
  t: number; // 還有多少模擬秒擊球
  x: number; // 世界座標擊球點
  y: number;
  z: number;
  d: number; // 那時羽球離（預估的）身體位置的水平距離
}

const HIT_R = 0.9; // 羽球進到這麼近通常就會被打到（模擬的位置品質在 0.92 m 內滿分）
const LOOK_AHEAD = 1.1; // 只看這麼遠的未來（模擬秒）
const MOVE_LEAD = 0.1; // 球員再沿目前速度移動這麼久就會停下來（減速）

export function predictContact(m: Match, id: 0 | 1, out: ContactHint): ContactHint | null {
  const sh = m.shuttle;
  const pred = sh.prediction;
  if (m.phase !== 'rally' || sh.mode !== 'flight' || sh.lastHitter === id || !pred) return null;
  const p = m.players[id];
  const pts = pred.points;
  const elapsed = m.time - sh.launchTime;
  let best = -1;
  let bestD = Infinity;
  const i0 = Math.max(0, Math.floor(elapsed / PHYS.dt) - 2);
  for (let i = i0; i < pts.length; i++) {
    const pt = pts[i];
    const tt = pt.t - elapsed;
    if (tt < 0) continue;
    if (tt > LOOK_AHEAD) break;
    const q = pt.p;
    if (q.z * p.side < 0.05 || q.y < GAME.reachMinY || q.y > GAME.reachMaxY + p.pos.y) continue;
    const lead = Math.min(tt, MOVE_LEAD);
    const d = Math.hypot(q.x - (p.pos.x + p.vel.x * lead), q.z - (p.pos.z + p.vel.z * lead));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
    if (d <= HIT_R) break;
  }
  if (best < 0) return null;
  const q = pts[best].p;
  out.t = Math.max(0, pts[best].t - elapsed);
  out.x = q.x;
  out.y = q.y;
  out.z = q.z;
  out.d = bestD;
  return out;
}
