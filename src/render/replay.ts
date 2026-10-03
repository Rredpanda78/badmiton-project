import { GAME, PHYS } from '../config';
import { Match, type MatchEvent, type Phase, type PlayerId, type PlayerState, type ShuttleMode, type ShuttleState, type Swing } from '../sim/match';
import { v3, type Prediction, type Vec3 } from '../sim/physics';
import { Rng } from '../sim/rng';

/**
 * 得分回放（精彩回放）：主動得分（羽球落在對方場內，不是掛網、出界、發球失誤）時，
 * 從致勝那一拍前一點開始重播到落地，大約 3 秒（真實時間）：
 * 擊球瞬間慢動作、鏡頭從擊球員身後低角度跟著羽球出去，再切到落點旁邊的低角度特寫。
 *
 * - ReplayRecorder：比賽每個 tick 把畫面需要的狀態（球員、羽球）＋這個 tick 的事件存進環形緩衝區（約 5 模擬秒）
 * - ReplayPlayer：照錄下來的資料，把狀態寫進另一個「檢視用」的 Match（view），畫面（GameRenderer）讀 view 來畫，
 *   真正的比賽完全不碰（回放期間比賽暫停、不推進），所以回放前後的模擬一模一樣
 *
 * 這個檔案不用 three.js（無畫面測試 scripts/replay-test.ts 也能跑）：鏡頭只算出位置、看的點、視角，交給 scene.ts 擺。
 */

type HitEvent = Extract<MatchEvent, { type: 'hit' }>;
type LandEvent = Extract<MatchEvent, { type: 'land' }>;

const TPS = Math.round(1 / PHYS.dt); // 每模擬秒幾個 tick（120）
const RING = TPS * 5; // 環形緩衝區：5 模擬秒（最長的高遠球飛行約 2 秒，加上前後還很夠）
const NONE: MatchEvent[] = [];

/** 每個 tick 存的球員狀態（只存畫面用得到的欄位） */
interface PSnap {
  pos: Vec3;
  vel: Vec3;
  vy: number;
  airborne: boolean;
  takeoffAt: number;
  jumpArmed: boolean;
  charging: boolean;
  charge: number;
  swing: Swing | null; // 複本：揮拍中的欄位每 tick 都在變
  swingKey: number; // 同一次揮拍的編號（動畫用「是不是同一個物件」判斷新的一拍，回放時同一拍要用同一個物件）
  dive: { t: number; dx: number; dz: number; v0: number } | null;
  downT: number;
  landRecover: number;
  recover: number;
  court: 1 | -1;
  reachMul: number;
}

/** 每個 tick 存的羽球狀態 */
interface SSnap {
  pos: Vec3;
  vel: Vec3;
  mode: ShuttleMode;
  lastHitter: PlayerId | null;
  isServe: boolean;
  serveBoxSign: number;
  prediction: Prediction | null; // 擊出時算好、之後不會再改 → 直接存參考
  stepDt: number;
  launchTime: number;
  wobble: boolean;
  attack: number;
  pace: number;
}

interface Frame {
  tick: number; // 這場比賽的第幾個 tick（從開始錄算起）
  time: number;
  phase: Phase;
  phaseT: number;
  server: PlayerId;
  hitSerial: number;
  rallyHits: number;
  sh: SSnap;
  ps: PSnap[];
  events: MatchEvent[]; // 這個 tick 的事件（擊球聲、殺球特效、落地揚塵要跟著重播）
}

const newPSnap = (): PSnap => ({
  pos: v3(),
  vel: v3(),
  vy: 0,
  airborne: false,
  takeoffAt: 0,
  jumpArmed: false,
  charging: false,
  charge: 0,
  swing: null,
  swingKey: 0,
  dive: null,
  downT: 0,
  landRecover: 0,
  recover: 0,
  court: 1,
  reachMul: 1,
});

const newFrame = (players: number): Frame => ({
  tick: -1,
  time: 0,
  phase: 'serve',
  phaseT: 0,
  server: 0,
  hitSerial: 0,
  rallyHits: 0,
  sh: { pos: v3(), vel: v3(), mode: 'held', lastHitter: null, isServe: false, serveBoxSign: 1, prediction: null, stepDt: PHYS.dt, launchTime: 0, wobble: false, attack: 0, pace: 0 },
  ps: Array.from({ length: players }, newPSnap),
  events: NONE,
});

const set3 = (o: Vec3, a: Vec3) => {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
};

/** 回放播放時用的複本（緩衝區的格子之後會被覆蓋） */
function cloneFrame(f: Frame): Frame {
  return {
    ...f,
    sh: { ...f.sh, pos: { ...f.sh.pos }, vel: { ...f.sh.vel } },
    ps: f.ps.map((p) => ({ ...p, pos: { ...p.pos }, vel: { ...p.vel }, swing: p.swing && { ...p.swing }, dive: p.dive && { ...p.dive } })),
  };
}

/** 比賽中每個 tick 錄下畫面需要的狀態（只讀比賽，不改任何東西） */
export class ReplayRecorder {
  private ring: Frame[] = [];
  private n = 0; // 這場累計錄了幾個 tick
  private match: Match | null = null;
  private keys = new WeakMap<Swing, number>();
  private nextKey = 1;
  /** 最近一次擊球、落地（得分時用來找致勝的那一拍） */
  lastHit: { tick: number; e: HitEvent } | null = null;
  lastLand: { tick: number; e: LandEvent } | null = null;

  /** 每個 tick（match.step 並取出事件之後）呼叫一次 */
  record(m: Match, events: MatchEvent[]): void {
    if (m !== this.match) this.reset(m);
    const idx = this.n % RING;
    let f = this.ring[idx];
    if (!f || f.ps.length !== m.players.length) f = this.ring[idx] = newFrame(m.players.length);
    f.tick = this.n;
    f.time = m.time;
    f.phase = m.phase;
    f.phaseT = m.phaseT;
    f.server = m.server;
    f.hitSerial = m.hitSerial;
    f.rallyHits = m.rallyHits;
    const s = m.shuttle;
    const fs = f.sh;
    set3(fs.pos, s.pos);
    set3(fs.vel, s.vel);
    fs.mode = s.mode;
    fs.lastHitter = s.lastHitter;
    fs.isServe = s.isServe;
    fs.serveBoxSign = s.serveBoxSign;
    fs.prediction = s.prediction;
    fs.stepDt = s.stepDt;
    fs.launchTime = s.launchTime;
    fs.wobble = s.wobble;
    fs.attack = s.attack;
    fs.pace = s.pace;
    for (let i = 0; i < m.players.length; i++) {
      const p = m.players[i];
      const q = f.ps[i];
      set3(q.pos, p.pos);
      set3(q.vel, p.vel);
      q.vy = p.vy;
      q.airborne = p.airborne;
      q.takeoffAt = p.takeoffAt;
      q.jumpArmed = p.jumpArmed;
      q.charging = p.charging;
      q.charge = p.charge;
      q.swing = p.swing ? { ...p.swing } : null;
      q.swingKey = p.swing ? this.keyOf(p.swing) : 0;
      q.dive = p.dive ? { ...p.dive } : null;
      q.downT = p.downT;
      q.landRecover = p.landRecover;
      q.recover = p.recover;
      q.court = p.court;
      q.reachMul = p.reachMul;
    }
    f.events = events.length ? events : NONE;
    for (const e of events) {
      if (e.type === 'hit') this.lastHit = { tick: this.n, e };
      else if (e.type === 'land') this.lastLand = { tick: this.n, e };
    }
    this.n++;
  }

  /** 換一場比賽（或不用了）：清空 */
  reset(m: Match | null = null): void {
    this.match = m;
    this.n = 0;
    this.lastHit = null;
    this.lastLand = null;
  }

  /** 最新一格的 tick（還沒錄 = -1） */
  get lastTick(): number {
    return this.n - 1;
  }

  /** 緩衝區裡最舊的一格 */
  get oldestTick(): number {
    return Math.max(0, this.n - RING);
  }

  /** 錄的是哪一場 */
  get recording(): Match | null {
    return this.match;
  }

  frame(tick: number): Frame | null {
    if (tick < this.oldestTick || tick > this.lastTick) return null;
    return this.ring[tick % RING];
  }

  private keyOf(s: Swing): number {
    let k = this.keys.get(s);
    if (k === undefined) {
      k = this.nextKey++;
      this.keys.set(s, k);
    }
    return k;
  }
}

/** 這一分值不值得回放：羽球落在對方場內（落地得分、發球得分），不是掛網、出界、發球失誤、對方判定 */
export function isWinner(e: MatchEvent): boolean {
  return e.type === 'point' && !e.byRemote && (e.reason === '落地得分' || e.reason === '發球得分');
}

/** 鏡頭：位置、看的點、垂直視角（度） */
export interface CamPose {
  pos: Vec3;
  look: Vec3;
  fov: number;
}

/** 回放時要跟著重播的事件（聲音、特效）；得分、比分、教學／訓練的事件不重播 */
const VISUAL = new Set<MatchEvent['type']>(['hit', 'land', 'net', 'jump', 'jumpLand', 'dive', 'diveLand', 'whiff']);

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
// 鏡頭活動範圍：場地外的樹、竹子、攤位大約從 |x| 4.4～5.6、|z| 9.2～9.8 開始（render/envKit.ts 的 scatter），
// 近側（z>0）場外沒有高的東西；遠側的樹冠很大（離樹幹 3 m 內、1 m 以上都可能有葉子），所以遠側收緊、高的地方再收緊；
// 網子延長線上有主審椅（x≈-4.3）、發球裁判凳（x≈3.75）
const CAM_X = 4.3;
const CAM_Z = 8.8; // 近側
const CAM_ZFAR = 7.2; // 遠側

/** 鏡頭位置限制在不會鑽進場外樹叢、裁判椅的範圍 */
function safeCam(o: Vec3): void {
  const far = o.z < 0;
  o.z = clamp(o.z, -CAM_ZFAR, CAM_Z);
  if (far && o.z < -5.8) o.y = Math.min(o.y, 1.8);
  const xMax = Math.abs(o.z) < 1.2 ? 3.5 : far && o.y > 1.2 ? 3.7 : CAM_X;
  o.x = clamp(o.x, -xMax, xMax);
}
const smooth = (t: number) => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (o: Vec3, a: Vec3, b: Vec3, t: number) => {
  o.x = a.x + (b.x - a.x) * t;
  o.y = a.y + (b.y - a.y) * t;
  o.z = a.z + (b.z - a.z) * t;
  return o;
};
/** o = a + b·k（水平向量 b） */
const add = (o: Vec3, a: Vec3, b: Vec3, k: number) => {
  o.x = a.x + b.x * k;
  o.y = a.y + b.y * k;
  o.z = a.z + b.z * k;
  return o;
};

/** 回放的時間軸（以影格索引為單位）：慢動作、加速的鍵格；speed = 相對正常遊戲速度的倍率 */
type Keys = [number, number][];

export class ReplayPlayer {
  /** 畫面讀的檢視用比賽（跟真正的比賽是不同物件） */
  readonly view: Match;
  readonly shot: HitEvent;
  /** 整段預估長度（真實秒） */
  readonly duration: number;
  /** 鏡頭（每次 update 更新） */
  readonly cam: CamPose = { pos: v3(), look: v3(), fov: 40 };
  /** 畫面寬高比（直向手機的鏡頭拉遠、視角放寬） */
  aspect = 16 / 9;
  done = false;
  elapsed = 0;

  private frames: Frame[];
  private cur = 0; // 播放位置（frames 的索引，可以是小數）
  private fired = 0; // 事件已經觸發到哪一格
  private keys: Keys;
  private readonly c: number; // 致勝擊球那一格
  private readonly L: number; // 落地那一格
  private readonly K: number; // 切到落點特寫的那一格
  private swings = new Map<number, Swing>(); // 回放用的揮拍物件（同一拍同一個物件）
  private dives: { t: number; dx: number; dz: number; v0: number }[];
  // 鏡頭用的固定資料
  private H: Vec3; // 擊球員（擊球那一格）
  private C: Vec3; // 擊球點
  private Lp: Vec3; // 落點
  private d: Vec3; // 球路方向（水平單位向量）
  private r: Vec3; // 擊球員的右手邊（水平，跟 d 垂直）
  private a: Vec3; // 擊球員身後鏡頭的朝向（水平：球路方向往球場長邊拉一點）
  private ra: Vec3; // a 的右手邊
  private sb: number; // 落點特寫在球路的哪一邊（±r）
  private tmp = v3();
  private tmp2 = v3();

  /** 從錄影裡切出這一球；資料不夠（太久以前、沒錄到）回傳 null */
  static create(rec: ReplayRecorder, live: Match, hit: { tick: number; e: HitEvent }, land: { tick: number; e: LandEvent }): ReplayPlayer | null {
    const pre = Math.round(GAME.replay.pre * TPS);
    const post = Math.round(GAME.replay.post * TPS);
    const s = Math.max(hit.tick - pre, rec.oldestTick);
    const e = Math.min(land.tick + post, rec.lastTick);
    if (s > hit.tick || e < land.tick || land.tick <= hit.tick) return null;
    const frames: Frame[] = [];
    for (let t = s; t <= e; t++) {
      const f = rec.frame(t);
      if (!f || f.ps.length !== live.players.length) return null;
      frames.push(cloneFrame(f));
    }
    return new ReplayPlayer(live, frames, hit.tick - s, land.tick - s, hit.e, land.e);
  }

  private constructor(live: Match, frames: Frame[], c: number, L: number, hit: HitEvent, land: LandEvent) {
    this.frames = frames;
    this.c = c;
    this.L = L;
    this.shot = hit;
    this.view = makeView(live);
    this.dives = live.players.map(() => ({ t: 0, dx: 0, dz: 0, v0: 0 }));

    // 切到落點特寫：落地前約 0.45 模擬秒（至少擊球後 0.1 秒、落地前 0.07 秒）
    this.K = Math.max(clamp(L - Math.round(0.45 * TPS), Math.min(c + 12, L - 8), L - 8), Math.min(c + 4, L));

    // 時間軸：飛行段的速度自動調整，讓整段約 target 秒
    const R = GAME.replay;
    let lo = R.flightMin;
    let hi = R.flightMax;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (this.realLength(this.buildKeys(mid)) > R.target) lo = mid;
      else hi = mid;
    }
    this.keys = this.buildKeys(hi);
    this.duration = this.realLength(this.keys);

    // 鏡頭
    const hp = frames[c].ps[hit.player];
    this.H = { ...hp.pos, y: 0 };
    this.C = { ...hit.pos };
    this.Lp = { ...land.pos, y: 0 };
    let dx = this.Lp.x - this.C.x;
    let dz = this.Lp.z - this.C.z;
    const dl = Math.hypot(dx, dz);
    const side = live.players[hit.player].side;
    if (dl < 0.3) {
      dx = 0;
      dz = -side;
    } else {
      dx /= dl;
      dz /= dl;
    }
    this.d = v3(dx, 0, dz);
    this.r = v3(-dz, 0, dx); // 往前打的球：擊球員的右手邊（持拍手那一側）
    // 擊球員身後的鏡頭：大致順著球場長邊往前看（斜線球只稍微偏過去，不然畫面一半是場外）
    const ax = dx;
    const az = dz - side * 1.6;
    const al = Math.hypot(ax, az);
    this.a = v3(ax / al, 0, az / al);
    this.ra = v3(-this.a.z, 0, this.a.x);
    // 落點特寫放在球路的哪一邊：避開輸球那一方離落點最近的人（不要擋到）；差不多時放在場外那一側（像線審的角度）
    const lf = frames[L];
    const loseTeam = live.players[hit.player].team === 0 ? 1 : 0;
    let near: Vec3 | null = null;
    let nd = Infinity;
    live.players.forEach((p, i) => {
      if (p.team !== loseTeam) return;
      const q = lf.ps[i].pos;
      const dd = Math.hypot(q.x - this.Lp.x, q.z - this.Lp.z);
      if (dd < nd) {
        nd = dd;
        near = q;
      }
    });
    const nearP = near as Vec3 | null;
    const dot = nearP && nd < 3 ? (nearP.x - this.Lp.x) * this.r.x + (nearP.z - this.Lp.z) * this.r.z : 0;
    const outward = Math.sign(this.Lp.x * this.r.x) || 1;
    this.sb = Math.abs(dot) > 0.35 ? -Math.sign(dot) : outward;
    // 那一邊空間不夠（場外的樹、牆）就換邊
    if (Math.abs(this.Lp.x + this.r.x * this.sb * 2.2) > CAM_X) this.sb = -this.sb;

    this.apply();
    this.updateCamera();
  }

  /** 播放進度 0..1（真實時間） */
  get progress(): number {
    return clamp(this.elapsed / Math.max(0.1, this.duration), 0, 1);
  }

  /** 致勝擊球後經過的模擬秒（負 = 還沒擊球） */
  get sinceHit(): number {
    return (this.cur - this.c) / TPS;
  }

  /**
   * 往前播 realDt 秒（真實時間）。回傳這段時間經過的事件（擊球、落地……要重播聲音和特效），
   * 以及給動畫用的 dt（真實秒換算：模擬前進量 ÷ simSpeed，慢動作時動畫也跟著變慢）。
   */
  update(realDt: number): { events: MatchEvent[]; animDt: number } {
    if (this.done) return { events: [], animDt: 0 };
    this.elapsed += realDt;
    const start = this.cur;
    const last = this.frames.length - 1;
    // 速度會變，分小步積分
    const n = Math.max(1, Math.ceil(realDt / 0.008));
    const h = realDt / n;
    for (let i = 0; i < n && this.cur < last; i++) this.cur += h * GAME.simSpeed * this.speedAt(this.cur) * TPS;
    if (this.cur >= last) {
      this.cur = last;
      this.done = true;
    }
    const events: MatchEvent[] = [];
    const upto = Math.floor(this.cur);
    while (this.fired < upto) {
      this.fired++;
      for (const e of this.frames[this.fired].events) if (VISUAL.has(e.type)) events.push(e);
    }
    this.apply();
    this.updateCamera();
    return { events, animDt: (this.cur - start) / TPS / GAME.simSpeed };
  }

  // ---------- 時間軸 ----------

  /** 鍵格：擊球前正常速度 → 擊球瞬間慢動作 → 飛行（速度 v）→ 落地前後放慢 */
  private buildKeys(v: number): Keys {
    const { c, L } = this;
    const R = GAME.replay;
    const E = this.frames.length - 1;
    const a = Math.min(c + 7, L);
    const b = Math.min(c + 26, (a + L) / 2);
    const dd = Math.max(b, L - 14);
    const raw: Keys = [
      [0, 0.95],
      [Math.max(0, c - 16), 0.95],
      [Math.max(0, c - 5), R.slow],
      [a, R.slow],
      [b, v],
      [dd, v],
      [L, 0.42],
      [E, 0.42],
    ];
    const keys: Keys = [];
    for (const k of raw) if (!keys.length || k[0] >= keys[keys.length - 1][0]) keys.push(k);
    return keys;
  }

  private speedAt(i: number, keys: Keys = this.keys): number {
    if (i <= keys[0][0]) return keys[0][1];
    for (let k = 1; k < keys.length; k++) {
      const [i1, s1] = keys[k];
      if (i <= i1) {
        const [i0, s0] = keys[k - 1];
        return i1 > i0 ? s0 + (s1 - s0) * smooth((i - i0) / (i1 - i0)) : s1;
      }
    }
    return keys[keys.length - 1][1];
  }

  /** 照這組鍵格播完要幾秒（真實時間） */
  private realLength(keys: Keys): number {
    const last = this.frames.length - 1;
    const step = 0.25;
    let t = 0;
    for (let i = 0; i < last; i += step) t += step / TPS / (GAME.simSpeed * this.speedAt(i + step / 2, keys));
    return t;
  }

  // ---------- 狀態：錄影 → 檢視用比賽（前後兩格內插，慢動作才順） ----------

  private apply(): void {
    const fr = this.frames;
    const i = Math.min(Math.floor(this.cur), fr.length - 1);
    const j = Math.min(i + 1, fr.length - 1);
    const a = fr[i];
    const b = fr[j];
    const t = this.cur - i;
    const v = this.view;
    v.time = lerp(a.time, b.time, t);
    v.phase = a.phase;
    v.phaseT = a.phaseT;
    v.server = a.server;
    v.hitSerial = a.hitSerial;
    v.rallyHits = a.rallyHits;

    const sh = v.shuttle;
    const sa = a.sh;
    const sbn = b.sh;
    // 瞬移（發球前重新擺位）就不要內插
    if (Math.abs(sa.pos.x - sbn.pos.x) + Math.abs(sa.pos.y - sbn.pos.y) + Math.abs(sa.pos.z - sbn.pos.z) < 1.5) lerp3(sh.pos, sa.pos, sbn.pos, t);
    else set3(sh.pos, sa.pos);
    set3(sh.vel, sa.vel);
    sh.mode = sa.mode;
    sh.lastHitter = sa.lastHitter;
    sh.isServe = sa.isServe;
    sh.serveBoxSign = sa.serveBoxSign;
    sh.prediction = sa.prediction;
    sh.stepDt = sa.stepDt;
    sh.launchTime = sa.launchTime;
    sh.wobble = sa.wobble;
    sh.attack = sa.attack;
    sh.pace = sa.pace;

    v.players.forEach((p, k) => {
      const pa = a.ps[k];
      const pb = b.ps[k];
      if (Math.hypot(pa.pos.x - pb.pos.x, pa.pos.z - pb.pos.z) < 0.5) lerp3(p.pos, pa.pos, pb.pos, t);
      else set3(p.pos, pa.pos);
      lerp3(p.vel, pa.vel, pb.vel, t);
      p.vy = pa.vy;
      p.airborne = pa.airborne;
      p.takeoffAt = pa.takeoffAt;
      p.jumpArmed = pa.jumpArmed;
      p.charging = pa.charging;
      p.charge = lerp(pa.charge, pb.charge, t);
      p.downT = lerp(pa.downT, pb.downT, t);
      p.landRecover = pa.landRecover;
      p.recover = pa.recover;
      p.court = pa.court;
      p.reachMul = pa.reachMul;
      if (pa.swing) {
        let s = this.swings.get(pa.swingKey);
        if (!s) this.swings.set(pa.swingKey, (s = { ...pa.swing }));
        else Object.assign(s, pa.swing);
        if (pb.swing && pb.swingKey === pa.swingKey) s.t = lerp(pa.swing.t, pb.swing.t, t);
        p.swing = s;
      } else p.swing = null;
      if (pa.dive) {
        const dv = Object.assign(this.dives[k], pa.dive);
        if (pb.dive) dv.t = lerp(pa.dive.t, pb.dive.t, t);
        p.dive = dv;
      } else p.dive = null;
    });
  }

  // ---------- 鏡頭 ----------

  /**
   * 第一個鏡頭（擊球前～落地前約 0.45 秒）：擊球員右後方、低角度往上看擊球點，慢慢推近；
   * 擊出後鏡頭跟著羽球往前移、轉頭追球。
   * 第二個鏡頭（落地前～結束）：落點旁邊貼近地面，球從畫面一邊飛進來落地，落地後再慢慢推近。
   */
  private updateCamera(): void {
    const { c, L, K, H, C, Lp, d, r, a, ra } = this;
    const cam = this.cam;
    const cur = this.cur;
    const sh = this.view.shuttle.pos;
    const portrait = this.aspect < 1;
    const far = portrait ? 1.4 : 1; // 直向畫面窄：拉遠一點
    const o = this.tmp;
    if (cur < K) {
      // ---- 擊球員身後 ----
      const pre = smooth(cur / Math.max(1, c)); // 擊球前慢慢推近
      const post = smooth((cur - c) / Math.max(1, K - c)); // 擊出後往前跟
      add(o, H, a, -(2.5 + 0.9 * (1 - pre)) + 1.6 * post);
      add(o, o, ra, 1.3 * far);
      // 肩膀高度、略低於擊球點（高點球微微仰角；太低會整個畫面都是天空）
      o.y = 0.85 + 0.3 * C.y + 0.3 * (1 - pre) + 0.4 * post + (portrait ? 0.3 : 0);
      // 底線後面退不出去（場外的樹、攤位）：不夠的距離改成往右邊補
      const lim = o.z < 0 ? CAM_ZFAR : CAM_Z;
      const cut = Math.max(0, Math.abs(o.z) - lim);
      if (cut > 0) {
        o.z = Math.sign(o.z) * lim;
        add(o, o, ra, cut * 0.8);
      }
      safeCam(o);
      set3(cam.pos, o);
      // 看擊球點和身體之間、往前（前面的場地、對手也拍進來）；擊出後轉頭追球
      const lk = this.tmp2;
      lk.x = lerp(H.x, C.x, 0.5) + a.x * 1.8;
      lk.y = lerp(1.3, C.y, 0.5);
      lk.z = lerp(H.z, C.z, 0.5) + a.z * 1.8;
      const w = 0.82 * smooth((cur - c) / 14);
      lerp3(cam.look, lk, sh, w);
      cam.fov = portrait ? 72 : 46;
    } else {
      // ---- 落點特寫 ----
      const sb = this.sb;
      const u = smooth((cur - K) / Math.max(1, L - K)); // 落地前推近
      const z = smooth((cur - L) / Math.max(1, this.frames.length - 1 - L)); // 落地後再推近一點
      add(o, Lp, r, sb * (2.0 + 0.7 * (1 - u)) * far * (1 - 0.18 * z));
      add(o, o, d, -(0.75 + 0.4 * (1 - u)) * (1 - 0.18 * z));
      o.y = 0.42 + 0.35 * (1 - u) + (portrait ? 0.3 : 0) - 0.06 * z;
      // 不要穿過網子、跑出場外太遠（樹、牆）
      const sz = Math.sign(Lp.z) || 1;
      if (o.z * sz < 0.45) o.z = 0.45 * sz;
      safeCam(o);
      set3(cam.pos, o);
      // 看落點；落地前一部分看球，球才會在畫面裡
      const lk = this.tmp2;
      lk.x = Lp.x;
      lk.y = 0.12;
      lk.z = Lp.z;
      lerp3(cam.look, sh, lk, 0.55 + 0.45 * smooth((cur - K) / Math.max(1, L - K) * 1.2));
      cam.fov = portrait ? 58 : 38;
    }
    if (cam.pos.y < 0.25) cam.pos.y = 0.25;
  }
}

/**
 * 檢視用的比賽：跟 Match 同一個原型（hitByTeam、teamOf、doubles… 這些唯讀的方法照常能用），
 * 但欄位全部是自己的複本；亂數也是另外一顆，萬一被呼叫到也不會動到真正比賽的亂數。
 */
function makeView(live: Match): Match {
  const v = Object.create(Match.prototype) as Match;
  const players: PlayerState[] = live.players.map((p) => ({ ...p, pos: { ...p.pos }, vel: { ...p.vel }, swing: null, dive: null, bufferedFlick: null }));
  const shuttle: ShuttleState = { ...live.shuttle, pos: { ...live.shuttle.pos }, vel: { ...live.shuttle.vel } };
  Object.assign(v as unknown as Record<string, unknown>, {
    rng: new Rng(1),
    settings: live.settings,
    players,
    shuttle,
    score: [live.score[0], live.score[1]],
    games: [live.games[0], live.games[1]],
    server: live.server,
    phase: live.phase,
    phaseT: 0,
    time: live.time,
    rallyHits: 0,
    hitSerial: live.hitSerial,
    lastPoint: null,
    events: [],
    gameJustEnded: false,
    remote: null,
    netLag: 0,
    remoteStates: new Map(),
  });
  return v;
}
