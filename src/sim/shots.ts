import { COURT, GAME, PHYS } from '../config';
import { fly2d, netTopAt, solveCrossing, solveSpeed, v3, type Vec3 } from './physics';
import { shotGroup, type Kit } from './kits';
import type { Rng } from './rng';

/** 划動方向分成三類：上（高遠/挑）、下（殺/切/放網）、橫（平抽） */
export type Family = 'up' | 'down' | 'side';

export interface Flick {
  x: number; // 往右為正（擊球者自己的視角）
  y: number; // 往上（往對面）為正
  /** 第二種操作（點擊滑放）直接指定球種與深度；smash = 依位置自動選殺球或撲球 */
  cmd?: { family: Family; depth: number | 'smash' };
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
  jump: boolean; // 在空中擊球
  kit?: Kit; // 球員特質＋球拍（沒給就是標準）
}

export interface ShotResult {
  vel: Vec3;
  name: string;
  family: Family;
  target: Vec3;
  speedKmh: number;
  netFault: boolean; // 注定掛網
  powerShort: boolean; // 掛網原因是蓄力不足（否則是擊球品質差造成的誤差）
  stepDt: number; // 這顆球每 tick 前進的物理時間（球速倍率）
}

const DEG = Math.PI / 180;
// 球速倍率：殺球類維持原速；網前小球只加快一點（太快會變成救不到的必殺球）；其他 ×ballSpeedMul
const SPEED_BY_NAME: Record<string, number> = { 殺球: 1, 撲球: 1, 跳撲: 1, 下壓: 1, 切球: 1.2, 放網: 1.2, 發小球: 1.2 };

/** 蓄力 → 目標落點深度（越過網後的距離）。很小或負值代表掛網，大於底線代表出界。 */
export function depthFromCharge(charge: number): number {
  return GAME.depthAtZero + charge * (GAME.depthAtFull - GAME.depthAtZero);
}
export function chargeForDepth(depth: number): number {
  return (depth - GAME.depthAtZero) / (GAME.depthAtFull - GAME.depthAtZero);
}

/**
 * 來球越快，反彈力越大：接殺球時就算沒蓄力也能擋到網前。
 * 實際蓄力 = max(玩家蓄力, 反彈力)
 */
export function reboundCharge(incomingSpeed: number): number {
  return Math.min(0.45, incomingSpeed * 0.028);
}

/** 蓄力條上各區段（0..1）——UI 用 */
export function chargeZones(serve = false) {
  const c = (d: number) => Math.max(0, Math.min(1, chargeForDepth(d)));
  return {
    net: c(serve ? COURT.shortService : NET_FAULT_DEPTH), // 小於此值：掛網（發球則是沒過前發球線）
    front: c(serve ? COURT.shortService + 0.6 : 2.2), // 網前
    deep: c(COURT.halfLength - 1.4), // 底線前 1.4 m：深球
    out: c(COURT.halfLength), // 大於此值：出界
  };
}

const NET_FAULT_DEPTH = 0.35;

export function resolveShot(req: ShotRequest, rng: Rng): ShotResult {
  const { side, contact, family, charge, quality } = req;
  const dn = Math.abs(contact.z);
  const err = 1 - quality;

  const D0 = depthFromCharge(charge);
  const acc = req.kit?.accuracy ?? 1;
  let D = D0 + rng.gauss() * (0.1 + err * 0.7) * acc;
  // 發球：在對角發球區內左右微調；一般擊球：左右分量決定落點
  const tx = req.serve
    ? req.serve.boxCenterX + side * req.aimX * 1.0 + rng.gauss() * 0.1
    : side * (req.aimX * 2.3 + rng.gauss() * (0.08 + err * 0.6) * acc);
  let netFault = false;
  if (D < NET_FAULT_DEPTH) {
    // 深度太短：打進網子
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

  let name = shotName(family, y0, dn, D, !!req.serve);
  // 在空中往下壓：後場叫跳殺；網前叫跳撲（仍套用撲球限速）
  const jumpSmash = req.jump && (name === '殺球' || name === '撲球');
  if (jumpSmash) name = name === '撲球' ? '跳撲' : '跳殺';
  // 球員／球拍的球速加成：同一條軌跡跑更快
  // 發球不吃球速加成（避免平快發球被推壓手濫用）
  const kitMul = req.serve ? 1 : (req.kit?.speed[shotGroup(name)] ?? 1);
  const dt = PHYS.dt * kitMul * (name === '跳殺' ? GAME.jump.smashBallMul : (SPEED_BY_NAME[name] ?? GAME.ballSpeedMul));

  let th: number;
  let v: number;
  if (netFault) {
    ({ th, v } = solveCrossing(netY - 0.3, y0, L, sNet, -30 * DEG, 70 * DEG, dt));
  } else if (family === 'up') {
    th = (req.serve ? 55 : y0 >= GAME.highZoneY ? 40 : 52) * DEG;
    v = solveSpeed(th, y0, L, sNet, dt);
    // 靠網太近、擊球點又低時，固定仰角會撞網 → 改用更陡的角度挑過網
    if (fly2d(v, th, y0, sNet, dt).netY < netY + 0.4) ({ th, v } = solveCrossing(netY + 0.6, y0, L, sNet, th, 84 * DEG, dt));
    ({ th, v } = capSpeed(th, v, GAME.liftMaxSpeed / kitMul, y0, L, sNet, dt, 25 * DEG));
  } else if (family === 'side') {
    const clear = y0 >= GAME.highZoneY ? 0.5 : 0.35;
    ({ th, v } = solveCrossing(netY + clear, y0, L, sNet, -20 * DEG, 45 * DEG, dt));
    ({ th, v } = capSpeed(th, v, GAME.smashMaxSpeed / kitMul, y0, L, sNet, dt));
  } else {
    ({ th, v } = solveCrossing(netY + 0.1, y0, L, sNet, -35 * DEG, 75 * DEG, dt));
    // 上限要除以球速加成：加成是讓球「跑更快」，實際速度仍不能超過上限
    const cap = name === '撲球' || name === '跳撲' ? GAME.killMaxSpeed : name === '跳殺' ? GAME.jump.smashMaxSpeed : GAME.smashMaxSpeed;
    ({ th, v } = capSpeed(th, v, cap / kitMul, y0, L, sNet, dt));
  }

  const vh = v * Math.cos(th);
  const vel = v3(ux * vh, v * Math.sin(th), uz * vh);
  const powerShort = netFault && D0 < NET_FAULT_DEPTH + 0.3;
  return { vel, name, family, target, speedKmh: Math.round(v * 3.6 * kitMul), netFault, powerShort, stepDt: dt };
}

/** 初速超過上限時，把角度往 thTo 調（壓球往上抬、挑球往下壓到較省力的角度）直到初速降到上限內 */
function capSpeed(th: number, v: number, cap: number, y0: number, L: number, sNet: number, dt: number, thTo = 45 * DEG): { th: number; v: number } {
  if (v <= cap) return { th, v };
  let lo = th;
  let hi = thTo;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (solveSpeed(mid, y0, L, sNet, dt) > cap) lo = mid;
    else hi = mid;
  }
  return { th: hi, v: Math.min(cap, solveSpeed(hi, y0, L, sNet, dt)) };
}

function shotName(family: Family, y: number, dn: number, D: number, serve: boolean): string {
  if (serve) return family === 'up' ? '發高遠球' : family === 'side' ? '平快發球' : '發小球';
  const high = y >= GAME.highZoneY;
  const aboveNet = y >= COURT.netTop;
  if (family === 'up') return high ? '高遠球' : '挑球';
  if (family === 'side') return high && D > 4.5 ? '平高球' : '平抽';
  // 靠網 2.5 m 內往下壓到中後場都算撲球（會被限速），不論擊球點多高
  if (aboveNet && dn < 2.5 && D >= 2.6) return '撲球';
  if (high) return D < 2.6 ? '切球' : '殺球';
  if (aboveNet) return D < 2.6 ? '切球' : '下壓';
  return D < 2.6 ? '放網' : '推球';
}
