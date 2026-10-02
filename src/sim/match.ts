import { chargeFromTime, COURT, GAME, PHYS, type MatchSettings } from '../config';
import { copy3, netTopAt, predict, stepShuttle, v3, type Prediction, type Vec3 } from './physics';
import { Rng } from './rng';
import { classifyFlick, reboundCharge, resolveShot, type Family, type Flick } from './shots';

/** 每個 tick 每位球員的輸入（全部用球員自己的視角，所以 AI/線上玩家都能共用） */
export interface PlayerInput {
  moveX: number; // 右為正
  moveY: number; // 往網子方向為正
  charging: boolean;
  flick: Flick | null; // 這個 tick 出拍的方向
}
export const idleInput = (): PlayerInput => ({ moveX: 0, moveY: 0, charging: false, flick: null });

export interface Swing {
  t: number;
  charge: number;
  family: Family;
  aimX: number;
  contacted: boolean;
  contactPoint: Vec3 | null;
  contactT: number;
  isServe: boolean;
}

export interface PlayerState {
  id: 0 | 1;
  side: 1 | -1; // 1 = z>0 半場（畫面下方）
  pos: Vec3;
  vel: Vec3;
  charge: number;
  charging: boolean;
  chargeT: number;
  swing: Swing | null;
  recover: number;
}

export type Phase = 'serve' | 'rally' | 'point' | 'matchOver';

export type MatchEvent =
  | { type: 'hit'; player: 0 | 1; name: string; speedKmh: number; pos: Vec3; family: Family; charge: number; netFault: boolean }
  | { type: 'whiff'; player: 0 | 1 }
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
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

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
      pos: v3(0, 0, side * 4),
      vel: v3(),
      charge: 0,
      chargeT: 0,
      charging: false,
      swing: null,
      recover: 0,
    });
    this.players = [mk(0, 1), mk(1, -1)];
    this.shuttle = { pos: v3(), vel: v3(), mode: 'held', lastHitter: null, isServe: false, serveBoxSign: 1, prediction: null, stepDt: PHYS.dt };
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

    // 出拍
    if (input.flick && !p.swing && p.recover <= 0 && this.phase !== 'matchOver') {
      const { family, aimX } = classifyFlick(input.flick);
      p.swing = { t: 0, charge: p.charge, family, aimX, contacted: false, contactPoint: null, contactT: 0, isServe: false };
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
    } else if (!input.charging) {
      p.charging = false;
      p.charge = 0;
      p.chargeT = 0;
    }

    if (p.swing) {
      p.swing.t += dt;
      if (p.swing.t >= GAME.swingDuration) {
        if (!p.swing.contacted) {
          p.recover = GAME.whiffRecover;
          this.events.push({ type: 'whiff', player: p.id });
        }
        p.swing = null;
      }
    }

    // 移動（輸入是自己視角 → 換成世界座標）
    let mx = input.moveX;
    let my = input.moveY;
    const m = Math.hypot(mx, my);
    if (m > 1) {
      mx /= m;
      my /= m;
    }
    const mul = p.swing ? GAME.swingMoveMul : p.charging ? GAME.chargeMoveMul : 1;
    const tvx = p.side * mx * GAME.moveSpeed * mul;
    const tvz = -p.side * my * GAME.moveSpeed * mul;
    const maxDv = GAME.moveAccel * dt;
    p.vel.x += clamp(tvx - p.vel.x, -maxDv, maxDv);
    p.vel.z += clamp(tvz - p.vel.z, -maxDv, maxDv);
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;

    // 活動範圍
    if (this.phase === 'serve') {
      const isServer = p.id === this.server;
      const sign = isServer ? p.side * this.serveCourtSign() : this.shuttle.serveBoxSign;
      const lx = clamp(p.pos.x * sign, 0.15, COURT.singlesHalfWidth - 0.15);
      p.pos.x = lx * sign;
      p.pos.z = p.side * clamp(p.pos.z * p.side, COURT.shortService + 0.3, COURT.halfLength - 0.3);
    } else {
      p.pos.x = clamp(p.pos.x, -3.6, 3.6);
      p.pos.z = p.side * clamp(p.pos.z * p.side, 0.3, 8.2);
    }
    if (p.pos.x !== p.pos.x) p.pos.x = 0;
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
      },
      this.rng,
    );
    swing.contacted = true;
    swing.contactPoint = contact;
    swing.contactT = swing.t;
    swing.isServe = true;
    this.launch(p, shot.vel, shot.stepDt, true);
    this.events.push({ type: 'hit', player: p.id, name: shot.name, speedKmh: shot.speedKmh, pos: contact, family: swing.family, charge: swing.charge, netFault: shot.netFault });
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
    sh.prediction = predict(sh.pos, sh.vel, stepDt);
    this.rallyHits++;
    this.hitSerial++;
  }

  private updateRally(): void {
    const sh = this.shuttle;
    // 擊球判定（先判定再移動，避免高速球穿過）
    if (sh.mode === 'flight') {
      for (const p of this.players) {
        if (p.id === sh.lastHitter || !p.swing || p.swing.contacted || p.swing.isServe) continue;
        if (p.swing.t > GAME.swingWindow) continue;
        if (sh.pos.z * p.side < 0.05) continue;
        const d = Math.hypot(sh.pos.x - p.pos.x, sh.pos.z - p.pos.z);
        if (d > GAME.reach || sh.pos.y < GAME.reachMinY || sh.pos.y > GAME.reachMaxY) continue;
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
    const qTime = 1 - 0.35 * clamp(swing.t / GAME.swingWindow, 0, 1);
    let qPos = 1;
    if (dist > 0.85) qPos = 1 - 0.3 * ((dist - 0.85) / (GAME.reach - 0.85));
    else if (dist < 0.25) qPos = 0.85;
    const contact = copy3(sh.pos);
    const incoming = Math.hypot(sh.vel.x, sh.vel.y, sh.vel.z);
    const charge = Math.max(swing.charge, reboundCharge(incoming));
    const shot = resolveShot(
      { side: p.side, contact, family: swing.family, aimX: swing.aimX, charge, quality: qTime * qPos, serve: null },
      this.rng,
    );
    swing.contacted = true;
    swing.contactPoint = contact;
    swing.contactT = swing.t;
    this.launch(p, shot.vel, shot.stepDt, false);
    this.events.push({ type: 'hit', player: p.id, name: shot.name, speedKmh: shot.speedKmh, pos: contact, family: swing.family, charge: swing.charge, netFault: shot.netFault });
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
