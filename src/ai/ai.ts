import { chargeFromTime, COURT, GAME, timeForCharge, type Difficulty } from '../config';
import { idleInput, type Match, type PlayerInput } from '../sim/match';
import { reboundCharge, type Family, type Flick } from '../sim/shots';

interface AIParams {
  reaction: number; // 對手出拍後多久才開始動
  speedMul: number;
  chargeNoise: number; // 蓄力誤差（蓄力值單位）
  timingJitter: number;
  outJudge: number; // 正確放掉出界球的機率
  smartAim: number; // 打對手空檔的機率
  smashBias: number;
}

const PARAMS: Record<Difficulty, AIParams> = {
  easy: { reaction: 0.38, speedMul: 0.78, chargeNoise: 0.05, timingJitter: 0.05, outJudge: 0.5, smartAim: 0.35, smashBias: 0.6 },
  normal: { reaction: 0.25, speedMul: 0.9, chargeNoise: 0.025, timingJitter: 0.03, outJudge: 0.8, smartAim: 0.7, smashBias: 1 },
  hard: { reaction: 0.15, speedMul: 1.0, chargeNoise: 0.017, timingJitter: 0.015, outJudge: 0.95, smartAim: 0.9, smashBias: 1.2 },
};

interface ShotChoice {
  family: Family;
  depth: number;
  aimX: number;
}

interface Plan {
  reactAt: number;
  standX: number;
  standZ: number;
  contactAt: number;
  chargeAt: number;
  flickAt: number;
  charge: number;
  flick: Flick;
  leave: boolean;
  done: boolean;
}

export class AIController {
  private p: AIParams;
  private plan: Plan | null = null;
  private seenHits = -1;
  private seenServeT = -1;
  private serveDelay = 1;
  private serveChoice: { charge: number; flick: Flick } | null = null;

  constructor(private match: Match, private id: 0 | 1, difficulty: Difficulty) {
    this.p = PARAMS[difficulty];
  }

  private get me() {
    return this.match.players[this.id];
  }

  input(): PlayerInput {
    const m = this.match;
    const inp = idleInput();
    if (m.phase === 'serve') return this.serveInput(inp);
    this.serveChoice = null;
    if (m.phase !== 'rally') return inp;

    const sh = m.shuttle;
    if (sh.lastHitter !== this.id && sh.lastHitter !== null && m.hitSerial !== this.seenHits) {
      this.seenHits = m.hitSerial;
      this.plan = this.makePlan();
    }

    const plan = sh.lastHitter === this.id || !this.plan || this.plan.leave || this.plan.done ? null : this.plan;
    if (!plan) {
      this.moveTo(inp, 0, this.me.side * 3.9, 0.6);
      return inp;
    }

    const now = m.time;
    if (now >= plan.reactAt) this.moveTo(inp, plan.standX, plan.standZ, 1);
    else this.moveTo(inp, 0, this.me.side * 3.9, 0.4);

    if (now >= plan.chargeAt && now >= plan.reactAt) inp.charging = true;
    const charged = this.me.charge >= plan.charge;
    if ((charged && now >= plan.flickAt - 0.04) || now >= plan.flickAt + 0.03) {
      inp.flick = plan.flick;
      inp.charging = false;
      plan.done = true;
    }
    return inp;
  }

  private serveInput(inp: PlayerInput): PlayerInput {
    const m = this.match;
    if (m.server !== this.id) return inp;
    if (m.phaseT < this.seenServeT || this.seenServeT < 0) {
      this.serveDelay = 0.9 + m.rng.next() * 0.9;
      this.serveChoice = null;
    }
    this.seenServeT = m.phaseT;
    if (m.phaseT < this.serveDelay) return inp;
    if (!this.serveChoice) {
      const dn = Math.abs(m.shuttle.pos.z);
      const long = m.rng.chance(0.35);
      const depth = long ? 5.9 : COURT.shortService + 0.5;
      const aim = (m.rng.next() - 0.5) * 1.2;
      this.serveChoice = {
        charge: this.chargeFor(dn, depth),
        flick: this.flickFor(long ? 'up' : 'down', aim),
      };
    }
    inp.charging = true;
    if (this.me.charge >= this.serveChoice.charge) {
      inp.charging = false;
      inp.flick = this.serveChoice.flick;
    }
    return inp;
  }

  private chargeFor(dn: number, depth: number): number {
    const c = (dn + depth) / GAME.maxShotLength + this.match.rng.gauss() * this.p.chargeNoise;
    return Math.max(0.02, Math.min(1, c));
  }

  private flickFor(family: Family, aimX: number): Flick {
    if (family === 'side') return { x: Math.sign(aimX || 1), y: 0.05 };
    const nx = Math.max(-0.7, Math.min(0.7, aimX / 1.15));
    const ny = Math.sqrt(1 - nx * nx);
    return { x: nx, y: family === 'up' ? ny : -ny };
  }

  private moveTo(inp: PlayerInput, x: number, z: number, urgency: number): void {
    const me = this.me;
    const dx = x - me.pos.x;
    const dz = z - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    const s = Math.min(1, d / 0.35) * this.p.speedMul * urgency;
    // 世界座標 → 自己視角
    inp.moveX = (dx / d) * me.side * s;
    inp.moveY = (-dz / d) * me.side * s;
  }

  private makePlan(): Plan | null {
    const m = this.match;
    const sh = m.shuttle;
    const pred = sh.prediction;
    const me = this.me;
    const rng = m.rng;
    const now = m.time;
    const p = this.p;
    const leavePlan = (): Plan => ({ reactAt: now, standX: 0, standZ: me.side * 3.9, contactAt: 0, chargeAt: 1e9, flickAt: 1e9, charge: 0, flick: { x: 0, y: 1 }, leave: true, done: false });
    if (!pred || pred.hitsNet) return leavePlan();

    // 出界球判斷
    if (pred.landing) {
      const L = pred.landing;
      const marginX = COURT.singlesHalfWidth - Math.abs(L.x);
      const marginZ = COURT.halfLength - Math.abs(L.z);
      let margin = Math.min(marginX, marginZ);
      if (sh.isServe) margin = Math.min(margin, Math.abs(L.z) - COURT.shortService, L.x * sh.serveBoxSign);
      if (margin < -0.05 && rng.chance(p.outJudge)) return leavePlan();
      if (margin >= 0 && margin < 0.3 && rng.chance((1 - p.outJudge) * 0.4)) return leavePlan();
    }

    const speed = GAME.moveSpeed * p.speedMul;
    type Cand = { score: number; i: number; tAbs: number; sx: number; sz: number };
    let best: Cand | null = null;
    let fallback: Cand | null = null;
    for (let i = 0; i < pred.points.length; i += 3) {
      const pt = pred.points[i].p;
      if (pt.z * me.side < 0.15) continue;
      if (pt.y < 0.25 || pt.y > GAME.reachMaxY - 0.15) continue;
      const tAbs = now + pred.points[i].t;
      const sx = Math.max(-3.4, Math.min(3.4, pt.x - me.side * 0.55));
      const sz = pt.z + me.side * 0.15;
      const travel = Math.hypot(sx - me.pos.x, sz - me.pos.z);
      const avail = tAbs - now - p.reaction;
      const cand = { score: 0, i, tAbs, sx, sz };
      fallback = cand;
      if (travel / speed + 0.12 > avail && travel > 0.4) continue;
      let score = -0.15 * (tAbs - now);
      if (pt.y >= GAME.highZoneY) score += 1 * p.smashBias;
      if (pt.y < 0.5) score -= 0.6;
      cand.score = score;
      if (!best || score > best.score) best = cand;
    }
    const pick = best ?? fallback;
    if (!pick) return leavePlan();

    const pt = pred.points[pick.i].p;
    const dn = Math.abs(pt.z);
    const contactAt = pick.tAbs;
    const flickAt = contactAt - 0.05 + rng.gauss() * p.timingJitter;
    // 來不及蓄滿就改打需要較少力道的球（放網／擋網前）；快球有反彈力可借
    const pts = pred.points;
    const j = Math.min(pick.i + 1, pts.length - 1);
    const inSpeed = j > pick.i ? Math.hypot(pts[j].p.x - pt.x, pts[j].p.y - pt.y, pts[j].p.z - pt.z) / (pts[j].t - pts[pick.i].t) : 0;
    const maxCharge = Math.max(chargeFromTime(flickAt - (now + p.reaction)), reboundCharge(inSpeed));
    let shot = this.chooseShot(pt.y, dn);
    if ((dn + shot.depth) / GAME.maxShotLength > maxCharge) {
      const depth = Math.max(0.9, maxCharge * GAME.maxShotLength - dn - 0.3);
      shot = { family: 'down', depth, aimX: shot.aimX };
    }
    const charge = this.chargeFor(dn, shot.depth);
    return {
      reactAt: now + p.reaction,
      standX: pick.sx,
      standZ: pick.sz,
      contactAt,
      chargeAt: flickAt - timeForCharge(charge),
      flickAt,
      charge,
      flick: this.flickFor(shot.family, shot.aimX),
      leave: false,
      done: false,
    };
  }

  private chooseShot(y: number, dn: number): ShotChoice {
    const m = this.match;
    const rng = m.rng;
    const me = this.me;
    const opp = m.players[this.id === 0 ? 1 : 0];
    const oppDeep = Math.abs(opp.pos.z) > 4.6;
    const oppFront = Math.abs(opp.pos.z) < 3.0;

    // 打對手空檔：對手在我視角的左右
    const oppAim = (opp.pos.x * me.side) / 2.3;
    const aimX = rng.chance(this.p.smartAim)
      ? -Math.sign(oppAim || rng.next() - 0.5) * rng.range(0.5, 0.95)
      : rng.range(-0.8, 0.8);

    const pick = (opts: [number, ShotChoice['family'], number][]): ShotChoice => {
      const total = opts.reduce((s, o) => s + o[0], 0);
      let r = rng.next() * total;
      for (const [w, family, depth] of opts) {
        r -= w;
        if (r <= 0) return { family, depth, aimX };
      }
      return { family: opts[0][1], depth: opts[0][2], aimX };
    };

    const sb = this.p.smashBias;
    if (y >= GAME.highZoneY) {
      if (dn < 4.5) return pick([[0.6 * sb, 'down', 4.3], [oppDeep ? 0.35 : 0.2, 'down', 1.3], [oppFront ? 0.3 : 0.12, 'up', 5.8]]);
      return pick([[oppFront ? 0.55 : 0.4, 'up', 5.8], [0.3 * sb, 'down', 4.6], [oppDeep ? 0.45 : 0.25, 'down', 1.4]]);
    }
    if (y >= 1.3) {
      if (dn < 2.3) return pick([[0.7, 'down', 3.2], [0.3, 'down', 1.0]]);
      return pick([[0.4, 'side', 5.2], [oppFront ? 0.5 : 0.3, 'up', 5.6], [oppDeep ? 0.35 : 0.2, 'down', 1.5]]);
    }
    if (dn < 2.5) return pick([[oppDeep ? 0.65 : 0.45, 'down', 0.9], [oppFront ? 0.65 : 0.45, 'up', 5.6]]);
    return pick([[0.65, 'up', 5.6], [0.35, 'side', 5.0]]);
  }
}
