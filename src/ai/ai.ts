import { chargeFromTime, COURT, GAME, PHYS, timeForCharge, type Difficulty } from '../config';
import { idleInput, type Match, type PlayerInput } from '../sim/match';
import { chargeForDepth, depthFromCharge, reboundCharge, type Family, type Flick } from '../sim/shots';

interface AIParams {
  reaction: number; // 對手出拍後多久才開始動
  speedMul: number;
  depthNoise: number; // 落點深度誤差（公尺）
  timingJitter: number;
  outJudge: number; // 正確放掉出界球的機率
  smartAim: number; // 打對手空檔的機率
  smashBias: number;
  killRate: number; // 網前高球選擇撲殺的比例
  jumpRate: number; // 高球殺球時改用跳殺的比例
}

const PARAMS: Record<Difficulty, AIParams> = {
  easy: { reaction: 0.38, speedMul: 0.78, depthNoise: 0.9, timingJitter: 0.05, outJudge: 0.5, smartAim: 0.35, smashBias: 0.6, killRate: 0.25, jumpRate: 0 },
  normal: { reaction: 0.25, speedMul: 0.9, depthNoise: 0.5, timingJitter: 0.04, outJudge: 0.8, smartAim: 0.7, smashBias: 1, killRate: 0.4, jumpRate: 0.15 },
  hard: { reaction: 0.15, speedMul: 1.0, depthNoise: 0.3, timingJitter: 0.025, outJudge: 0.95, smartAim: 0.9, smashBias: 1.2, killRate: 0.55, jumpRate: 0.35 },
};


/** AI 打法個性：各球種選擇權重倍率＋跳殺、假動作、穩定度 */
export interface AIStyle {
  name: string;
  smash: number;
  drop: number; // 切球／放網
  clear: number; // 高遠／挑球
  drive: number;
  jump: number; // 額外跳殺機率
  feint: number; // 假動作機率（先蓄力、放掉、再蓄）
  steady: number; // 落點誤差倍率（<1 越穩）
}

export const STYLES: Record<string, AIStyle> = {
  allround: { name: '全能', smash: 1, drop: 1, clear: 1, drive: 1, jump: 0, feint: 0, steady: 1 },
  attacker: { name: '進攻型', smash: 1.8, drop: 0.7, clear: 0.8, drive: 1, jump: 0.25, feint: 0, steady: 1.1 },
  netter: { name: '網前型', smash: 0.7, drop: 2.0, clear: 0.8, drive: 0.8, jump: 0, feint: 0.15, steady: 0.85 },
  defender: { name: '防守型', smash: 0.6, drop: 0.8, clear: 1.8, drive: 0.9, jump: 0, feint: 0, steady: 0.75 },
  driver: { name: '平抽快攻', smash: 1.1, drop: 0.8, clear: 0.6, drive: 2.2, jump: 0, feint: 0.05, steady: 1 },
  trickster: { name: '假動作大師', smash: 1, drop: 1.5, clear: 1, drive: 1, jump: 0.1, feint: 0.45, steady: 0.9 },
};

/** 難度連續值：0 = 簡單、1 = 普通、2 = 困難（中間線性內插），巡迴賽用 */
export function aiLevel(t: number): AIParams {
  const keys: Difficulty[] = ['easy', 'normal', 'hard'];
  const c = Math.max(0, Math.min(2, t));
  const i = Math.min(1, Math.floor(c));
  const u = c - i;
  const a = PARAMS[keys[i]];
  const b = PARAMS[keys[i + 1]];
  const out = {} as AIParams;
  for (const k of Object.keys(a) as (keyof AIParams)[]) out[k] = a[k] + (b[k] - a[k]) * u;
  return out;
}

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
  jump: boolean;
  feint: boolean; // 先假蓄力一次
  done: boolean;
}

export class AIController {
  private p: AIParams;
  private plan: Plan | null = null;
  private seenHits = -1;
  private seenServeT = -1;
  private serveDelay = 1;
  private serveChoice: { charge: number; flick: Flick } | null = null;

  /**
   * moveOnly = 簡單模式的自動跑位：只輸出移動，蓄力／出拍交給玩家
   */
  constructor(
    private match: Match,
    private id: 0 | 1,
    difficulty: Difficulty | number,
    private moveOnly = false,
    private style: AIStyle = STYLES.allround,
  ) {
    this.p = typeof difficulty === 'number' ? aiLevel(difficulty) : PARAMS[difficulty];
  }

  private get me() {
    return this.match.players[this.id];
  }

  input(): PlayerInput {
    const inp = this.decide();
    if (this.moveOnly) {
      inp.charging = false;
      inp.jump = false;
      inp.flick = null;
    }
    return inp;
  }

  private decide(): PlayerInput {
    const m = this.match;
    const inp = idleInput();
    if (m.phase === 'serve') return this.moveOnly ? inp : this.serveInput(inp);
    this.serveChoice = null;
    if (m.phase !== 'rally') return inp;

    const sh = m.shuttle;
    if (sh.lastHitter !== this.id && sh.lastHitter !== null && m.hitSerial !== this.seenHits) {
      this.seenHits = m.hitSerial;
      this.plan = this.makePlan();
    }

    const plan = sh.lastHitter === this.id || !this.plan || this.plan.leave || this.plan.done ? null : this.plan;
    if (!plan) {
      this.moveTo(inp, 0, this.me.side * 3.6, 0.6);
      return inp;
    }

    const now = m.time;
    if (now >= plan.reactAt) this.moveTo(inp, plan.standX, plan.standZ, 1);
    else this.moveTo(inp, 0, this.me.side * 3.6, 0.4);

    // 假動作：先蓄力一下再放掉（腳下光圈會亮又熄），然後才真的蓄力
    const feinting = plan.feint && now >= plan.chargeAt - 0.5 && now < plan.chargeAt - 0.2;
    if ((now >= plan.chargeAt || feinting) && now >= plan.reactAt) {
      inp.charging = true;
      inp.jump = plan.jump;
    }
    const charged = this.me.charge >= plan.charge;
    // 自動跑位模式不出拍、也不提早離開站位，等玩家自己打
    if (!this.moveOnly && ((charged && now >= plan.flickAt - 0.04) || now >= plan.flickAt + 0.03)) {
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
      const long = m.rng.chance(0.35);
      const depth = long ? 5.9 : COURT.shortService + 0.5;
      const aim = (m.rng.next() - 0.5) * 1.2;
      this.serveChoice = {
        charge: this.chargeFor(depth),
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

  private chargeFor(depth: number): number {
    const c = chargeForDepth(depth + this.match.rng.gauss() * this.p.depthNoise * this.style.steady);
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
    const leavePlan = (): Plan => ({ reactAt: now, standX: 0, standZ: me.side * 3.6, contactAt: 0, chargeAt: 1e9, flickAt: 1e9, charge: 0, flick: { x: 0, y: 1 }, leave: true, jump: false, feint: false, done: false });
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

    const speed = GAME.moveSpeed * p.speedMul * me.kit.move;
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
      if (travel / speed + 0.12 / me.kit.accel > avail && travel > 0.4) continue;
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
    const flickAt = contactAt - GAME.idealContactT + rng.gauss() * p.timingJitter;
    // 來不及蓄滿就改打需要較少力道的球（放網／擋網前）；快球有反彈力可借
    const pts = pred.points;
    const j = Math.min(pick.i + 1, pts.length - 1);
    // 預測點的時間是 tick 時間；換回物理速度要除以球速倍率
    const speedMul = pred.stepDt / PHYS.dt;
    const inSpeed = j > pick.i ? Math.hypot(pts[j].p.x - pt.x, pts[j].p.y - pt.y, pts[j].p.z - pt.z) / (pts[j].t - pts[pick.i].t) / speedMul : 0;
    const maxCharge = Math.max(chargeFromTime(flickAt - (now + p.reaction)), reboundCharge(inSpeed));
    let shot = this.chooseShot(pt.y, dn);
    if (chargeForDepth(shot.depth) > maxCharge) {
      const depth = Math.max(0.9, depthFromCharge(maxCharge) - 0.3);
      shot = { family: 'down', depth, aimX: shot.aimX };
    }
    const charge = this.chargeFor(shot.depth);
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
      jump: shot.family === 'down' && shot.depth >= 2.6 && pt.y >= 2.1 && rng.chance(p.jumpRate + this.style.jump),
      feint: rng.chance(this.style.feint) && flickAt - timeForCharge(charge) - 0.55 > now + p.reaction,
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
      ? -Math.sign(oppAim || rng.next() - 0.5) * rng.range(0.45, 0.85)
      : rng.range(-0.8, 0.8);

    // 權重再乘上「打法個性」和「自己哪種球比較快」（會多打自己的強項）
    const st = this.style;
    const ks = me.kit.speed;
    const bias = (family: Family, depth: number) => {
      if (family === 'side') return st.drive * ks.push ** 4;
      if (family === 'up') return st.clear * ks.clear ** 4;
      return depth >= 2.6 ? st.smash * ks.smash ** 4 : st.drop * ks.drop ** 4;
    };
    const pick = (opts: [number, ShotChoice['family'], number][]): ShotChoice => {
      const ws = opts.map(([w, f, d]) => w * bias(f, d));
      const total = ws.reduce((s, w) => s + w, 0);
      let r = rng.next() * total;
      for (let i = 0; i < opts.length; i++) {
        r -= ws[i];
        if (r <= 0) return { family: opts[i][1], depth: opts[i][2], aimX };
      }
      return { family: opts[0][1], depth: opts[0][2], aimX };
    };

    const sb = this.p.smashBias * (m.shuttle.wobble ? 2.2 : 1); // 機會球就殺
    // 網前（不論高度）只要球明顯高過網：撲殺（已限速）或放網
    if (dn < 2.3 && y >= COURT.netTop + 0.3) {
      const kill = this.p.killRate;
      return pick([[kill, 'down', 3.2], [1 - kill, 'down', 1.1], [oppFront ? 0.3 : 0.1, 'up', 5.6]]);
    }
    if (y >= GAME.highZoneY) {
      if (dn < 4.5) return pick([[0.6 * sb, 'down', 4.3], [oppDeep ? 0.35 : 0.2, 'down', 1.3], [oppFront ? 0.3 : 0.12, 'up', 5.8]]);
      return pick([[oppFront ? 0.55 : 0.4, 'up', 5.8], [0.3 * sb, 'down', 4.6], [oppDeep ? 0.45 : 0.25, 'down', 1.4]]);
    }
    if (y >= 1.3) {
      if (dn < 2.3) return pick([[0.7, 'down', 1.1], [0.3, 'up', 5.6]]);
      return pick([[0.4, 'side', 5.2], [oppFront ? 0.5 : 0.3, 'up', 5.6], [oppDeep ? 0.35 : 0.2, 'down', 1.5]]);
    }
    if (dn < 2.5) return pick([[oppDeep ? 0.65 : 0.45, 'down', 1.1], [oppFront ? 0.65 : 0.45, 'up', 5.6]]);
    return pick([[0.65, 'up', 5.6], [0.35, 'side', 5.0]]);
  }
}
