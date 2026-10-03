import { chargeFromTime, COURT, GAME, PHYS, timeForCharge, type Difficulty } from '../config';
import { idealContactFor, idleInput, runTime, type Match, type PlayerId, type PlayerInput } from '../sim/match';
import type { Prediction } from '../sim/physics';
import { chargeForDepth, depthFromCharge, reboundCharge, type Family, type Flick, type ServeKind } from '../sim/shots';
import { ballTaker, formationSpot, isLift } from './doubles';

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
  diveRate: number; // 跑不到的低球改用魚躍撲救的比例
  aimWide: number; // 打空檔時往邊線瞄多寬（1 = 標準；超難、地獄更貼邊線）
  flickServe: number; // 發球時彈發的權重（相對發小球 = 1；接發球員站很前面時加倍）
  driveServe: number; // 雙打平抽發球的權重（單打再打折）
  rushRate: number; // 接發球：對方小球發得飄（網前、比網高）就搶攻的機率
}

/**
 * 各難度的 AI 參數（測試腳本會讀／覆寫，所以 export）。
 * 超難、地獄：反應更快、落點與出拍時機更準、出界球幾乎不碰、更常打空檔、多殺多撲多跳殺、跑不到就撲；
 * speedMul > 1 = 跑速／起步比同一位球員快一點（搖桿推滿也追不上的那一點點）
 * 發球：簡單／普通幾乎只發小球與高遠球；困難以上會混彈發（接發球員站前面時更多）、雙打混平抽發，也會搶攻飄高的小球
 */
export const DIFFICULTY_PARAMS: Record<Difficulty, AIParams> = {
  easy: { reaction: 0.38, speedMul: 0.78, depthNoise: 0.9, timingJitter: 0.05, outJudge: 0.5, smartAim: 0.35, smashBias: 0.6, killRate: 0.25, jumpRate: 0, diveRate: 0.2, aimWide: 1, flickServe: 0, driveServe: 0, rushRate: 0 },
  normal: { reaction: 0.25, speedMul: 0.9, depthNoise: 0.5, timingJitter: 0.04, outJudge: 0.8, smartAim: 0.7, smashBias: 1, killRate: 0.4, jumpRate: 0.15, diveRate: 0.6, aimWide: 1, flickServe: 0.04, driveServe: 0.03, rushRate: 0.1 },
  hard: { reaction: 0.15, speedMul: 1.0, depthNoise: 0.3, timingJitter: 0.025, outJudge: 0.95, smartAim: 0.9, smashBias: 1.2, killRate: 0.55, jumpRate: 0.35, diveRate: 0.9, aimWide: 1, flickServe: 0.12, driveServe: 0.12, rushRate: 0.55 },
  extreme: { reaction: 0.1, speedMul: 1.02, depthNoise: 0.2, timingJitter: 0.015, outJudge: 0.98, smartAim: 0.95, smashBias: 1.35, killRate: 0.65, jumpRate: 0.45, diveRate: 0.95, aimWide: 1.06, flickServe: 0.18, driveServe: 0.18, rushRate: 0.75 },
  hell: { reaction: 0.055, speedMul: 1.05, depthNoise: 0.12, timingJitter: 0.008, outJudge: 0.995, smartAim: 0.98, smashBias: 1.5, killRate: 0.75, jumpRate: 0.55, diveRate: 1, aimWide: 1.12, flickServe: 0.22, driveServe: 0.22, rushRate: 0.9 },
};
const PARAMS = DIFFICULTY_PARAMS;

/** 難度由低到高（aiLevel 的 0..4） */
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'extreme', 'hell'];


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

/** 難度連續值：0 = 簡單、1 = 普通、2 = 困難、3 = 超難、4 = 地獄（中間線性內插），巡迴賽用 */
export function aiLevel(t: number): AIParams {
  const top = DIFFICULTIES.length - 1;
  const c = Math.max(0, Math.min(top, t));
  const i = Math.min(top - 1, Math.floor(c));
  const u = c - i;
  const a = PARAMS[DIFFICULTIES[i]];
  const b = PARAMS[DIFFICULTIES[i + 1]];
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
  dive: { at: number; x: number; z: number } | null; // 跑不到 → 這個時間往 (x,z) 魚躍
}

export class AIController {
  private p: AIParams;
  private plan: Plan | null = null;
  private seenHits = -1;
  private seenServeT = -1;
  private reactAt = 0; // 對方這一拍之後，什麼時候開始動（雙打補位也照反應時間）
  private serveDelay = 1;
  private serveChoice: { chargeAt: number; flickAt: number; flick: Flick } | null = null;
  /** 會不會魚躍（自動跑位時看設定「自動魚躍」） */
  allowDive = true;
  /** 自動跑位用：反應時間（null = 照難度）。預判模式平常慢一點、讀對了立刻起步；輔助模式 = 0（玩家自己起步） */
  reactionOverride: number | null = null;

  /**
   * moveOnly = 簡單模式的自動跑位：只輸出移動，蓄力／出拍交給玩家
   */
  constructor(
    private match: Match,
    private id: PlayerId,
    difficulty: Difficulty | number,
    private moveOnly = false,
    private style: AIStyle = STYLES.allround,
  ) {
    this.p = typeof difficulty === 'number' ? aiLevel(difficulty) : PARAMS[difficulty];
    // speedMul > 1（地獄）：搖桿推滿也只有 1，所以直接把這位 AI 的跑速／起步加成（只有這位，自動跑位不會）
    const boost = Math.max(1, this.p.speedMul);
    if (boost > 1 && !moveOnly) {
      const k = this.me.kit;
      this.me.kit = { ...k, move: k.move * boost, accel: k.accel * boost };
    }
  }

  /** 搖桿推多少（speedMul ≤ 1 = 跑慢一點；> 1 的部分已經加在 kit 上） */
  private get stickMul(): number {
    return Math.min(1, this.p.speedMul);
  }

  private get reaction(): number {
    return this.reactionOverride ?? this.p.reaction;
  }

  /** 自動跑位：這一球要跑去哪裡（還沒有計畫 = null） */
  planTarget(): { x: number; z: number } | null {
    const pl = this.plan;
    if (!pl || pl.leave || pl.done) return null;
    return pl.dive ? { x: pl.dive.x, z: pl.dive.z } : { x: pl.standX, z: pl.standZ };
  }

  /** 預判讀對：現在就起步 */
  startNow(): void {
    const now = this.match.time;
    this.reactAt = Math.min(this.reactAt, now);
    if (this.plan) this.plan.reactAt = Math.min(this.plan.reactAt, now);
  }

  /** 預判猜錯：晚一點才起步 */
  delay(dt: number): void {
    this.reactAt += dt;
    if (this.plan) this.plan.reactAt += dt;
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
      if (!this.allowDive) inp.dive = null;
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
    // 對方（單打：對手；雙打：對方兩人之一）剛打過來
    const theirs = sh.lastHitter !== null && m.teamOf(sh.lastHitter) !== this.me.team;
    if (theirs && m.hitSerial !== this.seenHits) {
      this.seenHits = m.hitSerial;
      this.reactAt = m.time + this.reaction;
      // 雙打：只有分到這一球的人去接，另一人照陣型補位
      this.plan = this.takesBall() ? this.makePlan() : null;
    }

    const plan = !theirs || !this.plan || this.plan.leave || this.plan.done ? null : this.plan;
    if (!plan) {
      const h = this.home();
      this.moveTo(inp, h.x, h.z, m.doubles && m.time < this.reactAt ? 0.4 : 0.6);
      return inp;
    }

    const now = m.time;
    if (plan.dive) {
      // 跑不到的球：先往落點衝，時間到就撲出去（撲的過程會自動挑回）
      this.moveTo(inp, plan.dive.x, plan.dive.z, now >= plan.reactAt ? 1 : 0.4);
      if (now >= plan.dive.at && this.allowDive) {
        const me = this.me;
        const dx = plan.dive.x - me.pos.x;
        const dz = plan.dive.z - me.pos.z;
        inp.dive = { x: dx * me.side, y: -dz * me.side };
        plan.done = true;
      }
      return inp;
    }
    if (now >= plan.reactAt) this.moveTo(inp, plan.standX, plan.standZ, 1);
    else {
      const h = this.home();
      this.moveTo(inp, h.x, h.z, 0.4);
    }

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

  /** 沒球要接時站的位置：單打 = 中場；雙打 = 陣型位置 */
  private home(): { x: number; z: number } {
    return this.match.doubles ? formationSpot(this.match, this.id) : { x: 0, z: this.me.side * 3.6 };
  }

  /** 測試用：改寫「這球我接不接」（assigned = 分工的結果；4 人線上測試用來故意讓兩個隊友都去搶） */
  takeHook: ((assigned: boolean) => boolean) | null = null;

  /** 這一球是不是我接（單打一定是；雙打看分工） */
  private takesBall(): boolean {
    if (!this.match.doubles) return true;
    const assigned = ballTaker(this.match, this.me.team)?.id === this.id;
    return this.takeHook ? this.takeHook(assigned) : assigned;
  }

  /**
   * 發球：選種類與落點（像點擊滑放一樣直接指定，深度誤差照難度），照發球節奏在球落到最低點時出拍
   * （時機誤差照難度；發球節奏慢，誤差放大一點），出拍前先按住一下（腳下光圈會亮，跟真人一樣）
   */
  private serveInput(inp: PlayerInput): PlayerInput {
    const m = this.match;
    if (m.server !== this.id) return inp;
    if (m.phaseT < this.seenServeT || this.seenServeT < 0) {
      this.serveDelay = 0.3 + m.rng.next() * 0.9;
      this.serveChoice = null;
    }
    this.seenServeT = m.phaseT;
    if (!this.serveChoice) {
      const rng = m.rng;
      const P = GAME.serve.beat;
      const kind = this.pickServe();
      const { depth, aimX } = this.serveTarget(kind);
      const noisy = depth + rng.gauss() * this.p.depthNoise * this.style.steady * 0.4;
      // serveDelay 之後的第一個最低點（P/2、3P/2、…）
      const flickAt = P / 2 + Math.ceil(Math.max(0, this.serveDelay - P / 2) / P) * P + rng.gauss() * this.p.timingJitter * 1.5;
      const dir = kind === 'drive' ? { x: Math.sign(aimX || 1), y: 0.05 } : this.flickFor(kind === 'short' ? 'down' : 'up', aimX);
      this.serveChoice = {
        chargeAt: flickAt - 0.3 - rng.next() * 0.3,
        flickAt,
        flick: { ...dir, cmd: { family: kind === 'short' ? 'down' : kind === 'drive' ? 'side' : 'up', depth: noisy, serve: kind } },
      };
    }
    const c = this.serveChoice;
    if (m.phaseT >= c.chargeAt) inp.charging = true;
    if (m.phaseT >= c.flickAt) {
      inp.charging = false;
      inp.flick = c.flick;
    }
    return inp;
  }

  /** 發球種類：雙打多發小球；困難以上混彈發（接發球員站很前面時加倍）、雙打混平抽發；打法個性：進攻型／平抽快攻更愛彈發、平抽發 */
  private pickServe(): ServeKind {
    const m = this.match;
    const p = this.p;
    const st = this.style;
    const r = m.players[m.receiver];
    const creeping = Math.abs(r.pos.z) < COURT.shortService + 0.75;
    const flickMul = ((st.smash + st.drive) / 2) * (creeping ? 2 : 1);
    const opts: [number, ServeKind][] = m.doubles
      ? [[1, 'short'], [0.1, 'high'], [p.flickServe * flickMul, 'flick'], [p.driveServe * st.drive, 'drive']]
      : [[0.55, 'short'], [0.45, 'high'], [p.flickServe * 0.8 * flickMul, 'flick'], [p.driveServe * 0.35 * st.drive, 'drive']];
    const total = opts.reduce((s, [w]) => s + w, 0);
    let x = m.rng.next() * total;
    for (const [w, k] of opts) {
      x -= w;
      if (x <= 0) return k;
    }
    return 'short';
  }

  /** 發球落點：深度（公尺）與左右（aimX，自己視角；往中線 = T 點、往邊線 = 開角） */
  private serveTarget(kind: ServeKind): { depth: number; aimX: number } {
    const m = this.match;
    const rng = m.rng;
    const S = GAME.serve;
    const me = this.me;
    const back = m.serveLongLine;
    const r = m.players[m.receiver];
    const boxSign = m.shuttle.serveBoxSign;
    // 世界座標 x → aimX（跟 shots.ts resolveServe 的對應相反）
    const span = m.halfWidth / 2 - S.aimMargin;
    const aimForX = (xw: number) => Math.max(-1, Math.min(1, (xw - boxSign * (m.halfWidth / 2)) / (me.side * span)));
    const toT = -boxSign * me.side; // 往中線（T 點）的 aimX 方向
    const backhand = -r.side * 0.9; // 右手持拍的接發球員：反手在他的左邊（世界座標）
    if (kind === 'short') {
      // 雙打標準是 T 點；偶爾開角把人拉開
      const u = rng.next();
      const tRate = m.doubles ? 0.6 : 0.4;
      const aimX = u < tRate ? toT * rng.range(0.75, 1) : u < tRate + 0.2 ? -toT * rng.range(0.7, 1) : rng.range(-0.4, 0.4);
      return { depth: COURT.shortService + S.short, aimX };
    }
    if (kind === 'high') return { depth: back - (m.doubles ? S.highGap.doubles : S.highGap.singles), aimX: rng.chance(0.5) ? aimForX(r.pos.x + backhand) : rng.range(-0.6, 0.6) };
    if (kind === 'flick') return { depth: back - (m.doubles ? S.flickGap.doubles : S.flickGap.singles), aimX: rng.chance(0.65) ? aimForX(r.pos.x + backhand) : rng.range(-0.5, 0.5) };
    // 平抽發：身體或反手（aimX 在 resolveServe 是相對接發球員身體的偏移）
    return { depth: Math.max(COURT.shortService + 1.2, Math.min(back - 0.35, Math.abs(r.pos.z) + S.driveBehind)), aimX: rng.chance(0.6) ? (backhand * 0.6) / (me.side * 0.7) : rng.range(-0.15, 0.15) };
  }

  private chargeFor(depth: number, noiseMul = 1): number {
    const c = chargeForDepth(depth + this.match.rng.gauss() * this.p.depthNoise * this.style.steady * noiseMul);
    return Math.max(0.02, Math.min(1, c));
  }

  private flickFor(family: Family, aimX: number): Flick {
    if (family === 'side') return { x: Math.sign(aimX || 1), y: 0.05 };
      const lim = 0.7 * this.p.aimWide; // 超難／地獄瞄得更貼邊線
    const nx = Math.max(-lim, Math.min(lim, aimX / 1.15));
    const ny = Math.sqrt(1 - nx * nx);
    return { x: nx, y: family === 'up' ? ny : -ny };
  }

  private moveTo(inp: PlayerInput, x: number, z: number, urgency: number): void {
    const me = this.me;
    const dx = x - me.pos.x;
    const dz = z - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    const s = Math.min(1, d / 0.35) * this.stickMul * urgency;
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
    const leavePlan = (): Plan => ({ reactAt: now, standX: 0, standZ: me.side * 3.6, contactAt: 0, chargeAt: 1e9, flickAt: 1e9, charge: 0, flick: { x: 0, y: 1 }, leave: true, jump: false, feint: false, done: false, dive: null });
    if (!pred || pred.hitsNet) return leavePlan();

    // 出界球判斷
    if (pred.landing) {
      const L = pred.landing;
      const marginX = m.halfWidth - Math.abs(L.x);
      const marginZ = COURT.halfLength - Math.abs(L.z);
      let margin = Math.min(marginX, marginZ);
      if (sh.isServe) margin = Math.min(margin, Math.abs(L.z) - COURT.shortService, L.x * sh.serveBoxSign, m.serveLongLine - Math.abs(L.z));
      if (margin < -0.05 && rng.chance(p.outJudge)) return leavePlan();
      if (margin >= 0 && margin < 0.3 && rng.chance((1 - p.outJudge) * 0.4)) return leavePlan();
    }

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
      const avail = tAbs - now - this.reaction;
      const cand = { score: 0, i, tAbs, sx, sz };
      fallback = cand;
      // 跑過去要多久：起步加速、往後退比較慢（跟 Match 的移動一樣）
      if (runTime(me, sx - me.pos.x, sz - me.pos.z) / this.stickMul > avail && travel > 0.4) continue;
      let score = -0.15 * (tAbs - now);
      if (pt.y >= GAME.highZoneY) score += 1 * p.smashBias;
      if (pt.y < 0.5) score -= 0.6;
      cand.score = score;
      if (!best || score > best.score) best = cand;
    }
    if (!best) {
      const dive = this.divePlan(pred, now);
      if (dive) return dive;
    }
    const pick = best ?? fallback;
    if (!pick) return leavePlan();

    const pt = pred.points[pick.i].p;
    const dn = Math.abs(pt.z);
    const contactAt = pick.tAbs;
    const flickAt = contactAt - idealContactFor(pt.y - this.me.pos.y) + rng.gauss() * p.timingJitter;
    // 來不及蓄滿就改打需要較少力道的球（放網／擋網前）；快球有反彈力可借
    const pts = pred.points;
    const j = Math.min(pick.i + 1, pts.length - 1);
    // 預測點的時間是 tick 時間；換回物理速度要除以球速倍率
    const speedMul = pred.stepDt / PHYS.dt;
    const inSpeed = j > pick.i ? Math.hypot(pts[j].p.x - pt.x, pts[j].p.y - pt.y, pts[j].p.z - pt.z) / (pts[j].t - pts[pick.i].t) / speedMul : 0;
    const maxCharge = Math.max(chargeFromTime(flickAt - (now + this.reaction)), reboundCharge(inSpeed));
    let shot = this.chooseShot(pt.y, dn);
    // 搶攻：對方的小球發得飄（還在網前、高過網帶）→ 困難以上直接撲下去
    const nearNetHigh = dn < GAME.netKill.zone - 0.1 && pt.y >= COURT.netTop + 0.15;
    const rush = nearNetHigh && sh.isServe && rng.chance(p.rushRate);
    if (rush) shot = { family: 'down', depth: GAME.netKill.depth, aimX: shot.aimX };
    // 雙打網前撲球：前場兩人距離近、來不及蓄力，跟玩家一樣用「網前平球 = 撲球」（不用蓄力）
    const netKill =
      nearNetHigh && (rush || (m.doubles && shot.family === 'down' && shot.depth >= 2.6))
        ? { x: Math.max(-0.7, Math.min(0.7, shot.aimX / 1.15)), y: 0.7, cmd: { family: 'side' as const, depth: GAME.netKill.depth } }
        : null;
    // 雙打抓球：中前場平飛過來、高度到網子以上的球 → 搶下來往下壓（跟玩家「點一下」一樣，擊中時才轉成抓球）
    const intercept =
      !netKill && m.doubles && !isLift(m) && dn >= GAME.netKill.zone - 0.1 && dn < GAME.intercept.zone && pt.y >= COURT.netTop - 0.05 && rng.chance(Math.min(0.95, p.killRate + 0.3))
        ? { x: rng.range(-0.2, 0.2), y: 1, cmd: { family: 'side' as const, depth: 5.0 } }
        : null;
    let flick: Flick;
    let charge: number;
    if (netKill) {
      flick = netKill;
      charge = 0;
    } else if (intercept) {
      flick = intercept;
      charge = 0;
    } else if (m.doubles) {
      // 雙打：跟預設的點擊滑放一樣直接指定球種與深度（不用蓄力；前場兩人距離近，蓄力常來不及），落點誤差照難度
      // 小球（< 2.6 m）誤差減半、不會短到直接掛網（玩家點擊滑放的小球深度也是固定的，只吃擊球品質）
      const short = shot.depth < 2.6;
      let depth = shot.depth + rng.gauss() * p.depthNoise * this.style.steady * (short ? 0.5 : 1);
      if (short) depth = Math.max(0.75, depth);
      flick = { ...this.flickFor(shot.family, shot.aimX), cmd: { family: shot.family, depth } };
      charge = 0;
    } else {
      if (chargeForDepth(shot.depth) > maxCharge) {
        const depth = Math.max(0.9, depthFromCharge(maxCharge) - 0.3);
        shot = { family: 'down', depth, aimX: shot.aimX };
      }
      charge = this.chargeFor(shot.depth);
      flick = this.flickFor(shot.family, shot.aimX);
    }
    const jump = !netKill && shot.family === 'down' && shot.depth >= 2.6 && pt.y >= 2.1 && rng.chance(p.jumpRate + this.style.jump);
    return {
      reactAt: now + this.reaction,
      standX: pick.sx,
      standZ: pick.sz,
      contactAt,
      // 不用蓄力的跳殺也要先按住一陣子（連按兩下待命）才會自動起跳
      chargeAt: flickAt - (charge === 0 && jump ? 0.45 : timeForCharge(charge)),
      flickAt,
      charge,
      flick,
      leave: false,
      jump,
      feint: rng.chance(this.style.feint) && flickAt - timeForCharge(charge) - 0.55 > now + this.reaction,
      done: false,
      dive: null,
    };
  }

  /** 跑不到的球：看撲出去搆不搆得到（低於 dive.maxY 的點），可以就排一次魚躍 */
  private divePlan(pred: Prediction, now: number): Plan | null {
    const me = this.me;
    const p = this.p;
    const D = GAME.dive;
    if (!this.match.rng.chance(this.moveOnly ? 1 : p.diveRate)) return null;
    const speed = GAME.moveSpeed * this.stickMul * me.kit.move;
    const reach = GAME.reach * me.reachMul;
    // 用跑的其實搆得到就不撲；但快球（殺球）硬伸手接球質很差，要能「舒服地」接到才不撲
    const sh = this.match.shuttle;
    const fastIn = (Math.hypot(sh.vel.x, sh.vel.y, sh.vel.z) * pred.stepDt) / PHYS.dt > 25;
    const okDist = fastIn ? GAME.stretch.comfy + 0.15 : reach * 0.9;
    for (const q of pred.points) {
      const pt = q.p;
      if (pt.z * me.side < 0.05 || pt.y < 0.1 || pt.y > GAME.reachMaxY) continue;
      const run = speed * Math.max(0, q.t - this.reaction - 0.15);
      if (Math.hypot(pt.x - me.pos.x, pt.z - me.pos.z) <= run + okDist) return null;
    }
    for (let i = 0; i < pred.points.length; i += 2) {
      const q = pred.points[i];
      const pt = q.p;
      if (pt.z * me.side < 0.15 || pt.y < 0.08 || pt.y > D.maxY - 0.1) continue;
      const avail = q.t - this.reaction;
      if (avail < D.dur * 0.6) continue;
      const run = speed * Math.max(0, avail - D.dur - 0.12);
      const dist = Math.hypot(pt.x - me.pos.x, pt.z - me.pos.z);
      if (dist > run + D.dist * 0.85 + D.reachBonus + reach * 0.8) continue;
      const contactAt = now + q.t;
      return {
        reactAt: now + this.reaction,
        standX: pt.x,
        standZ: pt.z,
        contactAt,
        chargeAt: 1e9,
        flickAt: 1e9,
        charge: 0,
        flick: { x: 0, y: 1 },
        leave: false,
        jump: false,
        feint: false,
        done: false,
        dive: { at: contactAt - D.dur * 0.75, x: pt.x, z: pt.z },
      };
    }
    return null;
  }

  /**
   * 雙打落點（自己視角的 aimX）：看兩位對手的左右位置，找最大的空檔——
   * 兩人中間（容易互相讓）或邊線那一側；判斷不準時就隨便打
   */
  private doublesAim(opps: { pos: { x: number } }[]): number {
    const rng = this.match.rng;
    if (!rng.chance(this.p.smartAim)) return rng.range(-0.8, 0.8);
    const side = this.me.side;
    const xs = opps.map((o) => o.pos.x * side).sort((a, b) => a - b);
    const W = 2.1; // AI 瞄得到的最外側（再外面容易出界）
    const gaps: [number, number][] = [
      [-W, xs[0]],
      [xs[0], xs[1]],
      [xs[1], W],
    ];
    let bestC = 0;
    let bestW = -Infinity;
    gaps.forEach(([a, b], i) => {
      const w = b - a + (i === 1 ? 0.5 : 0); // 中間的空檔多加一點：兩人容易互相讓
      if (w > bestW) {
        bestW = w;
        bestC = (a + b) / 2;
      }
    });
    const tx = Math.max(-W, Math.min(W, bestC + rng.gauss() * 0.25));
    return tx / 2.3;
  }

  private chooseShot(y: number, dn: number): ShotChoice {
    const m = this.match;
    const rng = m.rng;
    const me = this.me;
    let oppDeep: boolean;
    let oppFront: boolean;
    let aimX: number;
    if (m.doubles) {
      // 雙打：兩位對手都在後面才放短、兩位都在前面才挑後場；落點打兩人中間或空檔
      const opps = m.players.filter((o) => o.team !== me.team);
      oppDeep = Math.min(...opps.map((o) => Math.abs(o.pos.z))) > 4.2;
      oppFront = Math.max(...opps.map((o) => Math.abs(o.pos.z))) < 3.2;
      aimX = this.doublesAim(opps);
    } else {
      const opp = m.players[this.id === 0 ? 1 : 0];
      oppDeep = Math.abs(opp.pos.z) > 4.6;
      oppFront = Math.abs(opp.pos.z) < 3.0;
      // 打對手空檔：對手在我視角的左右
      const oppAim = (opp.pos.x * me.side) / 2.3;
      aimX = rng.chance(this.p.smartAim) ? -Math.sign(oppAim || rng.next() - 0.5) * rng.range(0.45, 0.85) * this.p.aimWide : rng.range(-0.8, 0.8);
    }

    // 權重再乘上「打法個性」和「自己哪種球比較快」（會多打自己的強項）
    const st = this.style;
    const ks = me.kit.speed;
    // 雙打打法更積極：多殺、多平抽，中高點少挑高（挑高就換對方殺）；網前低點的貼網小球還是要挑
    const dbl = m.doubles ? { side: 1.3, up: y < 1.3 ? 1 : 0.6, smash: 1.6, drop: 1 } : null;
    const bias = (family: Family, depth: number) => {
      if (family === 'side') return st.drive * ks.push ** 4 * (dbl?.side ?? 1);
      if (family === 'up') return st.clear * ks.clear ** 4 * (dbl?.up ?? 1);
      return depth >= 2.6 ? st.smash * ks.smash ** 4 * (dbl?.smash ?? 1) : st.drop * ks.drop ** 4 * (dbl?.drop ?? 1);
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

    const sb = this.p.smashBias * (1 + 1.2 * m.shuttle.attack); // 不到位的高球、機會球就殺
    // 網前（不論高度）只要球明顯高過網：撲殺（已限速）或放網
    if (dn < 2.3 && y >= COURT.netTop + 0.3) {
      const kill = this.p.killRate;
      return pick([[kill, 'down', 3.2], [1 - kill, 'down', 1.1], [oppFront ? 0.3 : 0.1, 'up', 5.6]]);
    }
    if (m.doubles && dn < 2.3) {
      // 雙打網前：球高過網帶就撲（前場兩人近，不撲會一直來回放網）；網帶以下放網、推後場空檔或挑
      if (y >= COURT.netTop + 0.1) {
        const kill = Math.min(0.85, this.p.killRate * 1.5);
        return pick([[kill, 'down', 3.2], [1 - kill, 'down', 1.1], [oppFront ? 0.3 : 0.1, 'up', 5.6]]);
      }
      if (y >= 1.0) return pick([[0.5, 'down', 1.1], [0.35, 'down', 4.6], [oppFront ? 0.4 : 0.25, 'up', 5.6]]);
    }
    if (y >= GAME.highZoneY) {
      if (dn < 4.5) return pick([[0.6 * sb, 'down', 4.3], [oppDeep ? 0.35 : 0.2, 'down', 1.3], [oppFront ? 0.3 : 0.12, 'up', 5.8]]);
      return pick([[oppFront ? 0.55 : 0.4, 'up', 5.8], [0.3 * sb, 'down', 4.6], [oppDeep ? 0.45 : 0.25, 'down', 1.4]]);
    }
    if (y >= 1.3) {
      if (dn < 2.3) return pick([[0.7, 'down', 1.1], [0.3, 'up', 5.6]]);
      return pick([[0.4, 'side', 5.2], [oppFront ? 0.5 : 0.3, 'up', 5.6], [oppDeep ? 0.35 : 0.2, 'down', 1.5]]);
    }
    // 雙打：中後場的低球多一個「擋網前」（防守時把殺球擋到對方前場）
    if (m.doubles && dn >= 2.5) return pick([[0.65, 'up', 5.6], [0.35, 'side', 5.0], [oppDeep ? 0.45 : 0.25, 'down', 1.4]]);
    if (dn < 2.5) return pick([[oppDeep ? 0.65 : 0.45, 'down', 1.1], [oppFront ? 0.65 : 0.45, 'up', 5.6]]);
    return pick([[0.65, 'up', 5.6], [0.35, 'side', 5.0]]);
  }
}
