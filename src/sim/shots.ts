import { COURT, GAME, PHYS } from '../config';
import { fly2d, netTopAt, solveCrossing, solveSpeed, v3, type Vec3 } from './physics';
import { shotGroup, type Kit } from './kits';
import type { Rng } from './rng';

/** 划動方向分成三類：上（高遠/挑）、下（殺/切/放網）、橫（平抽） */
export type Family = 'up' | 'down' | 'side';

/** 發球種類：發小球、發高遠球、彈發（快而平、剛好過接發球員頭頂）、平抽發（平快打接發球員身體／反手） */
export type ServeKind = 'short' | 'high' | 'flick' | 'drive';
export const SERVE_NAMES: Record<ServeKind, string> = { short: '發小球', high: '發高遠球', flick: '彈發', drive: '平抽發' };

export interface Flick {
  x: number; // 往右為正（擊球者自己的視角）
  y: number; // 往上（往對面）為正
  /**
   * 第二種操作（點擊滑放）直接指定球種與深度；smash = 依位置自動選殺球或撲球；auto = 依擊球點高低自動選（高 = 上手、低 = 下手）
   * stick = 來自「殺」搖桿（發球時：往上 = 彈發、其他 = 平抽發）；long = 主搖桿滑過第二圈（發球時往上 = 彈發）；
   * serve = 直接指定發球種類（AI 用，depth 給數字）
   */
  cmd?: { family: Family; depth: number | 'smash' | 'auto'; soft?: boolean; stick?: 'smash'; long?: boolean; serve?: ServeKind };
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

/** 發球：種類、對角發球區、目標深度、時機 */
export interface ServeSpec {
  kind: ServeKind;
  boxSign: number; // 對角發球區在 x 的正負號（世界座標）
  halfWidth: number; // 單打 2.59／雙打 3.05
  longLine: number; // 發球區後界：單打底線、雙打後發球線
  depth: number; // 目標深度（越過網的距離），由手勢／蓄力決定；時機差會再偏
  timing: number; // 出拍時機：正 = 早（球還沒落到最低點）、負 = 晚（秒）
  receiverX?: number; // 接發球員的位置（世界座標；平抽發球瞄身體／反手、彈發要過他頭頂）
  receiverZ?: number;
}

export interface ShotRequest {
  side: 1 | -1; // 1 = 靠近鏡頭那一側（z>0），-1 = 對面
  contact: Vec3;
  family: Family;
  aimX: number;
  charge: number; // 0..1
  quality: number; // 0..1，擊球時機/位置好壞（發球 = 節奏時機）
  serve: null | ServeSpec; // 發球
  jump: boolean; // 在空中擊球
  kit?: Kit; // 球員特質＋球拍（沒給就是標準）
  killCap?: number; // 撲球的初速上限（平球按鍵在網前變撲球時比較快）
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
const SPEED_BY_NAME: Record<string, number> = { 殺球: 1, 撲球: 1, 跳撲: 1, 下壓: 1, 切球: 1.2, 放網: 1.2, 發小球: 1.2, 彈發: 1.6, 平抽發: 1.6 };

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

/** 蓄力條上各區段（0..1）——UI 用；雙打發球的後界是雙打後發球線；發球時 deep～out 這段往上划 = 彈發 */
export function chargeZones(serve = false, doubles = false) {
  const c = (d: number) => Math.max(0, Math.min(1, chargeForDepth(d)));
  const back = serve && doubles ? COURT.doublesLongService : COURT.halfLength;
  return {
    net: c(serve ? COURT.shortService : NET_FAULT_DEPTH), // 小於此值：掛網（發球則是沒過前發球線）
    front: c(serve ? COURT.shortService + 0.6 : 2.2), // 網前
    deep: c(back - (serve ? GAME.serve.flickBand : 1.4)), // 底線前 1.4 m：深球（發球：彈發段）
    out: c(back), // 大於此值：出界
  };
}

const NET_FAULT_DEPTH = 0.35;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** 發球節奏的時機 → 品質：最低點前後 flat 秒內完美，離越遠越差（最差 worst） */
export function serveQuality(timing: number): number {
  const S = GAME.serve;
  const d = Math.abs(timing);
  if (d <= S.flat) return 1;
  return 1 - (1 - S.worst) * clamp((d - S.flat) / (S.beat / 2 - S.flat), 0, 1);
}

/**
 * 發球：落點在對角發球區內（aimX：0 = 中間、往中線 = T 點、往邊線 = 開角），深度與軌跡依種類；
 * 時機（quality）差：小球飄高又變深（可以搶攻）、高遠變短（好殺）、彈發太早翹高變短／太晚變平變長（出界）、平抽發飄高變慢
 */
function resolveServe(req: ShotRequest, sv: ServeSpec, rng: Rng): ShotResult {
  const S = GAME.serve;
  const { side, contact, quality } = req;
  const err = 1 - quality;
  const late = sv.timing < 0;
  const acc = req.kit?.accuracy ?? 1;
  const margin = S.aimMargin;
  // 落點左右：發球區中線到邊線之間；平抽發球以接發球員的身體為準（aimX 偏到他的左右）
  const span = sv.halfWidth / 2 - margin;
  let xw = sv.kind === 'drive' && sv.receiverX !== undefined ? sv.receiverX + side * req.aimX * 0.7 : sv.boxSign * (sv.halfWidth / 2) + side * req.aimX * span;
  xw += rng.gauss() * (0.08 + err * 0.2) * acc;
  xw = sv.boxSign * clamp(xw * sv.boxSign, margin, sv.halfWidth - margin);
  // 落點深度
  let D = sv.depth;
  if (sv.kind === 'short') D += err * S.shortDeep;
  else if (sv.kind === 'high') D -= err * S.highShort;
  else if (sv.kind === 'flick') D += late ? err * S.flickLong : -err * S.flickPop;
  D += rng.gauss() * (0.08 + err * 0.3) * acc;
  // 深度太短才算掛網；沒過前發球線的照落點判「發球失誤」
  const netFault = D < NET_FAULT_DEPTH;
  if (netFault) D = 0.8;
  const tz = -side * D;
  const target = v3(xw, 0, tz);
  const dx = xw - contact.x;
  const dz = tz - contact.z;
  const L = Math.hypot(dx, dz);
  const ux = dx / L;
  const uz = dz / L;
  const sNet = -contact.z / uz;
  const netY = netTopAt(contact.x + ux * sNet);
  const y0 = contact.y;
  const name = SERVE_NAMES[sv.kind];
  // 發球不吃球員／球拍的球速加成（避免平抽發球被推壓手濫用）；時機差的小球、平抽發飄比較慢
  const slow = sv.kind === 'short' || sv.kind === 'drive' ? 1 - err * 0.3 : 1;
  const dt = PHYS.dt * (SPEED_BY_NAME[name] ?? GAME.ballSpeedMul) * slow;

  let th: number;
  let v: number;
  if (netFault) {
    ({ th, v } = solveCrossing(netY - 0.3, y0, L, sNet, -30 * DEG, 70 * DEG, dt));
  } else if (sv.kind === 'high') {
    th = 55 * DEG;
    v = solveSpeed(th, y0, L, sNet, dt);
    ({ th, v } = capSpeed(th, v, GAME.liftMaxSpeed, y0, L, sNet, dt, 25 * DEG));
  } else if (sv.kind === 'flick') {
    // 經過接發球員頭頂時剛好高過他站著的擊球範圍；太早 = 翹高（好殺）、太晚 = 更平更低（搆得到）
    const sRecv = sv.receiverZ !== undefined ? (sv.receiverZ - contact.z) / uz : sNet + (COURT.shortService + 0.9) / Math.abs(uz);
    const clear = S.flickClear + (late ? -err * 0.9 : err * 1.4);
    ({ th, v } = solveCrossing(clear, y0, L, Math.max(sNet + 0.3, Math.min(L - 0.3, sRecv)), 12 * DEG, 62 * DEG, dt));
    if (fly2d(v, th, y0, sNet, dt).netY < netY + 0.3) ({ th, v } = solveCrossing(netY + 0.5, y0, L, sNet, th, 70 * DEG, dt));
    ({ th, v } = capSpeed(th, v, GAME.liftMaxSpeed, y0, L, sNet, dt, 25 * DEG));
  } else if (sv.kind === 'drive') {
    ({ th, v } = solveCrossing(netY + S.driveClear + err * S.driveFloat, y0, L, sNet, -20 * DEG, 45 * DEG, dt));
    ({ th, v } = capSpeed(th, v, GAME.smashMaxSpeed, y0, L, sNet, dt));
  } else {
    // 小球：完美擦網帶過，時機差飄高
    ({ th, v } = solveCrossing(netY + S.shortClear + err * S.shortFloat, y0, L, sNet, -35 * DEG, 75 * DEG, dt));
    ({ th, v } = capSpeed(th, v, GAME.smashMaxSpeed, y0, L, sNet, dt));
  }
  const vh = v * Math.cos(th);
  const vel = v3(ux * vh, v * Math.sin(th), uz * vh);
  return { vel, name, family: req.family, target, speedKmh: Math.round(v * 3.6), netFault, powerShort: netFault, stepDt: dt };
}

export function resolveShot(req: ShotRequest, rng: Rng): ShotResult {
  if (req.serve) return resolveServe(req, req.serve, rng);
  const { side, contact, family, charge, quality } = req;
  const dn = Math.abs(contact.z);
  const err = 1 - quality;

  const D0 = depthFromCharge(charge);
  const acc = req.kit?.accuracy ?? 1;
  // 擊球時機（品質）直接影響球質：完美的深球貼底線、小球貼網；時機差則深球變短、小球離網遠又高
  const qp = Math.max(0, Math.min(1, (quality - 0.6) / 0.33));
  let Dm = D0;
  if (family !== 'down' && D0 >= 4.5) Dm = D0 - (1 - qp) * 1.5;
  else if (D0 < 2.6 && D0 >= NET_FAULT_DEPTH) Dm = D0 + (1 - qp) * 1.1;
  let D = Dm + rng.gauss() * (0.1 + err * 0.7) * acc;
  // 左右分量決定落點
  const tx = side * (req.aimX * 2.3 + rng.gauss() * (0.08 + err * 0.6) * acc);
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

  let name = shotName(family, y0, dn, D);
  // 平球在網前變的撲球：就算擊球點很高也維持撲球（限速），不會變成超快殺球
  if (req.killCap && name === '殺球') name = '撲球';
  // 在空中往下壓：後場叫跳殺；網前叫跳撲（仍套用撲球限速）
  const jumpSmash = req.jump && (name === '殺球' || name === '撲球');
  if (jumpSmash) name = name === '撲球' ? '跳撲' : '跳殺';
  // 球員／球拍的球速加成：同一條軌跡跑更快（發球在 resolveServe，不吃加成）
  const kitMul = req.kit?.speed[shotGroup(name)] ?? 1;
  // 時機好的殺球、平抽更快
  const qSpeed = name === '殺球' || name === '跳殺' || name === '下壓' ? 0.88 + 0.12 * qp : family === 'side' ? 0.9 + 0.1 * qp : 1;
  const dt = PHYS.dt * kitMul * qSpeed * (name === '跳殺' ? GAME.jump.smashBallMul : (SPEED_BY_NAME[name] ?? GAME.ballSpeedMul));

  let th: number;
  let v: number;
  if (netFault) {
    ({ th, v } = solveCrossing(netY - 0.3, y0, L, sNet, -30 * DEG, 70 * DEG, dt));
  } else if (family === 'up') {
    th = (y0 >= GAME.highZoneY ? 40 : 52) * DEG;
    v = solveSpeed(th, y0, L, sNet, dt);
    // 靠網太近、擊球點又低時，固定仰角會撞網 → 改用更陡的角度挑過網
    if (fly2d(v, th, y0, sNet, dt).netY < netY + 0.4) ({ th, v } = solveCrossing(netY + 0.6, y0, L, sNet, th, 84 * DEG, dt));
    ({ th, v } = capSpeed(th, v, GAME.liftMaxSpeed / kitMul, y0, L, sNet, dt, 25 * DEG));
  } else if (family === 'side') {
    const clear = y0 >= GAME.highZoneY ? 0.5 : 0.35;
    ({ th, v } = solveCrossing(netY + clear, y0, L, sNet, -20 * DEG, 45 * DEG, dt));
    ({ th, v } = capSpeed(th, v, GAME.smashMaxSpeed / kitMul, y0, L, sNet, dt));
  } else {
    // 小球：時機好的貼網過（低），時機差的飄高
    const netClear = D < 2.6 ? 0.06 + (1 - qp) * 0.35 : 0.1;
    ({ th, v } = solveCrossing(netY + netClear, y0, L, sNet, -35 * DEG, 75 * DEG, dt));
    // 上限要除以球速加成：加成是讓球「跑更快」，實際速度仍不能超過上限
    const cap = name === '撲球' || name === '跳撲' ? (req.killCap ?? GAME.killMaxSpeed) : name === '跳殺' ? GAME.jump.smashMaxSpeed : GAME.smashMaxSpeed;
    ({ th, v } = capSpeed(th, v, cap / kitMul, y0, L, sNet, dt));
  }

  const vh = v * Math.cos(th);
  const vel = v3(ux * vh, v * Math.sin(th), uz * vh);
  const powerShort = netFault && D0 < NET_FAULT_DEPTH + 0.3;
  return { vel, name, family, target, speedKmh: Math.round(v * 3.6 * kitMul * qSpeed), netFault, powerShort, stepDt: dt };
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

function shotName(family: Family, y: number, dn: number, D: number): string {
  const high = y >= GAME.highZoneY;
  const aboveNet = y >= COURT.netTop;
  if (family === 'up') return high ? '高遠球' : '挑球';
  if (family === 'side') return high && D > 4.5 ? '平高球' : '平抽';
  // 上手高球往下壓：中前場也是殺球（只有貼網 1.2 m 內才算撲球）
  if (high && dn >= 1.2 && D >= 2.6) return '殺球';
  // 靠網 2.5 m 內、比網高的球往下壓到中後場算撲球（會被限速）
  if (aboveNet && dn < 2.5 && D >= 2.6) return '撲球';
  if (high) return D < 2.6 ? '切球' : '殺球';
  if (aboveNet) return D < 2.6 ? '切球' : '下壓';
  return D < 2.6 ? '放網' : '推球';
}
