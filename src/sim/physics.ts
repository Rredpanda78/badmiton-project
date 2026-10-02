import { COURT, DRAG_K, PHYS } from '../config';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const copy3 = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

/**
 * 羽球一步積分：二次空氣阻力（以速度衰減的解析式處理，大速度也穩定）＋重力。
 * 遊戲模擬與擊球求解器共用同一套公式，所以預測的落點與實際一致。
 */
export function stepShuttle(p: Vec3, v: Vec3, dt = PHYS.dt): void {
  const s = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const f = 1 / (1 + DRAG_K * s * dt);
  v.x *= f;
  v.y *= f;
  v.z *= f;
  v.y -= PHYS.g * dt;
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;
}

/** 網子高度（中間 1.524，網柱 1.55，中間用二次內插） */
export function netTopAt(x: number): number {
  const r = Math.min(1, Math.abs(x) / COURT.doublesHalfWidth);
  return COURT.netTop + (COURT.postTop - COURT.netTop) * r * r;
}

export interface PathPoint {
  t: number;
  p: Vec3;
}

export interface Prediction {
  points: PathPoint[]; // 每 step 一點（直到落地或撞網）
  landing: Vec3 | null; // 若撞網則為 null
  landTime: number;
  hitsNet: boolean;
  stepDt: number; // 每 tick 的物理時間步長（> PHYS.dt 代表球速被加快）
}

/** 從目前狀態往後預測軌跡（含撞網判定）。stepDt = 每 tick 羽球前進的物理時間（球速倍率 × PHYS.dt）；t 用 tick 時間計 */
export function predict(p0: Vec3, v0: Vec3, stepDt = PHYS.dt, maxT = 6): Prediction {
  const p = copy3(p0);
  const v = copy3(v0);
  const points: PathPoint[] = [{ t: 0, p: copy3(p) }];
  let t = 0;
  while (t < maxT) {
    const pz = p.z;
    const py = p.y;
    stepShuttle(p, v, stepDt);
    t += PHYS.dt;
    if (pz !== 0 && Math.sign(pz) !== Math.sign(p.z)) {
      const a = pz / (pz - p.z);
      const yCross = py + (p.y - py) * a;
      if (yCross < netTopAt(p.x)) return { points, landing: null, landTime: t, hitsNet: true, stepDt };
    }
    if (p.y <= 0) {
      const a = py / (py - p.y);
      const land = v3(p.x, 0, pz + (p.z - pz) * a);
      points.push({ t, p: land });
      return { points, landing: land, landTime: t, hitsNet: false, stepDt };
    }
    points.push({ t, p: copy3(p) });
  }
  return { points, landing: null, landTime: t, hitsNet: false, stepDt };
}

// ---------- 擊球求解器（2D：沿擊球方向的垂直平面） ----------

interface Flight2D {
  land: number; // 落地時的水平距離
  netY: number; // 經過網子平面時的高度（還沒到網就落地則為 -1）
}

export function fly2d(v0: number, th: number, y0: number, sNet: number, dt = PHYS.dt): Flight2D {
  let s = 0;
  let y = y0;
  let vs = v0 * Math.cos(th);
  let vy = v0 * Math.sin(th);
  let netY = -1;
  for (let t = 0; t < 8; t += dt) {
    const sp = Math.sqrt(vs * vs + vy * vy);
    const f = 1 / (1 + DRAG_K * sp * dt);
    vs *= f;
    vy = vy * f - PHYS.g * dt;
    const ps = s;
    const py = y;
    s += vs * dt;
    y += vy * dt;
    if (netY < 0 && ps < sNet && s >= sNet) netY = py + ((y - py) * (sNet - ps)) / (s - ps);
    if (y <= 0) return { land: ps + (s - ps) * (py / (py - y)), netY };
  }
  return { land: s, netY };
}

const V_MAX = 150;

/** 固定仰角下，求能落在距離 L 的初速 */
export function solveSpeed(th: number, y0: number, L: number, sNet: number, dt = PHYS.dt): number {
  let lo = 0.3;
  let hi = V_MAX;
  if (fly2d(hi, th, y0, sNet, dt).land < L) return hi;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (fly2d(mid, th, y0, sNet, dt).land < L) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 求「落在 L 且過網高度約為 targetNetY」的仰角（取最低、最有攻擊性的一條） */
export function solveCrossing(
  targetNetY: number,
  y0: number,
  L: number,
  sNet: number,
  thMin: number,
  thMax: number,
  dt = PHYS.dt,
): { th: number; v: number } {
  const netYAt = (th: number) => fly2d(solveSpeed(th, y0, L, sNet, dt), th, y0, sNet, dt).netY;
  if (netYAt(thMin) >= targetNetY) return { th: thMin, v: solveSpeed(thMin, y0, L, sNet, dt) };
  let lo = thMin;
  let hi = thMax;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (netYAt(mid) < targetNetY) lo = mid;
    else hi = mid;
  }
  return { th: hi, v: solveSpeed(hi, y0, L, sNet, dt) };
}
