import { chargeFromTime, COURT, GAME, PHYS, type MatchSettings } from '../config';
import { copy3, netTopAt, predict, stepShuttle, v3, type Prediction, type Vec3 } from './physics';
import { buildKit, type Kit } from './kits';
import { Rng } from './rng';
import { chargeForDepth, classifyFlick, reboundCharge, resolveShot, type Family, type Flick } from './shots';

/** 每個 tick 每位球員的輸入（全部用球員自己的視角，所以 AI/線上玩家都能共用） */
export interface PlayerInput {
  moveX: number; // 右為正
  moveY: number; // 往網子方向為正
  charging: boolean;
  jump: boolean; // 這次蓄力是「連按兩下」→ 跳殺模式
  flick: Flick | null; // 這個 tick 出拍的方向
}
export const idleInput = (): PlayerInput => ({ moveX: 0, moveY: 0, charging: false, jump: false, flick: null });

export interface Swing {
  t: number;
  window: number; // 這次揮拍可擊中的時間長度
  charge: number;
  family: Family;
  aimX: number;
  contacted: boolean;
  contactPoint: Vec3 | null;
  contactT: number;
  isServe: boolean;
  whiffed: boolean;
  from: Vec3; // 出拍當下的位置（揮空原因用）
  airborne: boolean; // 出拍時是否在空中（或這一下觸發起跳）
  triggeredJump: boolean; // 這一下划動直接觸發起跳（時機改用「是否在最高點擊中」評分）
}

export interface PlayerState {
  id: 0 | 1;
  side: 1 | -1; // 1 = z>0 半場（畫面下方）
  pos: Vec3; // y = 腳離地高度（跳躍時 > 0）
  vel: Vec3;
  charge: number;
  charging: boolean;
  chargeT: number;
  swing: Swing | null;
  recover: number;
  jumpArmed: boolean; // 已連按兩下，等待自動起跳
  jumpUsed: boolean; // 這次按住已經跳過了（放開才會重置，避免一直連跳）
  airborne: boolean;
  landRecover: number; // 落地硬直剩餘時間
  kit: Kit; // 球員特質＋球拍
  takeoffAt: number; // 這次起跳的 match.time（算空中高度用）
  vy: number; // 跳躍垂直速度
  bufferedFlick: Flick | null; // 揮拍／硬直中太早划的那一下
  bufferT: number;
}

export type Phase = 'serve' | 'rally' | 'point' | 'matchOver';

export type WhiffReason = '太早' | '太晚' | '太遠' | '太高' | '太低';
export type HitGrade = '完美' | '不錯' | '勉強';

export type MatchEvent =
  | {
      type: 'hit';
      player: 0 | 1;
      name: string;
      speedKmh: number;
      pos: Vec3;
      family: Family;
      charge: number;
      netFault: boolean;
      powerShort: boolean;
      quality: number;
      grade: HitGrade;
      jump: boolean;
      serve: boolean;
    }
  | { type: 'whiff'; player: 0 | 1; reason: WhiffReason; airborne: boolean }
  | { type: 'jump'; player: 0 | 1 }
  | { type: 'jumpLand'; player: 0 | 1 }
  | { type: 'net'; pos: Vec3 }
  | { type: 'land'; pos: Vec3; inBounds: boolean }
  | { type: 'point'; winner: 0 | 1; reason: string }
  | { type: 'game'; winner: 0 | 1 }
  | { type: 'match'; winner: 0 | 1 }
  | { type: 'serveStart'; server: 0 | 1 };

export type ShuttleMode = 'held' | 'flight' | 'netfall' | 'down';

export interface ShuttleState {
  pos: Vec3;
  vel: Vec3;
  mode: ShuttleMode;
  lastHitter: 0 | 1 | null;
  isServe: boolean;
  serveBoxSign: number; // 發球時對角發球區在 x 的正負號
  prediction: Prediction | null;
  stepDt: number; // 每 tick 羽球前進的物理時間（球速倍率）
  launchTime: number; // 擊出時的 match.time（prediction 的 t 從這裡算）
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
/** 起跳到最高點的時間 */
export const jumpApexTime = () => Math.sqrt((2 * GAME.jump.height) / GAME.jump.gravity);
/** 還要多久落地 */
const airTimeLeft = (p: PlayerState) => {
  const g = GAME.jump.gravity;
  const vy = p.airborne ? p.vy : Math.sqrt(2 * g * GAME.jump.height);
  const y = p.airborne ? p.pos.y : 0;
  return (vy + Math.sqrt(vy * vy + 2 * g * y)) / g;
};
const JUMP_CHARGE_CAP = chargeForDepth(COURT.halfLength - 0.4);

export class Match {
  readonly rng: Rng;
  players: [PlayerState, PlayerState];
  shuttle: ShuttleState;
  score: [number, number] = [0, 0];
  games: [number, number] = [0, 0];
  server: 0 | 1 = 0;
  phase: Phase = 'serve';
  phaseT = 0;
  time = 0;
  rallyHits = 0;
  hitSerial = 0; // 整場累計擊球數（不歸零，給 AI/網路偵測新擊球用）
  lastPoint: { winner: 0 | 1; reason: string } | null = null;
  events: MatchEvent[] = [];
  private gameJustEnded = false;

  constructor(readonly settings: MatchSettings, seed = Date.now()) {
    this.rng = new Rng(seed);
    const mk = (id: 0 | 1, side: 1 | -1): PlayerState => ({
      id,
      side,
      kit: id === 0 ? buildKit(settings.character, settings.racket) : buildKit(settings.aiCharacter ?? 'allround', settings.aiRacket ?? 'balance'),
      pos: v3(0, 0, side * 4),
      vel: v3(),
      charge: 0,
      chargeT: 0,
      charging: false,
      swing: null,
      recover: 0,
      jumpArmed: false,
      jumpUsed: false,
      takeoffAt: 0,
      airborne: false,
      landRecover: 0,
      vy: 0,
      bufferedFlick: null,
      bufferT: 0,
    });
    this.players = [mk(0, 1), mk(1, -1)];
    this.shuttle = { pos: v3(), vel: v3(), mode: 'held', lastHitter: null, isServe: false, serveBoxSign: 1, prediction: null, stepDt: PHYS.dt, launchTime: 0 };
    this.setupServe();
  }

  get receiver(): 0 | 1 {
    return this.server === 0 ? 1 : 0;
  }

  /** 發球方分數偶數 → 從自己的右半場發 */
  private serveCourtSign(): 1 | -1 {
    return this.score[this.server] % 2 === 0 ? 1 : -1;
  }

  setupServe(): void {
    const s = this.players[this.server];
    const r = this.players[this.receiver];
    const court = this.serveCourtSign();
    s.pos = v3(s.side * court * 0.7, 0, s.side * (COURT.shortService + 1.2));
    r.pos = v3(r.side * court * 0.9, 0, r.side * (COURT.shortService + 1.7));
    for (const p of this.players) {
      p.vel = v3();
      p.swing = null;
      p.charge = 0;
      p.chargeT = 0;
      p.charging = false;
      p.recover = 0;
      p.pos.y = 0;
      p.vy = 0;
      p.airborne = false;
      p.jumpArmed = false;
      p.jumpUsed = false;
      p.landRecover = 0;
      p.bufferT = 0;
    }
    this.shuttle.mode = 'held';
    this.shuttle.vel = v3();
    this.shuttle.lastHitter = null;
    this.shuttle.prediction = null;
    this.shuttle.serveBoxSign = r.side * court;
    this.placeHeldShuttle();
    this.phase = 'serve';
    this.phaseT = 0;
    this.rallyHits = 0;
    this.events.push({ type: 'serveStart', server: this.server });
  }

  private placeHeldShuttle(): void {
    const s = this.players[this.server];
    this.shuttle.pos = v3(s.pos.x + s.side * 0.35, GAME.serveContactY, s.pos.z - s.side * 0.4);
  }

  /** 推進一個固定 tick（PHYS.dt 模擬秒） */
  step(inputs: [PlayerInput, PlayerInput]): void {
    const dt = PHYS.dt;
    this.time += dt;
    this.phaseT += dt;

    for (const p of this.players) this.updatePlayer(p, inputs[p.id], dt);

    switch (this.phase) {
      case 'serve':
        this.placeHeldShuttle();
        break;
      case 'rally':
        this.updateRally();
        break;
      case 'point':
        this.updateShuttleLoose();
        if (this.phaseT >= GAME.pointPause) this.afterPoint();
        break;
      case 'matchOver':
        this.updateShuttleLoose();
        break;
    }
  }

  private updatePlayer(p: PlayerState, input: PlayerInput, dt: number): void {
    if (p.recover > 0) p.recover -= dt;
    if (p.landRecover > 0) p.landRecover -= dt;

    // 連按兩下 = 跳殺模式（放開蓄力就取消）
    if (input.charging && input.jump && !p.airborne && !p.jumpUsed) p.jumpArmed = true;

    // 出拍（揮拍或硬直中划動會先暫存一下，避免太早划被吃掉）
    if (input.flick) {
      p.bufferedFlick = input.flick;
      p.bufferT = GAME.flickBuffer;
    } else if (p.bufferT > 0) p.bufferT -= dt;
    const flick = p.bufferT > 0 ? p.bufferedFlick : null;
    if (flick && !p.swing && p.recover <= 0 && this.phase !== 'matchOver') {
      p.bufferT = 0;
      const { family, aimX } = classifyFlick(flick);
      // 在空中出拍：揮拍時間至少涵蓋到落地前，避免剛起跳就划結果時間不夠
      const baseWindow = GAME.swingWindow * p.kit.window;
      let window = p.airborne ? Math.max(baseWindow, airTimeLeft(p) - 0.02) : baseWindow;
      let triggeredJump = false;
      if (p.jumpArmed && !p.airborne && p.landRecover <= 0 && this.phase === 'rally') {
        // 還沒起跳就划了 → 立刻起跳，整段滯空都能擊球
        this.takeoff(p);
        window = airTimeLeft(p) - 0.02;
        triggeredJump = true;
      }
      p.jumpArmed = false;
      p.swing = {
        t: 0,
        window,
        charge: p.charge,
        family,
        aimX,
        contacted: false,
        contactPoint: null,
        contactT: 0,
        isServe: false,
        whiffed: false,
        from: copy3(p.pos),
        airborne: p.airborne,
        triggeredJump,
      };
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
      if (this.phase === 'serve' && p.id === this.server) this.doServe(p);
    }

    // 蓄力（放開但沒划動 = 取消）
    if (input.charging && !p.swing && p.recover <= 0) {
      p.charging = true;
      p.chargeT += dt;
      p.charge = chargeFromTime(p.chargeT);
      // 跳殺待命或在空中時，蓄力上限停在底線前，避免等起跳等太久變出界
      if (p.jumpArmed || p.airborne) p.charge = Math.min(p.charge, JUMP_CHARGE_CAP);
    } else if (!input.charging) {
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
      p.jumpUsed = false;
      if (!p.swing) p.jumpArmed = false;
    }

    // 跳殺自動起跳：羽球預計進入「跳起來的擊球範圍」前 apex 時間起跳
    if (p.jumpArmed && !p.airborne && p.landRecover <= 0 && this.phase === 'rally') {
      const tReach = this.timeUntilJumpReach(p);
      if (tReach !== null && tReach <= jumpApexTime() + GAME.jump.lead) this.takeoff(p);
    }

    if (p.swing) {
      const s = p.swing;
      s.t += dt;
      if (!s.contacted && !s.whiffed && !s.isServe && s.t > s.window) {
        s.whiffed = true;
        p.recover = GAME.whiffRecover;
        this.events.push({ type: 'whiff', player: p.id, reason: this.whiffReason(p), airborne: s.airborne });
      }
      if (s.t >= Math.max(GAME.swingDuration, s.window + 0.1)) p.swing = null;
    }

    // 空中：照拋物線，不能改方向
    if (p.airborne) {
      p.vy -= GAME.jump.gravity * dt;
      p.pos.y += p.vy * dt;
      if (p.pos.y <= 0) {
        p.pos.y = 0;
        p.vy = 0;
        p.airborne = false;
        p.landRecover = GAME.jump.landRecover;
        this.events.push({ type: 'jumpLand', player: p.id });
      }
    }

    // 移動（輸入是自己視角 → 換成世界座標）。得分暫停時不能走，避免發球前被瞬移
    let mx = this.phase === 'point' ? 0 : input.moveX;
    let my = this.phase === 'point' ? 0 : input.moveY;
    const m = Math.hypot(mx, my);
    if (m > 1) {
      mx /= m;
      my /= m;
    }
    if (!p.airborne) {
      const mul = p.landRecover > 0 ? GAME.jump.landMoveMul : p.swing ? GAME.swingMoveMul : p.charging ? GAME.chargeMoveMul : 1;
      const top = GAME.moveSpeed * p.kit.move * mul;
      const tvx = p.side * mx * top;
      const tvz = -p.side * my * top;
      const maxDv = GAME.moveAccel * p.kit.accel * dt;
      p.vel.x += clamp(tvx - p.vel.x, -maxDv, maxDv);
      p.vel.z += clamp(tvz - p.vel.z, -maxDv, maxDv);
    }
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;

    // 活動範圍（撞到邊界就把那個方向的速度歸零，往回走才不會卡一下）
    let x0: number, x1: number, zA: number, zB: number;
    if (this.phase === 'serve') {
      const isServer = p.id === this.server;
      const sign = isServer ? p.side * this.serveCourtSign() : this.shuttle.serveBoxSign;
      const a = 0.15 * sign;
      const b = (COURT.singlesHalfWidth - 0.15) * sign;
      [x0, x1] = [Math.min(a, b), Math.max(a, b)];
      zA = COURT.shortService + 0.3;
      zB = COURT.halfLength - 0.3;
    } else {
      [x0, x1] = [-3.6, 3.6];
      zA = 0.3;
      zB = 8.2;
    }
    if (p.pos.x < x0 || p.pos.x > x1) {
      p.pos.x = clamp(p.pos.x, x0, x1);
      p.vel.x = 0;
    }
    const lz = p.pos.z * p.side;
    if (lz < zA || lz > zB) {
      p.pos.z = p.side * clamp(lz, zA, zB);
      p.vel.z = 0;
    }
    if (p.pos.x !== p.pos.x) p.pos.x = 0;
  }

  /** 發球時自己被限制在哪個區域（UI 畫框用）：回傳世界座標 x0,x1,z0,z1 */
  serveBox(id: 0 | 1): { x0: number; x1: number; z0: number; z1: number } | null {
    if (this.phase !== 'serve') return null;
    const p = this.players[id];
    const sign = id === this.server ? p.side * this.serveCourtSign() : this.shuttle.serveBoxSign;
    const xa = 0;
    const xb = COURT.singlesHalfWidth * sign;
    const za = COURT.shortService * p.side;
    const zb = COURT.halfLength * p.side;
    return { x0: Math.min(xa, xb), x1: Math.max(xa, xb), z0: Math.min(za, zb), z1: Math.max(za, zb) };
  }

  private takeoff(p: PlayerState): void {
    p.airborne = true;
    p.takeoffAt = this.time;
    p.jumpArmed = false;
    p.jumpUsed = true;
    p.vy = Math.sqrt(2 * GAME.jump.gravity * GAME.jump.height);
    p.vel.x *= 0.6;
    p.vel.z *= 0.6;
    this.events.push({ type: 'jump', player: p.id });
  }

  /** 羽球還要多久才會進入「跳起來後」的擊球範圍；不會進入則 null */
  private timeUntilJumpReach(p: PlayerState): number | null {
    const sh = this.shuttle;
    if (sh.mode !== 'flight' || sh.lastHitter === p.id || !sh.prediction) return null;
    const elapsed = this.time - sh.launchTime;
    const top = GAME.reachMaxY + GAME.jump.height;
    for (const pt of sh.prediction.points) {
      if (pt.t < elapsed) continue;
      const q = pt.p;
      if (q.z * p.side < 0.05) continue;
      if (q.y < GAME.jump.minShuttleY || q.y > top) continue;
      // 起跳前會繼續移動、起跳後保留六成速度：用預估位置判斷
      const tt = pt.t - elapsed;
      if (Math.hypot(q.x - (p.pos.x + p.vel.x * tt * 0.8), q.z - (p.pos.z + p.vel.z * tt * 0.8)) <= GAME.reach) return tt;
    }
    return null;
  }

  /** 揮空原因：以出拍當下的位置，看羽球路徑什麼時候真的打得到，跟出拍時間比較 */
  private whiffReason(p: PlayerState): WhiffReason {
    const sh = this.shuttle;
    const s = p.swing!;
    const pred = sh.prediction;
    if (!pred || sh.lastHitter === p.id || sh.mode === 'held') return '太遠';
    const flickAt = this.time - s.t;
    // 跳起來的那一下：腳的高度隨時間變化（起跳→最高點→落地）
    const v0 = Math.sqrt(2 * GAME.jump.gravity * GAME.jump.height);
    const feetAt = (t: number) => {
      if (!s.airborne) return 0;
      const tau = t - p.takeoffAt;
      return Math.max(0, v0 * tau - 0.5 * GAME.jump.gravity * tau * tau);
    };
    let first = Infinity;
    let last = -Infinity;
    let best = Infinity;
    let bestY = 0;
    let bestFeet = 0;
    let bestT = 0;
    for (const pt of pred.points) {
      if (pt.p.z * p.side < 0.05) continue;
      const t = sh.launchTime + pt.t;
      const feet = feetAt(t);
      const d = Math.hypot(pt.p.x - s.from.x, pt.p.z - s.from.z);
      if (d < best) {
        best = d;
        bestY = pt.p.y;
        bestFeet = feet;
        bestT = t;
      }
      if (d <= GAME.reach && pt.p.y >= GAME.reachMinY + feet && pt.p.y <= GAME.reachMaxY + feet) {
        first = Math.min(first, t);
        last = Math.max(last, t);
      }
    }
    if (first < Infinity) {
      if (first > flickAt + s.window) return '太早';
      if (last < flickAt) return '太晚';
      return '太遠'; // 時間對，但出拍後人跑開了
    }
    // 跳起來了，但羽球要等落地後才到 → 起跳（划動）太早
    if (s.airborne && best <= GAME.reach + 0.3 && bestT > flickAt + s.window) return '太早';
    if (best <= GAME.reach) return bestY > GAME.reachMaxY + bestFeet ? '太高' : '太低';
    return '太遠';
  }

  private doServe(p: PlayerState): void {
    const swing = p.swing!;
    const contact = copy3(this.shuttle.pos);
    const shot = resolveShot(
      {
        side: p.side,
        contact,
        family: swing.family,
        aimX: swing.aimX,
        charge: swing.charge,
        quality: 1,
        serve: { boxCenterX: this.shuttle.serveBoxSign * 1.3 },
        kit: p.kit,
        jump: false,
      },
      this.rng,
    );
    swing.contacted = true;
    swing.contactPoint = contact;
    swing.contactT = swing.t;
    swing.isServe = true;
    this.launch(p, shot.vel, shot.stepDt, true);
    this.events.push({
      type: 'hit',
      player: p.id,
      name: shot.name,
      speedKmh: shot.speedKmh,
      pos: contact,
      family: swing.family,
      charge: swing.charge,
      netFault: shot.netFault,
      powerShort: shot.powerShort,
      quality: 1,
      grade: '完美',
      jump: false,
      serve: true,
    });
    this.phase = 'rally';
    this.phaseT = 0;
  }

  private launch(p: PlayerState, vel: Vec3, stepDt: number, isServe: boolean): void {
    const sh = this.shuttle;
    sh.vel = copy3(vel);
    sh.mode = 'flight';
    sh.lastHitter = p.id;
    sh.isServe = isServe;
    sh.stepDt = stepDt;
    sh.launchTime = this.time;
    sh.prediction = predict(sh.pos, sh.vel, stepDt);
    this.rallyHits++;
    this.hitSerial++;
  }

  /** 羽球 q 是否在「站在 at（腳高 at.y）」的球員擊球範圍內；回傳水平距離 */
  private inReach(p: PlayerState, q: Vec3, at: Vec3 = p.pos): number | null {
    if (q.z * p.side < 0.05) return null;
    if (q.y < GAME.reachMinY + at.y || q.y > GAME.reachMaxY + at.y) return null;
    const d = Math.hypot(q.x - at.x, q.z - at.z);
    return d <= GAME.reach ? d : null;
  }

  /** 擊球品質：時機（划動後 idealContactT 最好）× 位置（0.25~0.85 m 最好） */
  private contactQuality(t: number, dist: number): number {
    return timeQuality(t) * posQuality(dist);
  }

  private updateRally(): void {
    const sh = this.shuttle;
    const dt = PHYS.dt;
    // 擊球判定（先判定再移動，避免高速球穿過）
    if (sh.mode === 'flight') {
      for (const p of this.players) {
        const s = p.swing;
        if (p.id === sh.lastHitter || !s || s.contacted || s.whiffed || s.isServe) continue;
        if (s.t > s.window) continue;
        const d = this.inReach(p, sh.pos);
        if (d === null) continue;
        // 下一個 tick 球的位置更好（更靠近甜蜜點）而且整體品質不會變差就等一下；
        // 只看位置、不幫玩家修正時機，所以划太晚還是會被評「不錯／勉強」；高點球不能等到掉下高點
        if (s.t + dt <= s.window) {
          const np = copy3(sh.pos);
          stepShuttle(np, copy3(sh.vel), sh.stepDt);
          const at = v3(p.pos.x + p.vel.x * dt, p.airborne ? p.pos.y + p.vy * dt : p.pos.y, p.pos.z + p.vel.z * dt);
          const nd = this.inReach(p, np, at);
          const dropsBelowHigh = sh.pos.y >= GAME.highZoneY + p.pos.y && np.y < GAME.highZoneY + at.y;
          if (nd !== null && !dropsBelowHigh && posQuality(nd) > posQuality(d) + 1e-4 && this.contactQuality(s.t + dt, nd) >= this.contactQuality(s.t, d)) continue;
        }
        this.hit(p, d);
        break;
      }
    }

    const pz = sh.pos.z;
    const py = sh.pos.y;
    stepShuttle(sh.pos, sh.vel, sh.stepDt);
    if (sh.mode === 'flight' && pz !== 0 && Math.sign(pz) !== Math.sign(sh.pos.z)) {
      const a = pz / (pz - sh.pos.z);
      const yCross = py + (sh.pos.y - py) * a;
      if (yCross < netTopAt(sh.pos.x)) {
        sh.mode = 'netfall';
        sh.pos.z = Math.sign(pz) * 0.06;
        sh.pos.y = Math.max(0.05, yCross);
        sh.vel = v3(sh.vel.x * 0.1, Math.min(0, sh.vel.y) * 0.3, -sh.vel.z * 0.04);
        this.events.push({ type: 'net', pos: copy3(sh.pos) });
      }
    }
    if (sh.pos.y <= 0) this.onLand();
  }

  private hit(p: PlayerState, dist: number): void {
    const swing = p.swing!;
    const sh = this.shuttle;
    // 在空中擊中：越接近跳躍最高點越好。划動直接起跳的那一下只看這個；先起跳再划的取兩者較好的
    let qTime = timeQuality(swing.t);
    if (p.airborne) {
      const apexQ = 1 - 0.35 * clamp(Math.abs(this.time - p.takeoffAt - jumpApexTime()) / 0.15, 0, 1);
      qTime = swing.triggeredJump ? apexQ : Math.max(qTime, apexQ);
    }
    const quality = qTime * posQuality(dist);
    const contact = copy3(sh.pos);
    const incoming = Math.hypot(sh.vel.x, sh.vel.y, sh.vel.z);
    const charge = Math.max(swing.charge, reboundCharge(incoming));
    const shot = resolveShot(
      { side: p.side, contact, family: swing.family, aimX: swing.aimX, charge, quality, serve: null, jump: p.airborne, kit: p.kit },
      this.rng,
    );
    swing.contacted = true;
    swing.contactPoint = contact;
    swing.contactT = swing.t;
    this.launch(p, shot.vel, shot.stepDt, false);
    this.events.push({
      type: 'hit',
      player: p.id,
      name: shot.name,
      speedKmh: shot.speedKmh,
      pos: contact,
      family: swing.family,
      charge,
      netFault: shot.netFault,
      powerShort: shot.powerShort,
      quality,
      grade: quality >= 0.92 ? '完美' : quality >= 0.78 ? '不錯' : '勉強',
      jump: shot.name === '跳殺' || shot.name === '跳撲',
      serve: false,
    });
  }

  private onLand(): void {
    const sh = this.shuttle;
    sh.pos.y = 0;
    const wasNet = sh.mode === 'netfall';
    sh.mode = 'down';
    sh.vel = v3();
    const hitter = sh.lastHitter ?? this.server;
    const other: 0 | 1 = hitter === 0 ? 1 : 0;
    const hitterSide = this.players[hitter].side;
    const landSide = sh.pos.z >= 0 ? 1 : -1;

    let inBounds = false;
    let winner: 0 | 1;
    let reason: string;
    if (wasNet) {
      winner = other;
      reason = '掛網';
    } else if (landSide === hitterSide) {
      winner = other;
      reason = '未過網';
    } else {
      const ax = Math.abs(sh.pos.x);
      const az = Math.abs(sh.pos.z);
      const tol = 0.03; // 壓線算好球
      inBounds = ax <= COURT.singlesHalfWidth + tol && az <= COURT.halfLength + tol;
      if (sh.isServe) inBounds = inBounds && az >= COURT.shortService - tol && sh.pos.x * sh.serveBoxSign >= -tol;
      if (inBounds) {
        winner = hitter;
        reason = sh.isServe ? '發球得分' : '落地得分';
      } else {
        winner = other;
        reason = sh.isServe ? '發球失誤' : '出界';
      }
    }
    this.events.push({ type: 'land', pos: copy3(sh.pos), inBounds });
    this.awardPoint(winner, reason);
  }

  private awardPoint(winner: 0 | 1, reason: string): void {
    this.score[winner]++;
    this.server = winner;
    this.lastPoint = { winner, reason };
    this.events.push({ type: 'point', winner, reason });
    this.phase = 'point';
    this.phaseT = 0;
    for (const p of this.players) {
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
    }

    const target = this.settings.points;
    const cap = target === 21 ? 30 : 15;
    const w = this.score[winner];
    const l = this.score[winner === 0 ? 1 : 0];
    if ((w >= target && w - l >= 2) || w >= cap) {
      this.games[winner]++;
      this.gameJustEnded = true;
      this.events.push({ type: 'game', winner });
      if (this.games[winner] > this.settings.games / 2) {
        this.phase = 'matchOver';
        this.events.push({ type: 'match', winner });
      }
    }
  }

  private afterPoint(): void {
    if (this.gameJustEnded) {
      this.gameJustEnded = false;
      this.score = [0, 0];
    }
    this.setupServe();
  }

  private updateShuttleLoose(): void {
    const sh = this.shuttle;
    if (sh.mode === 'flight' || sh.mode === 'netfall') {
      stepShuttle(sh.pos, sh.vel, sh.stepDt);
      if (sh.pos.y <= 0) {
        sh.pos.y = 0;
        sh.mode = 'down';
      }
    }
  }


  drainEvents(): MatchEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}

/** 羽球還要多久會進入這位球員目前的擊球範圍（UI 提示用）；不會進入則 null */
export function timeUntilInReach(m: Match, id: 0 | 1): number | null {
  const sh = m.shuttle;
  const p = m.players[id];
  if (sh.mode !== 'flight' || sh.lastHitter === id || !sh.prediction) return null;
  const elapsed = m.time - sh.launchTime;
  for (const pt of sh.prediction.points) {
    if (pt.t < elapsed) continue;
    const q = pt.p;
    if (q.z * p.side < 0.05 || q.y < GAME.reachMinY + p.pos.y || q.y > GAME.reachMaxY + p.pos.y) continue;
    if (Math.hypot(q.x - p.pos.x, q.z - p.pos.z) <= GAME.reach) return pt.t - elapsed;
  }
  return null;
}

/** 時機分數：划動後 GAME.idealContactT 擊中最好；划太晚（球已經在身邊）扣分較少，划太早扣較多 */
function timeQuality(t: number): number {
  const ideal = GAME.idealContactT;
  return t < ideal ? 1 - 0.25 * ((ideal - t) / ideal) : 1 - 0.35 * clamp((t - ideal) / (GAME.swingWindow - ideal), 0, 1);
}

/** 位置分數：離身體 0.25~0.85 m 最好，太遠或太擠扣分 */
function posQuality(dist: number): number {
  if (dist > 0.85) return 1 - 0.3 * ((dist - 0.85) / (GAME.reach - 0.85));
  if (dist < 0.25) return 0.85;
  return 1;
}
