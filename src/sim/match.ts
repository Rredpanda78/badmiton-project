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
  dive: { x: number; y: number } | null; // 這個 tick 魚躍（撲救）的方向（自己視角）
}
export const idleInput = (): PlayerInput => ({ moveX: 0, moveY: 0, charging: false, jump: false, flick: null, dive: null });

export interface Swing {
  t: number;
  window: number; // 這次揮拍可擊中的時間長度
  charge: number;
  preset: boolean; // 點擊滑放：深度已指定，不吃反彈力
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
  dive: boolean; // 魚躍撲救時的揮拍（撲出去的整段都能擊中）
  diveAuto: boolean; // 魚躍時沒有另外划 → 自動挑回
  auto?: boolean; // 點擊滑放：深度等擊中時依擊球點高低決定（上手高遠／切球、下手挑球／放網）
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
  dive: { t: number; dx: number; dz: number; v0: number } | null; // 魚躍中（dx,dz = 世界座標方向）
  downT: number; // 魚躍後趴在地上的剩餘時間
  reachMul: number; // 擊球範圍倍率（手動跑位的玩家較大）
}

export type Phase = 'serve' | 'rally' | 'point' | 'matchOver' | 'drill' | 'await'; // drill = 練習模式等待發球機；await = 線上：自己打出去的球落地，等對方判定

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
      dive: boolean; // 魚躍救球
      vel: Vec3; // 擊出的初速（線上傳給對方）
      stepDt: number;
      wobble: boolean; // 這球是晃動的機會球
      attack: number; // 這球有多好殺（給接球方的殺球加成）
    }
  | { type: 'whiff'; player: 0 | 1; reason: WhiffReason; airborne: boolean }
  | { type: 'jump'; player: 0 | 1 }
  | { type: 'jumpLand'; player: 0 | 1 }
  | { type: 'dive'; player: 0 | 1; dx: number; dz: number }
  | { type: 'diveLand'; player: 0 | 1 }
  | { type: 'net'; pos: Vec3 }
  | { type: 'land'; pos: Vec3; inBounds: boolean }
  | { type: 'drillLand'; hitter: 0 | 1; pos: Vec3; inBounds: boolean; net: boolean }
  | { type: 'chance'; player: 0 | 1 } // 打出晃動的機會球
  | { type: 'point'; winner: 0 | 1; reason: string; byRemote?: boolean }
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
  wobble: boolean; // 勉強接回的機會球（會晃、比較慢、適合殺）
  attack: number; // 這顆球有多好殺（0..1）：高球越短越好殺，機會球 = 1
  pace: number; // 來球有多兇（0..1）：殺球 1、撲／壓 0.8、平抽 0.5（硬伸手接的懲罰用）
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


/** 線上：對方傳來的狀態（已換成本機座標） */
export interface RemoteState {
  pos: Vec3; // y = 腳離地高度
  vel: Vec3; // y = 跳躍垂直速度
  airborne: boolean;
  charging: boolean;
  charge: number;
  jumpArmed: boolean;
  dive: { t: number; dx: number; dz: number } | null;
  downT: number;
  swing: { family: Family; t: number; airborne: boolean } | null;
}

/** 線上：對方的一次擊球（已換成本機座標） */
export interface RemoteHit {
  contact: Vec3;
  vel: Vec3;
  stepDt: number;
  family: Family;
  name: string;
  speedKmh: number;
  charge: number;
  quality: number;
  grade: HitGrade;
  serve: boolean;
  jump: boolean;
  dive: boolean;
  wobble: boolean;
  attack: number;
  netFault: boolean;
  powerShort: boolean;
}
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
  /** 線上對戰：遠端玩家的 id（移動、擊球都由網路訊息決定）；離線 = null */
  remote: 0 | 1 | null = null;
  private remoteState: { rs: RemoteState; at: number } | null = null;

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
      dive: null,
      downT: 0,
      reachMul: 1,
    });
    this.players = [mk(0, 1), mk(1, -1)];
    this.shuttle = { pos: v3(), vel: v3(), mode: 'held', lastHitter: null, isServe: false, serveBoxSign: 1, prediction: null, stepDt: PHYS.dt, launchTime: 0, wobble: false, attack: 0, pace: 0 };
    if (settings.practice) this.enterDrillIdle();
    else this.setupServe();
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
    this.remoteState = null; // 線上：舊位置作廢，等對方送新的發球站位
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
      p.dive = null;
      p.downT = 0;
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

  private placeHeldShuttle(who: 0 | 1 = this.server): void {
    const s = this.players[who];
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
      case 'drill':
        this.placeHeldShuttle(1);
        break;
      case 'point':
        this.updateShuttleLoose();
        if (this.phaseT >= (this.settings.practice ? 0.9 : GAME.pointPause)) this.afterPoint();
        break;
      case 'matchOver':
        this.updateShuttleLoose();
        break;
      case 'await':
        break;
    }
  }

  private updatePlayer(p: PlayerState, input: PlayerInput, dt: number): void {
    if (p.id === this.remote) return this.updateRemote(p, dt);
    if (p.recover > 0) p.recover -= dt;
    if (p.landRecover > 0) p.landRecover -= dt;
    if (p.downT > 0) p.downT -= dt;

    // 魚躍（撲救）：往某方向撲出去，撲的整段都能自動把球挑回；之後趴在地上一下
    if (input.dive && this.canDive(p)) this.startDive(p, input.dive);
    const busy = !!p.dive || p.downT > 0; // 撲出去或趴在地上：不能蓄力、跳、另外揮拍

    // 連按兩下 = 跳殺模式（放開蓄力就取消）
    if (input.jump && !p.airborne && !p.jumpUsed && !busy) p.jumpArmed = true;

    // 出拍（揮拍或硬直中划動會先暫存一下，避免太早划被吃掉）
    if (input.flick) {
      p.bufferedFlick = input.flick;
      p.bufferT = GAME.flickBuffer;
    } else if (p.bufferT > 0) p.bufferT -= dt;
    // 只點不滑：羽球快到身邊才算出拍，否則只是連按兩下的第一下（不揮拍）
    if (p.bufferT > 0 && p.bufferedFlick?.cmd?.soft && !this.softTapLive(p)) p.bufferT = 0;
    const flick = p.bufferT > 0 ? p.bufferedFlick : null;
    // 撲出去時右手划動不算（撲到就自動救回網前，不用同時操作兩邊）
    if (flick && p.dive) p.bufferT = 0;
    if (flick && !p.swing && !busy && p.recover <= 0 && this.phase !== 'matchOver') {
      p.bufferT = 0;
      const cls = classifyFlick(flick);
      const aimX = cls.aimX;
      let family = cls.family;
      let charge = p.charge;
      const preset = !!flick.cmd;
      if (flick.cmd) {
        // 點擊滑放：不用蓄力，球種與深度由手勢決定；品質只看放開的時機
        family = flick.cmd.family;
        const dn = Math.abs(p.pos.z);
        const cd = flick.cmd.depth;
        charge = chargeForDepth(cd === 'smash' ? (dn > 2.5 ? 4.6 : 3.0) : cd === 'auto' ? autoDepth(family, GAME.highZoneY) : cd);
        if (this.phase === 'serve' && p.id === this.server) {
          // 發球：往上 = 發高遠球、其他 = 發小球（剛好過前發球線）
          family = family === 'up' ? 'up' : 'down';
          charge = chargeForDepth(family === 'up' ? 6.0 : COURT.shortService + 0.45);
        }
      }
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
        charge,
        preset,
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
        dive: false,
        diveAuto: false,
        auto: flick.cmd?.depth === 'auto',
      };
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
      if (this.phase === 'serve' && p.id === this.server) this.doServe(p);
    }

    // 蓄力（放開但沒划動 = 取消）
    if (input.charging && !p.swing && !busy && p.recover <= 0) {
      p.charging = true;
      p.chargeT += dt;
      p.charge = chargeFromTime(p.chargeT);
      // 跳殺待命或在空中時，蓄力上限停在底線前，避免等起跳等太久變出界
      if (p.jumpArmed || p.airborne) p.charge = Math.min(p.charge, JUMP_CHARGE_CAP);
    } else if (!input.charging) {
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
      // 點擊滑放的跳殺不蓄力，只要還按著殺球搖桿（jump）就保持待命
      if (!input.jump) {
        p.jumpUsed = false;
        if (!p.swing) p.jumpArmed = false;
      }
    }

    // 跳殺自動起跳：羽球預計進入「跳起來的擊球範圍」前 apex 時間起跳
    if (p.jumpArmed && !busy && !p.airborne && p.landRecover <= 0 && this.phase === 'rally') {
      const tReach = this.timeUntilJumpReach(p);
      if (tReach !== null && tReach <= jumpApexTime() + GAME.jump.lead) this.takeoff(p);
    }

    if (p.swing) {
      const s = p.swing;
      s.t += dt;
      if (!s.contacted && !s.whiffed && !s.isServe && s.t > s.window) {
        s.whiffed = true;
        if (!s.dive) {
          // 魚躍沒撲到：不算揮空（趴在地上就是代價）
          p.recover = GAME.whiffRecover;
          this.events.push({ type: 'whiff', player: p.id, reason: this.whiffReason(p), airborne: s.airborne });
        }
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
    if (p.dive) {
      // 撲出去：初速最快、線性減到 0，著地後趴一下
      const d = p.dive;
      d.t += dt;
      const v = d.v0 * Math.max(0, 1 - d.t / GAME.dive.dur);
      p.vel.x = d.dx * v;
      p.vel.z = d.dz * v;
      if (d.t >= GAME.dive.dur) {
        p.dive = null;
        p.downT = GAME.dive.down;
        p.vel = v3();
        this.events.push({ type: 'diveLand', player: p.id });
      }
    } else if (p.downT > 0) {
      p.vel.x = 0;
      p.vel.z = 0;
    } else if (!p.airborne) {
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

  /** 這位球員的水平擊球範圍（站著） */
  reachOf(p: PlayerState): number {
    return GAME.reach * p.reachMul;
  }

  private canDive(p: PlayerState): boolean {
    return this.phase === 'rally' && !p.dive && p.downT <= 0 && !p.airborne && p.landRecover <= 0 && !p.swing?.contacted;
  }

  private startDive(p: PlayerState, dir: { x: number; y: number }): void {
    const m = Math.hypot(dir.x, dir.y);
    if (m < 1e-3) return;
    // 自己視角 → 世界座標（跟移動同一套換算）
    const dx = (p.side * dir.x) / m;
    const dz = (-p.side * dir.y) / m;
    const along = Math.max(0, p.vel.x * dx + p.vel.z * dz);
    p.dive = { t: 0, dx, dz, v0: (2 * GAME.dive.dist) / GAME.dive.dur + along * 0.3 };
    p.charging = false;
    p.charge = 0;
    p.chargeT = 0;
    p.jumpArmed = false;
    p.bufferT = 0;
    p.recover = 0;
    p.swing = {
      t: 0,
      window: GAME.dive.dur + 0.04,
      charge: chargeForDepth(GAME.dive.depth),
      preset: true,
      family: 'down', // 救回網前
      aimX: 0,
      contacted: false,
      contactPoint: null,
      contactT: 0,
      isServe: false,
      whiffed: false,
      from: copy3(p.pos),
      airborne: false,
      triggeredJump: false,
      dive: true,
      diveAuto: true,
    };
    this.events.push({ type: 'dive', player: p.id, dx, dz });
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
      if (Math.hypot(q.x - (p.pos.x + p.vel.x * tt * 0.8), q.z - (p.pos.z + p.vel.z * tt * 0.8)) <= this.reachOf(p)) return tt;
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
      if (d <= this.reachOf(p) && pt.p.y >= GAME.reachMinY + feet && pt.p.y <= GAME.reachMaxY + feet) {
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
    if (s.airborne && best <= this.reachOf(p) + 0.3 && bestT > flickAt + s.window) return '太早';
    if (best <= this.reachOf(p)) return bestY > GAME.reachMaxY + bestFeet ? '太高' : '太低';
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
      dive: false,
      vel: copy3(shot.vel),
      stepDt: shot.stepDt,
      wobble: false,
      attack: 0,
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
    sh.wobble = false;
    sh.attack = 0;
    sh.pace = 0;
    sh.prediction = predict(sh.pos, sh.vel, stepDt);
    this.rallyHits++;
    this.hitSerial++;
  }

  /** 羽球 q 是否在「站在 at（腳高 at.y）」的球員擊球範圍內；回傳水平距離 */
  private inReach(p: PlayerState, q: Vec3, at: Vec3 = p.pos): number | null {
    if (q.z * p.side < 0.05) return null;
    if (p.dive) {
      // 撲出去：身體撲平，範圍往撲的方向延伸、高度變低
      if (q.y < 0.02 || q.y > GAME.dive.maxY) return null;
      const b = GAME.dive.reachBonus;
      const d = Math.hypot(q.x - (at.x + p.dive.dx * b), q.z - (at.z + p.dive.dz * b));
      return d <= this.reachOf(p) ? d : null;
    }
    if (q.y < GAME.reachMinY + at.y || q.y > GAME.reachMaxY + at.y) return null;
    const d = Math.hypot(q.x - at.x, q.z - at.z);
    return d <= this.reachOf(p) ? d : null;
  }

  /** 擊球品質：時機（划動後 idealContactT 最好）× 位置（0.25~0.85 m 最好） */
  private contactQuality(p: PlayerState, t: number, dist: number): number {
    return timeQuality(t, setFactor(p)) * posQuality(dist, this.reachOf(p));
  }

  private updateRally(): void {
    const sh = this.shuttle;
    const dt = PHYS.dt;
    // 擊球判定（先判定再移動，避免高速球穿過）
    if (sh.mode === 'flight') {
      for (const p of this.players) {
        const s = p.swing;
        if (p.id === sh.lastHitter || p.id === this.remote || !s || s.contacted || s.whiffed || s.isServe) continue;
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
          if (nd !== null && !dropsBelowHigh && posQuality(nd, this.reachOf(p)) > posQuality(d, this.reachOf(p)) + 1e-4 && this.contactQuality(p, s.t + dt, nd) >= this.contactQuality(p, s.t, d)) continue;
        }
        this.hit(p, d);
        break;
      }
    }

    this.advanceShuttle();
  }

  /** 羽球往前飛一個 tick：過網判定（掛網）、落地 */
  private advanceShuttle(): void {
    const sh = this.shuttle;
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
    let qTime = timeQuality(swing.t, setFactor(p));
    if (p.airborne) {
      const apexQ = 1 - 0.35 * clamp(Math.abs(this.time - p.takeoffAt - jumpApexTime()) / 0.15, 0, 1);
      qTime = swing.triggeredJump ? apexQ : Math.max(qTime, apexQ);
    }
    // 魚躍：自動救回固定是一顆普通的球（至少會過網）
    let quality = swing.diveAuto ? GAME.dive.quality : qTime * posQuality(dist, this.reachOf(p)) * (swing.dive ? 0.85 : 1);
    const contact = copy3(sh.pos);
    const incoming = Math.hypot(sh.vel.x, sh.vel.y, sh.vel.z);
    // 硬伸手去接快球（殺球）：離身體越遠、來球越快，球質越差；太勉強可能直接掛網 → 這種球要用魚躍
    let stretchFail = false;
    if (!swing.dive && !p.airborne) {
      const fast = sh.pace;
      // 看球的路線離身體多遠（側向距離），不是擊球當下的距離：正面飛來的球在身前 0.9 m 接很正常
      const hv = Math.hypot(sh.vel.x, sh.vel.z) || 1;
      const lateral = Math.abs((p.pos.x - sh.pos.x) * (sh.vel.z / hv) - (p.pos.z - sh.pos.z) * (sh.vel.x / hv));
      const stretch = clamp((lateral - GAME.stretch.comfy) / (this.reachOf(p) - GAME.stretch.comfy), 0, 1);
      const strain = fast * stretch;
      if (strain > 0) {
        quality *= 1 - GAME.stretch.penalty * strain;
        if (quality < 0.5 && strain > 0.5) stretchFail = this.rng.chance(clamp((0.5 - quality) / 0.25, 0, GAME.stretch.maxFail));
      }
    }
    let charge = swing.preset ? swing.charge : Math.max(swing.charge, reboundCharge(incoming));
    if (swing.auto) charge = chargeForDepth(autoDepth(swing.family, contact.y - p.pos.y));
    // 勉強接到（品質差、不是往下壓）→ 只能把球撈成一顆又高又慢、會晃的「機會球」到中場
    let family = swing.family;
    const weak = quality < 0.6 && !p.airborne && family !== 'down' && !stretchFail;
    if (weak) {
      family = 'up';
      charge = clamp(charge, chargeForDepth(3.2), chargeForDepth(4.6));
    }
    if (stretchFail) {
      // 伸手太勉強：拍面沒控制好，球打進網
      family = 'down';
      charge = chargeForDepth(-0.6);
    }
    // 網前、球高於網時按平球（點一下／左右滑）→ 撲球：比一般撲球快一點，但打向對方中場、反應得過來還救得到
    let killCap: number | undefined;
    if (!weak && family === 'side' && Math.abs(contact.z) < GAME.netKill.zone && contact.y >= COURT.netTop + 0.05) {
      family = 'down';
      charge = chargeForDepth(GAME.netKill.depth);
      killCap = GAME.netKill.maxSpeed;
    }
    const attackIn = sh.attack; // 對方送來的球有多好打（不到位的高球、機會球）
    const shot = resolveShot({ side: p.side, contact, family, aimX: swing.aimX, charge, quality, serve: null, jump: p.airborne, kit: p.kit, killCap }, this.rng);
    // 殺不到位的高球更兇
    const bonus = shot.name === '殺球' || shot.name === '跳殺' ? attackIn : 0;
    const chanceSmash = bonus >= 0.7;
    let stepDt = shot.stepDt;
    if (weak) stepDt *= 0.85; // 機會球飄比較慢
    stepDt *= 1 + GAME.attackSmashBonus * bonus;
    const killMul = killCap ? GAME.netKill.speedMul : 1;
    stepDt *= killMul;
    swing.contacted = true;
    swing.contactPoint = contact;
    swing.contactT = swing.t;
    this.launch(p, shot.vel, stepDt, false);
    sh.wobble = weak;
    sh.pace = paceOf(shot.name);
    // 這顆球有多好打：高球越短越好殺；機會球最好殺
    sh.attack = weak ? 1 : family === 'up' ? clamp((5.8 - Math.abs(shot.target.z)) / 1.4, 0, 1) : 0;
    if (weak) this.events.push({ type: 'chance', player: p.id === 0 ? 1 : 0 });
    this.events.push({
      type: 'hit',
      player: p.id,
      name: chanceSmash ? '機會殺球' : shot.name,
      speedKmh: Math.round(shot.speedKmh * (1 + GAME.attackSmashBonus * bonus) * killMul),
      pos: contact,
      family,
      charge,
      netFault: shot.netFault,
      powerShort: shot.powerShort,
      quality,
      grade: quality >= 0.9 ? '完美' : quality >= 0.74 ? '不錯' : '勉強',
      jump: shot.name === '跳殺' || shot.name === '跳撲' || chanceSmash,
      serve: false,
      dive: swing.dive,
      vel: copy3(shot.vel),
      stepDt,
      wobble: weak,
      attack: sh.attack,
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
    if (this.remote !== null && hitter !== this.remote) {
      // 線上：自己打出去的球由對方（接球方）判定，等對方的結果（避免兩邊各判一次）
      this.phase = 'await';
      this.phaseT = 0;
      return;
    }
    if (this.settings.practice) {
      // 練習：不計分，交給關卡判定
      this.events.push({ type: 'drillLand', hitter, pos: copy3(sh.pos), inBounds, net: wasNet || landSide === hitterSide });
      this.phase = 'point';
      this.phaseT = 0;
      return;
    }
    this.awardPoint(winner, reason);
  }

  private awardPoint(winner: 0 | 1, reason: string, byRemote = false): void {
    this.score[winner]++;
    this.server = winner;
    this.lastPoint = { winner, reason };
    this.events.push({ type: 'point', winner, reason, byRemote });
    this.phase = 'point';
    this.phaseT = 0;
    for (const p of this.players) {
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
    }

    const target = this.settings.points;
    const cap = target === 21 ? 30 : target === 15 ? 21 : 15;
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
    if (this.settings.practice) return this.enterDrillIdle();
    if (this.gameJustEnded) {
      this.gameJustEnded = false;
      this.score = [0, 0];
    }
    this.setupServe();
  }

  // ---------- 練習模式（發球機） ----------

  /** 練習：等待下一球。發球機（對面球員）拿著球 */
  private enterDrillIdle(): void {
    for (const p of this.players) {
      p.swing = null;
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
      p.airborne = false;
      p.pos.y = 0;
      p.jumpArmed = false;
      p.jumpUsed = false;
      p.bufferT = 0;
      p.dive = null;
      p.downT = 0;
    }
    this.shuttle.mode = 'held';
    this.shuttle.vel = v3();
    this.shuttle.lastHitter = null;
    this.shuttle.prediction = null;
    this.shuttle.wobble = false;
    this.phase = 'drill';
    this.phaseT = 0;
    this.placeHeldShuttle(1);
  }

  /**
   * 發球機餵一球：從對面 from 位置，用指定球種打到「自己半場」深度 depth 的地方。
   * playerAt：餵球前把玩家放回的位置（世界座標，自己這側）
   */
  feed(spec: { from: { x: number; y: number; z: number }; family: Family; depth: number; aimX: number; playerAt?: { x: number; z: number } }): void {
    const feeder = this.players[1];
    const me = this.players[0];
    if (spec.playerAt) {
      me.pos = v3(spec.playerAt.x, 0, spec.playerAt.z);
      me.vel = v3();
    }
    feeder.pos = v3(spec.from.x - feeder.side * 0.4, 0, spec.from.z);
    feeder.vel = v3();
    const contact = v3(spec.from.x, spec.from.y, spec.from.z);
    this.shuttle.pos = copy3(contact);
    const shot = resolveShot(
      { side: feeder.side, contact, family: spec.family, aimX: spec.aimX, charge: chargeForDepth(spec.depth), quality: 1, serve: null, jump: false },
      this.rng,
    );
    feeder.swing = {
      t: 0,
      window: GAME.swingWindow,
      charge: 0,
      preset: true,
      family: spec.family,
      aimX: spec.aimX,
      contacted: true,
      contactPoint: contact,
      contactT: 0,
      isServe: false,
      whiffed: false,
      from: copy3(feeder.pos),
      airborne: false,
      triggeredJump: false,
      dive: false,
      diveAuto: false,
    };
    this.launch(feeder, shot.vel, shot.stepDt, false);
    this.shuttle.pace = paceOf(shot.name);
    this.events.push({
      type: 'hit',
      player: 1,
      name: shot.name,
      speedKmh: shot.speedKmh,
      pos: contact,
      family: spec.family,
      charge: 0,
      netFault: false,
      powerShort: false,
      quality: 1,
      grade: '完美',
      jump: false,
      serve: false,
      dive: false,
      vel: copy3(shot.vel),
      stepDt: shot.stepDt,
      wobble: false,
      attack: 0,
    });
    this.phase = 'rally';
    this.phaseT = 0;
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


  /** 羽球是否在 softTapLead 秒內會飛到這位球員附近（比擊球範圍寬一點，邊跑邊點也算） */
  private softTapLive(p: PlayerState): boolean {
    const sh = this.shuttle;
    if (this.phase !== 'rally' || sh.mode !== 'flight' || sh.lastHitter === p.id || !sh.prediction) return false;
    const elapsed = this.time - sh.launchTime;
    for (const pt of sh.prediction.points) {
      if (pt.t < elapsed) continue;
      if (pt.t - elapsed > GAME.softTapLead) break;
      const q = pt.p;
      if (q.z * p.side < 0.05 || q.y > GAME.reachMaxY + p.pos.y + 0.6) continue;
      if (Math.hypot(q.x - p.pos.x, q.z - p.pos.z) <= this.reachOf(p) + 0.7) return true;
    }
    return false;
  }

  /** 教學暫停時：世界停住，只讓這位球員繼續蓄力（放開就歸零） */
  holdCharge(id: 0 | 1, charging: boolean, dt: number): void {
    const p = this.players[id];
    if (charging && !p.swing) {
      p.charging = true;
      p.chargeT += dt;
      p.charge = chargeFromTime(p.chargeT);
      if (p.jumpArmed || p.airborne) p.charge = Math.min(p.charge, JUMP_CHARGE_CAP);
    } else if (!charging) {
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
    }
  }

  // ---------- 線上對戰 ----------

  /** 對方最新的狀態（收到時的 match.time 一起存） */
  setRemoteState(rs: RemoteState): void {
    this.remoteState = { rs, at: this.time };
  }

  /** 遠端玩家：位置用網路狀態外插、每 tick 拉近一點；不會自己擊球（擊球只來自 applyRemoteHit） */
  private updateRemote(p: PlayerState, dt: number): void {
    if (p.swing) {
      p.swing.t += dt;
      if (p.swing.t >= Math.max(GAME.swingDuration, p.swing.window + 0.1)) p.swing = null;
    }
    if (!this.remoteState) return;
    const { rs, at } = this.remoteState;
    const age = Math.min(0.2, this.time - at);
    const tx = rs.pos.x + rs.vel.x * age;
    const tz = rs.pos.z + rs.vel.z * age;
    if (Math.hypot(tx - p.pos.x, tz - p.pos.z) > 1.5) {
      p.pos.x = tx; // 差太多（換發球位置）直接過去
      p.pos.z = tz;
    } else {
      p.pos.x += (tx - p.pos.x) * 0.2;
      p.pos.z += (tz - p.pos.z) * 0.2;
    }
    p.vel.x = rs.vel.x;
    p.vel.z = rs.vel.z;
    p.airborne = rs.airborne;
    p.vy = rs.airborne ? rs.vel.y - GAME.jump.gravity * age : 0;
    p.pos.y = rs.airborne ? Math.max(0, rs.pos.y + rs.vel.y * age - 0.5 * GAME.jump.gravity * age * age) : 0;
    p.charging = rs.charging;
    p.charge = rs.charge;
    p.jumpArmed = rs.jumpArmed;
    p.dive = rs.dive ? { ...rs.dive, t: rs.dive.t + age, v0: 0 } : null;
    p.downT = Math.max(0, rs.downT - age);
    if (rs.swing && !p.swing && rs.swing.t + age < GAME.swingDuration) p.swing = this.syntheticSwing(p, rs.swing.family, rs.swing.t + age, rs.swing.airborne);
  }

  private syntheticSwing(p: PlayerState, family: Family, t: number, airborne: boolean): Swing {
    return {
      t,
      window: GAME.swingWindow,
      charge: 0,
      preset: true,
      family,
      aimX: 0,
      contacted: false,
      contactPoint: null,
      contactT: t,
      isServe: false,
      whiffed: false,
      from: copy3(p.pos),
      airborne,
      triggeredJump: false,
      dive: false,
      diveAuto: false,
    };
  }

  /**
   * 對方擊球：從擊球點用同樣的初速發出去（軌跡是確定的，兩邊算出來一樣），
   * 再往前補 lat 秒（訊息在路上的時間），讓兩邊的羽球位置對齊。
   */
  applyRemoteHit(h: RemoteHit, lat: number): void {
    if (this.remote === null || this.phase === 'matchOver') return;
    const p = this.players[this.remote];
    if (h.serve && this.phase === 'point') this.afterPoint(); // 對方比較快：先把發球準備好
    const sh = this.shuttle;
    sh.pos = copy3(h.contact);
    this.launch(p, h.vel, h.stepDt, h.serve);
    sh.wobble = h.wobble;
    sh.attack = h.attack;
    sh.pace = paceOf(h.name);
    const prev = p.swing;
    const s = this.syntheticSwing(p, h.family, prev && !prev.contacted ? prev.t : GAME.idealContactT, p.airborne);
    s.contacted = true;
    s.contactPoint = copy3(h.contact);
    s.isServe = h.serve;
    s.dive = h.dive;
    p.swing = s;
    if (this.phase !== 'rally') {
      this.phase = 'rally';
      this.phaseT = 0;
    }
    if (h.wobble) this.events.push({ type: 'chance', player: p.id === 0 ? 1 : 0 });
    this.events.push({
      type: 'hit',
      player: p.id,
      name: h.name,
      speedKmh: h.speedKmh,
      pos: copy3(h.contact),
      family: h.family,
      charge: h.charge,
      netFault: h.netFault,
      powerShort: h.powerShort,
      quality: h.quality,
      grade: h.grade,
      jump: h.jump,
      serve: h.serve,
      dive: h.dive,
      vel: copy3(h.vel),
      stepDt: h.stepDt,
      wobble: h.wobble,
      attack: h.attack,
    });
    const n = Math.min(36, Math.round(lat / PHYS.dt));
    sh.launchTime -= n * PHYS.dt;
    for (let i = 0; i < n && sh.mode !== 'down' && this.phase === 'rally'; i++) this.advanceShuttle();
  }

  /** 對方（接球方）判定這一分；score/games 是判定後的比分（本機 id 順序），以判定方為準 */
  applyRemoteVerdict(v: { remoteWon: boolean; reason: string; score: [number, number]; games: [number, number] }): void {
    if (this.remote === null || this.phase === 'point' || this.phase === 'matchOver') return;
    const local: 0 | 1 = this.remote === 0 ? 1 : 0;
    if (this.shuttle.mode !== 'down') {
      this.shuttle.mode = 'down';
      this.shuttle.vel = v3();
      this.shuttle.pos.y = Math.max(0, this.shuttle.pos.y);
    }
    this.awardPoint(v.remoteWon ? this.remote : local, v.reason, true);
    this.score = [v.score[0], v.score[1]];
    this.games = [v.games[0], v.games[1]];
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
    if (Math.hypot(q.x - p.pos.x, q.z - p.pos.z) <= GAME.reach * p.reachMul) return pt.t - elapsed;
  }
  return null;
}

/** 時機分數：划動後 GAME.idealContactT 擊中最好；划太晚（球已經在身邊）扣分較少，划太早扣較多 */
/**
 * 站穩程度（學 TopSpin）：擊球時越接近停住，「完美」的時間範圍越寬；邊跑邊打則變窄。
 * 回傳時間容許度倍率 0.8（全速跑動）～1.4（站定）
 */
function setFactor(p: PlayerState): number {
  if (p.airborne) return 1;
  const sp = Math.hypot(p.vel.x, p.vel.z);
  const set = 1 - Math.min(1, sp / (GAME.moveSpeed * 0.6));
  return 0.8 + 0.6 * set;
}

function timeQuality(t: number, f = 1): number {
  // 理想時機前後各 0.035 秒內都算滿分；超出後扣分也比較溫和（判定放寬）
  const ideal = GAME.idealContactT;
  const flat = 0.035 * f;
  if (Math.abs(t - ideal) <= flat) return 1;
  if (t < ideal) return 1 - 0.2 * clamp((ideal - flat - t) / Math.max(0.01, ideal - flat) / f, 0, 1);
  return 1 - 0.28 * clamp((t - ideal - flat) / (GAME.swingWindow - ideal) / f, 0, 1);
}

/** 點擊滑放的深度：高點 = 上手（高遠球貼底線、切球），低點 = 下手（挑球、放網） */
function autoDepth(family: Family, y: number): number {
  const high = y >= GAME.highZoneY;
  if (family === 'up') return high ? 6.3 : 6.1;
  if (family === 'down') return high ? 1.2 : 0.9;
  return 5.0;
}

/** 來球有多兇：硬伸手去接的難度 */
function paceOf(name: string): number {
  if (name === '殺球' || name === '跳殺' || name === '機會殺球') return 1;
  if (name === '撲球' || name === '跳撲' || name === '下壓') return 0.8;
  if (name === '平抽' || name === '推球' || name === '平高球') return 0.5;
  return 0;
}

/** 位置分數：離身體 0.25~0.85 m 最好，太遠或太擠扣分 */
function posQuality(dist: number, reach: number = GAME.reach): number {
  if (dist > 0.92) return 1 - 0.2 * ((dist - 0.92) / (reach - 0.92));
  if (dist < 0.2) return 0.9;
  return 1;
}
