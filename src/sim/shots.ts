import { COURT, GAME } from '../config';
import { fly2d, netTopAt, solveCrossing, solveSpeed, v3, type Vec3 } from './physics';
import type { Rng } from './rng';

/** 划動方向分成三類：上（高遠/挑）、下（殺/切/放網）、橫（平抽） */
export type Family = 'up' | 'down' | 'side';

export interface Flick {
  x: number; // 往右為正（擊球者自己的視角）
  y: number; // 往上（往對面）為正
}

export function classifyFlick(f: Flick): { family: Family; aimX: number } {
  const len = Math.hypot(f.x, f.y) || 1;
  const nx = f.x / len;
  const ny = f.y / len;
  // 與垂直方向夾角 < 約 50° 算上/下，其餘算橫
  let family: Family;
  if (Math.abs(nx) < 0.77) family = ny > 0 ? 'up' : 'down';
  else family = 'side';
  const aimX = Math.max(-1, Math.min(1, nx * 1.15));
  return { family, aimX };
}

export interface ShotRequest {
  side: 1 | -1; // 1 = 靠近鏡頭那一側（z>0），-1 = 對面
  contact: Vec3;
  family: Family;
  aimX: number;
  charge: number; // 0..1
  quality: number; // 0..1，擊球時機/位置好壞
  serve: null | { boxCenterX: number }; // 發球時對角發球區中心（世界座標 x）
}

export interface ShotResult {
  vel: Vec3;
  name: string;
  family: Family;
  target: Vec3;
  speedKmh: number;
  netFault: boolean; // 蓄力不足、注定掛網
}

const DEG = Math.PI / 180;

/** 依蓄力與目前離網距離，換算目標落點深度（越過網後的距離）。負值或很小代表掛網。 */
export function depthFromCharge(charge: number, distToNet: number): number {
  return charge * GAME.maxShotLength - distToNet;
}

/**
 * 來球越快，反彈力越大：接殺球時就算沒蓄力也能擋到網前。
 * 實際蓄力 = max(玩家蓄力, 反彈力)
 */
export function reboundCharge(incomingSpeed: number): number {
  return Math.min(0.45, incomingSpeed * 0.028);
}

/** 給定離網距離，回傳蓄力條上各區段（0..1）——UI 用 */
export function chargeZones(distToNet: number, serve = false) {
  const L = GAME.maxShotLength;
  const c = (d: number) => Math.max(0, Math.min(1, (distToNet + d) / L));
  return {
    net: c(serve ? COURT.shortService : 0.5), // 小於此值：掛網（發球則是沒過前發球線）
    front: c(serve ? COURT.shortService + 0.6 : 2.2), // 網前
    deep: c(COURT.halfLength - 1.4), // 底線前 1.4 m：深球
    out: c(COURT.halfLength), // 大於此值：出界
  };
}

export function resolveShot(req: ShotRequest, rng: Rng): ShotResult {
  const { side, contact, family, charge, quality } = req;
  const dn = Math.abs(contact.z);
  const err = 1 - quality;

  let D = depthFromCharge(charge, dn) + rng.gauss() * (0.15 + err * 1.6);
  // 發球：在對角發球區內左右微調；一般擊球：左右分量決定落點
  const tx = req.serve
    ? req.serve.boxCenterX + side * req.aimX * 1.0 + rng.gauss() * 0.1
    : side * (req.aimX * 2.3 + rng.gauss() * (0.12 + err * 1.2));
  let netFault = false;
  if (D < 0.35) {
    // 力道不足：打進網子
    netFault = true;
    D = 0.8;
  }
  const tz = -side * D;
  const target = v3(tx, 0, tz);

  const dx = tx - contact.x;
  const dz = tz - contact.z;
  const L = Math.hypot(dx, dz);
  const ux = dx / L;
  const uz = dz / L;
  const sNet = -contact.z / uz;
  const netY = netTopAt(contact.x + ux * sNet);
  const y0 = contact.y;

  let th: number;
  let v: number;
  if (netFault) {
    ({ th, v } = solveCrossing(netY - 0.3, y0, L, sNet, -30 * DEG, 70 * DEG));
  } else if (family === 'up') {
    th = (req.serve ? 55 : y0 >= GAME.highZoneY ? 40 : 52) * DEG;
    v = solveSpeed(th, y0, L, sNet);
    // 靠網太近、擊球點又低時，固定仰角會撞網 → 改用更陡的角度挑過網
    if (fly2d(v, th, y0, sNet).netY < netY + 0.4) ({ th, v } = solveCrossing(netY + 0.6, y0, L, sNet, th, 84 * DEG));
  } else if (family === 'side') {
    const clear = y0 >= GAME.highZoneY ? 0.5 : 0.35;
    ({ th, v } = solveCrossing(netY + clear, y0, L, sNet, -20 * DEG, 45 * DEG));
  } else {
    ({ th, v } = solveCrossing(netY + 0.1, y0, L, sNet, -35 * DEG, 75 * DEG));
  }

  const vh = v * Math.cos(th);
  const vel = v3(ux * vh, v * Math.sin(th), uz * vh);
  return {
    vel,
    name: shotName(family, y0, dn, D, !!req.serve),
    family,
    target,
    speedKmh: Math.round(v * 3.6),
    netFault,
  };
}

function shotName(family: Family, y: number, dn: number, D: number, serve: boolean): string {
  if (serve) return family === 'up' ? '發高遠球' : family === 'side' ? '平快發球' : '發小球';
  const high = y >= GAME.highZoneY;
  const aboveNet = y >= COURT.netTop;
  if (family === 'up') return high ? '高遠球' : '挑球';
  if (family === 'side') return high && D > 4.5 ? '平高球' : '平抽';
  if (high) return D < 2.6 ? '切球' : '殺球';
  if (aboveNet) return dn < 2.5 && D >= 2.6 ? '撲球' : D < 2.6 ? '切球' : '下壓';
  return D < 2.6 ? '放網' : '推球';
}
